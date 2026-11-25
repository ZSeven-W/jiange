# 性能基准、兼容迁移与发布治理

Jiange 将包体积、性能 SLA、单包隔离性、零 Canvas 2D 与 100% 单元测试覆盖率全部纳入自动化 CI 门禁（`.github/workflows/ci.yml` 与 `.github/workflows/release-sdk.yml`）。

---

## 1. RFC §7 实测性能基准（`node benchmarks/run-benchmarks.mjs`）

以下为仓库自动化基准脚本 `benchmarks/run-benchmarks.mjs` 在 `v0.2.0` 编译产物上的实测结果（全部大幅优于 RFC §7 SLA）：

| 基准场景 | RFC §7 SLA 门禁 | 实测成绩 | 状态 |
| --- | --- | --- | :---: |
| **10,000 公式工作表单格增量重算** | `< 5 ms` | **`0.051 ms`**（快 98×） | PASS |
| **50,000 单元格 XLSX DEFLATE 写出** | `< 500 ms` | **`135.2 ms`**（输出 `178.9 KB`） | PASS |
| **50,000 单元格 XLSX 读取解析** | `< 400 ms` | **`187.6 ms`** | PASS |
| **1,000,000 行稀疏 `FenwickVirtualizer`（1,000 帧变高滚动）** | `< 4 ms / frame` | **`0.0021 ms / frame`**（总计 `2.12 ms`） | PASS |
| **10,000 节点 `SpatialIndex` 视锥剔除 + GPU `InstanceBatch` 打包** | `< 2 ms / frame` | **`0.0326 ms / frame`** | PASS |
| **10,000 行（50,000 单元格）`Workbook.inspect({ detail: "summary", maxTokens: 1500 })`** | `< 15 ms` 且 `<= 1500 tokens` | **`2.25 ms`**，`89 tokens` | PASS |
| **5,000 块长文档 `DocViewController` 虚拟列表首屏渲染** | `< 40 ms` 且 DOM 池 `< 120` | **`0.40 ms`**，DOM 池恒定 **`22`** 节点 | PASS |
| **100,000 条记录 `BaseViewController` 虚拟网格滚动（50 帧）** | `< 4 ms / frame` | **`0.062 ms / frame`** | PASS |

---

## 2. 全量包体积审计与轻量对比

| 包名 | 编译 JS 文件数 | 未压缩 JS 体积 | Gzip 体积 | 第三方运行时依赖 |
| --- | ---: | ---: | ---: | :---: |
| `@jiange/ooxml` | 3 | 17.5 KB | **4.9 KB** | 0 |
| `@jiange/collab` | 19 | 144.9 KB | **35.1 KB** | 0 |
| `@jiange/sheet-sdk` | 22 | 348.7 KB | **72.6 KB** | 0（仅 `@jiange/ooxml`） |
| `@jiange/doc-sdk` | 16 | 234.7 KB | **58.1 KB** | 0（仅 `@jiange/collab`, `@jiange/ooxml`） |
| `@jiange/slides-sdk` | 14 | 111.8 KB | **25.8 KB** | 0（仅 `@jiange/ooxml`） |
| `@jiange/whiteboard-sdk` | 12 | 160.7 KB | **36.8 KB** | 0（仅 `@jiange/ooxml`） |
| `@jiange/base-sdk` | 8 | 68.8 KB | **14.7 KB** | 0 |
| `@jiange/render-gpu` | 8 | 78.5 KB | **17.5 KB** | 0 |
| `@jiange/sheet-ui` | 6 | 30.6 KB | **7.4 KB** | 0（仅 `sheet-sdk`, `render-gpu`） |
| `@jiange/doc-ui` | 4 | 9.7 KB | **2.8 KB** | 0（仅 `doc-sdk`, `render-gpu`） |
| `@jiange/slides-ui` | 4 | 15.6 KB | **4.2 KB** | 0（仅 `slides-sdk`, `render-gpu`） |
| `@jiange/whiteboard-ui` | 4 | 17.3 KB | **4.5 KB** | 0（仅 `whiteboard-sdk`, `render-gpu`） |
| `@jiange/base-ui` | 4 | 16.8 KB | **4.3 KB** | 0（仅 `base-sdk`, `render-gpu`） |

