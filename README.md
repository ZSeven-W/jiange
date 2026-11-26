# Jiange

<p align="center">
  <img src="apps/web/public/brand/jiange-lockup.svg" width="240" alt="Jiange" />
</p>

<p align="center">
  <b>简体中文</b> ·
  <a href="README.en.md">English</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <a href="https://github.com/ZSeven-W/jiange/actions/workflows/ci.yml"><img src="https://github.com/ZSeven-W/jiange/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ZSeven-W/jiange/releases/latest"><img src="https://img.shields.io/github/v/release/ZSeven-W/jiange?label=release&color=3370FF" alt="Latest Release" /></a>
  <a href="https://www.npmjs.com/package/@zseven-w/sheet-sdk"><img src="https://img.shields.io/npm/v/%40zseven-w%2Fsheet-sdk?label=npm%20%40zseven-w%2F*&color=CB3837" alt="npm SDKs" /></a>
  <a href="https://github.com/ZSeven-W/jiange/pkgs/container/jiange"><img src="https://img.shields.io/badge/ghcr.io-zseven--w%2Fjiange-2496ED?logo=docker&logoColor=white" alt="GHCR Docker Image" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Dual--Track%20%7C%20SDK%20Free-10B981" alt="License" /></a>
</p>

<p align="center">
  <strong>开源的飞书文档 + 电子表格 + 多维表格 + 幻灯片 + 画板/脑图完整协作套件</strong><br />
  <sub>AI 原生 · 轻量可拆 · 政企安全合规 · 多副本高可用 · 全仓双语与离线 CRDT · 零 Canvas 2D（WebGPU/WebGL2 + 虚拟列表）</sub>
</p>

<p align="center">
  An open-source, self-hostable, enterprise-ready, AI-native alternative to Feishu/Lark Docs, Sheets, Base, Slides, and Whiteboard/MindMap — built from scratch with a custom CRDT engine, pure-stdlib Go backend (SAML 2.0, OIDC, SCIM 2.0, LDAP/WeCom/DingTalk, WebAuthn Passkeys, DLP, Prometheus, OpenAPI 3.1), 13 zero-dependency TypeScript/WebGPU SDKs, and a single-binary Go CLI &amp; MCP Server.
</p>

---

## 宣传视频 / Launch Promo

<p align="center">
  <a href="design/promo/jiange-promo.mp4">
    <img src="design/promo/jiange-promo-cover.png" alt="Jiange 宣传视频 — 点击观看" width="100%" />
  </a>
</p>

<p align="center">
  <sub>
    ▶ <a href="design/promo/jiange-promo.mp4"><b>点击观看完整宣传视频（MP4 · 30s · 含原声 BGM）</b></a><br />
    视频动效由 <b>OpenPencil v0.8.6</b> 原生 <code>.op</code> 工程制作与导出（<a href="design/promo/jiange-promo.op"><code>design/promo/jiange-promo.op</code></a> / <a href="design/promo/build-jiange-promo.py">生成脚本</a>），配乐由本地 <b>MiniMax H3-Music</b> 器乐模型生成。
  </sub>
</p>

---

## 核心产品能力 / Full Suite Highlights

