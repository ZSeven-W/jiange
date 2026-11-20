# Jiange 对齐飞书全产品差距盘点（2026-11-18）

## 盘点范围与依据

本清单基于当前仓库（`6e8875a` 及本轮持续推进后的工作区状态），结合已读源码、数据库迁移（`0001`–`0065`）、前后端测试及 2026-11-16 至 2026-11-18 的验证报告整理。延续此前的口径：

- **部分**：已有可运行能力与测试覆盖，但模型、并发安全、功能闭环或真实飞书细节仍有明确缺口。
- **已缺**：源码、路由或持久化模型中明确尚未实现对应产品能力。
- **待核验**：本地仅有模拟视口、合成数据或局部对比，尚缺当前登录态飞书实页、真实 Word/Excel/PPTX 文件或实体移动设备验收。

> 本文只陈述从仓库文件、测试和运行输出直接观察到的现状；不包含未实测的百分比或工期估算。

---

## 一、自 2026-11-16 差距调查以来的新增对齐进展

对比 [2026-11-16 文档差距调查](document-feishu-gap-audit-20261116.md)，截至 2026-11-18 已补充落地以下能力（仍带各自边界）：

- **文档分栏（部分增强）**：新增 2–5 栏数量选择器（`column-count-picker.tsx`）、可逆栏归档与单栏/整组菜单及键盘删除/撤销/重做（`column-archive-commit.ts`）、分栏创建保留原 ID 的条件撤销/重做，见 [分栏创建撤销报告](document-column-create-undo-report-20261117.md) 与 [整组分栏删除报告](document-column-group-delete-report-20261117.md)。
- **文档表格富文本基础（仅内部原型，未接入产品）**：实验性表格 CRDT 新增绑定字符 ID 的文字格式（`packages/collab/src/table-experimental.ts`）、选区格式与撤销计划，以及服务端日志重建与试算准入原型（`server/internal/tableadmission`），见 [准入原型报告](document-table-rich-admission-report-20261117.md)；**尚未接入正式文档或编辑器界面**。
- **标题同步、查找替换与断线取消**：接入标题刷新恢复（`title-auto-sync.ts`）、标题与正文/表格混合替换的条件提交与撤销（`atomic-find-commit.ts`）、以及受复制限制文档断线后仅凭摘要主动取消请求的服务端屏障（迁移 `0064`，需显式开启 `JIANGE_ENABLE_CONDITIONAL_CANCEL=true`），见 [断线恢复报告](document-conditional-cancel-report-20261117.md)。
- **版本管理、提及与双向链接**：已存版本支持分享链接、重命名、删除与回收站管理（迁移 `0059`）；正文 `@` 成员改为随操作原子提交通知并定位到正文位置（迁移 `0060`）；新增按权限过滤的引用/被引用列表、引用隐藏设置（迁移 `0063`）、可缩放交互关系图、以及手动普通链接与引用链接的区分，见 [引用验证报告](document-references-report-20261117.md) 与 [关系图报告](document-reference-graph-report-20261117.md)。
- **链接权限与粘贴识别**：链接权限新增修订号冲突校验（迁移 `0061`）及「当前空间成员」访问范围（迁移 `0062`），支持识别粘贴的普通文档、共享文档与块定位链接，见 [空间链接报告](document-workspace-link-report-20261117.md)。
- **编辑器细节**：修正斜杠命令触发位置与多词英文别名（`apps/web/src/editor/pinyin.ts`）、修复空白文档首屏模板与引用面板遮挡、对齐空格触发的行内 Markdown 快捷输入（含 H4–H6 与 `***`），见 [Markdown 快捷输入报告](document-markdown-shortcuts-report-20261117.md)。
- **画板文档子类型（`docType="board"`，本轮完成）**：原子创建/复制/重命名全链路保留 `docType`（`server/internal/store/doc-type.go`、`postgres-copy.go`、`drive-folder.go`），前端主页、云盘、侧栏、全局搜索、回收站与文档顶栏统一识别 `画板` 独立图标、默认标题（`未命名画板`）、类型筛选及回收站标签，见 [画板子类型报告](board-document-subtype-report-20261118.md)。
- **独立普通电子表格（`kind="sheet"`，2026-11-18 P0 完成）**：新增正式持久化工作簿迁移（`0065_sheets.sql`、`0066_sheet_receipt_retention.sql`）、PostgreSQL/Memory 对等存储、WebSocket 在线光标与修订推送、`#/sheet/{id}` 全页编辑端与跨表公式计算/引用高亮/样式/合并/冻结/筛选排序/多表 `.xlsx` 导入导出，以及主页、云盘、侧栏、全局搜索单元格检索、副本与回收站全链路接入，见 [普通电子表格验证报告](sheet-workbook-report-20261118.md)。
- **企业组织架构、邀请同意与权限继承（2026-11-18 P0 完成）**：新增多级部门树、用户组、成员角色与邀请同意流程（`0067_org_permissions.sql`、`0068_workspace_invitations.sql`、`#/org`），分享弹窗支持按部门（含下级）/用户组授权及「继承上级权限」阻断开关与自锁保护，见 [组织架构与权限继承报告](org-permissions-report-20261118.md)。
- **独立知识库空间（Wiki，2026-11-19 P0 完成）**：新增独立知识库空间与空间级授权表（`0069_wiki_spaces.sql`、`#/wiki`、`#/wiki/{spaceId}`），支持全员可见/私有知识库、按成员/部门/用户组授予 `view`/`edit`/`manage`、多级混合资源树（文档/画板/表格/多维表格/幻灯片/目录分组）、单页权限阻断、跨库子树迁移与云盘迁入，并保持与云盘目录隔离且接入最近访问与全局搜索，见 [知识库空间验证报告](wiki-spaces-report-20261119.md)。

