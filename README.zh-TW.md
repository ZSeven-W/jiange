# Jiange

<p align="center">
  <img src="apps/web/public/brand/jiange-lockup.svg" width="240" alt="Jiange" />
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md">English</a> ·
  <b>繁體中文</b> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <strong>開源的飛書／Lark 雲端文件 + 試算表 + 多維表格 + 簡報 + 白板／心智圖完整協作套件</strong><br />
  <sub>AI 原生 · 輕量可拆 · 政府與企業安全合規 · 多副本高可用 · 全倉雙語與離線 CRDT · 零 Canvas 2D（WebGPU/WebGL2 + 虛擬列表）</sub>
</p>

<p align="center">
  開源、可自託管、企業級、AI 原生的飛書／Lark 替代方案，涵蓋文件、試算表、多維表格、簡報與白板／心智圖——從零打造自研 CRDT 引擎、純標準函式庫 Go 後端（SAML 2.0、OIDC、SCIM 2.0、LDAP／企業微信／釘釘、WebAuthn Passkeys、DLP、Prometheus、OpenAPI 3.1）、13 套零依賴 TypeScript/WebGPU SDK，以及單一二進位 Go CLI 與 MCP Server。
</p>

---

## 宣傳影片

<p align="center">
  <a href="design/promo/jiange-promo.mp4">
    <img src="design/promo/jiange-promo-cover.png" alt="Jiange 宣傳影片 — 點擊觀看" width="100%" />
  </a>
</p>

<p align="center">
  <sub>
    ▶ <a href="design/promo/jiange-promo.mp4"><b>點擊觀看完整宣傳影片（MP4 · 30s · 含原聲 BGM）</b></a><br />
    影片動態效果由 <b>OpenPencil v0.8.6</b> 原生 <code>.op</code> 專案製作並匯出（<a href="design/promo/jiange-promo.op"><code>design/promo/jiange-promo.op</code></a> / <a href="design/promo/build-jiange-promo.py">產生腳本</a>），配樂由本機 <b>MiniMax H3-Music</b> 器樂模型產生。
  </sub>
</p>

---

## 核心產品能力