| 模块 Module | 核心能力 Capabilities |
|---|---|
| **云文档 Cloud Doc** | 自研 RGA/Fugue CRDT 实时协同、**深度离线 CRDT 协同编辑与重连自动合并**（IndexedDB 副本持久化）、15+ 块类型（含原生 `audio` / `video` / `poll` 实时投票 / `countdown` 倒计时 / `tabs` 标签页 / 表格 / 代码块 / 公式 / Mermaid / 同步块 / 多栏 / 嵌表）、**行内修订模式（Track Changes）**、划词批注与表情回应、跟随阅读、历史版本、DOCX / Markdown（含图片）导入导出与 PDF 打印 |
| **电子表格 Sheet** | WebGPU/WebGL2 百万行虚拟网格、**148 个内置公式函数**（含 `XLOOKUP` / `FILTER` / `SORT` / `UNIQUE` / `LET` / `LAMBDA` / `ARRAYFORMULA` / `QUERY` / `REGEX*` / `IMAGE`）、浮动图表、数据透视表、**行内 SVG 迷你图（Sparklines）**、行列折叠分组、单元格图片、条件格式/数据校验/保护区域、云端命名区域、版本历史与单元格变更记录、离线单元格增量合并、XLSX/CSV 导入导出、**表格 AI 公式助手** |
| **多维表格 Base** | 多表与跨表双向关联、**23 种字段类型**（含货币、进度、自动编号、动作按钮、地理位置、公式、关联、查找）、**7 种视图**（网格、看板、甘特+依赖连线、日历、画册、**层级树视图**、条件分支公开表单）、最多 3 级嵌套分组、多步自动化工作流、数据仪表盘、多角色细粒度行/列 RBAC、XLSX/CSV 导入导出、**AI 按列批量填充** |
| **幻灯片 Slides** | WebGPU/WebGL2 画布、**母版与品牌套件（Master Brand Kit）**、文本/图形/表格/图表/视频/音频形状、图片裁剪、元素逐项动画与页面切换、演讲者模式（激光笔/画笔批注 + 基于 WebSocket 的**观众实时跟随放映**）、页/元素批注评论、版本历史、离线页面草稿合并、PPTX 导入导出与 PDF 打印 |
| **画板与脑图 Board & MindMap** | 无限画布、流程图与泳道、头脑风暴便签/荧光笔/圆点投票/倒计时/小地图/分组框架、多结构思维导图、外框/概要/徽章、与大纲双向同步、Mermaid/XMind/SVG/PNG 导出 |
| **知识库、云盘与全文检索 Wiki & Drive** | **多工作空间全生命周期**（创建、一键切换、重命名、所有权转让 UI/API、成员退出、删除）、独立知识库空间与多级目录、快捷方式、**跨空间移动（个人/共享/跨工作区）**、**空间存储用量看板与配额拦截（HTTP 413）**、**全格式在线预览**（图片缩放旋转、PDF、音视频、代码/Markdown/CSV、`.docx`/`.xlsx`/`.pptx`，含公开只读文档附件富预览）、**纯 Go 附件正文全文抽取 + 可插拔 OCR（HTTP / OpenAI Vision / `tesseract`）+ 存量附件一键/CLI 回填重建索引** |
| **AI 原生工作区 Workspace AI** | **混合语义向量 + BM25 RAG 全空间知识库问答**（128 维本地向量 + 可选远端 `/embeddings` + 权限隔离 + 文档与 PDF/Office/OCR 附件引用溯源）、**全空间与单文档双路 SSE 逐字流式输出**（`POST /api/ai/workspace-ask/stream` · `POST /api/ai/doc/stream`）、表格 AI 公式生成、多维表格 AI 批量填充、OpenAI / Anthropic 兼容多模型接入（无密钥时自动降级本地引擎） |
| **企业身份与目录同步 Enterprise IAM** | **OIDC / OAuth2 + SAML 2.0 SP**（Metadata XML、AuthnRequest、原生 XML-DSig RSA/ECDSA 验签与 XXE/XSW 防护）、**SCIM 2.0（RFC 7644 完整实现）**（`ServiceProviderConfig`、`Schemas`、`ResourceTypes`、`Users`/`Groups` 全量 `PUT`/`PATCH`/`DELETE`/筛选/分页）、**LDAP v3 / 企业微信 / 钉钉主动拉取与定时同步**（原生 ASN.1 BER 客户端 + 加密凭据）、**TOTP MFA + 8 组恢复码 + 工作空间强制 MFA 策略与全局顶部引导横幅**、**WebAuthn / Passkeys（FIDO2 ES256/RS256）无密码登录**、**账号安全自助闭环**（登录/MFA/Passkey/公开链接防爆破限流、修改密码、SMTP 忘记/重置密码、活跃登录设备列表与远程踢出） |
| **安全合规与开放生态 Governance & Open** | **企业 DLP 敏感词与安全 RE2 正则防泄漏**（覆盖 Doc / Sheet / Base / Slides / Survey，拦截/告警公开分享与 CSV/公开附件导出）、**数据保留周期策略与后台定时/手动清扫**、全套件防泄密水印、公开分享密码、企业安全审计日志与 CSV 导出、**OpenAPI 3.1.0 全量契约（361 个接口 100% 路由覆盖校验 + 27 数据模型 + 交互式开发者门户）**、**PAT 个人访问令牌**、**全部 6 类空间事件 HMAC-SHA256 Webhook**、**外部通知渠道**（SMTP / 飞书 / 钉钉 / 企微 / Slack） |
| **高可用、国际化与云原生 Scale & Ops** | **4 大实时协同 Hub 全量多副本水平扩展**（Doc `syncsrv` / Base `btsync` / Sheet `sheetsync` / Slides `slidessync` 均基于 Postgres `LISTEN/NOTIFY` 跨节点广播）、**全仓中/英双语完整国际化**（5,355 条词条，0 处用户可见遗漏）、**路由级 `React.lazy` + Rollup 分包**（主包 308 KB / gzip 84 KB）、PWA + IndexedDB 离线编辑与重连自动合并（Doc / Base / Sheet / Slides）、`/healthz` + `/readyz` + Prometheus `/metrics` + W3C `traceparent`、SHA-256 校验全量备份恢复 CLI（`jiange backup` / `restore` / `reindex-attachments`）、生产级 **Helm Chart** 与 **Kustomize** 清单 |