> **单场景典型增量体积**：
> - 仅需 Headless 多维表格：`@jiange/base-sdk` = **14.7 KB gzip**；
> - 仅需 Headless PPTX + SVG：`@jiange/slides-sdk` + `@jiange/ooxml` = **30.7 KB gzip**；
> - 仅需完整 WebGPU/WebGL2 表格（含 144 公式 + XLSX + UI）：`sheet-ui` + `sheet-sdk` + `render-gpu` + `ooxml` = **102.4 KB gzip**（远轻于传统全量套件数 MB 体积）。

---

## 3. 单包隔离安装保证与本地验证命令

### 3.1 单包隔离断言

`scripts/verify-headless-sdks.mjs`（`pnpm test:sdk:pack`）与 `benchmarks/run-benchmarks.mjs`（`pnpm bench`）会在临时目录对全部 13 个包逐一执行真实 `pnpm pack` → 解包到干净 `node_modules/@jiange/*` → 仅安装声明依赖运行冒烟脚本与 TypeScript `--strict --module NodeNext` 类型校验：

- 验证 `@jiange/sheet-sdk` 仅需 `@jiange/ooxml` 即可完整运行；
- 验证 `@jiange/doc-sdk` 仅需 `@jiange/collab` + `@jiange/ooxml`，**绝不隐式引入 `@jiange/whiteboard-sdk`**；
- 验证 `@jiange/base-sdk` 与 `@jiange/render-gpu` **零依赖**独立运行；
- 验证全部 5 个 `@jiange/*-ui` 包仅需各自 Headless SDK + `@jiange/render-gpu`，零 Canvas 2D，且 `./react` 与 `define*Element()` 在 Node/SSR 中安全导入；
- 验证每个 tarball 均打包了与仓库根一致的 `LICENSE`、`package.json` 含 `"license": "SEE LICENSE IN LICENSE"`、产物文件名全为 kebab-case、且 `README.md` 不含失效的 `../../LICENSE` 相对路径。

### 3.2 一键本地验证命令

```bash
# 文件名 kebab-case 规范检查
pnpm lint:names

# 全量构建与类型检查
pnpm -r build
pnpm -r typecheck

# 全部 TS 单元测试与四项 100% V8 覆盖率门禁
pnpm test
pnpm test:sdk:coverage

# 打包 + 隔离单包安装 + NodeNext 声明校验
pnpm test:sdk:pack

# 包体积审计 + Zero Canvas 2D 审计 + RFC §7 性能 SLA + 全 13 包隔离验证
pnpm bench

# Go CLI / MCP 与 Go 后端 SDK / PG 适配器并发与覆盖率校验
pnpm test:cli
pnpm test:sdk:go
cd sdk/go-pgstore && go vet ./... && go test -count=1 -race -cover ./...
```

---

## 4. 历史 camelCase 子路径迁移表（Deprecated → Kebab-Case）

为遵循仓库全量 kebab-case 路径规范，以下历史 camelCase 子路径在 **`v0.2.0`** 仍作为兼容别名保留（指向同一编译产物），计划于 **`v1.0.0`** 移除。请新代码统一迁移至右侧 kebab-case 子路径：