| 模組 | 核心能力 |
|---|---|
| **雲端文件** | 自研 RGA/Fugue CRDT 即時協作、**深度離線 CRDT 協同編輯與重連自動合併**（IndexedDB 副本持久化）、15+ 種區塊類型（含原生 `audio` / `video` / `poll` 即時投票 / `countdown` 倒數計時 / `tabs` 分頁標籤 / 表格 / 程式碼區塊 / 數學公式 / Mermaid / 同步區塊 / 多欄排版 / 嵌入式表格）、**行內修訂模式（Track Changes）**、劃詞註解與表情符號回應、跟隨閱讀、版本紀錄、DOCX / Markdown（含圖片）匯入匯出與 PDF 列印 |
| **試算表** | WebGPU/WebGL2 百萬列虛擬格線、**148 個內建公式函式**（含 `XLOOKUP` / `FILTER` / `SORT` / `UNIQUE` / `LET` / `LAMBDA` / `ARRAYFORMULA` / `QUERY` / `REGEX*` / `IMAGE`）、浮動圖表、樞紐分析表、**行內 SVG 走勢圖（Sparklines）**、列與欄摺疊群組、儲存格圖片、條件式格式設定／資料驗證／保護範圍、雲端已命名範圍、版本紀錄與儲存格變更紀錄、離線儲存格增量合併、XLSX/CSV 匯入匯出、**試算表 AI 公式助手** |
| **多維表格** | 多資料表與跨表雙向關聯、**23 種欄位類型**（含貨幣、進度、自動編號、動作按鈕、地理位置、公式、關聯、查閱）、**7 種檢視模式**（格狀表格、看板、甘特圖含相依連線、行事曆、畫廊、**階層樹狀檢視**、條件分支公開表單）、最多 3 層巢狀分組、多步驟自動化工作流程、資料儀表板、多角色細粒度列／欄 RBAC 權限控管、XLSX/CSV 匯入匯出、**AI 依欄位批次填寫** |
| **簡報** | WebGPU/WebGL2 畫布、**母片與品牌套件（Master Brand Kit）**、文字／圖形／表格／圖表／影片／音訊元件、圖片裁切、元件逐項動畫與投影片轉場效果、演講者模式（雷射筆／畫筆標註 + 基於 WebSocket 的**觀眾即時跟隨放映**）、投影片／元件註解評論、版本紀錄、離線頁面草稿合併、PPTX 匯入匯出與 PDF 列印 |
| **白板與心智圖** | 無限畫布、流程圖與泳道圖、腦力激盪便利貼／螢光筆／圓點投票／倒數計時／小地圖／分組框架、多結構心智圖、外框／摘要／徽章、與大綱雙向同步、Mermaid / XMind / SVG / PNG 匯出 |
| **知識庫、雲端硬碟與全文檢索** | **多工作空間完整生命週期**（建立、一鍵切換、重新命名、所有權轉讓 UI/API、成員退出、刪除）、獨立知識庫空間與多層目錄、捷徑、**跨空間移動（個人／共用／跨工作空間）**、**空間儲存用量儀表板與配額攔截（HTTP 413）**、**全格式線上預覽**（圖片縮放旋轉、PDF、影音、程式碼／Markdown／CSV、`.docx`／`.xlsx`／`.pptx`，含公開唯讀文件附件豐富預覽）、**純 Go 附件內文全文擷取 + 可插拔 OCR（HTTP / OpenAI Vision / `tesseract`）+ 既有附件一鍵／CLI 回填重建索引** |
| **AI 原生工作區** | **混合語意向量 + BM25 RAG 全空間知識庫問答**（128 維本機向量 + 選配遠端 `/embeddings` + 權限隔離 + 文件與 PDF／Office／OCR 附件引用溯源）、**全空間與單一文件雙路 SSE 逐字串流輸出**（`POST /api/ai/workspace-ask/stream` · `POST /api/ai/doc/stream`）、試算表 AI 公式產生、多維表格 AI 批次填寫、OpenAI / Anthropic 相容多模型接入（未設定金鑰時自動降級至本機引擎） |
| **企業身分認證與目錄同步** | **OIDC / OAuth2 + SAML 2.0 SP**（Metadata XML、AuthnRequest、原生 XML-DSig RSA/ECDSA 驗簽與 XXE/XSW 防護）、**SCIM 2.0（RFC 7644 完整實作）**（`ServiceProviderConfig`、`Schemas`、`ResourceTypes`、`Users`/`Groups` 完整 `PUT`/`PATCH`/`DELETE`/篩選/分頁）、**LDAP v3／企業微信／釘釘主動拉取與排程同步**（原生 ASN.1 BER 用戶端 + 加密憑證）、**TOTP MFA + 8 組復原碼 + 工作空間強制 MFA 原則與全域頂部引導橫幅**、**WebAuthn / Passkeys（FIDO2 ES256/RS256）無密碼登入**、**帳號安全自助閉環**（登入／MFA／Passkey／公開連結防暴力破解限流、變更密碼、SMTP 忘記／重設密碼、活躍登入裝置清單與遠端登出） |
| **安全合規與開放生態** | **企業 DLP 敏感詞與安全 RE2 正規表示式防外洩**（涵蓋 Doc / Sheet / Base / Slides / Survey，攔截或告警公開分享與 CSV／公開附件匯出）、**資料保留週期原則與背景排程／手動清理**、全套件防外洩浮水印、公開分享密碼、企業安全稽核日誌與 CSV 匯出、**OpenAPI 3.1.0 完整契約（361 個 API 端點 100% 路由覆蓋驗證 + 27 個資料模型 + 互動式開發者入口）**、**個人存取權杖（PAT）**、**全部 6 類空間事件 HMAC-SHA256 Webhook**、**外部通知管道**（SMTP／飛書／釘釘／企業微信／Slack） |
| **高可用、國際化與雲原生維運** | **4 大即時協作 Hub 全量多副本水平擴展**（Doc `syncsrv` / Base `btsync` / Sheet `sheetsync` / Slides `slidessync` 皆基於 Postgres `LISTEN/NOTIFY` 跨節點廣播）、**全倉中／英雙語完整國際化**（5,355 條詞條，0 處使用者可見遺漏）、**路由層級 `React.lazy` + Rollup 程式碼分割**（主套件 308 KB / gzip 84 KB）、PWA + IndexedDB 離線編輯與重連自動合併（Doc / Base / Sheet / Slides）、`/healthz` + `/readyz` + Prometheus `/metrics` + W3C `traceparent`、SHA-256 校驗全量備份與還原 CLI（`jiange backup` / `restore` / `reindex-attachments`）、生產級 **Helm Chart** 與 **Kustomize** 部署清單 |