### 产品界面预览 / Product Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <img src="design/screenshots/cloud-doc.png" alt="Cloud Doc" width="100%" /><br />
      <b>云文档 · Cloud Doc</b><br />
      <sub>自研 CRDT 实时/离线协同、多级目录大纲与丰富块编辑</sub>
    </td>
    <td align="center" width="50%">
      <img src="design/screenshots/sheet.png" alt="Sheet" width="100%" /><br />
      <b>电子表格 · Sheet</b><br />
      <sub>WebGPU 虚拟网格、148 个内置公式函数与浮动图表</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="design/screenshots/base.png" alt="Base" width="100%" /><br />
      <b>多维表格 · Base</b><br />
      <sub>23 种字段、表格/看板/甘特/层级多视图与 AI 批量填充</sub>
    </td>
    <td align="center" width="50%">
      <img src="design/screenshots/slides.png" alt="Slides" width="100%" /><br />
      <b>幻灯片 · Slides</b><br />
      <sub>WebGPU 演示画布、矢量图表/表格、母版套件与 PPTX 互通</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="design/screenshots/board.png" alt="Board & MindMap" width="100%" /><br />
      <b>画板与脑图 · Board &amp; MindMap</b><br />
      <sub>无限画布、跨部门泳道流程图、思维导图与小地图导航</sub>
    </td>
    <td align="center" width="50%">
      <img src="design/screenshots/workspace-ai.png" alt="Workspace AI" width="100%" /><br />
      <b>知识库 AI 问答 · Workspace AI</b><br />
      <sub>混合语义向量 + BM25 RAG 全空间问答与可点击引用溯源</sub>
    </td>
  </tr>
</table>

---

## 快速使用 / Quick Start

你可以按需以 **完整自托管套件**、**npm TypeScript/WebGPU SDK**、**Go 可嵌入后端 SDK** 或 **Go CLI / AI MCP Server** 四种方式接入 Jiange：

### 1. 一键运行完整协作套件（Docker）

```bash
# 方式 A：Docker Compose 一键启动（Postgres 16 + MinIO + Jiange 全家桶）
git clone https://github.com/ZSeven-W/jiange.git && cd jiange
docker compose up -d --build
# 访问 http://localhost:8080 注册首个空间管理员即可使用

# 方式 B：直接拉取 GHCR 预构建多架构镜像（linux/amd64 & linux/arm64）
docker pull ghcr.io/zseven-w/jiange:latest
docker run -d --name jiange -p 8080:8080 \
  -e DATABASE_URL="postgres://jiange:jiange@host.docker.internal:5432/jiange?sslmode=disable" \
  -e JIANGE_SECURE_COOKIES="false" \
  -e JIANGE_SECRET_KEY="$(openssl rand -hex 32)" \
  -v jiange_blobs:/data/blobs \
  ghcr.io/zseven-w/jiange:latest
```

> 生产 Kubernetes 部署请直接使用 Helm Chart（`helm upgrade --install jiange ./deploy/helm/jiange`），详见 [deploy/README.md](deploy/README.md)。

### 2. 使用 TypeScript / WebGPU SDK（npm `@zseven-w/*`）

