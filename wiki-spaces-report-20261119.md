# P0 切片 2b：独立知识库空间（Wiki Knowledge Spaces，2026-11-19）

对齐飞书「知识库独立空间、空间级权限（成员/部门/用户组）、层级目录树、单页权限阻断、跨库迁移与云盘迁入」。迁移 `0069_wiki_spaces.sql`。

## 能力

| 能力 | 说明 |
| --- | --- |
| 独立知识库空间 `#/wiki` | 支持创建全员可见（`workspace`，空间成员默认只读）与私有知识库（`private`，仅管理员与显式授权对象可见），支持编辑名称、简介、图标、可见范围及级联删除（同步回收失去最后引用的附件 Blob）。 |
| 空间级权限授权 | 支持按「成员 / 部门（自动覆盖下级部门）/ 用户组」授予 `view` / `edit` / `manage`；成员移出空间、部门删除或用户组删除时自动清理对应 `wiki_space_grants`。 |
| 层级目录树与多资源嵌入 | 空间内支持创建 `doc`、`board`（画板）、`sheet`、`base`、`slides` 及 `folder` 目录分组，非 `folder` 页面可挂在任意页面或目录分组下，右侧直接嵌入对应实时编辑端。 |
| 页面级权限继承与阻断 | 空间内任意页面/目录可在分享弹窗中关闭「继承上级权限」（`inherit_parent_acl = false`），阻断空间默认的 `view`/`edit`；空间管理员（`manage`）、节点创建者与显式授权继续生效。 |
| 跨库移动与云盘迁入 | 支持同库调整父级、跨知识库整棵子树迁移（校验全子树 `manage` 权限与目标 `edit` 权限）以及从云盘（共享/个人空间）迁入知识库（拒绝含二进制 `kind='file'` 子树）。 |
| 决策 A2 隔离与检索 | 知识库页面不出现在云盘目录列表（`ListDriveChildren`）与侧栏「我的文档库」，但在主页「最近访问」、收藏、置顶与全局搜索中按实际有效权限可见，点击直接跳转 `#/wiki/{spaceId}/node/{nodeId}`。 |

## 一致性与安全边界

- **三套权限路径一致**：Postgres `roleSQL`/`roleJoins`、Memory `roleLocked`、加锁路径 `lockCopySource` 对 `wiki_space_id` 使用完全一致的 `wiki_rank` 计算与 `inherit_parent_acl` 阻断规则；`lockCopySource` 中被并发测试轮询的 3 条 SQL 原样保留。
- **云盘与知识库边界**：`MoveDriveNode`、旧版 `Move`、`PatchDocMetadataGuarded` / `PatchManagedDocGuarded`（移动分支）、`CopyDoc`（指定父级时）与旧版 `POST /api/docs` 均拒绝跨界操作知识库节点；`0034_drive_folder_foundation.sql` 的目录触发器规则（`folder` 父级必须为 `folder`、目录写入带 `drive_revision` 与工作区锁）在知识库创建/移动/迁入中全部遵守。

## 验证结果

- **后端 Go**：
  - `go test ./...` 全部通过。
  - Postgres（`-p 1 -count=1`）：`internal/migrate`、`internal/store`、`internal/api`、`internal/sheetsync`、`internal/syncsrv` 全部通过（含 `TestPostgresWikiSpaces` 与所有升级/并发回归测试）。
  - Postgres `-race`：`TestWiki|TestPostgresWiki|TestMemoryWiki|TestOrg|TestPostgresOrg|TestGuardedShare|TestCopyDoc` 全部通过。
- **前端与 SDK**：
  - `pnpm typecheck`、`pnpm test`（含 `wiki-page.test.tsx` 3/3、`i18n.test.ts` 5/5）、`pnpm test:sdk:pack`、`pnpm --filter @jiange/web build` 全部通过。
- **无头 Chrome CDP（`scripts/verify-wiki-spaces.mjs`）**：
  - 创建「产品与研发知识库」→ 空间设置向「研发中心」授予 `edit` → 创建多级页面（`架构总览` → `接口规范`、`核心密钥说明`）与 `排期表` → 从云盘迁入「存量云盘规范」并核验云盘列表不再展示 → 对「核心密钥说明」关闭继承并仅授权「前端组」→ 切换市场部成员 Bob 登录，确认 Bob 可阅读「架构总览」且在全局搜索中命中（携带 `wikiSpaceId`），无法在目录看到「核心密钥说明」且直接请求返回 `404`。
  - 截图位于 `output/wiki-spaces-verify-20261119/`：`wiki-spaces-desktop.png`、`wiki-doc-desktop.png`、`wiki-settings-desktop.png`（`1440×900`）与 `wiki-mobile.png`（`390×844` **模拟**移动端视口，非真机），无横向溢出或遮挡。

## 已知边界

- 知识库目录树尚不支持鼠标拖拽排序（当前通过「移动 / 跨库迁移」弹窗调整父级与所属空间）。
- 知识库空间内尚不支持「添加快捷方式」（跨库引用同一页面）。
- 移动端核验基于无头 Chrome `390×844` 模拟视口，尚缺真机触控与输入法实测。
