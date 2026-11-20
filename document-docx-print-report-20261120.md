# P1 Slice 13：`.docx` 导入导出深度保真与精细化打印 / PDF 导出闭环验证报告（2026-11-20）

## 1. 交付范围与架构实现

本次切片围绕飞书云文档对标清单中「导入导出与打印」核心差距，在 `@jiange/doc-sdk`（无头 OOXML 引擎）与 `@jiange/web`（云文档前端与打印样式层）完成端到端闭环：

1. **`.docx` 导入深度保真（`packages/doc-sdk/src/docx.ts`）**：
   - **表格单元格内联富文本回写**：`parseDocx` 完整解析 `<w:tc>` 内加粗、斜体、下划线、删除线、等宽行内代码（自动剔除导出的 `#F2F3F5` 代码底纹避免无谓警告）与文字颜色，通过 `serializeTableRichSpans` 精准写入 `tbl.fmt.r{row}.c{col}`，并仅在存在富文本/背景/对齐时升级表格版本 `tbl.v = "2"`，保持普通纯文本表格往返 100% 兼容。
   - **表格单元格内嵌入图片提取**：当启用 `options.images` 且表格单元格含 `<a:blip>` 时，在原单元格保留 `[图片：<名称>]` 占位标记，并紧跟表格之后生成带 `importImageId` 与 `表格第 R 行第 C 列：<名称>` 说明文字的独立 `image` 块；前端 `uploadDocxImportImages` 自动上传至持久化附件存储并渲染。
   - **原生 Word 批注导入（`word/comments.xml`）**：解析 `<w:comment>` 作者/时间/文本与 `<w:commentRangeStart>`–`<w:commentRangeEnd>` 引用正文及目标块索引（`result.comments`）；`doc-page.tsx`（含常规菜单导入与云盘/主页待导入 `applyPendingWord`）将批注映射至真实 CRDT 块 ID 并通过受权限校验的 `commentsApi.create` 写入评论持久层。
   - **脚注与尾注导入（`word/footnotes.xml`、`word/endnotes.xml`）**：跳过分隔符节点，在正文原位插入顺序编号 `[注N]` / `[尾注N]` 标记，并在文末自动追加分割线、`脚注与尾注` 标题及可读注脚段落，同时在 `result.footnotes` 返回结构化列表。
   - **`mc:AlternateContent` 与文本框去重导入**：通过 `selectAlternateBranch` 优先读取 `<mc:Choice>` 并在缺失有效内容时回退 `<mc:Fallback>`，彻底避免现代 Word/WPS 文本框双份重复导入；经 `collectTextBoxContents` 转换为带 `📝` 图标的高亮块（`callout`）并透明提示用户。
   - **页眉与页脚提取（`word/header*.xml`、`word/footer*.xml`）**：按节属性 `<w:headerReference>` / `<w:footerReference>` 解析页眉/页脚文本，自动剥离 `PAGE` / `NUMPAGES` 动态域及孤立 `/` 间隔符，并同步回填至文档打印与再次 Word 导出设置。

2. **`.docx` 导出深度保真（`packages/doc-sdk/src/docx.ts` & `apps/web/src/pages/doc-page.tsx`）**：
   - `DocxExportOptions` 新增 `comments`、`headerText`、`footerText` 与 `includePageNumbers`。
   - 原生生成标准 OOXML `word/comments.xml`（含作者、ISO 时间、首字母、`[已解决]` 状态与嵌套回复段落），并在对应 `block.id` 段落精确包裹 `<w:commentRangeStart>` / `<w:commentRangeEnd>` / `<w:commentReference>`（未匹配块兜底挂载至末尾，确保评论不丢失）。
   - 原生生成 `word/header1.xml` 与 `word/footer1.xml`（含 Word 动态 `<w:fldSimple w:instr="PAGE"/>` / `<w:fldSimple w:instr="NUMPAGES"/>` 页码域），完整注册 `<w:sectPr>`、`word/_rels/document.xml.rels` 与 `[Content_Types].xml`。未传入扩展项时仍保持极简包结构。

3. **精细化打印 / 导出 PDF 闭环（`apps/web/src/pages/doc-print-dialog.tsx` & `apps/web/src/index.css`）**：
   - 新增飞书风格打印与导出 PDF 设置弹窗（`DocPrintDialog`），支持纸张大小（`A4` / `Letter`）、页面方向（`纵向` / `横向`）、页边距（`窄边距` / `标准` / `宽边距`）、自定义页眉/页脚开关与文案（自动预填导入的 Word 页眉页脚）、评论附录开关及实时按比例缩放纸张预览。
   - 确认打印时通过 `applyPrintPageStyle` 动态注入精确 `@page { size: ...; margin: ...; }` 并在 `afterprint` 及组件卸载时自动清理；严格遵守文档 `downloadAllowed` 下载/打印权限策略与既有 `[data-document-print-restricted="true"]` 隔离规则。
   - 升级 `@media print` 排版样式：展开 `#root` 与 `[data-doc-scroll]` 滚动容器防止长文档跨页截断；隐藏侧栏、导航折叠按钮、顶栏、目录、AI/评论/修订/引用/查找浮层及块内交互控件；启用标题防孤行（`break-after: avoid`）、表格跨页重复表头（`thead { display: table-header-group; }`）与表格行/代码块/高亮块/内嵌卡片/提醒/媒体/评论卡片防跨页截断（`break-inside: avoid`）；仅在打印媒体渲染 `[data-doc-print-header]`、`[data-doc-print-comments]` 与 `[data-doc-print-footer]`。

