# 文档多块分栏、取消分栏与服务端 10 栏上限落地报告（2026-11-19）

## 1. 交付范围（P0 Slice 4）
本次对齐解决了 [feishu-gap-audit-20261118.md](feishu-gap-audit-20261118.md) 中「文档分栏容器与末栏处理」的 P0 缺口：
1. **服务端 10 栏上限与条件加栏/移栏/取消分栏**：
   - [column-archive.go](server/collab/column-archive.go)：定义权威常量 `MaxColumns = 10`，新增 `ColumnCount`、`CanCreateColumn`、`CanUngroupColumns`，并在 `CanTransitionArchivedColumn` 恢复路径强制校验 `< MaxColumns`。
   - [conditional-ops.go](server/internal/api/conditional-ops.go)：支持条件新增分栏批次（超 10 栏返回 `400 column_limit`，head 过期返回 `409 document_changed`）、条件取消分栏批次（将各栏及其嵌套子块按前序提升至 `Root` 后原子归档空分栏容器），以及既有条件移栏 `CanReorderColumn`。
   - 前端 [column-ops-commit.ts](apps/web/src/editor/column-ops-commit.ts) 与 [editor.tsx](apps/web/src/editor/editor.tsx) 将「添加一栏」「移动分栏」「取消分栏」接入 `/api/docs/{id}/conditional-ops` 条件提交，并在仅剩 1 栏时执行删除自动归档整组分栏（可撤销/重做）。
2. **多块分栏容器（编辑器 + 只读态 + DOCX 导出）**：
   - 新增 [column-nested-blocks.tsx](apps/web/src/editor/column-nested-blocks.tsx)：每个分栏内支持嵌套混排多块内容（段落、标题、无序列表、有序列表、待办事项含勾选、引用、高亮块、代码块、分割线），提供栏底「+ 添加块」菜单、行内编辑与单块删除。
   - 取消分栏（`取消分栏`）按前序将各栏主块与栏内所有嵌套子块完整提升至文档根级，不丢失任何内容或块类型。
   - [docx.ts](packages/doc-sdk/src/docx.ts)：将 `columns` 块及其多块子内容导出为无边框 Word 多列表格（`<w:tbl>`），保留栏内标题、列表、待办、段落等结构。

## 2. 验证结果
- **Go 全量单测**：`cd server && go test ./...` 全量通过，含新增 [conditional-column-cap-ungroup_test.go](server/internal/api/conditional-column-cap-ungroup_test.go)（验证 10 栏上限 `400 column_limit`、陈旧 head 移栏 `409`、条件取消分栏）。
- **前端构建与单测**：`pnpm --filter @jiange/doc-sdk build`、`pnpm --filter @jiange/web build`、`pnpm typecheck`、`pnpm test` 全量通过（含新增 [column-multiblock-ungroup.test.tsx](apps/web/src/editor/column-multiblock-ungroup.test.tsx) 与 `columns.test.tsx`）。
- **真实浏览器 CDP 端到端验证**：[verify-document-columns.mjs](scripts/verify-document-columns.mjs) 在真实 PostgreSQL 16 + Go 服务 + Vite 下零控制台错误通过，已人工核验桌面端 `1440×900` 截图：多块分栏（主段落 + 二级标题 + 已勾选待办 + 第 3 栏）及「取消分栏」后全部块按前序提升至根级画布均正常。
