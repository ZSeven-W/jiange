# 画板锚点评论、多选等比缩放与 `.xmind` 导入导出闭环验证报告（2026-11-19）

本轮推进 **P1 Slice 9（画板对象与坐标锚点评论、多选对象与笔迹等比缩放、思维导图标准 `.xmind` 双向导入导出）**，补齐 `feishu-gap-audit-20261118.md` 中画板、流程图与思维导图三大高频生产差距。

## 主要改动

### 1. 无头白板引擎扩展（`@jiange/whiteboard-sdk`）

- [ink-geometry.ts](packages/whiteboard-sdk/src/ink-geometry.ts) & [ink.test.ts](packages/whiteboard-sdk/test/ink.test.ts)：
  - 新增 `selectionBounds` 与 `scaleSelectionProportionally`，支持任意混合多选的几何图形（`FlowNode`）与自由笔迹（`FlowStroke`）围绕锚点以单一标量执行等比缩放，同步等比调整图形坐标/尺寸/显式字号及笔迹坐标/线宽，并严格遵守画布 `[-20000, 20000]` 边界与最小图形尺寸约束（`20×16`）。
- [comment-anchor.ts](packages/whiteboard-sdk/src/comment-anchor.ts) & [comment-anchor.test.ts](packages/whiteboard-sdk/test/comment-anchor.test.ts)：
  - 新增画板锚点编解码与实时位置解析器（子路径导出 `@jiange/whiteboard-sdk/comment-anchor`）：将图形锚点（`fc:n:<nodeId>`）、思维导图主题锚点（`fc:m:<topicId>`）与自由画布坐标图钉（`fc:p:<x>,<y>`）及兜底坐标编码至文档评论既有 `startChar`/`endChar` 字段（均 ≤ 64 字符）；移动或缩放图形/导图时图钉动态跟随，原对象删除后平滑降级至原坐标并标注「原对象已删」。
- [xmind.ts](packages/whiteboard-sdk/src/xmind.ts) & [xmind.test.ts](packages/whiteboard-sdk/test/xmind.test.ts)：
  - 基于共享 `@jiange/ooxml`（零 DOM 依赖，子路径导出 `@jiange/whiteboard-sdk/xmind`）实现标准 `.xmind` 双向读写：
    - `exportMindMapToXmind`：输出 XMind ZEN（2020+）标准 ZIP 包（`content.json`、`metadata.json`、`manifest.json`、`META-INF/manifest.xml`），完整保留多根画布（Sheets）、节点层级与同级顺序、节点描述（`notes.plain.content`）、折叠态（`branch: "folded"`）、形状、填充/边框色、线宽及加粗/斜体/下划线/删除线/对齐格式。
    - `parseXmindToMindMap`：同时兼容现代 XMind ZEN（`content.json`）与旧版 XMind 8（`content.xml`），严格遵守 500 主题上限、32 层深度上限及文本/描述长度规范并自动纵向排布多画布根节点。
- [package.json](packages/whiteboard-sdk/package.json)、[tsconfig.build.json](packages/whiteboard-sdk/tsconfig.build.json)、[tsconfig.check.json](packages/whiteboard-sdk/tsconfig.check.json)、[verify-headless-sdks.mjs](scripts/verify-headless-sdks.mjs)：接入 `@jiange/ooxml` 依赖并在打包烟测中覆盖 `scaleSelectionProportionally`、`@jiange/whiteboard-sdk/xmind` 与 `@jiange/whiteboard-sdk/comment-anchor`。

### 2. 画板编辑器交互与文档评论全链路打通

- [comment-anchor.ts (web)](apps/web/src/editor/comment-anchor.ts)、[board-comments.tsx](apps/web/src/editor/flowchart/board-comments.tsx)、[board-comments.test.ts](apps/web/src/editor/flowchart/board-comments.test.ts)、[editor.tsx](apps/web/src/editor/editor.tsx)、[doc-page.tsx](apps/web/src/pages/doc-page.tsx)：
  - 将画板锚点评论纳入文档块级评论投影（兼容文档评论角标与历史评论），并向 `FlowchartBlock` / `FlowchartEditor` 注入实时评论列表及受账号与权限保护的 `create` / `reply` / `resolve` 回调（只读但有评论权限的成员同样可在画板内落钉评论）。
