# 文档表格单元格富文本与正式 CRDT 准入验证报告（2026-11-19）

## 一、交付范围（P0 Slice 5）

本轮完成云文档表格的 **单元格行内多样式富文本** 与 **服务端正式 CRDT 表格批次准入** 闭环：

1. **服务端正式 CRDT 表格准入**：
   - [server/internal/tableadmission/admission.go](server/internal/tableadmission/admission.go)：新增 `RebuildOrInit`（支持在既有可见 `table` 块上从 0 条 `ttable` 操作安全引导初始化）与 `PrepareBatch`（在独立克隆副本上完整校验 `axis-insert` / `axis-delete` / `text-insert` / `text-delete` / `text-mark` 批次，不污染在线状态）。
   - [server/internal/api/conditional-ops.go](server/internal/api/conditional-ops.go)：扩展 `conditionalCellKey` 正则以放行逐格富文本属性 `tbl.fmt.<row>.<col>`，并新增 `conditionalTableCRDTBatch` 分支将纯 `collab.TTable` 单块批次接入 `tableadmission.RebuildOrInit` + `PrepareBatch` 与 `CommitConditionalOps`（旧版非 `ttable` 视图门禁 `rejectUnsupportedTableView` 保持不变）。
   - [server/internal/api/conditional-table-admission_test.go](server/internal/api/conditional-table-admission_test.go)：覆盖 `tbl.fmt.r0.c0` 条件提交、正式 CRDT `ttable` 引导批次（`axis-insert` + `text-insert` + `text-mark`）、陈旧 Head `409 Conflict` 拒绝及最新 Head 续写 `200 OK`。

2. **单元格行内富文本模型、编辑器、只读页、剪贴板与导出**：
   - [packages/doc-sdk/src/table-cells.ts](packages/doc-sdk/src/table-cells.ts)：新增 `cellRichKey`（`tbl.fmt.<r>.<c>`）、`TableCellMarks`、`TableRichSpan`、`parseTableRichSpans`、`serializeTableRichSpans`、`tableCellRich`、`tableCellHasRichMarks`、`tableCellHasMark`、`toggleTableCellRichMark`（支持整格切换与字符子区间 `[start, end)` 局部行内格式，且纯文本修改时自动保留整格统一样式）与 `setTableCellRich`。
   - [apps/web/src/editor/table-rich-render.tsx](apps/web/src/editor/table-rich-render.tsx)：共享富文本 span 渲染组件（加粗、斜体、下划线、删除线、行内代码、文字颜色）。
   - [apps/web/src/editor/table-block.tsx](apps/web/src/editor/table-block.tsx) & [apps/web/src/editor/editor.tsx](apps/web/src/editor/editor.tsx)：表格浮动工具栏新增 **B / I / U / S / `</>` / 文字颜色**（含恢复默认），支持 `⌘/Ctrl+B`、`⌘/Ctrl+I`、`⌘/Ctrl+U`、`⌘/Ctrl+Shift+S`、`⌘/Ctrl+E` 快捷键；非编辑态叠加 `data-table-rich-overlay` 呈现多段行内富文本，编辑态对整格统一样式实时套用 CSS，保留原有 `<textarea>` 输入法、Tab 导航、拖选、查找高亮与撤销历史。
   - [apps/web/src/editor/table-rich-clipboard.ts](apps/web/src/editor/table-rich-clipboard.ts)：`RichTableCell` 向后兼容扩展可选 `rich` 字段，复制 HTML 输出 `<strong>`/`<em>`/`<u>`/`<s>`/`<code>`/`<span style="color:...">`，粘贴时通过 `setTableCellRich` 一并还原。
   - [apps/web/src/pages/read-only-doc.tsx](apps/web/src/pages/read-only-doc.tsx)：`ReadOnlyTable`（只读文档与匿名公开页 `#/p/{token}`）直接渲染单元格富文本。
   - [packages/doc-sdk/src/docx.ts](packages/doc-sdk/src/docx.ts) & [packages/doc-sdk/src/markdown.ts](packages/doc-sdk/src/markdown.ts)：DOCX `tableXml` 按富文本行输出 `<w:b/>`/`<w:i/>`/`<w:u w:val="single"/>`/`<w:strike/>`/`Courier New` 底纹/`<w:color w:val="..."/>`；Markdown 表格导出对含富文本单元格输出 `**` / `*` / `~~` / `` ` `` / `<u>`（纯文本单元格字节级保持原样）。

---

## 二、自动化与端到端验证结果

| 验证项 | 命令 / 路径 | 结果 |
| --- | --- | --- |
| Go 全量测试（含 `tableadmission` 与 `TestConditionalTableAdmission`） | `cd server && go test ./...` | 通过 |
| `@jiange/doc-sdk` 构建 | `pnpm --filter @jiange/doc-sdk build` | 通过 |
| 全仓库类型检查 | `pnpm typecheck` | 通过（7/7 包） |
| 前端生产构建 | `pnpm --filter @jiange/web build` | 通过 |
| 全仓库前端/SDK 单元测试（含 `table-rich-text.test.tsx` 3 用例） | `pnpm test` | 通过（235 文件，1,312 用例） |
| 真实 Postgres 16 + Go + Vite + Headless Chrome CDP 验证 | `node scripts/verify-document-table-rich.mjs` | 通过（0 控制台错误） |

### CDP 截图人工核验（桌面 `1440×900`）
- `output/doc-table-rich-verify-20261119/01-doc-table-rich-editor.png`：编辑器内 `(1,0)` 显示红色加粗「核心指标」、`(1,1)` 显示局部行内代码 `支持 P99 监控`（仅 `P99` 为等宽灰底胶囊）、`(1,2)` 显示斜体删除线「旧方案已归档」。
- `output/doc-table-rich-verify-20261119/02-doc-table-rich-reloaded.png`：硬刷新后 3 个单元格的富文本样式完整持久化保留。
- `output/doc-table-rich-verify-20261119/03-doc-table-rich-readonly.png`：匿名公开只读页（`#/p/{token}`）`ReadOnlyTable` 准确渲染 `<strong>`、`<code>`、`<em>`、`<s>` 与文字颜色。

---

## 三、已知边界（留作 P1 后续增强）

- 当前单元格富文本聚焦行内多样式（加粗/斜体/下划线/删除线/行内代码/文字颜色）及服务端正式 CRDT `ttable` 条件准入；单元格内嵌多段落列表、图片、附件与公式块留作 P1 阶段演进。