---

## 二、目前仍未对齐飞书的项目清单

### 1. 云文档编辑器（Docs）

| 能力项 | 状态 | 具体差距与代码依据 | 优先级 |
| --- | --- | --- | --- |
| 表格单元格富内容与正式 CRDT | **已落地（P0 Slice 5，2026-11-19）** | 已接入服务端正式 CRDT 表格批次准入（`tableadmission.RebuildOrInit` + `PrepareBatch` 接入 `/api/docs/{id}/conditional-ops`），并落地单元格行内多样式富文本（加粗/斜体/下划线/删除线/行内代码/文字颜色、整格与字符子区间切换、`tbl.fmt.<r>.<c>` 逐格独立属性），打通编辑器工具栏/快捷键、只读与公开分享页、剪贴板 HTML 往返、DOCX `<w:rPr>` 与 Markdown 导出（详见 [document-table-rich-report-20261119.md](document-table-rich-report-20261119.md)）；表格内嵌块级图片/附件/公式留作后续 P1 增强。 | **已完成（P0）** |
| 分栏容器与末栏处理 | **已落地（P0 Slice 4，2026-11-19）** | 已支持分栏内混排多块内容（段落/标题/列表/待办/引用/高亮块/代码块/分割线）、服务端 10 栏上限与条件加栏/移栏/取消分栏（前序提升所有嵌套子块）、仅剩 1 栏时安全归档整组，以及 DOCX 无边框多列表格导出（详见 [document-columns-multiblock-report-20261119.md](document-columns-multiblock-report-20261119.md)）。 | **已完成** |
| 协同 GC、离线与升级门禁 | **已落地核心闭环（P0 Slice 6，2026-11-19）** | 已落地 Go/TS 对等的客户端参与安全墓碑回收屏障（`CompactAtBarrier` + `room.CompactSnapshotAtSafeHorizon`，含全员 Horizon 检查与超窗离线无损 `repairFromLog` 兜底），以及基于 `localStorage` 心跳租约与持久化 `v2` 键的跨标签页关闭/崩溃待确认操作与标题同步恢复（详见 [collab-gc-recovery-report-20261119.md](collab-gc-recovery-report-20261119.md)）；`JIANGE_ENABLE_CONDITIONAL_CANCEL` 跨实例自动排空编排留作后续 P1 运维增强。 | **已完成（P0）** |
| 修订模式（建议与审阅） | **已落地（P1 Slice 1，2026-11-19）** | 已落地 `0071_doc_suggestions.sql`、`SuggestionStore`（PG/Memory 对等）、修订建议全套 API（发起/改批注/单条与批量接受拒绝/发起人撤回）、顶栏「编辑 / 建议 / 阅读」三态切换与右侧「修订建议」审阅抽屉，接受后通过 CRDT 原子写入正文并持久化（详见 [document-suggestions-report-20261119.md](document-suggestions-report-20261119.md)）。 | **已完成（P1）** |
| 跨文档同步块与子页面列表 | **已落地（P1 Slice 2，2026-11-19）** | 已落地 `0072_synced_blocks.sql`、`SyncedBlockStore`（PG/Memory 对等 + 乐观锁 `revision`）、同步块权限校验 API、按阅读权限动态过滤的 `GET /api/docs/{id}/subpages`、`/` 斜杠命令（`同步块` / `子页面列表`）及跨文档关联编辑与只读视图渲染（详见 [document-synced-subpages-report-20261119.md](document-synced-subpages-report-20261119.md)）。 | **已完成（P1）** |
| `/` 斜杠命令与段落拆段 | **已落地真实内嵌资源块、日期提醒、H7–H9 与安全拆段（P1 Slice 10，2026-11-19）** | 已将 `/` 斜杠命令扩展至 34 项（`apps/web/src/editor/pinyin.ts`），新增文档内嵌真实资源块（电子表格/多维表格/问卷/幻灯片卡片，`embed-block.tsx`，支持资源选择器与链接粘贴、实时数据预览及无权限资源的只读锁卡隔离）、交互式日期提醒块（`reminder-block.tsx`，含完成勾选、相对状态角标、时间与快捷预设及防抖持久化）、H7–H9 标题全链路支持（编辑器/大纲/Markdown/DOCX `Heading7`–`Heading9`/只读页/检索与服务端文本块白名单），以及本地段落中间插入块（同步表格/提醒/内嵌与异步附件/图片/公式/图表）的安全无损拆段与并发远端改写保护（`insertBlockAtSlashOffset` / `insertSlashBlock` / `validateUploadCommand`，详见 [document-slash-embeds-comments-report-20261119.md](document-slash-embeds-comments-report-20261119.md)）；群名片、投票、日程与第三方外部 iframe 嵌入留作后续深化。 | **部分（P1 核心闭环）** |
| 评论、提及与通知闭环 | **已落地跨段落划词评论闭环（P1 Slice 10，2026-11-19）** | 已打通跨段落划词选区锚点编码（`endChar: "<endBlockId>|<endCharId>"`，无需数据库迁移且兼容既有单段与画板评论）、正反向多段选区评论创建、跨越连续多段正文的一致高亮投影与首段单角标聚合、跨段落引用徽标与嵌套回复持久化，以及编辑器/只读视图与 `commentMinRole` 服务端权限联动（详见 [document-slash-embeds-comments-report-20261119.md](document-slash-embeds-comments-report-20261119.md)）；跨分栏选区评论、匿名公开评论、被替换后撤销恢复的旧字符 ID 高亮找回及多端离线提及推送留作后续深化。 | **部分（P1 核心闭环）** |
| 双向链接完整形态 | **已落地持久化索引、全类型资源引用与多跳图谱（P1 Slice 12，2026-11-20）** | 已落地持久化增量引用索引表（`0079_doc_reference_index.sql`：`doc_reference_index_state` + `doc_reference_edges`，PG/Memory 对等 `ReferenceIndexStore`，按精确版本戳命中热缓存零 CRDT 重放并将上限由 200 提升至 2,000，受限多维表格视图实时按权限计算不污染共享索引）、全类型资源双向引用覆盖（云文档/画板正文与 `embed` 内嵌块、电子表格、多维表格、幻灯片与问卷，`@` 提及与粘贴链接全类型解析，并在非文档资源顶栏提供双向链接抽屉），以及逐跳权限隔离的 1–3 跳交互式多跳关系图（`GET /api/docs/{id}/reference-graph?depth=1..3`、`1 跳/2 跳/3 跳` 切换、六色资源图标、内嵌虚线边与私密中间节点防穿透隔离，详见 [document-reference-index-graph-report-20261120.md](document-reference-index-graph-report-20261120.md)）；历史未标记旧普通链接区分、匿名公开页/历史版本引用展示及 2,000+ 节点后台异步预热留作后续深化。 | **部分（P1 核心闭环）** |
| 导入导出与打印 | **已落地 `.docx` 深度保真与精细化打印/PDF 闭环（P1 Slice 13，2026-11-20）** | 已在 `@jiange/doc-sdk/docx` 与云文档编辑器打通 `.docx` 表格单元格内联富文本双向保真（粗体/斜体/下划线/删除线/行内代码/文字颜色）、表格内嵌入图片提取上传与独立图片块渲染、原生 Word 批注（`word/comments.xml` 含回复与解决态）双向导入导出、脚注/尾注（`word/footnotes.xml`、`word/endnotes.xml`）内联标记与文末汇总、`<mc:AlternateContent>` 文本框去重转高亮块、页眉/页脚（`word/header1.xml`、`word/footer1.xml` 含动态 `PAGE`/`NUMPAGES` 页码域）提取与打印同步，以及云文档打印/导出 PDF 设置弹窗（`DocPrintDialog`，支持 A4/Letter、纵横向、三档页边距动态 `@page` 注入、自定义页眉页脚、评论附录与实时纸张预览）和长文档多页展开/防孤行/跨页表头重复打印排版（详见 [document-docx-print-report-20261120.md](document-docx-print-report-20261120.md)）；服务端无头原生 PDF 渲染引擎、复杂多栏节/SmartArt 图表及真实 Word/WPS 大样本语料库核验留作后续深化。 | **部分（P1 核心闭环）** |
| 查找替换边界 | **已落地公式安全替换、结构化表格历史联动与刷新后撤销恢复（P1 Slice 14，2026-11-20）** | 已为云文档查找替换补充 `Aa 区分大小写` 与 `Σ 包含公式`（默认关闭防止误改 LaTeX，开启后支持块级公式 `type === "math"` 与行内公式 `marks.math` 的安全查找、源码高亮定位与原子替换/撤销），打通 `TableStructureHistory` 与单格/批量/含标题查找替换的双向别名重基（增删行列与全部替换交错撤销/重做零误报冲突），并在 `@jiange/collab` `UndoManager` 与编辑器落地按账号/文档/历史纪元隔离、遵守防复制策略的 `sessionStorage` 刷新后本地撤销/重做恢复（覆盖正文、公式、表格单元格、表格结构与批量替换，详见 [document-find-replace-undo-report-20261120.md](document-find-replace-undo-report-20261120.md)）；跨请求条件日志类标题原子替换的刷新后撤销与正则替换留作后续按需扩展。 | **已完成（P1）** |