---

## 2. 自动化测试与构建验证

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| Workspace 全量类型检查 | `pnpm typecheck` | PASS（7/7 项目 0 错误） |
| 前端生产构建 | `pnpm --filter @jiange/web build` | PASS（4,077 modules，无报错） |
| `@jiange/doc-sdk` 单元测试 | `pnpm --filter @jiange/doc-sdk test` | PASS（10 个测试文件 / 142 条用例全绿，含 4 条新增深度保真测试） |
| Workspace 全量前端/包单测 | `pnpm test` | PASS（含 `@jiange/web` 246 个测试文件 / 1,356 条用例，含 `doc-print-dialog.test.tsx` 3 条用例） |
| 无头 SDK 打包与 NodeNext 校验 | `pnpm test:sdk:pack` | PASS（5 个无头 SDK + 共享 OOXML 均通过） |
| Go 服务端全量单元测试 | `cd server && go test -count=1 ./...` | PASS（全量包 `ok`） |
| 文件命名规范检查 | `pnpm lint:names` | PASS（kebab-case 检查通过） |

---

## 3. 真实 PostgreSQL 16 + 编译 Go 二进制 + Vite + Headless Chrome CDP 端到端核验

执行脚本：`scripts/verify-docx-print.mjs`（PostgreSQL 16 Docker 容器 + 编译后的 `/tmp/jiange-docx-print-srv` + Vite `127.0.0.1:5174` + Headless Chrome CDP 远程调试，0 控制台错误）：

1. **复合 `.docx` 实时上传导入**：
   - 生成包含富文本表格单元格（加粗/斜体/代码/`#D83931` 红字）、表格内 160×64 PNG 嵌入图、`word/comments.xml` 批注、`word/footnotes.xml` + `word/endnotes.xml`、`<mc:AlternateContent>` 双分支文本框及自定义 `word/header1.xml` + `word/footer1.xml`（含 `PAGE / NUMPAGES`）的 8,861 字节 `.docx` 样本，通过文档「更多 -> 导入 Word」真实文件控件上传。
   - 透明转换提示弹窗准确提示表格图片提取与文本框转高亮块，不再出现批注/脚注/页眉页脚丢弃警告。
   - 页面渲染断言全部通过：表格内 `<strong>核心加粗</strong>`、`<em>灰度斜体</em>`、`<code>v2-index</code>`、`rgb(216, 57, 49)` 红字、提取图片 `/api/files/{id}` 实测 `naturalWidth = 160, naturalHeight = 64`、文本框高亮块仅出现 **1 次**（零重复）、`[注1]` / `[尾注2]` 与文末 `脚注与尾注` 段落完整呈现；打开右侧评论抽屉确认 `[Word 批注 · 周架构 (2026-11-20)] 请补充回滚开关与降级 SLA 指标` 及引用原文已持久化至 PostgreSQL 16。
2. **浏览器真实 `.docx` 再次导出闭环**：
   - 点击「更多 -> 下载为 -> 导出 Word（.docx）」，实时拦截生成的 `.docx` Blob 并解析 ZIP 目录，确认包含 `word/comments.xml`、`word/header1.xml`、`word/footer1.xml` 与 `word/media/image1.png`，且 XML 内完整保留持久化评论正文、页眉文案及 `PAGE` / `NUMPAGES` 页码域。
3. **打印 / 导出 PDF 设置弹窗与真实 Chrome `Page.printToPDF` 输出**：
   - 打开「更多 -> 下载为 -> 导出 PDF（打印）」，确认页眉与页脚开关默认勾选且自动回填导入的 `Q4 架构升级方案 · 内部技术评审` 与 `鉴格云文档 · 架构委员会`（无多余 `/` 残留）。
   - 切换为 `A4` + `横向` + `窄边距` + 勾选 `导出评论附录` 并确认打印，验证动态注入精确规则 `@page { size: A4 landscape; margin: 10mm 10mm; }`。
   - 在 CDP `Emulation.setEmulatedMedia({ media: "print" })` 下确认 `header` 与 `[data-comments-panel]` 均为 `display: none`，`[data-doc-print-header]`、`[data-doc-print-comments]`、`[data-doc-print-footer]` 均为 `display: block`；调用真实 `Page.printToPDF({ preferCSSPageSize: true, printBackground: true })` 生成 **348,884 字节**有效 `%PDF-` 文件。
4. **刷新持久化与响应式核验**：
   - 硬刷新页面后全部富文本表格、附件图片、高亮块、脚注与评论均完整恢复。
   - 桌面端（`1440×900`）与移动端（`390×844`）4 张实拍截图已逐张人工视觉核验，移动端文档正文及打印弹窗均实测 **`0px` 水平溢出**，全程 **0 条控制台报错/未捕获异常**。

---

## 4. 已知边界与后续深化方向

- PDF 导出仍基于客户端精准 `@page` / `@media print` 与浏览器矢量打印引擎（无服务端独立 PDF 排版渲染进程），不支持离线/批量后台生成 PDF。
- 复杂多栏排版节（`w:cols` 混排）、嵌入式 Office 图表/SmartArt、浮动绕排图文与真实 Microsoft Word / WPS 大样本回归语料库校验留作后续持续深化。
