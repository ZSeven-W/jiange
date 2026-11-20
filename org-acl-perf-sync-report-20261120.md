# 企业组织大空间列表权限闭包加速与外部组织目录同步验证报告（2026-11-20）

## 1. 背景与目标

本轮（**P1 Slice 15**）聚焦 [feishu-gap-audit-20261118.md](feishu-gap-audit-20261118.md) 第 2 节「企业组织、部门与群组权限」遗留的两项 P1 核心差距：

1. **大空间列表权限计算性能优化**：此前 `server/internal/store/postgres-share.go` 中的 `roleJoins` 对每行节点都通过 `LEFT JOIN LATERAL` 执行两条 `WITH RECURSIVE`（节点继承祖先链 + 部门祖先树），且 `ListDocs` 对全量候选节点计算完整角色等级、`ListDriveChildren` 使用 `parent_id IS NOT DISTINCT FROM $3` 导致无法命中复合 B-Tree 索引，大空间深层级场景存在明显性能隐患。
2. **外部组织目录同步闭环**：此前组织架构仅支持手动逐个新建部门、用户组与邀请成员，缺少对接外部 IdP（SCIM 2.0 / LDAP / 企业微信 / 钉钉 / 自定义 Webhook）与企业花名册 CSV/JSON 批量预演同步及审计日志闭环。

## 2. 落地内容与关键文件

### 2.1 数据库迁移与物化闭包加速
- [`server/internal/migrate/sql/0080_org_acl_closure_and_sync.sql`](server/internal/migrate/sql/0080_org_acl_closure_and_sync.sql)
  - 新增 `org_department_closure` 物化部门祖先闭包表、`node_acl_state`（节点有效 `inherits_ws` 状态）与 `node_acl_ancestors`（有效 ACL 继承祖先闭包），并提供全量历史回填与实时触发器维护（`org_departments_closure_sync`、`nodes_acl_closure_sync`）。
  - 为避免父节点移动/修改继承时通过外键隐式对子节点 `nodes` 施加 `FOR KEY SHARE` 行锁而阻塞并发 `SELECT ... FOR UPDATE`，`node_acl_state` / `node_acl_ancestors` 采用 `AFTER DELETE` 触发器清理而非外键回指 `nodes(id)`，保持与既有 `lockCopySource` 并发锁协议 100% 兼容。
  - 新增 6 个复合索引：`nodes_ws_active_updated_idx`、`nodes_ws_parent_active_idx`、`doc_shares_user_doc_idx`、`doc_link_joins_user_doc_idx`、`org_dept_members_user_dept_idx`、`org_group_members_user_group_idx`。
  - 新增 `org_sync_sources`（含唯一 `token_hash`、协议枚举、自动邀请与缺失清理开关）与 `org_sync_runs` 同步审计表，并在 `org_departments` / `org_groups` 增加 `sync_source_id` 与 `external_id` 局部唯一索引。
- [`server/internal/store/postgres-share.go`](server/internal/store/postgres-share.go)、[`server/internal/store/postgres-docs.go`](server/internal/store/postgres-docs.go)、[`server/internal/store/drive-folder.go`](server/internal/store/drive-folder.go)
  - 重写 `roleJoins`，彻底消除逐行递归 CTE，改为基于 `node_acl_state`、`node_acl_ancestors` 与 `org_department_closure` 的索引连接，并为空间所有者/管理员及创建者提供快速短路路径。
  - 优化 `ListDocs` 快速可见性短路，仅对受限节点或知识库节点探测闭包与授权表。
  - 优化 `ListDriveChildren` 按 `parent == nil` / `parent != nil` 分支为 `n.parent_id IS NULL` / `n.parent_id = $3`，直接命中 `nodes_ws_parent_active_idx` 索引扫描。