### 2. 主页、云盘、全局搜索与知识库（Home / Drive / Search / Wiki）

| 能力项 | 状态 | 具体差距与代码依据 | 优先级 |
| --- | --- | --- | --- |
| 独立知识库空间（Wiki） | **已落地（P1 Slice 11，2026-11-20）** | 已落地独立知识库空间（`0069_wiki_spaces.sql`、`#/wiki`、`#/wiki/{spaceId}`）、空间级成员/部门/用户组授权、多级混合资源目录树、单页继承阻断、跨库子树迁移与云盘迁入（见 [知识库空间验证报告](wiki-spaces-report-20261119.md)），并完成目录树三区拖拽排序与「上移/下移」（`POST /api/wiki/spaces/{spaceId}/nodes/{id}/reorder`，含乐观锁、跨父权限校验、循环拦截与 `sort_key` 自动重平衡）以及跨库/云盘快捷方式引用闭环（`0078_wiki_shortcuts.sql`、`POST/DELETE /api/wiki/spaces/{spaceId}/shortcuts`，含弹窗选择、来源徽章、平滑跨库跳转及无权限目标的零元数据泄露实时锁定脱敏，详见 [wiki-tree-shortcuts-report-20261120.md](wiki-tree-shortcuts-report-20261120.md)）；移动端真机触控拖拽手势与快捷方式和普通页面混排拖拽留作后续深化。 | **已完成（P1）** |
| 企业组织、部门与群组权限 | **部分（P0 已闭环）** | 已落地多级部门、用户组、成员角色与邀请同意机制（`0067`–`0068`、`#/org`）、按部门/用户组授权及「继承上级权限」开关（见 [组织架构与权限继承报告](org-permissions-report-20261118.md)）；大空间列表权限计算性能优化与外部组织目录同步仍待后续深化。 | **P1** |
| 主页视图与交互细节 | **已落地核心闭环（P1 Slice 5，2026-11-19）** | 已落地主页独立可折叠「置顶文档」卡片区（`data-home-pins`）、列表与卡片视图批量勾选及账号绑定批量收藏/置顶/删除工具栏（`data-home-batch`），并打通多维表格（多表/关联/附件/共享视图完整克隆 + 权限视图 403 保护）与问卷在主页、云盘及多维表格页内创建副本（详见 [home-drive-closure-report-20261119.md](home-drive-closure-report-20261119.md)）；卡片正文内容实时缩略图留作后续视觉增强。 | **已完成（P1）** |
| 云盘操作闭环 | **已落地核心闭环（P1 Slice 5，2026-11-19）** | 已落地持久化快捷方式（`0075_drive_shortcuts.sql`、`GET/POST/DELETE /api/drive/shortcuts` 实时权限复验 + 顶部「添加」弹窗与目录卡片）、全类型文档「复制到指定目录」（`CopyToDialog` + `CopyDoc`/`CopyBase`/`CopySurvey` 目录门禁修复）、文件/文件夹拖拽移入文件夹卡片与面包屑，以及网格视图卡片批量勾选与共用批量操作栏（详见 [home-drive-closure-report-20261119.md](home-drive-closure-report-20261119.md)）；孤儿附件定时巡检 GC 留作后续运维增强。 | **已完成（P1）** |
| 全局搜索索引与筛选 | **已落地核心闭环（P1 Slice 4，2026-11-19）** | 已落地持久化索引表 `0074_search_index.sql`（`doc_search_index` + PG/Memory 对等 `SearchIndexStore`，按 `source_epoch`/`source_seq`/`source_stamp` 增量刷新，命中时零 CRDT 重放）、多维表格（含锁定视图权限隔离）/幻灯片（含备注与图形文本）/问卷深层检索，以及按所在目录（含多级子目录）、类型、所有者与精确更新日期范围的服务端与前端高级筛选（详见 [search-index-report-20261119.md](search-index-report-20261119.md)）；写入侧后台异步预热、创建时间筛选及附件正文提取留作后续增强。 | **已完成（P1）** |

