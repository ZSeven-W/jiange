# 跨文档同步块与子页面列表验证报告（2026-11-19）

## 一、交付范围（P1 Slice 2）

本轮完成云文档 **跨文档同步块（Synced Block）** 与 **按阅读权限动态过滤的子页面列表块（Subpage List）** 全栈闭环：

1. **数据库迁移与存储层（PostgreSQL / Memory 对等）**：
   - [0072_synced_blocks.sql](server/internal/migrate/sql/0072_synced_blocks.sql)：新增 `synced_blocks` 表（外键关联 `workspaces(id)`、`nodes(id)` 与 `users(id)`，含递增乐观锁 `revision` 字段与 `source_doc_id` 索引）。
   - [server/internal/store/synced-blocks.go](server/internal/store/synced-blocks.go) & [server/internal/store/memory.go](server/internal/store/memory.go)：实现 `SyncedBlockStore`（`CreateSyncedBlock`、`GetSyncedBlock`、`UpdateSyncedBlock`，支持 `expectedRevision` 冲突检测返回 `409 Conflict`）。

2. **HTTP API 与权限过滤**：
   - [server/internal/api/synced-blocks.go](server/internal/api/synced-blocks.go) & [server/internal/api/api.go](server/internal/api/api.go)：
     - `POST /api/docs/{id}/synced-blocks`（需源文档 `edit` 权限）
     - `GET /api/synced-blocks/{sid}`（校验当前用户对 `sourceDocId` 至少拥有 `view` 权限，无权返回 `403 Forbidden`，防止跨文档越权泄露）
     - `PUT /api/synced-blocks/{sid}`（校验源文档 `edit` 权限与乐观锁 `expectedRevision`）
     - `GET /api/docs/{id}/subpages`（合并 `ListDocs` 与 `SharedWithMe` 并去重，仅返回当前用户有权阅读的直接子页面，不泄露私密或回收站文档）
   - [server/internal/api/synced-blocks_test.go](server/internal/api/synced-blocks_test.go)：覆盖子页面权限隔离（所有者见 2 个子页、外部分享阅读者仅见已授权的 1 个子页）、同步块读写权限边界与 `409` 乐观锁冲突。

3. **斜杠命令与前端块渲染**：
   - [packages/doc-sdk/src/model.ts](packages/doc-sdk/src/model.ts) & [apps/web/src/editor/pinyin.ts](apps/web/src/editor/pinyin.ts)：将 `synced` / `subpages` 纳入 `TEXTLESS` 块并在 `/` 斜杠菜单注册 `同步块`（`tongbu` / `synced`）与 `子页面列表`（`ziyemian` / `subpages`）。
   - [apps/web/src/editor/synced-block.tsx](apps/web/src/editor/synced-block.tsx) & [apps/web/src/editor/subpages-block.tsx](apps/web/src/editor/subpages-block.tsx)：实现飞书风格珊瑚红边框同步块（支持创建新同步块、粘贴 ID 关联已有同步块、复制同步 ID、防抖保存、周期拉取同步、源文档跳转与无权占位态）以及子页面列表块（支持 `+ 新建子页面`、手动刷新与按权限动态渲染）。
   - [apps/web/src/editor/editor.tsx](apps/web/src/editor/editor.tsx) & [apps/web/src/pages/read-only-doc.tsx](apps/web/src/pages/read-only-doc.tsx)：接入编辑器渲染与只读视图渲染。

---

## 二、自动化与端到端验证结果

| 验证项 | 命令 / 路径 | 结果 |
| --- | --- | --- |
| Go 全量测试（含 `TestSyncedBlocksAndPermissionFilteredSubpages`） | `cd server && go test ./...` | 通过 |
| `@jiange/doc-sdk` 构建与全仓库类型检查 | `pnpm --filter @jiange/doc-sdk build && pnpm typecheck` | 通过 |
| 前端生产构建与全量单元测试（含 `synced-subpages.test.tsx`） | `pnpm --filter @jiange/web build && pnpm test` | 通过 |
| 真实 Postgres 16 + Go + Vite + Headless Chrome CDP 验证 | `node scripts/verify-synced-subpages.mjs` | 通过（0 控制台错误） |

### CDP 截图人工核验（桌面 `1440×900`）
- `output/synced-subpages-verify-20261119/01-doc-a-synced-and-subpages.png`：`项目主文档 A` 内同步块显示「源文档：项目主文档 A v2 已跨文档同步」，下方子页面列表自动渲染授权子页「需求规格子页 A1」。
- `output/synced-subpages-verify-20261119/02-doc-b-linked-synced-block.png`：`关联文档 B` 通过同步块 ID 关联后立即实时呈现同一同步块内容与源文档链接。