全部 **13 个零第三方依赖包** 已发布至 npmjs.com（`0.2.0`），支持按模块独立安装：

```bash
# 按需安装 Headless 引擎（Node.js / 浏览器 / Edge / AI Agent 均可运行）
npm install @zseven-w/sheet-sdk        # 电子表格（148 公式 + XLSX/CSV + AI 工具）
npm install @zseven-w/doc-sdk          # 云文档（CRDT + MD/HTML/DOCX + 批注修订）
npm install @zseven-w/base-sdk         # 多维表格（23 字段 + 7 视图 + 公式关联）
npm install @zseven-w/slides-sdk       # 幻灯片（PPTX + 纯 TS 16:9 SVG）
npm install @zseven-w/whiteboard-sdk   # 画板与脑图（Mermaid + DAG 布局 + XMind）

# 可选：按需安装 WebGPU/WebGL2 + 虚拟列表 UI 组件（零 Canvas 2D，含原生 mount / React / Web Components）
npm install @zseven-w/sheet-ui @zseven-w/doc-ui @zseven-w/base-ui @zseven-w/slides-ui @zseven-w/whiteboard-ui
```

Headless 公式计算 + AI 工具试算（`dryRun`）+ 导出 `.xlsx` 示例：

```ts
import { Workbook, createSheetTools } from "@zseven-w/sheet-sdk";

const wb = Workbook.fromCsv("Product,Units,UnitPrice\nPro,120,49\nEnterprise,25,299\n", "Q4");
const tools = createSheetTools(wb);

// AI Agent 先 dryRun 校验再提交，自动增量重算公式
tools.execute("sheet_apply", {
  ops: [
    {
      op: "setCells",
      sheet: "Q4",
      cells: [
        { a1: "D1", raw: "Revenue" },
        { a1: "D2", raw: "=B2*C2" },
        { a1: "D3", raw: "=B3*C3" },
        { a1: "D4", raw: "=SUM(D2:D3)" },
      ],
    },
  ],
});

console.log(wb.sheet("Q4").getValue("D4")); // 13355
const xlsxBytes = await wb.toXlsxAsync();   // 标准 DEFLATE .xlsx 字节流
```

在浏览器中挂载 WebGPU/WebGL2 虚拟网格（原生 DOM / React / `<jiange-sheet>` 均可）：

```ts
import { mountSheetView } from "@zseven-w/sheet-ui";

const view = await mountSheetView(document.getElementById("sheet-root")!, wb);
// 销毁时调用 view.dispose()
```

### 3. 在 Go 服务中嵌入后端 SDK（`sdk/go` & `sdk/go-pgstore`）

```bash
go get github.com/ZSeven-W/jiange/sdk/go@v0.2.0
go get github.com/ZSeven-W/jiange/sdk/go-pgstore@v0.2.0   # 可选 PostgreSQL 持久化适配器
```

```go
package main

import (
	"net/http"

	"github.com/ZSeven-W/jiange/sdk/go/server"
	"github.com/ZSeven-W/jiange/sdk/go/storage"
)

func main() {
	app := server.New(server.Config{
		Store:   storage.NewMemoryStore(), // 生产可替换为 pgstore.New(db)
		Auth:    storage.NewBearerTokenAuth(map[string]storage.Principal{"my-token": {ID: "u-1", Name: "Admin", Roles: []string{"admin"}}}),
		Version: "0.2.0",
	})
	mux := http.NewServeMux()
	mux.Handle("/api/v1/", http.StripPrefix("/api/v1", app))
	_ = http.ListenAndServe(":8090", mux)
}
```

### 4. 使用 Go CLI 与 AI Agent MCP Server（`jiange`）

```bash
# 从 Go Module 安装（或直接前往 GitHub Releases 下载 5 平台预编译静态二进制）
go install github.com/ZSeven-W/jiange/cli/cmd/jiange@v0.2.0

# 本地直接读写办公文件（零 Node.js 依赖）
jiange sheet inspect budget.xlsx --detail full
jiange sheet patch budget.xlsx --ops '[{"op":"setCell","sheet":"Sheet1","a1":"B2","raw":"=SUM(A1:A10)"}]' --out out.xlsx
jiange doc convert spec.md --out spec.docx
jiange slides render deck.pptx --slide 0 --out slide1.svg
jiange board render arch.mmd --out arch.svg

# 启动 MCP Server（支持 stdio 或 Streamable HTTP）
jiange mcp --transport stdio
jiange mcp --transport http --addr 127.0.0.1:8787
```

