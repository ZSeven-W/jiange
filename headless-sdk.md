# Jiange AI-Native 全栈 Office SDK 体系 (`0.2.0`)

Jiange 提供一套**超轻量、可独立安装、AI-Native、零 Canvas 2D（WebGPU/WebGL2 + 虚拟列表）**的前端/Headless TypeScript SDK 套件、**独立零外部依赖的 Go 后端可嵌入 SDK**（`sdk/go/`），以及 **Go 单静态二进制原生 CLI & MCP Server**（`cli/`）。

- **零臃肿 / 独立安装**：各业务 Headless SDK 之间**零交叉依赖**（仅共享 4.8 KB 的 `@jiange/ooxml` 或 12.9 KB 的 `@jiange/render-gpu`），全部 Headless SDK 与 Go SDK 均**零第三方运行时依赖**。
- **零 Canvas 2D**：所有图形/表格/幻灯片/白板/仪表盘 UI 均基于 **WebGPU（主后端）+ WebGL2（自动降级）+ 稀疏 Fenwick 树虚拟列表 / 池化 2D 虚拟网格**，通过静态校验确保零 `getContext("2d")`。
- **100% 单元测试覆盖率**：全部 13 个 TypeScript 包（Statements / Branches / Functions / Lines 四项 100%）、3 个 Go CLI/MCP 包（100.0% Statements + `-race`）、10 个 Go 后端 SDK 包（100.0% Statements + `-race`）均通过严格覆盖率门禁。

## 一、TypeScript Headless & WebGPU/WebGL2 UI 包（13 包，四项 100% 覆盖）

| 包 | 层级 | 运行时依赖 | Gzip 体积 | V8 覆盖率 (S/B/F/L) | 核心能力 |
| --- | --- | --- | ---: | :---: | --- |
| `@jiange/ooxml` | L0 基础 | 0 | 4.8 KB | 100 / 100 / 100 / 100 | 同步 STORE + 异步 DEFLATE (`createZipAsync`) + 有界安全 XML 解析 |
| `@jiange/collab` | L0 协同 | 0 | 35.3 KB | 100 / 100 / 100 / 100 | RGA 文档 CRDT、`SyncClient`、`UndoManager` + 可选子路径 `./table`、`./ws`、`./storage`、`./ai-agent` |
| `@jiange/sheet-sdk` | L1 Headless | `@jiange/ooxml` | 69.1 KB | 100 / 100 / 100 / 100 | `Workbook` Facade、AST+DAG 增量公式引擎（144 个 Excel 函数 + 动态数组 `#SPILL!` + Worker）、DEFLATE XLSX、CSV/TSV、`createSheetTools` |
| `@jiange/doc-sdk` | L1 Headless | `@jiange/collab`, `@jiange/ooxml` | 58.4 KB | 100 / 100 / 100 / 100 | `Document` Facade、Markdown/HTML/DOCX(DEFLATE) 双向、大纲/章节读取、保样式 `replaceText`、批注与修订、`createDocTools` |
| `@jiange/slides-sdk` | L1 Headless | `@jiange/ooxml` | 26.0 KB | 100 / 100 / 100 / 100 | `Presentation` Facade、主题/富段落/原生表格/图表/嵌入媒体、DEFLATE `.pptx`、纯 TS 16:9 SVG 渲染、视觉诊断 `verify()`、`createSlidesTools` |
| `@jiange/whiteboard-sdk` | L1 Headless | `@jiange/ooxml` | 37.0 KB | 100 / 100 / 100 / 100 | `Board` Facade、Mermaid 双向、DAG 自动布局/对齐分布、纯 TS SVG、DEFLATE `.xmind`、拓扑诊断 `verify()`、`createWhiteboardTools` |
| `@jiange/base-sdk` | L1 Headless | **0** | 14.7 KB | 100 / 100 / 100 / 100 | `Base` Facade、18 种字段类型、拓扑 `[Field]` 公式引擎、跨表 `link`/`lookup`、筛选排序分组、仪表盘聚合、CSV 推类型、`createBaseTools` |
| `@jiange/render-gpu` | L2 渲染核 | **0** | 12.9 KB | 100 / 100 / 100 / 100 | WebGPU + WebGL2 + Headless 后端、百万行稀疏 `FenwickVirtualizer`、`VirtualList1D`/`VirtualGrid2D` 复用池、`SpatialIndex`、零 GC `InstanceBatch` SDF |
| `@jiange/sheet-ui` | L2 UI | `sheet-sdk`, `render-gpu` | 6.9 KB | 100 / 100 / 100 / 100 | 4 象限冻结窗格 GPU Scissor 渲染 + 池化文本层 + 单例 IME 编辑器 + GPU 内嵌图表 + `mountSheetView` / `./react` |
| `@jiange/doc-ui` | L2 UI | `doc-sdk`, `render-gpu` | 2.3 KB | 100 / 100 / 100 / 100 | `VirtualList1D` + 动态块高追踪 + 大纲跳转 + `mountDocView` / `./react` |
| `@jiange/slides-ui` | L2 UI | `slides-sdk`, `render-gpu` | 3.6 KB | 100 / 100 / 100 / 100 | GPU SDF 舞台 + 虚拟缩略图栏 + 缩放控制柄 + 放映模式 + `mountSlidesView` / `./react` |
| `@jiange/whiteboard-ui` | L2 UI | `whiteboard-sdk`, `render-gpu` | 3.9 KB | 100 / 100 / 100 / 100 | 无限画布相机 + `SpatialIndex` 视锥剔除 + GPU SDF 图形/连线/脑图/笔迹 + `mountWhiteboardView` / `./react` |
| `@jiange/base-ui` | L2 UI | `base-sdk`, `render-gpu` | 3.6 KB | 100 / 100 / 100 / 100 | 网格（条件填色）+ 看板 + 甘特图 + 仪表盘 GPU 视图 + `mountBaseView` / `./react` |