### 2.2 外部目录同步存储与 API（PG / Memory 对等）
- [`server/internal/store/org-sync.go`](server/internal/store/org-sync.go)、[`server/internal/store/org-sync-memory.go`](server/internal/store/org-sync-memory.go)、[`server/internal/store/org-sync-pg.go`](server/internal/store/org-sync-pg.go)
  - 实现 `OrgSyncStore` 接口（同步源列表/审计、创建、配置更新与 Token 轮换、删除、管理员手动运行、Bearer Token 外部推送），内置部门拓扑排序与循环/超深（>32 层）拦截、Dry-Run 零写入差异预演、基于 `(sync_source_id, external_id)` 的幂等 upsert、仅限托管范围的缺失清理（绝不误删手工创建的部门与用户组）、成员移除清理并递增关联节点 `permissions_revision`。
  - 严格遵守成员加入同意与非枚举不变量：未加入空间的邮箱（无论是否已注册账号）仅在启用 `autoInviteMissing` 时创建 `workspace_invitations` 待接受邀请，绝不静默拉入空间，且绝不降级 `owner`。
- [`server/internal/api/org-sync.go`](server/internal/api/org-sync.go)、[`server/internal/api/api.go`](server/internal/api/api.go)、[`server/internal/httpx/httpx.go`](server/internal/httpx/httpx.go)
  - 新增 5 个管理员路由：`GET/POST /api/workspaces/{wsId}/org/sync-sources`、`PATCH/DELETE /api/workspaces/{wsId}/org/sync-sources/{sourceId}`、`POST .../run`。
  - 新增外部推送端点 `POST /api/org/sync/push`（Bearer Token SHA-256 校验，支持 `application/json` 与 `application/scim+json`），原生支持 Jiange 标准快照与 **SCIM 2.0 `ListResponse`**（自动解析 `User` + Enterprise `department` 路径与 `Group` 成员，规范化路径前缀 `dept:<path>` 与 CSV 导入无缝合并）。

### 2.3 前端组织架构「目录同步」工作台
- [`apps/web/src/lib/api.ts`](apps/web/src/lib/api.ts)、[`apps/web/src/pages/org/org-sync-panel.tsx`](apps/web/src/pages/org/org-sync-panel.tsx)、[`apps/web/src/pages/org/org-page.tsx`](apps/web/src/pages/org/org-page.tsx)、[`apps/web/src/i18n/en.ts`](apps/web/src/i18n/en.ts)
  - 在 `#/org` 新增第 4 个页签「目录同步」，提供同步源 CRUD、一次性明文 Token 展示与 `curl` 推送示例、启用/停用与 Token 轮换、CSV/JSON 文件与粘贴导入（含 `parseOrgDirectoryCsv` 嵌套路径/多部门/负责人/角色/用户组解析器与一键载入示例）、Dry-Run 差异预演卡片、执行同步及审计日志列表。
  - 在「部门架构」树中为外部托管部门增加「同步」标识徽章，清晰区分手工与同步部门。

## 3. 实测验证结果

### 3.1 自动化测试（Go + PostgreSQL 16 + Vitest + SDK + 命名规范）
- `cd server && go test -count=1 ./...`：全部 Go 包通过（含新增 [`org-sync_test.go`](server/internal/store/org-sync_test.go) 与 [`api/org-sync_test.go`](server/internal/api/org-sync_test.go)）。
- 真实 **PostgreSQL 16** 回归与并发测试（`JIANGE_TEST_DATABASE_URL`）：
  - `./internal/migrate`（`0001`–`0080` 完整迁移验证）：通过。
  - `./internal/api`：通过。
  - `TestPostgresOrgPermissions`、`TestPostgresOrgDirectorySync`、`TestPostgresOrgACLClosureAndLargeSpacePerf`、`TestPostgresShareGuardConcurrentAuthorization`（含 `ancestor_move`、`managers_demote_each_other`、`workspace_admin_downgrade`、`ancestor_trash_deadlock_rolls_back` 全部 4 个子测试）：全部通过。
