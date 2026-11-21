# Jiange AI-Native 全栈 Office SDK 体系 (`0.2.0`)

> **完整详细文档导航**：请阅读 [sdk-docs/README.md](./sdk-docs/README.md)（包含快速上手、Headless API、WebGPU/WebGL2 UI、AI-Native 协议、Go 后端 SDK、PostgreSQL 适配器、Go CLI/MCP 与性能发版指南）。

Jiange 提供一套**超轻量、可独立安装、AI-Native、零 Canvas 2D（WebGPU/WebGL2 + 虚拟列表）**的前端/Headless TypeScript SDK 套件、**独立零外部依赖的 Go 后端可嵌入 SDK**（`sdk/go/`）+ 可选 PostgreSQL 适配器（`sdk/go-pgstore/`），以及 **Go 单静态二进制原生 CLI & Streamable HTTP/stdio MCP Server**（`cli/`）。

- **零臃肿 / 独立安装**：各业务 Headless SDK 之间**零交叉依赖**（仅共享 ~4.9 KB gzip 的 `@jiange/ooxml` 或 ~17.5 KB gzip 的 `@jiange/render-gpu`），全部 Headless SDK、Go 后端 SDK、PostgreSQL 适配器与 Go CLI/MCP 均**零第三方运行时依赖**。
- **零 Canvas 2D**：所有图形/表格/幻灯片/白板/仪表盘 UI 均基于 **WebGPU（主后端）+ WebGL2（自动降级）+ 4 条 SDF/GlyphAtlas 管线 + 稀疏 Fenwick 树虚拟列表 / 池化 2D 虚拟网格**，通过静态校验确保零 `getContext("2d")`。
- **100% 单元测试覆盖率**：全部 13 个 TypeScript 包（Statements / Branches / Functions / Lines 四项 100%，零 `v8/c8/istanbul ignore`）、4 个 Go CLI/MCP 包（100.0% Statements + `-race`）、10 个 Go 后端 SDK 包（100.0% Statements + `-race`）与 `sdk/go-pgstore`（100.0% Statements + `-race`）均通过严格覆盖率门禁。

## 一、TypeScript Headless & WebGPU/WebGL2 UI 包（13 包，四项 100% 覆盖）

| 包 | 层级 | 运行时依赖 | Gzip 体积 | V8 覆盖率 (S/B/F/L) | 核心能力 |
| --- | --- | --- | ---: | :---: | --- |
| `@jiange/ooxml` | L0 基础 | 0 | 4.9 KB | 100 / 100 / 100 / 100 | 同步 STORE + 异步 DEFLATE (`createZipAsync`) + 可配置限额 + 有界安全 XML 解析 |
| `@jiange/collab` | L0 协同 | 0 | 35.1 KB | 100 / 100 / 100 / 100 | RGA 文档 CRDT、`SyncClient`、`UndoManager` + 可选子路径 `./table`、`./ws`、`./storage`、`./ai-agent` |
| `@jiange/sheet-sdk` | L1 Headless | `@jiange/ooxml` | 72.6 KB | 100 / 100 / 100 / 100 | `Workbook` Facade、AST+DAG 增量公式引擎（144 个 Excel 函数 + 动态数组 `#SPILL!` + Worker）、DEFLATE XLSX（含条件格式 `<conditionalFormatting>` 与批注 `comments*.xml`）、CSV/TSV、`createSheetTools` |
| `@jiange/doc-sdk` | L1 Headless | `@jiange/collab`, `@jiange/ooxml` | 58.1 KB | 100 / 100 / 100 / 100 | `Document` Facade、Markdown/HTML/DOCX(DEFLATE) 双向、大纲/章节读取、保样式 `replaceText`、批注与修订、`createDocTools` |
| `@jiange/slides-sdk` | L1 Headless | `@jiange/ooxml` | 25.8 KB | 100 / 100 / 100 / 100 | `Presentation` Facade、主题/富段落/原生表格/图表/嵌入媒体、DEFLATE `.pptx`、纯 TS 16:9 SVG 渲染、视觉诊断 `verify()`、`createSlidesTools` |
| `@jiange/whiteboard-sdk` | L1 Headless | `@jiange/ooxml` | 36.8 KB | 100 / 100 / 100 / 100 | `Board` Facade、Mermaid 双向、DAG 自动布局/对齐分布、纯 TS SVG、DEFLATE `.xmind`、拓扑诊断 `verify()`、`createWhiteboardTools` |
| `@jiange/base-sdk` | L1 Headless | **0** | 14.7 KB | 100 / 100 / 100 / 100 | `Base` Facade（含 `version`）、18 种字段类型、拓扑 `[Field]` 公式引擎、跨表 `link`/`lookup`、筛选排序分组、仪表盘聚合、CSV 推类型、`createBaseTools` |
| `@jiange/render-gpu` | L2 渲染核 | **0** | 17.5 KB | 100 / 100 / 100 / 100 | WebGPU + WebGL2 + Headless 后端、Rect/Line/Arc SDF + R8 位图 `GlyphAtlas` 四管线、百万行稀疏 `FenwickVirtualizer`、`VirtualList1D`/`VirtualGrid2D` 复用池、`SpatialIndex`、零 GC `InstanceBatch` |
| `@jiange/sheet-ui` | L2 UI | `sheet-sdk`, `render-gpu` | 7.4 KB | 100 / 100 / 100 / 100 | 4 象限冻结窗格 GPU Scissor + 池化文本层 + 单例 IME + 内嵌图表 + `mountSheetView` / `./react` / `<jiange-sheet>` |
| `@jiange/doc-ui` | L2 UI | `doc-sdk`, `render-gpu` | 2.8 KB | 100 / 100 / 100 / 100 | `VirtualList1D`（版本缓存）+ 动态块高追踪 + 大纲跳转 + `mountDocView` / `./react` / `<jiange-doc>` |
| `@jiange/slides-ui` | L2 UI | `slides-sdk`, `render-gpu` | 4.2 KB | 100 / 100 / 100 / 100 | GPU SDF 舞台 + 虚拟缩略图栏 + 缩放控制柄 + 放映模式 + `mountSlidesView` / `./react` / `<jiange-slides>` |
| `@jiange/whiteboard-ui` | L2 UI | `whiteboard-sdk`, `render-gpu` | 4.5 KB | 100 / 100 / 100 / 100 | 无限画布相机 + `SpatialIndex` 视锥剔除 + GPU SDF 图形/连线/脑图/笔迹 + `mountWhiteboardView` / `./react` / `<jiange-whiteboard>` |
| `@jiange/base-ui` | L2 UI | `base-sdk`, `render-gpu` | 4.3 KB | 100 / 100 / 100 / 100 | 网格（版本缓存 + 条件填色）+ 看板 + 甘特图 + 仪表盘 GPU 视图 + `mountBaseView` / `./react` / `<jiange-base>` |

