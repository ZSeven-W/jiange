# 多维表格多数据表与视图配置锁 / 个人视图落地报告（2026-11-19）

## 1. 交付范围（P0 Slice 3）
本次对齐解决了 [feishu-gap-audit-20261118.md](feishu-gap-audit-20261118.md) 中的两项核心 P0 缺口：
1. **单 Base 内多数据表（`bt_tables`）全链路落地**：
   - 数据库迁移 [0070_base_multi_table_and_views.sql](server/internal/migrate/sql/0070_base_multi_table_and_views.sql)：为 `base_fields`、`base_records`、`bt_views` 增加非空 `table_id`（外键 `bt_tables(id) ON DELETE CASCADE`）并回填默认表；将 `base_fields_one_primary` 唯一索引与主字段触发器改为按 `table_id` 隔离；为 `base_fields` 增加 `target_table_id` 支持同 Base 跨表关联；通过 `BEFORE INSERT` 默认表触发器保持旧调用方 100% 兼容。
   - 后端存储与 API：[base-tables.go](server/internal/store/base-tables.go) / [api/base-tables.go](server/internal/api/base-tables.go) 实现 `GET/POST /api/bases/{id}/tables`、`PATCH/DELETE /api/bases/{id}/tables/{tid}`（默认表不可删除，返回 `409`）、`POST /api/bases/{id}/tables/reorder`；`GET /api/bases/{id}?tableId=...`、字段/记录/视图增删改、服务端筛选排序 `POST /api/bases/{id}/query` 及 CSV 导出 `GET /api/bases/{id}/export?tableId=...` 均按数据表隔离；同 Base 跨表 `link` 字段自动在目标表创建双向关联字段并展开记录标题。
   - 前端 UI：[base-page.tsx](apps/web/src/pages/base-page.tsx)、[fields.tsx](apps/web/src/pages/base/fields.tsx)、[grid.tsx](apps/web/src/pages/base/grid.tsx) 左侧数据表侧栏与移动端导航支持多表新建、切换、重命名、删除，创建关联字段时可直接选择同 Base 内的目标数据表。
2. **飞书「锁定视图配置」与「个人视图」与「权限视图」语义解耦**：
   - **锁定视图配置（`configLocked: true`）**：仅管理员可开启/关闭，锁定后仅管理员可修改/重命名/删除该共享视图的筛选、排序、分组与隐藏列配置；**不触发 `writeRestricted`**，编辑者仍可正常读写数据，并可复制视图（副本自动清除 `configLocked`）或新建个人视图。
   - **个人视图（`bt_views.owner_id` / `isPersonal: true`）**：仅创建者本人可见与编辑，其他用户（含管理员）在列表与接口中均不可见且无法修改/删除（返回 `404`）；不支持表单类型、不支持 `locked` / `configLocked`，且删除个人视图不受「至少保留一个共享视图」限制。
   - **权限视图（`locked: true`）**：完整保留既有高级数据权限语义与所有安全不变量，与「锁定视图配置」在 UI 上分别以 `Shield`（「权限视图」）和 `Lock`（「锁定视图配置」）明确区分。

## 2. 验证结果
- **Go 单元测试**：`cd server && go test ./...` 全量通过，含新增 [base-multitable-views_test.go](server/internal/api/base-multitable-views_test.go)（`TestBaseMultiTableCRUDAndCrossTableLink`、`TestBaseViewConfigLockAndPersonalViews`）。
- **真实 PostgreSQL 16 集成测试**：`JIANGE_TEST_DATABASE_URL=... go test -p 1 ./internal/migrate ./internal/store ./internal/api` 全量通过（含 `0070_base_multi_table_and_views.sql` 与 `TestPostgresMultitableCompatibilityViews`）。
- **前端构建与单测**：`pnpm typecheck`、`pnpm --filter @jiange/web build`、`pnpm test`（含新增 [view-config-lock.test.tsx](apps/web/src/pages/base/view-config-lock.test.tsx) 与 `i18n.test.ts`）全部通过。
- **真实浏览器 CDP 端到端验证**：[verify-base-multitable.mjs](scripts/verify-base-multitable.mjs) 零控制台错误通过，已人工核验桌面端 `1440×900` 与模拟移动端 `390×844`（非真机）4 张截图：多表切换、跨表关联标题展开、`锁定视图配置` 不阻塞编辑者写数据、以及 `Bob 个人视图` 隔离均正常。
