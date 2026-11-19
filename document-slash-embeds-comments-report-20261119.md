# 云文档 `/` 斜杠命令扩展（真实内嵌资源块、日期提醒、H7–H9 与安全拆段）与跨段落划词评论验证报告（2026-11-19）

## 1. 交付范围（P1 Slice 10）

本轮针对 [feishu-gap-audit-20261118.md](feishu-gap-audit-20261118.md)「云文档编辑器（Docs）」中的 `/` 斜杠命令扩展、段落中间安全拆段、H7–H9 标题与跨段落划词评论四项核心差距落地完整闭环：

1. **H7–H9 标题全链路支持（`h7` / `h8` / `h9`）**
   - `packages/doc-sdk/src/model.ts`、`markdown.ts`、`docx.ts`：补齐 `####### ` / `######## ` / `######### ` Markdown 快捷输入、Markdown 导入导出双向往返与标准 OOXML `Heading7`–`Heading9`（`outlineLvl` 6–8）导入导出。
   - 前端编辑器与只读/大纲视图：`apps/web/src/editor/pinyin.ts`、`menu-icons.tsx`、`block-handle.tsx`、`format-toolbar.tsx`、`find-replace.ts`、`editor.tsx`，以及 `apps/web/src/pages/outline-panel.tsx`、`read-only-doc.tsx`（`role="heading" aria-level={7..9}`）、`doc-info-stats.ts`、`markdown-export.ts`、`suggestion-panel.tsx`、`doc-page.tsx`。
   - Go 服务端白名单同步：`server/collab/mention.go`、`server/internal/api/document-references.go`、`server/internal/api/conditional-ops.go`。

2. **真实内嵌资源块（`embed`）与交互式日期提醒（`reminder`）**
   - `apps/web/src/editor/pinyin.ts` 将 `/` 斜杠命令扩展至 34 项，新增 `日期提醒`（`reminder`）、`嵌入电子表格`（`embed-sheet`）、`嵌入多维表格`（`embed-base`）、`嵌入问卷`（`embed-survey`）、`嵌入幻灯片`（`embed-slides`）及 `七/八/九级标题`。
   - `apps/web/src/editor/embed-block.tsx`：提供块内资源选择器（按资源类型标签筛选、关键词搜索及直接粘贴 `#/sheet|base|survey|slides/{id}` 链接），绑定后按当前登录会话调用真实 API 渲染实时预览卡片：
     - **电子表格**：多工作表切换与前 6×6 单元格表格预览；
     - **多维表格**：数据表/字段/记录计数，优先预览非空业务记录（跳过新建默认空行）；
     - **问卷**：草稿/收集中/已停止状态、题数/答卷数、题目列表与已发布问卷「前往填写」直达入口；
     - **幻灯片**：页数与 16:9 缩略卡片预览；
     - **权限隔离**：无权访问或已删除资源（服务端返回 `403`/`404`）展示统一锁卡，不泄露任何私有内容。
   - `apps/web/src/editor/reminder-block.tsx`：提供日期提醒卡片（完成复选框、动态相对状态角标 `今天`/`明天`/`N 天后`/`今日已过时`/`已过期 N 天`/`已完成`、250ms 防抖与失焦/回车持久化标题输入、日期/时间选择器及 `今天`/`明天`/`下周` 快捷预设）。
   - 服务端只读投影与全局搜索：`server/internal/api/public-common-block.go` 对 `embed`（白名单 `resourceKind` + 正整数 `resourceId` + `title`）和 `reminder`（`date`/`time`/`label`/`done`）执行安全属性净化并剥离残余文本 span；`server/internal/api/search-favorites.go` 将嵌入标题与日期提醒文本纳入全文检索；`embed`/`reminder` 同步接入整块复制与整块评论锚点（`CLIPPABLE_BLOCKS` / `COMMENTABLE_BLOCKS`）。

3. **段落中间安全拆段（同步块 & 异步对话框/上传）**
   - `apps/web/src/editor/slash-insert.ts` 新增 `insertBlockAtSlashOffset`（供表格、分割线、日期提醒、嵌入资源、同步块、子页面列表、流程图、分栏等同步斜杠命令在段中插入时安全拆分前后文并保留行内格式与公式原子 `mathId`）。
   - `captureSlashInsertion` 新增 `tailIds` 捕获；`insertSlashBlock` 与 `apps/web/src/editor/upload-insert.ts` 中的 `validateUploadCommand` 在确认命令后半段字符 ID 未被远端协作者并发修改时安全拆分段落并支持无损撤销；若异步弹窗/上传期间远端协作者并发改写两侧正文，仍安全返回 `"middle"` 拒绝拆分以防重排他人文本。

4. **跨段落划词评论闭环**
   - `apps/web/src/editor/comment-anchor.ts` 扩展 `commentSelection` 与 `projectCommentAnchors`：在无需数据库迁移的前提下，以 `block: "<startBlockId>"`、`startChar: "<startCharId>"`、`endChar: "<endBlockId>|<endCharId>"`（长度远低于服务端 64 字符限制）持久化跨段落选区锚点，保持与单段及画板坐标锚点 100% 兼容。
   - 支持正反向跨多段选区创建（跨分栏选区仍安全拒绝）、连续多段内每个跨越正文块均精确渲染 `[data-comment-anchor]` 高亮、仅在首段渲染单一 `[data-comment-bubble]` 计数角标避免多行堆叠、任意端点字符删除后跨段投影统一失效防错位，并在 `apps/web/src/pages/comments-panel.tsx` 中展示「跨段落」标识、多行引用摘要与防折行回复按钮。