在 **Claude Desktop / Cursor / Antigravity** 等 MCP 客户端中直接配置：

```json
{
  "mcpServers": {
    "jiange": {
      "command": "jiange",
      "args": ["mcp", "--transport", "stdio"]
    }
  }
}
```

> 预编译 CLI 二进制（Linux / macOS / Windows `amd64` & `arm64`）与全部 SDK 离线包见 [GitHub Releases (`sdk-v0.2.0`)](https://github.com/ZSeven-W/jiange/releases/tag/sdk-v0.2.0)，完整 API 参考见 [sdk-docs/getting-started.md](sdk-docs/getting-started.md)。

---

## 目录 / Layout

```text
apps/web              Jiange 主产品 Web 前端 (React + Vite + TS + TanStack Query + Tailwind + shadcn/ui)
server/               Jiange 主产品 Go 后端: cmd/jiange, internal/{api,auth,backup,blob,btformula,btquery,btsync,config,httpx,migrate,sheetstore,sheetsync,slidessync,store,syncsrv,tableadmission}, collab
packages/
  ooxml               L0: 零依赖同步 STORE + 异步 DEFLATE ZIP 与有界安全 XML
  collab              L0: 协同内核 (RGA/Fugue CRDT, 离线快照注水与自动合并, Undo, ./table, ./ws, ./storage, ./ai-agent)
  sheet-sdk           L1: 无头 AI-Native 电子表格 SDK (AST+DAG 增量公式引擎 148 函数, XLSX/CSV, Worker)
  doc-sdk             L1: 无头 AI-Native 文档 SDK (Document Facade, MD/HTML/DOCX, 批注与修订)
  slides-sdk          L1: 无头 AI-Native 演示文稿 SDK (Presentation, PPTX, 纯 TS 16:9 SVG, 媒体与裁剪)
  whiteboard-sdk      L1: 无头 AI-Native 白板/脑图 SDK (Board, Mermaid 双向, DAG 布局, XMind, SVG)
  base-sdk            L1: 零依赖无头 AI-Native 多维表格 SDK (23 字段, 7 视图, 公式, 关联查找, 仪表盘, CSV)
  render-gpu          L2: 零 Canvas 2D 渲染核 (WebGPU/WebGL2 SDF+GlyphAtlas, 百万行 Fenwick 虚拟列表, SpatialIndex)
  {sheet,doc,slides,whiteboard,base}-ui
                      L2: 5 个独立轻量 UI SDK (原生 mount, ./react, <jiange-*> Web Components)
cli/                  零外部依赖 Go 1.23 原生 CLI & Streamable HTTP/stdio MCP Server (单静态二进制 ~5.5 MB)
sdk/go/               零外部依赖 Go 1.23 可嵌入后端 SDK (10 包: storage, sync, 5 域引擎, ai, server, client)
sdk/go-pgstore/       可选 PostgreSQL storage.Store 适配器 (标准 database/sql, 兼容 pgx/v5/stdlib 与 lib/pq)
sdk-docs/             完整 SDK 使用指南、API 参考、AI-Native 协议、WebGPU UI 与 Go 接入文档
deploy/               生产级 Kubernetes Helm Chart (deploy/helm/jiange)、Kustomize 清单 (deploy/k8s) 与运维手册
e2e/                  Playwright 自动化浏览器端到端回归测试套件 (与 GitHub Actions CI `e2e` 流水线联动)
benchmarks/           RFC §7 量化性能 SLA、包体积、零 Canvas 2D 与 13 包隔离安装自动化门禁
examples/             可运行示例: ts-headless、go-backend、零构建 WebGPU/WebGL2 ui-playground
design/               OpenPencil 设计源文件（jiange.op）与宣传片工程（promo/jiange-promo.op + mp4）
spec/                 PROTOCOL.md 协同协议规范 + vectors/ TS/Go 跨语言一致性向量
docker-compose.yml    Postgres + MinIO
```

## SDK 与运维文档导航 / Documentation

- **SDK 文档首页**：[sdk-docs/README.md](sdk-docs/README.md)
- **5 分钟快速上手**：[sdk-docs/getting-started.md](sdk-docs/getting-started.md)
- **Headless TS SDK 手册**：[sdk-docs/headless-sdks.md](sdk-docs/headless-sdks.md)
- **WebGPU/WebGL2 + 虚拟列表 UI SDK 手册**：[sdk-docs/gpu-ui-sdks.md](sdk-docs/gpu-ui-sdks.md)
- **AI-Native 协议与工具规范**：[sdk-docs/ai-native-protocol.md](sdk-docs/ai-native-protocol.md)
- **Go 后端 SDK、PostgreSQL 适配器与 Go CLI/MCP**：[sdk-docs/go-backend-and-cli.md](sdk-docs/go-backend-and-cli.md)
- **性能基准、包体积与发版指南**：[sdk-docs/performance-and-release.md](sdk-docs/performance-and-release.md)
- **总览与架构摘要**：[headless-sdk.md](headless-sdk.md)
- **生产部署、Helm/K8s 与备份恢复指南**：[deploy/README.md](deploy/README.md)
- **Playwright E2E 测试手册**：[e2e/README.md](e2e/README.md)

## 允许的基础库 / Allowed Foundational Libraries

| 层 Layer | 依赖 Dependencies |
|---|---|
| Headless & GPU SDK (`packages/*`) | **零第三方运行时依赖**（纯 ES2022 TypeScript） |
| Go SDK & CLI (`sdk/go`, `sdk/go-pgstore`, `cli`) | **零第三方运行时依赖**（纯 Go 1.23 标准库） |
| Web App (`apps/web`) | react, react-dom, @tanstack/react-query, tailwindcss, shadcn/ui（及其 @radix-ui/*, class-variance-authority, clsx, tailwind-merge） |
| Main Server (`server/`) | 标准库 stdlib（含纯 Go SAML 2.0 / LDAP v3 BER / WebAuthn CBOR+COSE / PDF+OOXML 抽取 / Prometheus）, github.com/jackc/pgx/v5, github.com/coder/websocket |
| Dev & E2E | vite, typescript, vitest, tsx, @playwright/test |

不使用 Yjs / Tiptap / ProseMirror / 任何重型 DI 容器、Web 框架或 ORM。No Yjs, Tiptap, ProseMirror, heavy DI containers, web frameworks, or ORMs.

## 本地运行与运维 / Run Locally & Production Ops

Requirements: Node 20+, pnpm 10, Go 1.23+ (`server/` requires Go matching `server/go.mod`), Docker (for Postgres).

```bash
pnpm install
docker compose up -d postgres            # postgres://jiange:jiange@localhost:5432/jiange

cd server && go run ./cmd/jiange         # :8080, runs migrations (0001..0092) on start
# 另开终端 / another terminal
pnpm --filter @jiange/web dev            # http://localhost:5173 (proxies /api & /scim -> :8080)
```

数据备份恢复与附件全文索引回填 / Backup, Restore & Attachment Index Backfill:

```bash
cd server
go run ./cmd/jiange backup /path/to/jiange-backup.tar.gz
go run ./cmd/jiange restore /path/to/jiange-backup.tar.gz
go run ./cmd/jiange reindex-attachments [workspaceId]
```

体验零构建 WebGPU/WebGL2 + 虚拟列表 UI SDK Playground：

```bash
pnpm -r build
node examples/ui-playground/serve.mjs    # http://127.0.0.1:4173
```

环境变量 / Env: `DATABASE_URL`, `JIANGE_ADDR` (default `:8080`), `JIANGE_SESSION_TTL` (default `720h`), `JIANGE_SECURE_COOKIES=true` behind HTTPS, `JIANGE_SECRET_KEY` (AES-256-GCM sealing for AI keys / SSO secrets / LDAP-WeCom-DingTalk connector credentials / Webhook & Notification channel secrets), `JIANGE_METRICS_TOKEN` (optional Bearer token guarding `/metrics`), `JIANGE_AI_EMBEDDING_MODEL` (optional remote `/embeddings` model name), `JIANGE_OCR_URL` / `JIANGE_OCR_MODE` / `JIANGE_OCR_API_KEY` / `JIANGE_OCR_TESSERACT` (optional OCR for images & scanned PDFs), `JIANGE_BLOB_DIR` (local disk blob dir, overrides S3 when set).

文档待确认操作的安全停止默认关闭。部署时先应用数据库迁移、升级并排空所有旧的文档写入实例，再设置 `JIANGE_ENABLE_CONDITIONAL_CANCEL=true`；启用后不能让不支持停止屏障的旧实例重新写入。详见 [docs/deploy.md](docs/deploy.md) 与 [deploy/README.md](deploy/README.md)。

### Attachments (MinIO / S3)

Set `JIANGE_S3_ENDPOINT` (e.g. `http://localhost:9000`), `JIANGE_S3_ACCESS_KEY`, `JIANGE_S3_SECRET_KEY` and optionally `JIANGE_S3_BUCKET` (default `jiange`; created on start). Without an endpoint (or `JIANGE_BLOB_DIR`), uploads are disabled. With docker-compose: `JIANGE_S3_ENDPOINT=http://localhost:9000 JIANGE_S3_ACCESS_KEY=jiange JIANGE_S3_SECRET_KEY=jiange-dev-secret`.

## 测试与门禁 / Tests & Quality Gates

```bash
pnpm lint:names                          # 全仓 kebab-case 路径校验（1,960+ 追踪路径）
pnpm -r build && pnpm -r typecheck       # 全部 13 个 SDK/UI 包 + apps/web 构建与类型校验
pnpm test                                # 全仓 Vitest 单测（apps/web 313 文件 / 1,814 用例）
pnpm test:sdk:coverage                   # 全部 13 个 TS SDK/UI 包 100/100/100/100 V8 覆盖率门禁
pnpm test:sdk:pack                       # 真实 pnpm pack 隔离 Node ESM 与 NodeNext 类型验证
pnpm test:e2e                            # Playwright 全套浏览器端到端回归（登录/空间/四件套/管理台/双语/离线）
pnpm bench                               # RFC §7 全部 7 项性能 SLA、零 Canvas 2D 与 13 包隔离安装验证
pnpm gen:vectors                         # 修改协同内核后重新生成 spec/vectors

cd cli && go test -race -cover ./...             # Go CLI & MCP (4 包 100.0% 覆盖)
cd sdk/go && go test -race -cover ./...          # Go 后端 SDK (10 包 100.0% 覆盖)
cd sdk/go-pgstore && go test -race -cover ./...  # PostgreSQL 适配器 (100.0% 覆盖)
cd server && go test ./... && go vet ./...       # Jiange 主服务端 20 包全测（含 OpenAPI 100% 路由一致 & 多副本同步）
JIANGE_TEST_DATABASE_URL=postgres://jiange:jiange@localhost:5432/jiange_test?sslmode=disable go test ./internal/store
go test ./collab -run '^$' -fuzz '^FuzzDecode$' -fuzztime 30s
```

跨语言一致性：TS 生成 `spec/vectors/encoding.json`（ops ↔ 十六进制字节）和 `scenarios.json`（ops → 期望物化视图，含 5 个随机 3 副本会话）。Go 测试逐字节比对编码，并以 25 种随机乱序 + 重复投递重放每个场景，结果必须与 TS 完全一致。

## 核心认证、可观测与开放 API / Auth, Ops & Open API

完整 361 个接口契约可直接访问 `GET /api/openapi.json` 或在管理后台「开发者 / API」页签交互式浏览与复制 cURL。

| Method | Path | 说明 |
|---|---|---|
| GET | `/healthz` · `/readyz` · `/metrics` | 存活探针、DB/存储就绪探针与 Prometheus 0.0.4 监控指标 |
| GET | `/api/openapi.json` | 完整 OpenAPI 3.1.0 规范（361 接口、27 数据模型） |
| GET/POST/PUT/PATCH/DELETE | `/scim/v2/{ServiceProviderConfig,Schemas,ResourceTypes,Users,Groups}` | RFC 7643/7644 SCIM 2.0 组织成员与群组同步（`admin` 作用域 PAT） |
| POST | `/api/auth/register` · `/api/auth/login` · `/api/auth/mfa/verify` · `/api/auth/password-reset/{request,confirm}` | 注册、密码登录（含限流、TOTP/恢复码二步挑战与强制 MFA 策略）及 SMTP 密码重置 |
| POST | `/api/auth/passkey/login/{begin,finish}` | WebAuthn / Passkeys（FIDO2 ES256/RS256）无密码登录 |
| GET/POST | `/api/auth/sso/{slug}/{start,callback,metadata.xml,acs}` | 企业 OIDC / OAuth2 与 SAML 2.0 SP 单点登录 |
| GET/POST/DELETE | `/api/me` · `/api/me/password` · `/api/me/sessions` · `/api/me/passkeys` · `/api/me/tokens` | 当前用户、修改密码、活跃设备会话管理/踢出、通行密钥与 PAT 令牌 |
| GET/POST/PATCH/DELETE | `/api/workspaces` · `/api/workspaces/{wsId}` | 多工作空间创建、切换、重命名、所有权转让（`/transfer-owner`）、退出（`/leave`）与删除 |
| GET/PUT/POST | `/api/workspaces/{wsId}/storage` · `/storage/quota` · `/attachments/reindex` | 空间存储用量看板、配额上限（413 拦截）与存量附件全文/OCR 回填重建索引 |
| POST | `/api/workspaces/{wsId}/org/sync-sources/{sourceId}/pull` | 触发 LDAP v3 / 企业微信 / 钉钉主动目录拉取（支持 Dry-Run） |
| POST | `/api/workspaces/{wsId}/dlp/check` · `/retention/run` | 企业 DLP 敏感词/正则实时试测与数据保留周期即时清理 |
| POST | `/api/ai/ask-workspace` · `/api/ai/workspace-ask/stream` · `/api/ai/doc/stream` | 混合语义向量 RAG 全空间问答与单文档 AI 写作（均支持 SSE 逐字流式输出） |
| GET/POST | `/api/workspaces/{wsId}/webhooks` · `/notification-channels` | 全部 6 类空间事件 HMAC-SHA256 Webhook 与外部通知渠道（SMTP/飞书/钉钉/企微/Slack） |

会话：32 字节随机 token，仅存 SHA-256 哈希；Cookie `HttpOnly; SameSite=Lax`。密码：PBKDF2-HMAC-SHA256（600k 次，Go 标准库 `crypto/pbkdf2`）。写请求必须为 `application/json`（配合 SameSite 防 CSRF，SAML HTTP-POST ACS 与带自定义头的上传端点除外）。

## 设计 / Design

UI 先在 OpenPencil 中设计（`design/jiange.op`），预览见 `design/previews/`，设计变量（`design/vars.json`）映射为 `apps/web/src/index.css` 中的 Tailwind/shadcn 主题变量；宣传视频由 OpenPencil v0.8.6 原生 `.op` 动效导出（`design/promo/jiange-promo.op`）。

## 许可 / License

本项目采用分组件许可，完整条款见 [LICENSE](./LICENSE)：

- **应用部分（`apps/`、`server/` 等）**：个人与非商业使用免费；商业使用（含企业内部生产经营、托管/SaaS、集成进商业产品或收费服务等）需事先购买商业授权。
- **SDK 部分（`packages/*`、`sdk/*`、`cli/*`）**：个人与商业使用全部免费；若企业对 SDK 进行二次开发（修改、扩展、裁剪或基于源码衍生），须在产品文档、关于页面或源码仓库说明等公开位置明确说明来源（基于 Jiange SDK）。

Application (`apps/`, `server/`, etc.): free for personal & non-commercial use; commercial use requires a paid license. SDKs (`packages/*`, `sdk/*`, `cli/*`): free for all uses (including commercial), provided that enterprises performing secondary development publicly attribute Jiange SDK as the source. See [LICENSE](./LICENSE).

---

文件及目录默认使用 kebab-case，代码标识符遵循各语言惯例。Go 平台及测试后缀、已应用的数据库迁移文件名、`README.md` / `README.<lang>.md`、`CHANGELOG.md`、`Dockerfile`、`Chart.yaml`、`NOTES.txt`、`_helpers.tpl`、许可证文件等保留工具约定；`pnpm lint:names` 可检查 Git 跟踪的路径。SDK 保留旧的 camelCase 子路径作为兼容入口，新代码请使用 kebab-case 子路径。
