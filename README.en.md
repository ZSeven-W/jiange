# Jiange

<p align="center">
  <img src="apps/web/public/brand/jiange-lockup.svg" width="240" alt="Jiange" />
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <b>English</b> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <strong>Open-Source Collaborative Suite: Docs + Sheets + Base + Slides + Whiteboard &amp; MindMap</strong><br />
  <sub>AI-Native · Modular &amp; Lightweight · Enterprise Security &amp; Compliance · Multi-Replica HA · Full i18n &amp; Offline CRDT · Zero Canvas 2D (WebGPU/WebGL2 + Virtual List)</sub>
</p>

<p align="center">
  An open-source, self-hostable, enterprise-ready, AI-native alternative to Feishu/Lark Docs, Sheets, Base, Slides, and Whiteboard/MindMap — built from scratch with a custom CRDT engine, pure-stdlib Go backend (SAML 2.0, OIDC, SCIM 2.0, LDAP/WeCom/DingTalk, WebAuthn Passkeys, DLP, Prometheus, OpenAPI 3.1), 13 zero-dependency TypeScript/WebGPU SDKs, and a single-binary Go CLI &amp; MCP Server.
</p>

---

## Launch Promo

<p align="center">
  <a href="design/promo/jiange-promo.mp4">
    <img src="design/promo/jiange-promo-cover.png" alt="Jiange Launch Promo — Click to Watch" width="100%" />
  </a>
</p>

<p align="center">
  <sub>
    ▶ <a href="design/promo/jiange-promo.mp4"><b>Watch the full launch promo (MP4 · 30s · with original BGM)</b></a><br />
    Motion graphics authored and exported from native <b>OpenPencil v0.8.6</b> <code>.op</code> source (<a href="design/promo/jiange-promo.op"><code>design/promo/jiange-promo.op</code></a> / <a href="design/promo/build-jiange-promo.py">generator script</a>); soundtrack composed locally with the <b>MiniMax H3-Music</b> instrumental model.
  </sub>
</p>

---

## Full Suite Highlights