### 產品介面預覽

<table>
  <tr>
    <td align="center" width="50%">
      <img src="design/screenshots/cloud-doc.png" alt="雲端文件" width="100%" /><br />
      <b>雲端文件（Cloud Doc）</b><br />
      <sub>自研 CRDT 即時／離線協同、多層目錄大綱與豐富區塊編輯</sub>
    </td>
    <td align="center" width="50%">
      <img src="design/screenshots/sheet.png" alt="試算表" width="100%" /><br />
      <b>試算表（Sheet）</b><br />
      <sub>WebGPU 虛擬格線、148 個內建公式函式與浮動圖表</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="design/screenshots/base.png" alt="多維表格" width="100%" /><br />
      <b>多維表格（Base）</b><br />
      <sub>23 種欄位、表格／看板／甘特／階層多檢視與 AI 批次填寫</sub>
    </td>
    <td align="center" width="50%">
      <img src="design/screenshots/slides.png" alt="簡報" width="100%" /><br />
      <b>簡報（Slides）</b><br />
      <sub>WebGPU 簡報畫布、向量圖表／表格、母片套件與 PPTX 互通</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="design/screenshots/board.png" alt="白板與心智圖" width="100%" /><br />
      <b>白板與心智圖（Board &amp; MindMap）</b><br />
      <sub>無限畫布、跨部門泳道流程圖、心智圖與小地圖導覽</sub>
    </td>
    <td align="center" width="50%">
      <img src="design/screenshots/workspace-ai.png" alt="知識庫 AI 問答" width="100%" /><br />
      <b>知識庫 AI 問答（Workspace AI）</b><br />
      <sub>混合語意向量 + BM25 RAG 全空間問答與可點擊引用溯源</sub>
    </td>
  </tr>
</table>

---

## 快速使用

你可以依需求以 **完整自託管套件**、**npm TypeScript/WebGPU SDK**、**Go 可嵌入後端 SDK** 或 **Go CLI / AI MCP Server** 四種方式導入 Jiange：

### 1. 一鍵執行完整協作套件（Docker）

```bash
# 方式 A：Docker Compose 一鍵啟動（Postgres 16 + MinIO + Jiange 完整套件）
git clone https://github.com/ZSeven-W/jiange.git && cd jiange
docker compose up -d --build
# 開啟 http://localhost:8080 註冊首位空間管理員即可使用

# 方式 B：直接拉取 GHCR 預建置多架構映像檔（linux/amd64 & linux/arm64）
docker pull ghcr.io/zseven-w/jiange:latest
docker run -d --name jiange -p 8080:8080 \
  -e DATABASE_URL="postgres://jiange:jiange@host.docker.internal:5432/jiange?sslmode=disable" \
  -e JIANGE_SECURE_COOKIES="false" \
  -e JIANGE_SECRET_KEY="$(openssl rand -hex 32)" \
  -v jiange_blobs:/data/blobs \
  ghcr.io/zseven-w/jiange:latest
```

> 生產環境 Kubernetes 部署請直接使用 Helm Chart（`helm upgrade --install jiange ./deploy/helm/jiange`），詳見 [deploy/README.md](deploy/README.md)。

### 2. 使用 TypeScript / WebGPU SDK（npm `@zseven-w/*`）

全部 **13 套零第三方依賴套件** 均已發佈至 npmjs.com（`0.2.0`），支援依模組獨立安裝：