### 3. 独立普通电子表格（Sheet）

| 能力项 | 状态 | 具体差距与代码依据 | 优先级 |
| --- | --- | --- | --- |
| 正式工作簿、多工作表、公式与协同基座 | **部分（P0 已闭环）** | 已落地 `kind='sheet'` 持久化工作簿（`0065_sheets.sql`、`server/internal/store/sheets*.go`、`internal/sheetsync/`、`#/sheet/{id}`），打通多工作表增删改排、跨表公式计算与 `#ff8800` 高亮、单元格基础格式/合并/冻结/筛选排序、WebSocket 光标与修订同步、多表 `.xlsx` 读写及全站检索副本闭环（见 [普通电子表格验证报告](sheet-workbook-report-20261118.md)）；高并发同格合并与区域级精细协同冲突消解仍待继续深化。 | **P1** |
| 高级表格分析与 `.xlsx` 样式保真 | **已落地核心分析与管控（P1 Slice 6，2026-11-19）** | 已落地单元格数据验证（下拉选项行内选择器/数字范围/日期范围，支持严格拦截 `422` 与警告模式）、动态条件格式（10 类运算符 + 5 套预设样式，基于公式求值结果实时变色）、管理员专属受保护单元格区域（含协作者白名单及服务端写格/删行列 `403` 强制校验）、绑定持久化行列 ID 的单元格锚点评论（`0076_sheet_rules_and_comments.sql`，抗插行位移/删行级联清理、橘色角标、解决/重开、`commentMinRole` 权限联动与 WebSocket 实时刷新）及工作簿副本规则克隆（详见 [sheet-advanced-report-20261119.md](sheet-advanced-report-20261119.md)）；嵌入式图表、数据透视表、`.xlsx` 列宽/行高/主题色/渐变/复杂边框与规则保真，以及 `pg_trgm` 单元格子串索引留作后续深化。 | **部分（P1 核心闭环）** |

