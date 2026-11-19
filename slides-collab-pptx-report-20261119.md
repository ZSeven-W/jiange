# 幻灯片多人实时协同、页面结构撤销与 OOXML `.pptx` 导入导出闭环验证报告（2026-11-19）

本轮推进 **P1 Slice 8（幻灯片多人实时协同、页面结构级撤销与标准 `.pptx` 导入导出闭环）**，系统性补齐 `feishu-gap-audit-20261118.md` 中幻灯片（Slides）核心差距：基于 WebSocket 的在线协作者头像/当前页角标与变更即时推送、基于 `@jiange/ooxml` 的无头 16:9 标准 PresentationML `.pptx` 双向导入导出与打印/PDF 视图，以及覆盖删页原子恢复、新建/复制、排序与隐藏状态切换的页面结构级撤销/重做闭环。

## 主要改动

### 1. 服务端实时协同 Hub、原子导入与删页恢复（PostgreSQL + Memory 对等）

- [slidessync.go](server/internal/slidessync/slidessync.go) & [slidessync_test.go](server/internal/slidessync/slidessync_test.go)：
  - 实现幻灯片房间级 WebSocket Hub（`GET /api/slides/{id}/ws`）：实时广播按 `UserID` 稳定排序的在线协作者列表及当前查看页 `pageId`（`presence`）、在每次幻灯片变更后广播递增修订信号（`revision` + `actorId`），并按固定周期（默认 2 秒）复验会话与文档阅读权限，撤权后主动返回 `StatusPolicyViolation (1008)` 断开连接并在全员离线后回收房间。
- [slides-import.go (store)](server/internal/store/slides-import.go) & [slides-import.go (api)](server/internal/api/slides-import.go)：
  - 新增 `SlidesDeckImportStore`（合入 [store.go](server/internal/store/store.go)）与 PostgreSQL / Memory 双引擎对等实现：
    - `POST /api/slides/{id}/import-pptx`（`ReplaceSlidesDeckGuarded`）：单事务校验写权限与 `X-Jiange-User-Id` 账号绑定、全量图形合法性（`validSlideShapes`）与 1–100 页上限，原子替换演示文稿全部页面并推送 `SlidesHub.Notify`。
    - `POST /api/slides/{id}/pages/restore`（`RestoreSlidesPageGuarded`）：单事务在原索引 `targetIndex` 处原子恢复已删除页面（完整保留标题、正文、背景、布局、备注、隐藏状态与全部图形）并重新规整位置 `1..N`。
- [api.go](server/internal/api/api.go)、[main.go](server/cmd/jiange/main.go) 与全部既有幻灯片变更处理器（`slides.go`、`slides-insert-page.go`、`slides-delete-page.go`、`slides-duplicate-page.go`、`slides-order.go`、`slides-paste.go`、`slides-cross-paste.go`、`slides-visibility.go`、`slides-background.go`、`slides-title.go`）：接入 `SlidesHub` 并在写操作成功后即时调用 `s.notifySlides(...)`。

### 2. 无头 OOXML `.pptx` 读写 SDK（`@jiange/slides-sdk/pptx`）

- [pptx.ts](packages/slides-sdk/src/pptx.ts)、[pptx.test.ts](packages/slides-sdk/test/pptx.test.ts)、[package.json](packages/slides-sdk/package.json)、[index.ts](packages/slides-sdk/src/index.ts)、[verify-headless-sdks.mjs](scripts/verify-headless-sdks.mjs)：
  - 基于共享 `@jiange/ooxml`（零 DOM 依赖）实现 `exportSlidesToPptx` 与 `parsePptxToSlides`：
    - **导出**：生成标准 16:9 PresentationML `.pptx`（`12192000 × 6858000` EMU），含 `[Content_Types].xml`、`_rels/.rels`、`docProps/core.xml`、`ppt/presentation.xml`、母版/版式/主题、逐页 `slideN.xml` 及演讲者备注 `notesSlideN.xml`；保留页面顺序、纯色背景（深色背景自动切换亮色标题/正文）、`show="0"` 隐藏标记、4 种布局占位符及全部 18 类基础图形/连接线箭头/文本框（百分比与 EMU 换算、旋转角度 `rot`、字号/粗体/对齐/颜色）。
    - **导入**：校验 ZIP 与 XML 边界、按 `<p:sldIdLst>` 顺序解析页面、按实际 `<p:sldSz>` 动态归一坐标至合法区间（兼容 16:9 与 4:3 外来文件并严格满足服务端 `validSlideShapes` 约束）、还原布局/背景/隐藏标记/连接线/图形/文本框/演讲者备注，对跳过的嵌入图片或图表给出明确中文提示；损坏或非 `.pptx` 文件抛出 `PptxError`。