```bash
# 依需求安裝 Headless 引擎（Node.js / 瀏覽器 / Edge / AI Agent 皆可執行）
npm install @zseven-w/sheet-sdk        # 試算表（148 公式 + XLSX/CSV + AI 工具）
npm install @zseven-w/doc-sdk          # 雲端文件（CRDT + MD/HTML/DOCX + 註解與修訂）
npm install @zseven-w/base-sdk         # 多維表格（23 欄位 + 7 檢視 + 公式關聯）
npm install @zseven-w/slides-sdk       # 簡報（PPTX + 純 TS 16:9 SVG）
npm install @zseven-w/whiteboard-sdk   # 白板與心智圖（Mermaid + DAG 版面配置 + XMind）

# 選配：依需求安裝 WebGPU/WebGL2 + 虛擬列表 UI 元件（零 Canvas 2D，含原生 mount / React / Web Components）
npm install @zseven-w/sheet-ui @zseven-w/doc-ui @zseven-w/base-ui @zseven-w/slides-ui @zseven-w/whiteboard-ui
```

Headless 公式運算 + AI 工具預檢試算（`dryRun`）+ 匯出 `.xlsx` 範例：

```ts
import { Workbook, createSheetTools } from "@zseven-w/sheet-sdk";

const wb = Workbook.fromCsv("Product,Units,UnitPrice\nPro,120,49\nEnterprise,25,299\n", "Q4");
const tools = createSheetTools(wb);

// AI Agent 先透過 dryRun 驗證再提交，自動增量重算公式
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
const xlsxBytes = await wb.toXlsxAsync();   // 標準 DEFLATE .xlsx 位元組串流
```

在瀏覽器中掛載 WebGPU/WebGL2 虛擬格線（原生 DOM / React / `<jiange-sheet>` 皆適用）：

```ts
import { mountSheetView } from "@zseven-w/sheet-ui";

const view = await mountSheetView(document.getElementById("sheet-root")!, wb);
// 銷毀時呼叫 view.dispose()
```

### 3. 在 Go 服務中嵌入後端 SDK（`sdk/go` & `sdk/go-pgstore`）

```bash
go get github.com/ZSeven-W/jiange/sdk/go@v0.2.0
go get github.com/ZSeven-W/jiange/sdk/go-pgstore@v0.2.0   # 選配 PostgreSQL 持久化配接器
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
		Store:   storage.NewMemoryStore(), // 生產環境可改用 pgstore.New(db)
		Auth:    storage.NewBearerTokenAuth(map[string]storage.Principal{"my-token": {ID: "u-1", Name: "Admin", Roles: []string{"admin"}}}),
		Version: "0.2.0",
	})
	mux := http.NewServeMux()
	mux.Handle("/api/v1/", http.StripPrefix("/api/v1", app))
	_ = http.ListenAndServe(":8090", mux)
}
```

### 4. 使用 Go CLI 與 AI Agent MCP Server（`jiange`）

```bash
# 從 Go Module 安裝（或直接前往 GitHub Releases 下載 5 平台預編譯靜態二進位檔）
go install github.com/ZSeven-W/jiange/cli/cmd/jiange@v0.2.0

# 本機直接讀寫辦公檔案（零 Node.js 依賴）
jiange sheet inspect budget.xlsx --detail full
jiange sheet patch budget.xlsx --ops '[{"op":"setCell","sheet":"Sheet1","a1":"B2","raw":"=SUM(A1:A10)"}]' --out out.xlsx
jiange doc convert spec.md --out spec.docx
jiange slides render deck.pptx --slide 0 --out slide1.svg
jiange board render arch.mmd --out arch.svg

# 啟動 MCP Server（支援 stdio 或 Streamable HTTP）
jiange mcp --transport stdio
jiange mcp --transport http --addr 127.0.0.1:8787
```

在 **Claude Desktop / Cursor / Antigravity** 等 MCP 用戶端中直接設定：

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