### 4. 多维表格（Base）与独立问卷（Form / Questionnaire）

| 能力项 | 状态 | 具体差距与代码依据 | 优先级 |
| --- | --- | --- | --- |
| 单 Base 多数据表闭环 | **已落地（P0 Slice 3，2026-11-19）** | 已落地 `0070_base_multi_table_and_views.sql`、`bt_tables` 完整 CRUD/排序/默认表保护、按表隔离的字段/记录/视图/筛选/导出与同 Base 跨表双向关联（详见 [base-multitable-views-report-20261119.md](base-multitable-views-report-20261119.md)）。 | **已完成** |
| 高级权限 vs 视图配置锁定 | **已落地核心解耦（P0 Slice 3，2026-11-19）** | 已将飞书「锁定视图配置」（`configLocked`，仅限管理员改视图配置且不阻塞协作者读写数据）与「个人视图」（`bt_views.owner_id`，仅本人可见与编辑）同「权限视图」（`locked` 行/列数据限制）彻底解耦；按角色/字段的细粒度高级权限矩阵与界面插件留作后续 P1 增强。 | **已完成（P0）** |
| 视图、公式与批量操作细节 | **已落地仪表盘与原子批量撤销核心闭环（P1 Slice 7，2026-11-19）** | 已落地持久化多仪表盘与 6 类可配置图表（`0077_base_dashboards.sql`、`bt_dashboards`、指标卡/柱状图/条形图/环形饼图/日期趋势折线图/汇总表，含排序/宽窄布局持久化、副本字段 ID 重映射与权限投影隔离）、服务端单事务原子批量删除/恢复/条件更新（`batch-delete`/`batch-restore`/`batch-update`）、桌面与移动端批量勾选操作栏，以及覆盖单条/批量记录删除恢复与多行单元格改写的撤销/重做闭环（详见 [base-dashboard-batch-report-20261119.md](base-dashboard-batch-report-20261119.md)）；字段/视图结构级撤销、分组视图拖选、日历小时排程与甘特真实拖拽仍待后续完善。 | **部分（P1 核心闭环）** |
| 独立问卷产品 | **已落地（P1 Slice 3，2026-11-19）** | 已落地独立 `kind="survey"` 节点迁移（`0073_surveys.sql`）、PG/Memory 对等 `SurveyStore`、全站新建入口与筛选、7 类富题型（单选/多选/简答/评分/矩阵量表/排序/手写电子签名）、前后端一致的跳题逻辑、发布/停止收集/匿名/上限控制、`#/q/{token}` 公开填写页，以及可视化结果统计与 CSV 导出（详见 [survey-product-report-20261119.md](survey-product-report-20261119.md)）。 | **已完成（P1）** |