### 3. 前端协同展示、页面结构撤销与导入/导出/打印闭环

- [vite.config.ts](apps/web/vite.config.ts) & [api.ts](apps/web/src/lib/api.ts)：新增 `/api/slides` WebSocket 开发代理及 `slidesApi.importPptx` / `slidesApi.restorePage`。
- [slides-structure-history.ts](apps/web/src/pages/slides-structure-history.ts) & [slides-structure-history.test.ts](apps/web/src/pages/slides-structure-history.test.ts)：实现上限 50 步的演示文稿结构操作历史栈，支持删除页恢复、新建/复制页撤销与重做、页面排序撤销与隐藏状态切换撤销。
- [slides-page.tsx](apps/web/src/pages/slides-page.tsx)、[slides-presenter.tsx](apps/web/src/pages/slides-presenter.tsx)、[slides-presenter.test.tsx](apps/web/src/pages/slides-presenter.test.tsx)、[index.css](apps/web/src/index.css)：
  - 接入 `/api/slides/{id}/ws`：顶栏展示在线协作者头像（点击可跳转至协作者当前页），左侧缩略图左下角展示协作者所在页彩色角标（移动端自动收紧为单字徽标防遮挡），收到 `revision` 推送后即时刷新页面与元数据。
  - 将结构历史栈与既有单页内容撤销、批量背景撤销按操作时序统一接入工具栏撤销/重做按钮（`data-slides-undo` / `data-slides-redo`）及 `⌘/Ctrl+Z` / `⌘/Ctrl+Shift+Z` 快捷键（即使删除最后一张幻灯片后仍可撤销恢复）。
  - 顶栏新增「导入/导出」菜单（`导入 PPTX` 带解析预览与覆盖确认弹窗、`导出 PPTX`、`打印 / 导出 PDF`），导出与打印严格遵守 `canDownloadDocument` 下载权限与 `data-document-print-restricted` 保护；新增深色背景自适应亮色文字反色与 `@media print` 逐页 16:9 打印样式。

## 测试结果

1. **Go 全量与隔离 PostgreSQL 16 `-race` 集成测试**：
   - `cd server && go test -count=1 ./...`：全部 17 个 Go 包无缓存通过。
   - 隔离 `postgres:16-alpine` 容器运行 `-race` 测试：
     - [slidessync_test.go](server/internal/slidessync/slidessync_test.go)：`TestHubPresenceCursorRevisionAndRevocation`（0.04s）通过。
     - [slides-collab-pptx_test.go](server/internal/api/slides-collab-pptx_test.go)：`TestSlidesCollabPptxMemory`（0.06s）与 `TestSlidesCollabPptxPostgres`（1.38s）在 `-race` 下全通过，覆盖双人 WebSocket 在线状态与 `pageId` 同步、导入 `.pptx` 权限与图形校验、远端变更 `revision` 实时推送、删页与精确位置恢复，以及撤销共享后 WebSocket `1008` 自动断开。
     - `internal/migrate` 迁移测试在 PostgreSQL 16 下全通过（3.311s）。