- 前端与无头 SDK 验证：
  - `pnpm typecheck`：7 个工作区包全部通过。
  - `pnpm --filter @jiange/web build`：生产构建通过（4079 模块）。
  - `pnpm test`：248 个测试文件 / 1,366 个测试全部通过（含 [`org-sync-panel.test.tsx`](apps/web/src/pages/org/org-sync-panel.test.tsx) 与 `i18n.test.ts` 全量字典覆盖检查）。
  - `pnpm test:sdk:pack` 与 `pnpm lint:names`：通过。

### 3.2 真实 PostgreSQL 16 大空间权限性能实测
在 5 级目录树 + 4 级部门树 + **2,000 篇文档**（1,600 公开文档 + 200 研发保密文档 + 200 高管机密文档，且将受限文档时间戳置为最新以构成 `ORDER BY updated_at DESC LIMIT 500` 最坏过滤场景）下实测：
- **查询计划验证**：`EXPLAIN (ANALYZE, FORMAT TEXT)` 确认 **零 `Recursive Union`**，执行耗时 **`5.557 ms`**。
- **Go Store 实测耗时**：
  - `alice`（含 4 级子部门继承 200 篇受限文档 + 过滤 200 篇机密文档）：`ListDocs` **`11.95 ms`**，精确返回 0 篇机密 / 200 篇研发保密 / 295 篇公开 + 5 个可见文件夹（合计 500）。
  - `bob`（仅公开文档）：`ListDocs` **`8.52 ms`**。
  - `ListDriveChildren`（200 篇受限子部门目录直查）：优化 `parent_id = $3` 索引分支后由 `639 ms` 降至 **`66.59 ms`**（约 9.6 倍加速）。
  - 部门调整上级与文件夹关闭/开启继承触发器实时生效：权限变更后 `ListDocs` 计数即时更新为零误差。
- **真实 HTTP 端到端压测**（[`scripts/verify-org-sync-perf.mjs`](scripts/verify-org-sync-perf.mjs)，1,500 篇文档 + 真实 Go 编译服务 + PostgreSQL 16）：5 次 `GET /api/docs` 实测 `[10.8, 10.6, 10.1, 12.2, 9.5] ms`，平均 **`10.6 ms`**。

### 3.3 Headless Chrome CDP 端到端与视觉验证
执行 [`scripts/verify-org-sync-perf.mjs`](scripts/verify-org-sync-perf.mjs) 针对真实 PostgreSQL 16 + 编译 Go 后端 + Vite 前端完成全流程验证，并逐张审阅了桌面（`1440×900`）与移动端（`390×844`）截图：
- 创建 SCIM 2.0 同步源并展示一次性明文 Token 及 `curl` 推送示例；
- CSV 导入预演（Dry-Run 校验零落库）与正式执行；
- 真实 Bearer Token + `Content-Type: application/scim+json` 推送 SCIM 2.0 `ListResponse` 至 `/api/org/sync/push`，与 CSV 导入规范化合并为单一「研发中心」部门树并新增「SCIM评审团」用户组，手工创建的「手工保留部」完整保留；
- 页面刷新后全部部门、用户组、待接受邀请与审计日志持久化无丢失；
- 受限文件夹授权给同步得到的上级部门「研发中心」，子部门成员立即获得文档访问权；
- 桌面 `1440×900` 与移动端 `390×844` 均为 **`0px` 水平溢出**、`0` 控制台/页面错误。

## 4. 边界与后续说明

- 主动定时拉取型连接器（直接以部署密钥轮询外部企业微信/钉钉/LDAP 服务器）属于部署侧定时调度能力，当前已通过标准 Bearer Token 推送（含 SCIM 2.0 `ListResponse`）与 UI CSV/JSON 快照预演导入完成核心闭环，外部 cron/IdP 推送脚本可直接对接 `POST /api/org/sync/push`。