| Module | Capabilities |
|---|---|
| **Cloud Doc** | Custom RGA/Fugue CRDT real-time collaboration, **deep offline CRDT editing with automatic merge on reconnect** (IndexedDB replica persistence), 15+ block types (including native `audio` / `video` / `poll` live polls / `countdown` timers / `tabs` / tables / code blocks / math equations / Mermaid / synced blocks / multi-column layouts / embedded tables), **inline Track Changes**, text-selection comments & emoji reactions, follow-along reading, version history, DOCX / Markdown (with images) import & export, and PDF printing |
| **Sheet** | WebGPU/WebGL2 million-row virtual grid, **148 built-in formula functions** (including `XLOOKUP` / `FILTER` / `SORT` / `UNIQUE` / `LET` / `LAMBDA` / `ARRAYFORMULA` / `QUERY` / `REGEX*` / `IMAGE`), floating charts, pivot tables, **inline SVG sparklines**, collapsible row/column grouping, in-cell images, conditional formatting / data validation / protected ranges, cloud named ranges, version history & cell edit history, offline cell delta merge, XLSX/CSV import & export, and **Sheet AI Formula Assistant** |
| **Base** | Multi-table architecture with bidirectional cross-table links, **23 field types** (including currency, progress, auto-number, action button, geolocation, formula, link, and lookup), **7 view types** (Grid, Kanban, Gantt with dependency lines, Calendar, Gallery, **Hierarchical Tree View**, and public Forms with conditional branching), up to 3 levels of nested grouping, multi-step automation workflows, data dashboards, multi-role fine-grained row/column RBAC, XLSX/CSV import & export, and **AI column batch autofill** |
| **Slides** | WebGPU/WebGL2 canvas, **Master Brand Kit**, text/shape/table/chart/video/audio elements, image cropping, per-element animations & slide transitions, Presenter Mode (laser pointer / freehand annotation + WebSocket-backed **live audience follow-along broadcast**), slide & element comments, version history, offline slide draft merge, PPTX import & export, and PDF printing |
| **Board & MindMap** | Infinite canvas, flowcharts & swimlanes, brainstorming sticky notes / highlighter / dot voting / countdown timer / minimap / grouping frames, multi-layout mind maps, boundaries / summaries / badges, two-way outline sync, and Mermaid / XMind / SVG / PNG export |
| **Wiki & Drive** | **Full multi-workspace lifecycle** (create, one-click switch, rename, ownership transfer UI/API, member leave, delete), dedicated wiki spaces & multi-level folders, shortcuts, **cross-space move (personal / shared / cross-workspace)**, **workspace storage usage dashboard & quota enforcement (HTTP 413)**, **all-format inline preview** (image zoom/rotate, PDF, audio/video, code/Markdown/CSV, `.docx`/`.xlsx`/`.pptx`, including rich attachment previews on public read-only docs), **pure-Go attachment full-text extraction + pluggable OCR (HTTP / OpenAI Vision / `tesseract`) + one-click/CLI index backfill for existing attachments** |
| **Workspace AI** | **Hybrid semantic vector + BM25 RAG workspace-wide Q&A** (128-dim local embeddings + optional remote `/embeddings` + permission-scoped retrieval + citation provenance across docs and PDF/Office/OCR attachments), **dual SSE token-streaming endpoints for workspace Q&A & single-doc writing** (`POST /api/ai/workspace-ask/stream` · `POST /api/ai/doc/stream`), Sheet AI formula generation, Base AI batch autofill, and OpenAI / Anthropic-compatible multi-provider routing (with automatic fallback to a local engine when no API key is configured) |
| **Enterprise IAM** | **OIDC / OAuth2 + SAML 2.0 SP** (Metadata XML, AuthnRequest, native XML-DSig RSA/ECDSA verification with XXE/XSW hardening), **full SCIM 2.0 (RFC 7644)** (`ServiceProviderConfig`, `Schemas`, `ResourceTypes`, full `Users`/`Groups` `PUT`/`PATCH`/`DELETE`/filter/pagination), **LDAP v3 / WeCom / DingTalk active pull & scheduled directory sync** (native ASN.1 BER client + encrypted credentials), **TOTP MFA + 8 recovery codes + workspace-enforced MFA policy & global top onboarding banner**, **WebAuthn / Passkeys (FIDO2 ES256/RS256) passwordless login**, and **self-service account security** (brute-force rate limiting across login/MFA/Passkey/public links, password change, SMTP forgot/reset password, active device session list & remote revocation) |
| **Governance & Open Ecosystem** | **Enterprise DLP keyword & safe-RE2 regex leak prevention** (covering Doc / Sheet / Base / Slides / Survey; blocks or alerts on public sharing and CSV/public attachment exports), **data retention policies with background scheduled & manual sweeps**, suite-wide anti-leak watermarks, password-protected public shares, enterprise security audit logs with CSV export, **complete OpenAPI 3.1.0 contract (361 endpoints with 100% route-coverage verification + 27 schemas + interactive developer portal)**, **Personal Access Tokens (PATs)**, **HMAC-SHA256 webhooks for all 6 workspace event types**, and **external notification channels** (SMTP / Feishu / DingTalk / WeCom / Slack) |
| **Scale, i18n & Cloud-Native Ops** | **Horizontal multi-replica scaling across all 4 real-time collaboration hubs** (Doc `syncsrv` / Base `btsync` / Sheet `sheetsync` / Slides `slidessync`, all broadcasting cross-node via Postgres `LISTEN/NOTIFY`), **complete repo-wide Chinese/English i18n** (5,355 translation keys, 0 user-visible gaps), **route-level `React.lazy` + Rollup code splitting** (main bundle 308 KB / 84 KB gzipped), PWA + IndexedDB offline editing & auto-merge on reconnect (Doc / Base / Sheet / Slides), `/healthz` + `/readyz` + Prometheus `/metrics` + W3C `traceparent`, SHA-256-verified full backup/restore CLI (`jiange backup` / `restore` / `reindex-attachments`), and production-grade **Helm Chart** & **Kustomize** manifests |

---

## Quick Start

Adopt Jiange in any of four ways depending on your needs: as the **full self-hosted suite**, **npm TypeScript/WebGPU SDKs**, an **embeddable Go backend SDK**, or a **Go CLI / AI MCP Server**:

### 1. Run the Full Collaborative Suite (Docker)

```bash
# Option A: One-command Docker Compose startup (Postgres 16 + MinIO + full Jiange suite)
git clone https://github.com/ZSeven-W/jiange.git && cd jiange
docker compose up -d --build
# Open http://localhost:8080 and register the initial workspace admin to get started

# Option B: Pull the prebuilt multi-arch image from GHCR (linux/amd64 & linux/arm64)
docker pull ghcr.io/zseven-w/jiange:latest
docker run -d --name jiange -p 8080:8080 \
  -e DATABASE_URL="postgres://jiange:jiange@host.docker.internal:5432/jiange?sslmode=disable" \
  -e JIANGE_SECURE_COOKIES="false" \
  -e JIANGE_SECRET_KEY="$(openssl rand -hex 32)" \
  -v jiange_blobs:/data/blobs \
  ghcr.io/zseven-w/jiange:latest
```

> For production Kubernetes deployments, install the Helm Chart directly (`helm upgrade --install jiange ./deploy/helm/jiange`). See [deploy/README.md](deploy/README.md) for details.

### 2. Use the TypeScript / WebGPU SDKs (npm `@zseven-w/*`)

All **13 zero-dependency packages** are published on npmjs.com (`0.2.0`) and can be installed individually per module:

```bash
# Install headless engines on demand (runs in Node.js, browsers, Edge, and AI agents)
npm install @zseven-w/sheet-sdk        # Sheet (148 formulas + XLSX/CSV + AI tools)
npm install @zseven-w/doc-sdk          # Cloud Doc (CRDT + MD/HTML/DOCX + comments & Track Changes)
npm install @zseven-w/base-sdk         # Base (23 field types + 7 views + formulas & links)
npm install @zseven-w/slides-sdk       # Slides (PPTX + pure-TS 16:9 SVG)
npm install @zseven-w/whiteboard-sdk   # Board & MindMap (Mermaid + DAG layout + XMind)

# Optional: install WebGPU/WebGL2 + virtual list UI components (Zero Canvas 2D; native mount / React / Web Components)
npm install @zseven-w/sheet-ui @zseven-w/doc-ui @zseven-w/base-ui @zseven-w/slides-ui @zseven-w/whiteboard-ui
```

Headless formula evaluation + AI tool dry-run validation (`dryRun`) + `.xlsx` export example:

```ts
import { Workbook, createSheetTools } from "@zseven-w/sheet-sdk";

const wb = Workbook.fromCsv("Product,Units,UnitPrice\nPro,120,49\nEnterprise,25,299\n", "Q4");
const tools = createSheetTools(wb);

// AI agents can validate via dryRun before applying; formulas recalculate incrementally
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
const xlsxBytes = await wb.toXlsxAsync();   // Standard DEFLATE .xlsx byte stream
```

Mount the WebGPU/WebGL2 virtual grid in the browser (native DOM, React, or `<jiange-sheet>`):

```ts
import { mountSheetView } from "@zseven-w/sheet-ui";

const view = await mountSheetView(document.getElementById("sheet-root")!, wb);
// Call view.dispose() on teardown
```

### 3. Embed the Backend SDK in a Go Service (`sdk/go` & `sdk/go-pgstore`)

```bash
go get github.com/ZSeven-W/jiange/sdk/go@v0.2.0
go get github.com/ZSeven-W/jiange/sdk/go-pgstore@v0.2.0   # Optional PostgreSQL persistence adapter
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
		Store:   storage.NewMemoryStore(), // Replace with pgstore.New(db) in production
		Auth:    storage.NewBearerTokenAuth(map[string]storage.Principal{"my-token": {ID: "u-1", Name: "Admin", Roles: []string{"admin"}}}),
		Version: "0.2.0",
	})
	mux := http.NewServeMux()
	mux.Handle("/api/v1/", http.StripPrefix("/api/v1", app))
	_ = http.ListenAndServe(":8090", mux)
}
```

### 4. Use the Go CLI & AI Agent MCP Server (`jiange`)