### 5. 幻灯片、画板/流程图/思维导图与智能纪要

| 能力项 | 状态 | 具体差距与代码依据 | 优先级 |
| --- | --- | --- | --- |
| 幻灯片（Slides） | **已落地多人协同、页面结构撤销与 `.pptx` 闭环（P1 Slice 8，2026-11-19）** | 已落地 WebSocket 多人实时在线协作者头像、缩略图当前页位置角标、变更即时广播与定时权限复验（`server/internal/slidessync/`、`GET /api/slides/{id}/ws`），基于 `@jiange/ooxml` 的无头 16:9 标准 OOXML `.pptx` 双向导入导出与打印/PDF 视图（`@jiange/slides-sdk/pptx`、`POST /api/slides/{id}/import-pptx`，支持幻灯片顺序、纯色背景与深色自适应反色、隐藏页、布局、18 类图形/连接线/文本框、旋转与演讲者备注，导出/打印遵守下载权限策略），以及覆盖删页原子恢复（`POST /api/slides/{id}/pages/restore`）、新建/复制、排序与隐藏切换的页面结构级撤销/重做闭环（详见 [slides-collab-pptx-report-20261119.md](slides-collab-pptx-report-20261119.md)）；真正母版继承与图片占位符、图表/音视频/动画、图片渐变背景与裁剪、导入嵌入图片/SmartArt 及真实 PowerPoint 大样本核验留作后续深化。 | **部分（P1 核心闭环）** |
| 画板、流程图与思维导图 | **已落地画板锚点评论、多选等比缩放与 `.xmind` 闭环（P1 Slice 9，2026-11-19）** | 已落地基于 `@jiange/whiteboard-sdk` 的画板对象与坐标锚点评论（`fc:n:<id>` 图形锚点、`fc:m:<id>` 导图主题锚点、`fc:p:<x>,<y>` 自由画布图钉，复用受权限保护的文档评论持久层，支持画板内评论图钉工具、移动/缩放动态跟随、行内回复与解决，及删对象后坐标兜底）、混合多选图形与自由笔迹的统一外框等比缩放（`selectionBounds` + `scaleSelectionProportionally`，单步撤销完整还原），以及基于 `@jiange/ooxml` 的无头标准 `.xmind` 双向导入导出（`@jiange/whiteboard-sdk/xmind`，支持现代 XMind ZEN `content.json` 与旧版 XMind 8 `content.xml` 导入及多画布/描述/折叠/样式/格式导出，详见 [whiteboard-mindmap-report-20261119.md](whiteboard-mindmap-report-20261119.md)）；独立画板存储模型、在途协作竞态保护、导图局部字符级富文本描述、节点附件与结构条件提交留作后续深化。 | **部分（P1 核心闭环）** |
| 智能纪要（Minutes） | **已缺** | 无独立纪要资源模型、音视频上传/播控、说话人时间戳逐字稿编辑器，以及可配置真实 ASR/摘要服务的持久化异步任务与失败恢复链路。 | **P2** |
| 思维笔记（Mind Notes） | **已缺** | 主页/云盘与文档模型均无飞书「思维笔记」（大纲笔记与导图一键双向切换）产品形态。 | **P2** |

### 6. 移动端真机、输入法与逐像素对照（待核验）

| 方面 | 状态 | 依据与差距 |
| --- | --- | --- |
| 真实移动设备与中文 IME | **待核验** | 既有验证报告与本轮验证均以 macOS Chrome `390×844` / `320×690` 模拟视口为主，缺少 iOS Safari / Android Chrome 真机触控、虚拟键盘遮挡、系统剪贴板与真实中文输入法组合输入验证。 |
| 实时飞书全页面逐像素对照 | **待核验** | 本次未接入已登录飞书客户端进行实时逐屏测量；各组件色值、图标细节、空状态、悬停工具栏和响应式断点仍需按飞书最新页面逐屏校准。 |
