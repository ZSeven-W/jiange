# 文档修订模式（建议与审阅）验证报告（2026-11-19）

## 一、交付范围（P1 Slice 1）

本轮完成云文档 **修订模式（建议与审阅 / Suggestion Mode）** 全栈闭环：

1. **数据库迁移与存储层（PostgreSQL / Memory 对等）**：
   - [0071_doc_suggestions.sql](server/internal/migrate/sql/0071_doc_suggestions.sql)：新增 `doc_suggestions` 表（关联 `nodes(id)` 与 `users(id)`，约束 `kind IN ('replace','insert','delete')` 与 `status IN ('open','accepted','rejected','withdrawn')`）及 `(doc_id, status, created_at DESC)` 索引。
   - [server/internal/store/suggestions.go](server/internal/store/suggestions.go) & [server/internal/store/memory.go](server/internal/store/memory.go)：实现 `SuggestionStore` 接口（`ListDocSuggestions`、`CreateDocSuggestion`、`GetDocSuggestion`、`ResolveDocSuggestion`、`ResolveAllDocSuggestions`、`UpdateDocSuggestionNote`），单条审阅带 `WHERE status='open'` 并发冲突保护（已处理返回 `409 Conflict`）。

2. **HTTP API 与权限边界**：
   - [server/internal/api/suggestions.go](server/internal/api/suggestions.go) & [server/internal/api/api.go](server/internal/api/api.go)：新增 8 个接口：
     - `GET /api/docs/{id}/suggestions?status=open|resolved|all`（需 `view`）
     - `POST /api/docs/{id}/suggestions`（遵循评论权限，非 `edit` 限制时阅读者也可发起修订建议）
     - `PATCH /api/docs/{id}/suggestions/{sid}`（仅发起人在 `open` 状态修改批注）
     - `POST /api/docs/{id}/suggestions/{sid}/accept` & `/reject`（仅 `edit`/`manage` 可审阅）
     - `POST /api/docs/{id}/suggestions/{sid}/withdraw`（仅发起人或 `manage` 可撤回）
     - `POST /api/docs/{id}/suggestions/accept-all` & `/reject-all`（仅 `edit`/`manage` 可批量审阅）
   - [server/internal/api/suggestions_test.go](server/internal/api/suggestions_test.go)：覆盖阅读者发起/改批注/撤回、越权接受 `403`、编辑者接受与重复接受 `409`、以及批量拒绝闭环。

3. **前端修订模式与审阅面板**：
   - [apps/web/src/lib/api.ts](apps/web/src/lib/api.ts)：新增 `DocSuggestion` 与 `suggestionsApi`。
   - [apps/web/src/pages/suggestion-panel.tsx](apps/web/src/pages/suggestion-panel.tsx)：新增右侧「修订建议」抽屉，支持 `待审阅 / 全部` 筛选、段落选择与原文删除线/建议绿字对照、修订批注、单条「接受 / 拒绝 / 撤回」及「全部接受 / 全部拒绝」批量审阅。
   - [apps/web/src/pages/doc-page.tsx](apps/web/src/pages/doc-page.tsx)：顶栏模式切换升级为 **编辑 / 建议 / 阅读** 三态（对齐飞书），新增顶栏 `修订` 计数按钮与修订模式提示横幅；接受单条或全部修订时通过 CRDT `Tx` 原子写入正文并同步云端。

---

## 二、自动化与端到端验证结果

| 验证项 | 命令 / 路径 | 结果 |
| --- | --- | --- |
| Go 全量测试（含 `TestDocSuggestionsLifecycleAndPermissions`） | `cd server && go test ./...` | 通过 |
| 全仓库类型检查 | `pnpm typecheck` | 通过（7/7 包） |
| 前端生产构建 | `pnpm --filter @jiange/web build` | 通过 |
| 全仓库前端/SDK 单元测试（含 `suggestion-panel.test.tsx`） | `pnpm test` | 通过（237 文件，1,316 用例） |
| 真实 Postgres 16 + Go + Vite + Headless Chrome CDP 验证 | `node scripts/verify-doc-suggestions.mjs` | 通过（0 控制台错误） |

### CDP 截图人工核验（桌面 `1440×900`）
- `output/doc-suggestions-verify-20261119/01-doc-suggestion-open.png`：顶栏绿色 `建议 ▾` 模式状态、修订提示横幅、顶栏 `修订 1` 计数与右侧审阅抽屉（批量审阅栏 + 新建修订表单 + 待审阅建议卡片含批注与撤回/拒绝/接受按钮）布局清晰。
- `output/doc-suggestions-verify-20261119/02-doc-suggestion-accepted.png`：点击「接受」后正文立即更新为修订内容并提示「已经保存到云端」，卡片状态切换为「已接受」，硬刷新后持久化保留。