---

## 2. 自动化与实库验证结果

### 2.1 后端单元测试与 PostgreSQL 16 `-race` 集成测试
- 全量 Go 单元测试：`cd server && go test -count=1 ./...` —— **17 个测试包全部通过**。
- 真实 PostgreSQL 16（`postgres:16-alpine`，独立临时 schema）竞态集成测试：
  - `JIANGE_TEST_DATABASE_URL=... go test -race -count=1 -v ./internal/api -run "TestDocCrossCommentPostgres|TestPublicCommonBlockAndSearchEmbedReminderH7H9"` —— **PASS**（验证跨段落锚点 `1:12|1:42` 创建/回复/列表/`commentMinRole=edit` 403 拦截/解决，以及 `embed`/`reminder`/`h7`–`h9` 的只读属性净化、条件操作与检索文本提取）。
  - `JIANGE_TEST_DATABASE_URL=... go test -race -count=1 ./internal/migrate` —— **PASS**。

### 2.2 前端类型检查、构建、单元测试与 SDK 打包检查
- `pnpm typecheck` —— **PASS**（全工作区 7 个工程零错误）。
- `pnpm --filter @jiange/web build` —— **PASS**（Vite 生产构建通过）。
- `pnpm test` —— **PASS**（`@jiange/web` **244 个测试文件 / 1,346 条用例** + 全部无头 SDK 与 `@jiange/doc-sdk` 测试全部通过）。
- `pnpm test:sdk:pack` —— **PASS**（5 个打包无头 SDK 与 `@jiange/ooxml` 通过 Node ESM 与 NodeNext 校验）。
- `pnpm lint:names` —— **PASS**（全部跟踪路径符合 kebab-case 规范）。

### 2.3 真实 PostgreSQL 16 + 编译态 Go 服务 + Vite + Headless Chrome CDP 端到端验证
运行脚本：[scripts/verify-doc-slash-comments.mjs](scripts/verify-doc-slash-comments.mjs)（真实 `postgres:16-alpine` + 编译态 Go 二进制 + Vite `:5174` + Headless Chrome CDP `:9238`）：

- **H7 标题与目录联动**：输入 `####### ` 触发 H7 快捷转换，正文与左侧「目录」面板同步展示 `七级标题：斜杠命令与资源内嵌规范`。
- **段中安全拆段 + 日期提醒**：在 `前半句内容 后半句内容` 中间输入 `/日期提醒` 选中插入，段落无损拆分为 `前半句内容 ` → 日期提醒块 → `后半句内容`，设置标题 `提交发布评审报告` 与时间 `16:30` 并自动持久化。
- **真实内嵌资源预览**：通过 `/` 斜杠菜单分别插入并绑定实库中的电子表格（`Q4 运营预算表`，实时展示 3×3 预算明细与单元格计数）、多维表格（`产品需求排期库`，实时展示非空业务记录 `跨段落划词评论闭环`）、已发布问卷（`2026 用户满意度调研`，展示 `收集中`、2 道题目与 `前往填写` 按钮）以及私有电子表格（`机密薪酬测算表`）。
- **跨三段划词评论与持久化**：选中跨越 3 个连续段落的正文并点击浮动工具栏「评论」，成功提交并展示 `跨段落` 徽标与嵌套回复；页面整页刷新（`Page.reload`）后，H7 标题、拆分段落与日期提醒、全部内嵌实时预览及跨 3 段高亮（`anchorCount: 3`, `blockCount: 3`, `bubbles: 1`）完整还原。
- **跨用户权限隔离**：切换至仅获分享文档及公开资源的只读审阅者（`周审阅`）整页重载后，共享资源与跨三段高亮正常展示，未分享的私有表格（`机密薪酬测算表`）触发服务端 `404` 并在卡片内呈现「无权查看该电子表格或资源已删除」锁卡，零私有数据泄露。
- **视觉截图人工核验（桌面 `1440×900` & 移动端 `390×844`）**：
  - 人工逐张检查 4 张 CDP 截图（内嵌资源与提醒桌面视图、跨三段评论与右侧抽屉桌面视图、只读审阅者私有表格隔离视图、`390×844` 移动端视图），排版清晰、无重叠裁切；
  - 移动端 `390×844` 实测 `scrollWidth: 390, clientWidth: 390`（`0px` 水平溢出）；
  - 除刻意测试未授权私有表格触发的预期 `404` 响应外，**0 条未预期控制台错误或运行异常**。

---

## 3. 已知边界与后续项

- **斜杠扩展生态**：群名片、投票、日程与第三方外部 iframe 嵌入尚未纳入本轮，留作后续扩展。
- **评论边界**：跨分栏单元格选区评论、匿名公开分享页评论、被替换后经撤销恢复的旧字符 ID 高亮找回及多端离线提及推送仍待后续补齐。
- **真实移动真机与 IME**：本轮移动端核验基于 macOS Headless Chrome `390×844` 模拟视口，iOS Safari / Android Chrome 真机触控与系统中文输入法组合态仍待真机实测。