## 二、Go 后端可嵌入 SDK 与 PostgreSQL 适配器（11 包，零第三方依赖，100.0% 覆盖）

- **`sdk/go/`**（10 包，纯 Go 1.23 stdlib）：`storage`、`sync`、`sheet`、`doc`、`slides`、`whiteboard`、`base`、`ai`、`server`（含 `/health`、`/healthz`、`/ai/tools`、`/ai/tools/{name}`、`/mcp`）、`client`。详见 [sdk/go/README.md](./sdk/go/README.md)。
- **`sdk/go-pgstore/`**（可选独立模块，基于标准 `database/sql`，兼容 `pgx/v5/stdlib` 与 `lib/pq`）：为 `sdk/go/storage.Store` 提供带自动建表与乐观锁 CAS 版本控制的 PostgreSQL 生产存储实现。详见 [sdk/go-pgstore/README.md](./sdk/go-pgstore/README.md)。

## 三、Go 原生 CLI & Streamable HTTP/stdio MCP Server（`cli/`，4 包，100.0% 覆盖）

模块 `github.com/ZSeven-W/jiange/cli`（单静态二进制仅 **~5.5 MB**，无需 Node.js 运行时）：

- `cli/cmd/jiange`（100.0%）：本地 `jiange <sheet|doc|slides|board|base> ...`、远端 `jiange remote <health|tools|call|get|post|patch|delete> --server <url> --token <tok>` 与 `jiange mcp --transport stdio|http`
- `cli/internal/engine`（100.0%）：五大格式本地解析、求值、原子补丁与 SVG 渲染引擎
- `cli/internal/mcp`（100.0%）：19 个 AI 工具的 JSON-RPC 2.0 MCP Server（`stdio` + 完整 Streamable HTTP `POST`/`GET SSE`/`DELETE`/`OPTIONS` + `Mcp-Session-Id`）
- `cli/internal/remote`（100.0%）：零依赖远端 HTTP 客户端，直连 `sdk/go/server`

详见 [cli/README.md](./cli/README.md)。

## 四、实测性能基准与交互示例

运行 `pnpm bench`（[benchmarks/run-benchmarks.mjs](./benchmarks/run-benchmarks.mjs)）：

- **10,000 公式单格增量重算**：`0.049 ms`（SLA `< 5 ms`）
- **50,000 单元格 XLSX DEFLATE 读写**：写入 `105.4 ms`（`178.9 KB`，SLA `< 500 ms`），读取 `172.8 ms`（SLA `< 400 ms`）
- **1,000,000 行稀疏 Fenwick 虚拟列表**：`0.0020 ms / frame`（SLA `< 4 ms`）
- **10,000 节点 SpatialIndex 剔除 + GPU Buffer 打包**：`0.0340 ms / frame`（SLA `< 2 ms`）
- **10,000 行（50,000 单元格）`Workbook.inspect`**：`2.12 ms`（SLA `< 15 ms`）
- **5,000 块文档虚拟列表首帧**：`0.37 ms`（DOM 池 22 < 120，SLA `< 40 ms`）
- **100,000 条多维表格记录虚拟滚动**：`0.066 ms / frame`（SLA `< 4 ms`）
- **全量隔离单包安装测试**：全部 13 个 TS 包仅携声明依赖在隔离目录通过 Node ESM 冒烟与 `pnpm test:sdk:pack` 验证
- **可运行示例与浏览器 Playground**：见 [examples/README.md](./examples/README.md)

## 许可

`packages/*`、`sdk/*`、`cli/*` 下的全部 SDK 与工具对个人和商业使用均遵循仓库 [LICENSE](./LICENSE) 条款。