## 二、Go 后端可嵌入 SDK（`sdk/go/`，10 包，零外部依赖，100.0% 覆盖）

模块 `github.com/ZSeven-W/jiange/sdk/go`（纯 Go 1.23 stdlib），可按需单包引入，3 行代码挂载到 `net/http` / Gin / Echo / Chi：

| 子包 | 覆盖率 (`-race`) | 职责 |
| --- | :---: | --- |
| `sdk/go/storage` | 100.0% | `Store` / `Authenticator` / `Authorizer` 扩展接口、`MemoryStore`、`FileStore`、Bearer 鉴权、角色权限中间件、HMAC-SHA256 `WebhookDispatcher` |
| `sdk/go/sync` | 100.0% | 传输无关多房间 `RoomHub`（乐观 `baseSeq`、追帧、在线态 TTL、`TransportConn` WS 桥接）+ SSE/HTTP Handler |
| `sdk/go/sheet` | 100.0% | 纯 Go 电子表格引擎（DEFLATE XLSX/CSV + 公式引擎 + `Inspect`/`Query`/`Apply`/`Verify`）+ `http.Handler` + AI 工具注册 |
| `sdk/go/doc` | 100.0% | 纯 Go 文档引擎（DEFLATE DOCX/Markdown + 大纲 + `Inspect`/`Query`/`Apply`/`Verify`）+ `http.Handler` + AI 工具注册 |
| `sdk/go/slides` | 100.0% | 纯 Go 演示文稿引擎（DEFLATE PPTX + 16:9 SVG 渲染 + `Inspect`/`Apply`/`Verify`）+ `http.Handler` + AI 工具注册 |
| `sdk/go/whiteboard` | 100.0% | 纯 Go 白板/脑图引擎（Mermaid/XMind + SVG 渲染 + `Inspect`/`Apply`/`Verify`）+ `http.Handler` + AI 工具注册 |
| `sdk/go/base` | 100.0% | 纯 Go 多维表格引擎（CSV + `[Field]` 表达式 + `Inspect`/`Query`/`Apply`/`Verify`）+ `http.Handler` + AI 工具注册 |
| `sdk/go/ai` | 100.0% | 可组合 `ToolRegistry` + JSON-RPC 2.0 MCP Server（stdio / HTTP） |
| `sdk/go/server` | 100.0% | 一键按需组合挂载各业务 Handler、Sync Hub 与 MCP 的轻量网关 |
| `sdk/go/client` | 100.0% | 强类型 Go HTTP 客户端 SDK，用于微服务间调用 |

详见 [sdk/go/README.md](./sdk/go/README.md)。

## 三、Go 原生 CLI & MCP Server（`cli/`，3 包，零外部依赖，100.0% 覆盖）

模块 `github.com/ZSeven-W/jiange/cli`（单静态二进制仅 **5.5 MB**，无需 Node.js 运行时）：

- `cli/cmd/jiange`（100.0%）：`jiange <sheet|doc|slides|board|base> <inspect|query|patch|verify|convert|render>` 与 `jiange mcp --transport stdio|http`
- `cli/internal/engine`（100.0%）：五大格式本地解析、求值、原子补丁与 SVG 渲染引擎
- `cli/internal/mcp`（100.0%）：19 个 AI 工具的 JSON-RPC 2.0 MCP Server（stdio + HTTP）

详见 [cli/README.md](./cli/README.md)。

## 四、实测性能基准 (`node benchmarks/run-benchmarks.mjs`)

- **10,000 公式单格增量重算**：`0.049 ms`（SLA `< 5 ms`）
- **50,000 单元格 XLSX DEFLATE 读写**：写入 `102.8 ms`（178.9 KB），读取 `173.2 ms`（SLA `< 500 ms`）
- **1,000,000 行稀疏 Fenwick 虚拟列表**：`0.0020 ms / frame`（SLA `< 4 ms`）
- **10,000 节点 SpatialIndex 剔除 + GPU Buffer 打包**：`0.0308 ms / frame`（SLA `< 2 ms`）
- **全量隔离单包安装测试**：全部 13 个 TS 包仅携声明依赖在隔离目录通过 Node ESM 冒烟测试

## 许可

`packages/*`、`sdk/*`、`cli/*` 下的全部 SDK 与工具对个人和商业使用均遵循仓库 [LICENSE](./LICENSE) 条款。