| 包名 | 已废弃子路径（Deprecated in `0.2.0`） | 推荐迁移目标（Standard） |
| --- | --- | --- |
| `@jiange/sheet-sdk` | `@jiange/sheet-sdk/xlsxRead` | `@jiange/sheet-sdk/xlsx-read` |
| `@jiange/doc-sdk` | `@jiange/doc-sdk/tableCells` | `@jiange/doc-sdk/table-cells` |
| `@jiange/doc-sdk` | `@jiange/doc-sdk/blockStyles` | `@jiange/doc-sdk/block-styles` |
| `@jiange/doc-sdk` | `@jiange/doc-sdk/columnWidths` | `@jiange/doc-sdk/column-widths` |
| `@jiange/doc-sdk` | `@jiange/doc-sdk/columnMove` | `@jiange/doc-sdk/column-move` |
| `@jiange/whiteboard-sdk` | `@jiange/whiteboard-sdk/inkGeometry` | `@jiange/whiteboard-sdk/ink-geometry` |

---

## 5. 版本策略与发布流水线

- **语义化版本**：13 个 TypeScript 包、`sdk/go/`、`sdk/go-pgstore/` 与 `cli/` 同步维护独立 `CHANGELOG.md`，当前统一为 **`0.2.0`**；`0.x` 阶段在 minor 版本中保持向后兼容并提供清晰迁移表，`1.0.0` 起严格遵循 SemVer。
- **自动化发布工作流（[`.github/workflows/release-sdk.yml`](../.github/workflows/release-sdk.yml)）**：
  - 触发方式：推送 `sdk-v*` 或 `cli-v*` Git Tag，或在 GitHub Actions 手动执行 `workflow_dispatch`（支持 `release_tag`、`publish_npm`、`tag_go_modules` 参数）。
  - **`build-ts-sdks` 任务**：执行 `pnpm install --frozen-lockfile` → `pnpm -r build` → `pnpm test:sdk:pack` → `pnpm --workspace-concurrency=1 test:sdk:coverage` → `node benchmarks/run-benchmarks.mjs` → 按 L0→L1→L2 拓扑顺序打包全部 13 个 `@jiange/*.tgz`；配置 `NPM_TOKEN` Secret 后自动幂等发布到 npmjs.com（含 `--provenance`）。
  - **`build-go-cli` 任务**：运行 `go test -count=1 -race -cover ./...`，并以 `CGO_ENABLED=0` 交叉编译 5 个平台静态二进制（`linux/amd64`、`linux/arm64`、`darwin/amd64`、`darwin/arm64`、`windows/amd64`）。
  - **`verify-go-sdks` 任务**：在 `sdk/go`、`sdk/go-pgstore` 与 `examples/go-backend` 上执行 `gofmt`、`go vet`、`go test -race -cover` 与 `--check`。
  - **`publish-github-release` 任务**：生成 `SHA256SUMS.txt`、幂等创建/更新 GitHub Release（附带全部 13 个 `.tgz` 与 5 平台 CLI 二进制），并自动同步 Go 子模块 Tag（`sdk/go/vX.Y.Z`、`sdk/go-pgstore/vX.Y.Z`、`cli/vX.Y.Z`）与预热 `proxy.golang.org`。

---

## 6. 许可协议规则（License）

本仓库采用**分组件许可**（完整中英文法律条款见仓库根目录 [`LICENSE`](../LICENSE)）：

- **SDK 部分（`packages/*`、`sdk/*`、`cli/*`）**：
  - **个人与商业使用全部免费**：任何个人、非商业组织及企业（含商业主体）均可免费使用、复制、集成及分发 SDK，用于个人项目、企业内部系统、商业产品或商业 SaaS 服务，**无需购买商业授权**。
  - **企业二次开发须公开署名来源**：若企业（或营利性主体）对 SDK 进行二次开发（修改源码、扩展功能、裁剪模块、翻译移植或衍生新库），必须在产品官方文档、关于页面、官网或源码仓库（`README` / `NOTICE`）等公众或最终用户清晰可见的位置，明确声明其基于 **Jiange SDK**（`Copyright (c) ZSeven-W`，`https://github.com/ZSeven-W/jiange`）。
- **应用部分（`apps/`、`server/` 及部署配置）**：个人与非商业使用免费；任何商业用途须事先向版权所有者取得商业授权。使用或二开 SDK 部分不自动授予应用部分的商业使用权。