```bash
# Install via Go modules (or download prebuilt static binaries for 5 platforms from GitHub Releases)
go install github.com/ZSeven-W/jiange/cli/cmd/jiange@v0.2.0

# Read and write office files locally (zero Node.js dependencies)
jiange sheet inspect budget.xlsx --detail full
jiange sheet patch budget.xlsx --ops '[{"op":"setCell","sheet":"Sheet1","a1":"B2","raw":"=SUM(A1:A10)"}]' --out out.xlsx
jiange doc convert spec.md --out spec.docx
jiange slides render deck.pptx --slide 0 --out slide1.svg
jiange board render arch.mmd --out arch.svg

# Start the MCP Server (supports stdio or Streamable HTTP)
jiange mcp --transport stdio
jiange mcp --transport http --addr 127.0.0.1:8787
```

Configure directly in MCP clients such as **Claude Desktop / Cursor / Antigravity**:

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

> Prebuilt CLI binaries (Linux / macOS / Windows `amd64` & `arm64`) and offline archives for all SDKs are available on [GitHub Releases (`sdk-v0.2.0`)](https://github.com/ZSeven-W/jiange/releases/tag/sdk-v0.2.0). See [sdk-docs/getting-started.md](sdk-docs/getting-started.md) for the full API reference.

---

## Layout

```text
apps/web              Main Jiange Web frontend (React + Vite + TS + TanStack Query + Tailwind + shadcn/ui)
server/               Main Jiange Go backend: cmd/jiange, internal/{api,auth,backup,blob,btformula,btquery,btsync,config,httpx,migrate,sheetstore,sheetsync,slidessync,store,syncsrv,tableadmission}, collab
packages/
  ooxml               L0: Zero-dependency sync STORE + async DEFLATE ZIP & bounded safe XML
  collab              L0: Collaboration kernel (RGA/Fugue CRDT, offline snapshot hydration & auto-merge, Undo, ./table, ./ws, ./storage, ./ai-agent)
  sheet-sdk           L1: Headless AI-Native spreadsheet SDK (AST+DAG incremental formula engine with 148 functions, XLSX/CSV, Worker)
  doc-sdk             L1: Headless AI-Native document SDK (Document Facade, MD/HTML/DOCX, comments & Track Changes)
  slides-sdk          L1: Headless AI-Native presentation SDK (Presentation, PPTX, pure-TS 16:9 SVG, media & cropping)
  whiteboard-sdk      L1: Headless AI-Native whiteboard/mindmap SDK (Board, bidirectional Mermaid, DAG layout, XMind, SVG)
  base-sdk            L1: Zero-dependency headless AI-Native Base SDK (23 fields, 7 views, formulas, link/lookup, dashboards, CSV)
  render-gpu          L2: Zero Canvas 2D rendering core (WebGPU/WebGL2 SDF+GlyphAtlas, million-row Fenwick virtual list, SpatialIndex)
  {sheet,doc,slides,whiteboard,base}-ui
                      L2: 5 standalone lightweight UI SDKs (native mount, ./react, <jiange-*> Web Components)
cli/                  Zero-dependency Go 1.23 native CLI & Streamable HTTP/stdio MCP Server (single static binary ~5.5 MB)
sdk/go/               Zero-dependency Go 1.23 embeddable backend SDK (10 packages: storage, sync, 5 domain engines, ai, server, client)
sdk/go-pgstore/       Optional PostgreSQL storage.Store adapter (standard database/sql; compatible with pgx/v5/stdlib & lib/pq)
sdk-docs/             Complete SDK guides, API reference, AI-Native protocol, WebGPU UI, and Go integration docs
deploy/               Production Kubernetes Helm Chart (deploy/helm/jiange), Kustomize manifests (deploy/k8s), and ops guide
e2e/                  Playwright browser end-to-end regression test suite (integrated with GitHub Actions CI `e2e` pipeline)
benchmarks/           Automated gates for RFC §7 quantitative performance SLAs, bundle size, Zero Canvas 2D, and isolated 13-package install
examples/             Runnable examples: ts-headless, go-backend, and zero-build WebGPU/WebGL2 ui-playground
design/               OpenPencil design source (jiange.op) and promo project (promo/jiange-promo.op + mp4)
spec/                 PROTOCOL.md collaboration protocol spec + vectors/ TS/Go cross-language conformance vectors
docker-compose.yml    Postgres + MinIO
```

## Documentation

- **SDK Docs Home**: [sdk-docs/README.md](sdk-docs/README.md)
- **5-Minute Getting Started**: [sdk-docs/getting-started.md](sdk-docs/getting-started.md)
- **Headless TypeScript SDK Guide**: [sdk-docs/headless-sdks.md](sdk-docs/headless-sdks.md)
- **WebGPU/WebGL2 + Virtual List UI SDK Guide**: [sdk-docs/gpu-ui-sdks.md](sdk-docs/gpu-ui-sdks.md)
- **AI-Native Protocol & Tool Specification**: [sdk-docs/ai-native-protocol.md](sdk-docs/ai-native-protocol.md)
- **Go Backend SDK, PostgreSQL Adapter & Go CLI/MCP**: [sdk-docs/go-backend-and-cli.md](sdk-docs/go-backend-and-cli.md)
- **Performance Benchmarks, Bundle Budgets & Release Guide**: [sdk-docs/performance-and-release.md](sdk-docs/performance-and-release.md)
- **Architecture Overview & Summary**: [headless-sdk.md](headless-sdk.md)
- **Production Deployment, Helm/K8s & Backup/Restore Guide**: [deploy/README.md](deploy/README.md)
- **Playwright E2E Testing Guide**: [e2e/README.md](e2e/README.md)

## Allowed Foundational Libraries

| Layer | Dependencies |
|---|---|
| Headless & GPU SDK (`packages/*`) | **Zero third-party runtime dependencies** (pure ES2022 TypeScript) |
| Go SDK & CLI (`sdk/go`, `sdk/go-pgstore`, `cli`) | **Zero third-party runtime dependencies** (pure Go 1.23 stdlib) |
| Web App (`apps/web`) | `react`, `react-dom`, `@tanstack/react-query`, `tailwindcss`, `shadcn/ui` (and its `@radix-ui/*`, `class-variance-authority`, `clsx`, `tailwind-merge`) |
| Main Server (`server/`) | Go stdlib (including pure-Go SAML 2.0 / LDAP v3 BER / WebAuthn CBOR+COSE / PDF+OOXML extraction / Prometheus), `github.com/jackc/pgx/v5`, `github.com/coder/websocket` |
| Dev & E2E | `vite`, `typescript`, `vitest`, `tsx`, `@playwright/test` |

No Yjs, Tiptap, ProseMirror, heavy DI containers, web frameworks, or ORMs.

## Run Locally & Production Ops

Requirements: Node 20+, pnpm 10, Go 1.23+ (`server/` requires Go matching `server/go.mod`), Docker (for Postgres).

```bash
pnpm install
docker compose up -d postgres            # postgres://jiange:jiange@localhost:5432/jiange

cd server && go run ./cmd/jiange         # :8080, runs migrations (0001..0092) on start
# In another terminal
pnpm --filter @jiange/web dev            # http://localhost:5173 (proxies /api & /scim -> :8080)
```

Backup, Restore & Attachment Full-Text Index Backfill:

```bash
cd server
go run ./cmd/jiange backup /path/to/jiange-backup.tar.gz
go run ./cmd/jiange restore /path/to/jiange-backup.tar.gz
go run ./cmd/jiange reindex-attachments [workspaceId]
```

Try the zero-build WebGPU/WebGL2 + Virtual List UI SDK Playground:

```bash
pnpm -r build
node examples/ui-playground/serve.mjs    # http://127.0.0.1:4173
```

Environment variables: `DATABASE_URL`, `JIANGE_ADDR` (default `:8080`), `JIANGE_SESSION_TTL` (default `720h`), `JIANGE_SECURE_COOKIES=true` behind HTTPS, `JIANGE_SECRET_KEY` (AES-256-GCM sealing for AI keys / SSO secrets / LDAP-WeCom-DingTalk connector credentials / Webhook & Notification channel secrets), `JIANGE_METRICS_TOKEN` (optional Bearer token guarding `/metrics`), `JIANGE_AI_EMBEDDING_MODEL` (optional remote `/embeddings` model name), `JIANGE_OCR_URL` / `JIANGE_OCR_MODE` / `JIANGE_OCR_API_KEY` / `JIANGE_OCR_TESSERACT` (optional OCR for images & scanned PDFs), `JIANGE_BLOB_DIR` (local disk blob directory; overrides S3 when set).

Safe cancellation of pending document operations is disabled by default. During deployment, first apply database migrations, upgrade and drain all legacy document writer instances, and then set `JIANGE_ENABLE_CONDITIONAL_CANCEL=true`; once enabled, do not allow legacy instances without cancellation-barrier support to resume writing. See [docs/deploy.md](docs/deploy.md) and [deploy/README.md](deploy/README.md) for details.

### Attachments (MinIO / S3)

Set `JIANGE_S3_ENDPOINT` (e.g. `http://localhost:9000`), `JIANGE_S3_ACCESS_KEY`, `JIANGE_S3_SECRET_KEY`, and optionally `JIANGE_S3_BUCKET` (default `jiange`; created automatically on startup). Without an S3 endpoint (or `JIANGE_BLOB_DIR`), uploads are disabled. With `docker-compose`: `JIANGE_S3_ENDPOINT=http://localhost:9000 JIANGE_S3_ACCESS_KEY=jiange JIANGE_S3_SECRET_KEY=jiange-dev-secret`.

## Tests & Quality Gates

```bash
pnpm lint:names                          # Repo-wide kebab-case path lint (1,960+ tracked paths)
pnpm -r build && pnpm -r typecheck       # Build & typecheck all 13 SDK/UI packages + apps/web
pnpm test                                # Repo-wide Vitest unit tests (apps/web: 313 files / 1,814 tests)
pnpm test:sdk:coverage                   # 100/100/100/100 V8 coverage gate across all 13 TS SDK/UI packages
pnpm test:sdk:pack                       # Real pnpm pack isolated Node ESM & NodeNext type verification
pnpm test:e2e                            # Full Playwright browser E2E suite (auth/workspaces/4 apps/admin/i18n/offline)
pnpm bench                               # All 7 RFC §7 performance SLAs, Zero Canvas 2D & 13-package isolated install gate
pnpm gen:vectors                         # Regenerate spec/vectors after modifying the collaboration kernel

cd cli && go test -race -cover ./...             # Go CLI & MCP (4 packages, 100.0% coverage)
cd sdk/go && go test -race -cover ./...          # Go backend SDK (10 packages, 100.0% coverage)
cd sdk/go-pgstore && go test -race -cover ./...  # PostgreSQL adapter (100.0% coverage)
cd server && go test ./... && go vet ./...       # All 20 main server packages (incl. 100% OpenAPI route parity & multi-replica sync)
JIANGE_TEST_DATABASE_URL=postgres://jiange:jiange@localhost:5432/jiange_test?sslmode=disable go test ./internal/store
go test ./collab -run '^$' -fuzz '^FuzzDecode$' -fuzztime 30s
```

Cross-language conformance: TypeScript generates `spec/vectors/encoding.json` (ops ↔ hex bytes) and `scenarios.json` (ops → expected materialized view, including 5 randomized 3-replica sessions). Go tests verify encodings byte-for-byte and replay each scenario across 25 randomized out-of-order + duplicate-delivery schedules; outputs must match TypeScript identically.

## Auth, Ops & Open API

Inspect the complete 361-endpoint API contract at `GET /api/openapi.json` or interactively browse endpoints and copy cURL snippets under Admin Console → **Developer / API**.

| Method | Path | Description |
|---|---|---|
| GET | `/healthz` · `/readyz` · `/metrics` | Liveness probe, DB/storage readiness probe, and Prometheus 0.0.4 metrics |
| GET | `/api/openapi.json` | Complete OpenAPI 3.1.0 specification (361 endpoints, 27 schemas) |
| GET/POST/PUT/PATCH/DELETE | `/scim/v2/{ServiceProviderConfig,Schemas,ResourceTypes,Users,Groups}` | RFC 7643/7644 SCIM 2.0 user & group provisioning (`admin`-scoped PAT) |
| POST | `/api/auth/register` · `/api/auth/login` · `/api/auth/mfa/verify` · `/api/auth/password-reset/{request,confirm}` | Registration, password login (with rate limiting, TOTP/recovery-code MFA challenge & workspace-enforced MFA policy), and SMTP password reset |
| POST | `/api/auth/passkey/login/{begin,finish}` | WebAuthn / Passkeys (FIDO2 ES256/RS256) passwordless login |
| GET/POST | `/api/auth/sso/{slug}/{start,callback,metadata.xml,acs}` | Enterprise OIDC / OAuth2 and SAML 2.0 SP single sign-on |
| GET/POST/DELETE | `/api/me` · `/api/me/password` · `/api/me/sessions` · `/api/me/passkeys` · `/api/me/tokens` | Current user profile, password change, active device sessions & remote sign-out, passkeys, and PAT tokens |
| GET/POST/PATCH/DELETE | `/api/workspaces` · `/api/workspaces/{wsId}` | Multi-workspace create, switch, rename, ownership transfer (`/transfer-owner`), leave (`/leave`), and delete |
| GET/PUT/POST | `/api/workspaces/{wsId}/storage` · `/storage/quota` · `/attachments/reindex` | Workspace storage usage dashboard, quota limit (HTTP 413 enforcement), and full-text/OCR reindexing of existing attachments |
| POST | `/api/workspaces/{wsId}/org/sync-sources/{sourceId}/pull` | Trigger active LDAP v3 / WeCom / DingTalk directory pull (supports Dry-Run) |
| POST | `/api/workspaces/{wsId}/dlp/check` · `/retention/run` | Real-time enterprise DLP keyword/regex test & on-demand data retention sweep |
| POST | `/api/ai/ask-workspace` · `/api/ai/workspace-ask/stream` · `/api/ai/doc/stream` | Hybrid semantic vector RAG workspace Q&A and single-doc AI writing (both with SSE token streaming) |
| GET/POST | `/api/workspaces/{wsId}/webhooks` · `/notification-channels` | HMAC-SHA256 webhooks for all 6 workspace event types & external notification channels (SMTP / Feishu / DingTalk / WeCom / Slack) |

Sessions use 32-byte random tokens stored exclusively as SHA-256 hashes, delivered in `HttpOnly; SameSite=Lax` cookies. Passwords are hashed with PBKDF2-HMAC-SHA256 (600k iterations via Go stdlib `crypto/pbkdf2`). Write requests require `application/json` (paired with `SameSite` for CSRF protection, except SAML HTTP-POST ACS and upload endpoints using custom headers).

## Design

The UI is designed first in OpenPencil (`design/jiange.op`), with previews in `design/previews/`. Design tokens (`design/vars.json`) map directly to the Tailwind/shadcn theme variables in `apps/web/src/index.css`. The launch promo video is exported from native OpenPencil v0.8.6 `.op` motion graphics (`design/promo/jiange-promo.op`).

## License

This project uses a split-component license. See [LICENSE](./LICENSE) for the full terms:

- **Application (`apps/`, `server/`, etc.)**: Free for personal and non-commercial use; commercial use (including internal enterprise production/operations, hosting/SaaS, integration into commercial products or paid services, etc.) requires purchasing a commercial license in advance.
- **SDKs (`packages/*`, `sdk/*`, `cli/*`)**: Free for both personal and commercial use; if an enterprise performs secondary development on the SDKs (modifying, extending, trimming, or creating source-based derivatives), it must clearly attribute the source (based on Jiange SDK) in a public location such as product documentation, an About page, or the repository README.

---

Files and directories use kebab-case by default, while code identifiers follow each language's conventions. Tooling conventions are preserved for Go OS/arch and test suffixes, already-applied database migration filenames, `README.md` / `README.<lang>.md`, `CHANGELOG.md`, `Dockerfile`, `Chart.yaml`, `NOTES.txt`, `_helpers.tpl`, license files, and similar files; run `pnpm lint:names` to verify Git-tracked paths. SDKs retain legacy camelCase subpaths for backward compatibility; new code should use kebab-case subpaths.