2. **前端与无头 SDK 类型检查、构建、单测、打包与命名检查**：
   - `pnpm typecheck`：全部 7 个 workspace 项目通过。
   - `pnpm --filter @jiange/web build`：TypeScript + Vite 生产构建通过。
   - `pnpm test`：`@jiange/web` **242 个测试文件 / 1,337 项测试**（含 [slides-structure-history.test.ts](apps/web/src/pages/slides-structure-history.test.ts) 与更新后的 [slides-presenter.test.tsx](apps/web/src/pages/slides-presenter.test.tsx)）及 `@jiange/slides-sdk` **9 个测试文件 / 24 项测试**（含 [pptx.test.ts](packages/slides-sdk/test/pptx.test.ts)）全通过。
   - `pnpm test:sdk:pack`：全部 5 个无头 SDK 与 `@jiange/ooxml`（含 `@jiange/slides-sdk/pptx` 子路径导出与往返烟测）通过 Node ESM 与严格 NodeNext 类型校验。
   - `pnpm lint:names`：2,488 条路径全部符合 kebab-case 规范。

## 真实环境与双人 Chrome CDP 端到端可视化验证

在隔离 `postgres:16-alpine` 容器 + 编译版 Go 服务（`:8080`）+ Vite（`:5174`）+ 无头 Chrome CDP（`:9236`，双独立无痕 `BrowserContext` 模拟所有者「林产品」与协作者「陈设计」）下执行 [verify-slides-collab-pptx.mjs](scripts/verify-slides-collab-pptx.mjs)，全部断言通过、控制台 `0` 报错，并完成 5 张桌面与移动端截图视觉核查：

- [01-desktop-collab-presence.png](output/slides-collab-pptx-20261119/01-desktop-collab-presence.png)：`1440×900` 双人同时在线，顶栏显示橙色协作者头像「陈」，协作者新建第 2 页并在 `209ms` 内通过 WebSocket 推送至所有者视图，切页后左侧第 2 页缩略图即时出现橙色「陈设计」角标。
- [02-desktop-after-undo-restore.png](output/slides-collab-pptx-20261119/02-desktop-after-undo-restore.png)：`1440×900` 删除第 2 页后点击撤销按钮，原子恢复原第 2 页（标题、正文、绿色圆角矩形与演讲者备注均完整还原）且重做按钮就绪。
- [03-desktop-pptx-import-modal.png](output/slides-collab-pptx-20261119/03-desktop-pptx-import-modal.png)：`1440×900` 选入由 `@jiange/slides-sdk/pptx` 生成的 3 页标准 `.pptx` 文件后弹出确认导入预览框（正确展示 3 页标题、隐藏页标识与 4 个图形/文本框统计，菜单自动收起）。
- [04-desktop-imported-deck.png](output/slides-collab-pptx-20261119/04-desktop-imported-deck.png)：`1440×900` 确认导入后 3 页完整渲染（第 1 页深色封面亮色文字 + 五角星 + 双向箭头连接线、第 2 页正文 + 蓝色粗体文本框 + 橙色圆角矩形 + 备注、第 3 页隐藏标记），并验证整页刷新后从 PostgreSQL 16 持久恢复及导出 `.pptx` 成功提示。
- [05-mobile-slides-editor.png](output/slides-collab-pptx-20261119/05-mobile-slides-editor.png)：`390×844` 模拟移动视口下顶栏紧凑无溢出（横向溢出 `0px`），缩略图协作者角标收紧为单字「陈」不与更多按钮重叠，深色封面页与演讲者备注阅读清晰。

## 已知边界

- 幻灯片实时协同采用「页面级修订推送 + 乐观并发草稿队列」模型，尚非同页多光标字符级 CRDT；真正母版继承与图片占位符、图表/音视频/切换动画、图片渐变背景与裁剪留作后续深化。
- `.pptx` 导入当前支持标准 PresentationML 文本、布局、纯色背景、隐藏标记、基础图形、连接线与演讲者备注，嵌入图片/图表/SmartArt 会明确提示跳过；尚未在真实 Microsoft PowerPoint / WPS 大样本复杂模板上完成全面兼容核验。
- 移动端核验基于 macOS 无头 Chrome `390×844` 模拟视口，实体移动设备触控与中文输入法组合输入仍待真机验收。