> 預編譯 CLI 二進位檔（Linux / macOS / Windows `amd64` & `arm64`）與全部 SDK 離線套件請見 [GitHub Releases (`sdk-v0.2.0`)](https://github.com/ZSeven-W/jiange/releases/tag/sdk-v0.2.0)，完整 API 參考請見 [sdk-docs/getting-started.md](sdk-docs/getting-started.md)。

---

## 目錄結構

```text
apps/web              Jiange 主產品 Web 前端 (React + Vite + TS + TanStack Query + Tailwind + shadcn/ui)
server/               Jiange 主產品 Go 後端: cmd/jiange, internal/{api,auth,backup,blob,btformula,btquery,btsync,config,httpx,migrate,sheetstore,sheetsync,slidessync,store,syncsrv,tableadmission}, collab
packages/
  ooxml               L0: 零依賴同步 STORE + 非同步 DEFLATE ZIP 與有界安全 XML
  collab              L0: 協同核心 (RGA/Fugue CRDT, 離線快照載入與自動合併, Undo, ./table, ./ws, ./storage, ./ai-agent)
  sheet-sdk           L1: 無頭 AI-Native 試算表 SDK (AST+DAG 增量公式引擎 148 函式, XLSX/CSV, Worker)
  doc-sdk             L1: 無頭 AI-Native 文件 SDK (Document Facade, MD/HTML/DOCX, 註解與修訂)
  slides-sdk          L1: 無頭 AI-Native 簡報 SDK (Presentation, PPTX, 純 TS 16:9 SVG, 媒體與裁切)
  whiteboard-sdk      L1: 無頭 AI-Native 白板／心智圖 SDK (Board, Mermaid 雙向, DAG 版面配置, XMind, SVG)
  base-sdk            L1: 零依賴無頭 AI-Native 多維表格 SDK (23 欄位, 7 檢視, 公式, 關聯查閱, 儀表板, CSV)
  render-gpu          L2: 零 Canvas 2D 渲染核心 (WebGPU/WebGL2 SDF+GlyphAtlas, 百萬列 Fenwick 虛擬列表, SpatialIndex)
  {sheet,doc,slides,whiteboard,base}-ui
                      L2: 5 套獨立輕量 UI SDK (原生 mount, ./react, <jiange-*> Web Components)
cli/                  零外部依賴 Go 1.23 原生 CLI & Streamable HTTP/stdio MCP Server (單一靜態二進位 ~5.5 MB)
sdk/go/               零外部依賴 Go 1.23 可嵌入後端 SDK (10 套件: storage, sync, 5 領域引擎, ai, server, client)
sdk/go-pgstore/       選配 PostgreSQL storage.Store 配接器 (標準 database/sql, 相容 pgx/v5/stdlib 與 lib/pq)
sdk-docs/             完整 SDK 使用指南、API 參考、AI-Native 協定、WebGPU UI 與 Go 整合文件
deploy/               生產級 Kubernetes Helm Chart (deploy/helm/jiange)、Kustomize 清單 (deploy/k8s) 與維運手冊
e2e/                  Playwright 自動化瀏覽器端對端回歸測試套件 (與 GitHub Actions CI `e2e` 管線連動)
benchmarks/           RFC §7 量化效能 SLA、套件體積、零 Canvas 2D 與 13 套件隔離安裝自動化品質關卡
examples/             可執行範例: ts-headless、go-backend、零建置 WebGPU/WebGL2 ui-playground
design/               OpenPencil 設計原始檔（jiange.op）與宣傳片專案（promo/jiange-promo.op + mp4）
spec/                 PROTOCOL.md 協同協定規範 + vectors/ TS/Go 跨語言一致性向量
docker-compose.yml    Postgres + MinIO
```

## SDK 與維運文件導覽

- **SDK 文件首頁**：[sdk-docs/README.md](sdk-docs/README.md)
- **5 分鐘快速上手**：[sdk-docs/getting-started.md](sdk-docs/getting-started.md)
- **Headless TS SDK 手冊**：[sdk-docs/headless-sdks.md](sdk-docs/headless-sdks.md)
- **WebGPU/WebGL2 + 虛擬列表 UI SDK 手冊**：[sdk-docs/gpu-ui-sdks.md](sdk-docs/gpu-ui-sdks.md)
- **AI-Native 協定與工具規範**：[sdk-docs/ai-native-protocol.md](sdk-docs/ai-native-protocol.md)
- **Go 後端 SDK、PostgreSQL 配接器與 Go CLI/MCP**：[sdk-docs/go-backend-and-cli.md](sdk-docs/go-backend-and-cli.md)
- **效能基準、套件體積與發佈指南**：[sdk-docs/performance-and-release.md](sdk-docs/performance-and-release.md)
- **總覽與架構摘要**：[headless-sdk.md](headless-sdk.md)
- **生產部署、Helm/K8s 與備份還原指南**：[deploy/README.md](deploy/README.md)
- **Playwright E2E 測試手冊**：[e2e/README.md](e2e/README.md)

## 允許的基礎函式庫

| 層級 | 相依套件 |
|---|---|
| Headless & GPU SDK (`packages/*`) | **零第三方執行期依賴**（純 ES2022 TypeScript） |
| Go SDK & CLI (`sdk/go`, `sdk/go-pgstore`, `cli`) | **零第三方執行期依賴**（純 Go 1.23 標準函式庫） |
| Web App (`apps/web`) | `react`、`react-dom`、`@tanstack/react-query`、`tailwindcss`、`shadcn/ui`（及其 `@radix-ui/*`、`class-variance-authority`、`clsx`、`tailwind-merge`） |
| Main Server (`server/`) | Go 標準函式庫（含純 Go SAML 2.0 / LDAP v3 BER / WebAuthn CBOR+COSE / PDF+OOXML 擷取 / Prometheus）、`github.com/jackc/pgx/v5`、`github.com/coder/websocket` |
| Dev & E2E | `vite`、`typescript`、`vitest`、`tsx`、`@playwright/test` |

不使用 Yjs、Tiptap、ProseMirror，亦不使用任何重型 DI 容器、Web 框架或 ORM。

## 本機執行與生產維運

環境需求：Node 20+、pnpm 10、Go 1.23+（`server/` 須使用符合 `server/go.mod` 的 Go 版本）、Docker（用於 Postgres）。

```bash
pnpm install
docker compose up -d postgres            # postgres://jiange:jiange@localhost:5432/jiange

cd server && go run ./cmd/jiange         # :8080，啟動時自動執行資料庫遷移 (0001..0092)
# 另開終端機
pnpm --filter @jiange/web dev            # http://localhost:5173（代理 /api 與 /scim -> :8080）
```

資料備份還原與附件全文索引回填：

```bash
cd server
go run ./cmd/jiange backup /path/to/jiange-backup.tar.gz
go run ./cmd/jiange restore /path/to/jiange-backup.tar.gz
go run ./cmd/jiange reindex-attachments [workspaceId]
```

體驗零建置 WebGPU/WebGL2 + 虛擬列表 UI SDK Playground：

```bash
pnpm -r build
node examples/ui-playground/serve.mjs    # http://127.0.0.1:4173
```

環境變數：`DATABASE_URL`、`JIANGE_ADDR`（預設 `:8080`）、`JIANGE_SESSION_TTL`（預設 `720h`）、HTTPS 後端請設 `JIANGE_SECURE_COOKIES=true`、`JIANGE_SECRET_KEY`（以 AES-256-GCM 加密封存 AI 金鑰／SSO 密鑰／LDAP、企業微信、釘釘連接器憑證／Webhook 與通知管道密鑰）、`JIANGE_METRICS_TOKEN`（選配，保護 `/metrics` 的 Bearer 權杖）、`JIANGE_AI_EMBEDDING_MODEL`（選配，遠端 `/embeddings` 模型名稱）、`JIANGE_OCR_URL` / `JIANGE_OCR_MODE` / `JIANGE_OCR_API_KEY` / `JIANGE_OCR_TESSERACT`（選配，圖片與掃描 PDF 的 OCR 辨識）、`JIANGE_BLOB_DIR`（本機磁碟 Blob 目錄，設定後將覆寫 S3）。

文件待確認操作的安全停止預設關閉。部署時請先套用資料庫遷移、升級並排空所有舊版文件寫入實例，再設定 `JIANGE_ENABLE_CONDITIONAL_CANCEL=true`；啟用後切勿讓不支援停止屏障的舊實例重新寫入。詳見 [docs/deploy.md](docs/deploy.md) 與 [deploy/README.md](deploy/README.md)。

### 附件儲存（MinIO / S3）

請設定 `JIANGE_S3_ENDPOINT`（例如 `http://localhost:9000`）、`JIANGE_S3_ACCESS_KEY`、`JIANGE_S3_SECRET_KEY`，並可選設 `JIANGE_S3_BUCKET`（預設 `jiange`，啟動時自動建立）。若未設定端點（或 `JIANGE_BLOB_DIR`），附件上傳功能將停用。搭配 docker-compose 使用：`JIANGE_S3_ENDPOINT=http://localhost:9000 JIANGE_S3_ACCESS_KEY=jiange JIANGE_S3_SECRET_KEY=jiange-dev-secret`。

## 測試與品質關卡

```bash
pnpm lint:names                          # 全倉 kebab-case 路徑檢查（1,960+ 追蹤路徑）
pnpm -r build && pnpm -r typecheck       # 全部 13 個 SDK/UI 套件 + apps/web 建置與型別檢查
pnpm test                                # 全倉 Vitest 單元測試（apps/web 313 檔案 / 1,814 測試案例）
pnpm test:sdk:coverage                   # 全部 13 個 TS SDK/UI 套件 100/100/100/100 V8 覆蓋率關卡
pnpm test:sdk:pack                       # 真實 pnpm pack 隔離 Node ESM 與 NodeNext 型別驗證
pnpm test:e2e                            # Playwright 全套瀏覽器端對端回歸測試（登入／空間／四件套／管理後台／雙語／離線）
pnpm bench                               # RFC §7 全部 7 項效能 SLA、零 Canvas 2D 與 13 套件隔離安裝驗證
pnpm gen:vectors                         # 修改協同核心後重新產生 spec/vectors

cd cli && go test -race -cover ./...             # Go CLI & MCP（4 套件 100.0% 覆蓋率）
cd sdk/go && go test -race -cover ./...          # Go 後端 SDK（10 套件 100.0% 覆蓋率）
cd sdk/go-pgstore && go test -race -cover ./...  # PostgreSQL 配接器（100.0% 覆蓋率）
cd server && go test ./... && go vet ./...       # Jiange 主伺服器 20 套件全測（含 OpenAPI 100% 路由一致與多副本同步）
JIANGE_TEST_DATABASE_URL=postgres://jiange:jiange@localhost:5432/jiange_test?sslmode=disable go test ./internal/store
go test ./collab -run '^$' -fuzz '^FuzzDecode$' -fuzztime 30s
```

跨語言一致性：TS 產生 `spec/vectors/encoding.json`（ops ↔ 十六進位位元組）與 `scenarios.json`（ops → 預期具體化視圖，含 5 個隨機 3 副本工作階段）。Go 測試逐位元組比對編碼，並以 25 種隨機亂序與重複傳遞排程重播每個場景，結果必須與 TS 完全一致。

## 核心認證、可觀測性與開放 API

完整 361 個 API 端點契約可直接存取 `GET /api/openapi.json`，或於管理後台「開發者 / API」分頁互動式瀏覽與複製 cURL 指令。

| Method | Path | 說明 |
|---|---|---|
| GET | `/healthz` · `/readyz` · `/metrics` | 存活探針、資料庫／儲存就緒探針與 Prometheus 0.0.4 監控指標 |
| GET | `/api/openapi.json` | 完整 OpenAPI 3.1.0 規範（361 個端點、27 個資料模型） |
| GET/POST/PUT/PATCH/DELETE | `/scim/v2/{ServiceProviderConfig,Schemas,ResourceTypes,Users,Groups}` | RFC 7643/7644 SCIM 2.0 組織成員與群組同步（`admin` 作用域 PAT） |
| POST | `/api/auth/register` · `/api/auth/login` · `/api/auth/mfa/verify` · `/api/auth/password-reset/{request,confirm}` | 註冊、密碼登入（含限流、TOTP／復原碼兩步驟驗證挑戰與強制 MFA 原則）及 SMTP 密碼重設 |
| POST | `/api/auth/passkey/login/{begin,finish}` | WebAuthn / Passkeys（FIDO2 ES256/RS256）無密碼登入 |
| GET/POST | `/api/auth/sso/{slug}/{start,callback,metadata.xml,acs}` | 企業 OIDC / OAuth2 與 SAML 2.0 SP 單一登入（SSO） |
| GET/POST/DELETE | `/api/me` · `/api/me/password` · `/api/me/sessions` · `/api/me/passkeys` · `/api/me/tokens` | 目前使用者、變更密碼、活躍裝置工作階段管理／遠端登出、通行金鑰與 PAT 權杖 |
| GET/POST/PATCH/DELETE | `/api/workspaces` · `/api/workspaces/{wsId}` | 多工作空間建立、切換、重新命名、所有權轉讓（`/transfer-owner`）、退出（`/leave`）與刪除 |
| GET/PUT/POST | `/api/workspaces/{wsId}/storage` · `/storage/quota` · `/attachments/reindex` | 空間儲存用量儀表板、配額上限（HTTP 413 攔截）與既有附件全文／OCR 回填重建索引 |
| POST | `/api/workspaces/{wsId}/org/sync-sources/{sourceId}/pull` | 觸發 LDAP v3／企業微信／釘釘主動目錄拉取（支援 Dry-Run） |
| POST | `/api/workspaces/{wsId}/dlp/check` · `/retention/run` | 企業 DLP 敏感詞／正規表示式即時試測與資料保留週期即時清理 |
| POST | `/api/ai/ask-workspace` · `/api/ai/workspace-ask/stream` · `/api/ai/doc/stream` | 混合語意向量 RAG 全空間問答與單一文件 AI 寫作（皆支援 SSE 逐字串流輸出） |
| GET/POST | `/api/workspaces/{wsId}/webhooks` · `/notification-channels` | 全部 6 類空間事件 HMAC-SHA256 Webhook 與外部通知管道（SMTP／飛書／釘釘／企業微信／Slack） |

工作階段：32 位元組隨機 token，僅儲存 SHA-256 雜湊值；Cookie 為 `HttpOnly; SameSite=Lax`。密碼：PBKDF2-HMAC-SHA256（600k 次迭代，使用 Go 標準函式庫 `crypto/pbkdf2`）。寫入請求必須使用 `application/json`（搭配 `SameSite` 防護 CSRF，SAML HTTP-POST ACS 與帶有自訂標頭的上傳端點除外）。

## 設計

UI 先於 OpenPencil 設計（`design/jiange.op`），預覽圖位於 `design/previews/`，設計變數（`design/vars.json`）對應至 `apps/web/src/index.css` 中的 Tailwind/shadcn 主題變數；宣傳影片則由 OpenPencil v0.8.6 原生 `.op` 動態專案匯出（`design/promo/jiange-promo.op`）。

## 授權條款

本專案採用分元件授權，完整條款請參閱 [LICENSE](./LICENSE)：

- **應用程式部分（`apps/`、`server/` 等）**：個人與非商業使用免費；商業使用（含企業內部生產營運、託管／SaaS、整合至商業產品或付費服務等）須事先購買商業授權。
- **SDK 部分（`packages/*`、`sdk/*`、`cli/*`）**：個人與商業使用皆免費；若企業對 SDK 進行二次開發（修改、擴充、裁剪或基於原始碼衍生），須於產品文件、關於頁面或原始碼儲存庫說明等公開位置明確標示來源（基於 Jiange SDK）。

---

檔案與目錄預設採用 kebab-case，程式碼識別字則遵循各語言慣例。Go 平台與測試後綴、已套用的資料庫遷移檔名、`README.md` / `README.<lang>.md`、`CHANGELOG.md`、`Dockerfile`、`Chart.yaml`、`NOTES.txt`、`_helpers.tpl`、授權條款檔案等皆保留工具慣例；可執行 `pnpm lint:names` 檢查 Git 追蹤的路徑。SDK 保留舊版 camelCase 子路徑作為相容入口，新程式碼請使用 kebab-case 子路徑。