- [flowchart-block.tsx](apps/web/src/editor/flowchart/flowchart-block.tsx)：
  - **多选等比缩放**：同时选中 ≥ 2 个图形或笔迹时渲染统一蓝色虚线组合框（`data-flow-group-box`）与右下角等比缩放手柄（`data-flow-group-resize`），拖拽实时显示缩放百分比并按单步原子历史提交（一次撤销完整还原）。
  - **画板评论图钉与行内浮层**：左侧工具条与只读视图新增「评论图钉」工具（`data-flow-comment-tool`），图形浮动栏（`data-flow-comment`）与思维导图节点栏（`data-mind-comment`）支持在画板内原地发起锚点评论；画布与预览区直接渲染编号橙色/蓝色图钉（`data-flow-comment-pin`），点击打开行内线程弹窗支持回复与标记解决；顶栏展示未解决图钉计数徽标（`data-flow-comments-count`）支持循环定位。
  - **`.xmind` 导入导出**：右上角「导入」升级为菜单，支持 `.drawio`/`.xml` 与 `.xmind` 双格式自动识别导入并追加排布至画布右侧；「导出」新增 `XMind 文件（.xmind）` 选项并遵守文档复制/导出权限。

### 3. 后端集成测试（PostgreSQL 16 + Memory 对等）

- [whiteboard-comments_test.go](server/internal/api/whiteboard-comments_test.go)：在 Memory 与隔离 PostgreSQL 16 Schema（`-race`）双引擎下验证 `docType="board"` 文档上图形锚点（`fc:n:...`）、坐标锚点（`fc:p:...`）与导图主题锚点（`fc:m:...`）评论的创建、回复、账号绑定解决以及收紧 `commentMinRole="edit"` 后的 `403` 权限拦截。

## 测试结果

1. **Go 全量与隔离 PostgreSQL 16 `-race` 测试**：
   - `cd server && go test -count=1 ./...`：全部 17 个 Go 包无缓存通过。
   - 隔离 `postgres:16-alpine` 容器下 `-race` 运行 `TestWhiteboardCommentsMemory`（0.01s）与 `TestWhiteboardCommentsPostgres`（1.44s）全通过。
2. **前端与无头 SDK 验证**：
   - `pnpm typecheck`（7 个 workspace 项目）、`pnpm --filter @jiange/web build`、`pnpm test`（`@jiange/web` **243 个测试文件 / 1,338 项测试**、`@jiange/whiteboard-sdk` **10 个测试文件 / 69 项测试**）、`pnpm test:sdk:pack`（含 `@jiange/whiteboard-sdk/xmind` 与 `@jiange/whiteboard-sdk/comment-anchor` 烟测）及 `pnpm lint:names` 全通过。

## 真实环境与 Chrome CDP 端到端可视化验证

在隔离 `postgres:16-alpine` 容器 + 编译版 Go 服务（`:8080`）+ Vite（`:5174`）+ 无头 Chrome CDP（`:9237`）下执行 [verify-whiteboard-mindmap.mjs](scripts/verify-whiteboard-mindmap.mjs)，全部断言通过且控制台 `0` 报错，4 张桌面与移动端截图均已视觉审查：

- [01-desktop-multi-scale.png](output/whiteboard-mindmap-20261119/01-desktop-multi-scale.png)：`1440×900` 全选 2 个图形与 2 条自由笔迹后呈现统一蓝色虚线组合框与右下角缩放手柄，拖拽后图形（`1.25x / 1.19x`）与笔迹（`1.32x`）等比放大，点击一次撤销精确恢复原几何尺寸。
- [02-desktop-board-comment-pins.png](output/whiteboard-mindmap-20261119/02-desktop-board-comment-pins.png)：`1440×900` 成功在画布空白坐标与「圆角矩形」图形落钉 2 条锚点评论，顶栏显示橙色计数徽标 `2`，点击图钉展示行内详情弹窗、回复与解决按钮；整页刷新后从 PostgreSQL 16 完整还原，解决第 1 条后图钉数由 `2` 降至 `1`。
- [03-desktop-xmind-imported.png](output/whiteboard-mindmap-20261119/03-desktop-xmind-imported.png)：`1440×900` 通过文件选择器导入标准 `.xmind` 压缩包，5 主题导图（含蓝色粗体根节点、描述文本与绿色椭圆分支）与既有图形/笔迹/评论图钉共处画布，导出 `.xmind` 无报错，整页刷新后持久化完整。
- [04-mobile-board-editor.png](output/whiteboard-mindmap-20261119/04-mobile-board-editor.png)：`390×844` 模拟移动视口下横向溢出 `0px`，顶栏图标、底部工具条与画板评论弹窗自动避让边界无遮挡。

## 已知边界

- 画板与流程图目前仍共用文档内 `flowchart` 块模型；独立画板持久化模型、在途多端细粒度并发竞态保护、导图节点局部字符级富文本描述、节点附件及结构条件提交留作后续深化。
- `.xmind` 导入覆盖现代 XMind ZEN（`content.json`）与 XMind 8（`content.xml`）核心主题树/备注/折叠/基础样式，暂不导入 XMind 内嵌图片、联系线、概要外框与贴纸；移动端核验基于 macOS Chrome `390×844` 模拟视口，真机触控与中文 IME 仍待实机验收。
