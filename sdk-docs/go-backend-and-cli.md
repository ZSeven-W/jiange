# Go 后端 SDK、PostgreSQL 适配器与 CLI / MCP 指南

Jiange 提供三套完全基于 **Go 1.23 标准库、零第三方运行时依赖**的原生 Go 模块，覆盖嵌入式 Office 后端服务、生产级 PostgreSQL 存储适配与单二进制 CLI / MCP 工具链。

---

## 1. Go 后端可嵌入 SDK（`github.com/ZSeven-W/jiange/sdk/go`）

```bash
go get github.com/ZSeven-W/jiange/sdk/go
```

### 1.1 全 10 个独立子包一览

| 子包 | 核心类型与导出函数 | 职责 |
| --- | --- | --- |
| `storage` | `Store`, `DocumentRecord`, `MemoryStore`, `FileStore`, `Authenticator`, `Authorizer`, `BearerTokenAuth`, `RoleAuthorizer`, `AllowAllAuthorizer`, `AuthMiddleware`, `WebhookDispatcher`, `WebhookEvent`, `SignPayload`, `VerifySignature`, `SignatureHeader` | 文档持久化契约、乐观版本锁（`ErrVersionConflict`）、鉴权/RBAC 中间件、HMAC-SHA256 Webhook 派发与验签 |
| `sync` | `RoomHub`, `WithMaxHistory`, `WithPresenceTTL`, `TransportConn`, `ChanConn`, `NewChanConn`, `NewHandler`, `WithAuth` | 传输无关的多房间实时协同中枢（`Append`/`PullSince`/`Snapshot`/`Subscribe`/`Unsubscribe`/`UpdatePresence`/`ListPresence`）+ SSE/HTTP Handler |
| `sheet` | `Workbook`, `NewWorkbook`, `ParseXLSX`, `WriteXLSX`, `ParseCSV`, `WriteCSV`, `Op`, `Diagnostic`, `NewHandler`, `WithAuth`, `WithWebhook`, `RegisterTools` | 纯 Go 电子表格引擎（DEFLATE XLSX/CSV + 公式求值 + `Inspect`/`Query`/`Apply`/`Verify`）+ REST + MCP 工具注册 |
| `doc` | `Document`, `ParseDOCX`, `WriteDOCX`, `ParseMarkdown`, `ToMarkdown`, `Op`, `NewHandler`, `WithAuth`, `WithWebhook`, `RegisterTools` | 纯 Go 文档引擎（DEFLATE DOCX/Markdown + 大纲 + `Inspect`/`Query`/`Apply`/`Verify`）+ REST + MCP 工具注册 |
| `slides` | `Deck`, `ParsePPTX`, `WritePPTX`, `RenderSlideSVG`, `Op`, `NewHandler`, `WithAuth`, `WithWebhook`, `RegisterTools` | 纯 Go 演示文稿引擎（DEFLATE PPTX + 16:9 SVG 渲染 + `Inspect`/`Apply`/`Verify`）+ REST + MCP 工具注册 |
| `whiteboard` | `Board`, `ParseMermaid`, `ToMermaid`, `ParseXMind`, `RenderSVG`, `Op`, `NewHandler`, `WithAuth`, `WithWebhook`, `RegisterTools` | 纯 Go 白板/脑图引擎（Mermaid/XMind + SVG 渲染 + `Inspect`/`Apply`/`Verify`）+ REST + MCP 工具注册 |
| `base` | `Base`, `ParseCSV`, `ToCSV`, `EvalExpr`, `Record`, `Op`, `NewHandler`, `WithAuth`, `WithWebhook`, `RegisterTools` | 纯 Go 多维表格引擎（CSV + `[Field]` 表达式求值 + `Inspect`/`Query`/`Apply`/`Verify`）+ REST + MCP 工具注册 |
| `ai` | `ToolRegistry`, `NewToolRegistry`, `ToolDefinition`, `ToolHandler`, `Server`, `NewServer`, `ServeStdio`, `HTTPHandler`, `ErrToolNotFound`, `ProtocolVersion` (`"2024-11-05"`) | 可组合 AI 工具注册表与 JSON-RPC 2.0 MCP Server |
| `server` | `Config`, `Features`, `AllFeatures`, `Server`, `New`（暴露 `ServeHTTP`/`Store`/`Hub`/`Tools`/`MCP`/`Features`） | 一键按需组合挂载全部子系统或按 `Features` 精确裁剪的一体化 `http.Handler` |
| `client` | `Client`, `NewClient`, `WithBearerToken`, `WithHTTPClient`, `APIError`, `CreateSheet`/`InspectSheet`/`ApplySheet`/`VerifySheet`, `CreateDoc`/`ApplyDoc`, `CreateSlides`/`RenderSlideSVG`, `CreateBoard`, `CreateBase`/`QueryBase`, `CallMCPTool` | 强类型 Go HTTP 客户端，便于微服务间调用 |

### 1.2 按需裁剪挂载与扩展点

#### 按 `Features` 仅开启指定子系统

```go
srv := server.New(server.Config{
	Store:   myStore,
	Auth:    myAuth,
	Authz:   myAuthz,
	Webhook: storage.NewWebhookDispatcher("https://hooks.example.com/jiange", "whsec_123", nil),
	Enable: server.Features{
		Sheet: true,
		Doc:   true,
		MCP:   true,
	},
})
```

#### 自定义 `Authenticator`、`Authorizer` 与 Webhook 验签

- **鉴权 (`storage.Authenticator`)**：实现 `Authenticate(r *http.Request) (*storage.Principal, error)`，自动将 `*Principal` 注入 `r.Context()`（通过 `storage.PrincipalFromContext(ctx)` 读取）。
- **权限 (`storage.Authorizer`)**：实现 `Authorize(ctx context.Context, p *storage.Principal, docID string, action storage.Action) error`，内置 `ActionRead` / `ActionWrite` / `ActionAdmin` 三级动作与 `storage.NewRoleAuthorizer(nil)` 默认 RBAC（`viewer` → 读，`editor` → 读写，`admin` → 全部）。
- **Webhook 验签**：请求头 `X-Jiange-Signature`（常量 `storage.SignatureHeader`）携带 `sha256=<hex>`，接收方用恒定时间比对函数 `storage.VerifySignature(secret, body, sig)` 校验。

#### 实时协同中枢 (`sync.RoomHub`)

- 内置 HTTP + SSE 端点可直接挂载；
- 若需桥接 WebSocket（如 `coder/websocket` 或 `gorilla/websocket`），只需实现 2 方法接口 `sync.TransportConn`：
  ```go
  type TransportConn interface {
      Send(data []byte) error
      Close() error
  }
  ```
  然后通过 `subID := hub.Subscribe(roomID, conn)` 与 `defer hub.Unsubscribe(roomID, subID)` 接入广播扇出。

### 1.3 `sdk/go/server` 全量 REST / SSE / AI / MCP 端点表

假设挂载前缀为 `/api/v1`（通过 `http.StripPrefix("/api/v1", srv)`）：

| 模块 | Method & Path | 权限级别 | 说明 |
| --- | --- | :---: | --- |
| **健康检查** | `GET /health`、`GET /healthz` | 公开 | 返回服务名、版本与启用的 `features` |
| **Sheet** | `POST /sheets` | `write` | 创建工作簿（支持 JSON/XLSX/CSV） |
| | `GET /sheets/{id}?detail=...` | `read` | 获取工作簿及 `inspect` 摘要 |
| | `GET /sheets/{id}/export` | `read` | 导出 `.xlsx` / `.csv` |
| | `POST /sheets/{id}/query` | `read` | 条件查询单元格 |
| | `POST /sheets/{id}/apply` | `write` | 原子批改（支持 `dryRun`） |
| | `POST /sheets/{id}/verify` | `read` | 公式错误审计 |
| | `DELETE /sheets/{id}` | `admin` | 删除工作簿 |
| **Doc** | `POST /docs`、`GET /docs/{id}`、`GET /docs/{id}/export`、`POST /docs/{id}/query`、`POST /docs/{id}/apply`、`POST /docs/{id}/verify`、`DELETE /docs/{id}` | 同上 | 文档 CRUD、DOCX/MD 导出、查询、批改与校验 |
| **Slides** | `POST /slides`、`GET /slides/{id}`、`GET /slides/{id}/export`、`GET /slides/{id}/render/{file}`、`POST /slides/{id}/apply`、`POST /slides/{id}/verify`、`DELETE /slides/{id}` | 同上 | 演示文稿 CRUD、PPTX 导出、单页 `.svg` 渲染（如 `/render/0.svg`）与校验 |
| **Whiteboard** | `POST /boards`、`GET /boards/{id}`、`GET /boards/{id}/render.svg`、`POST /boards/{id}/apply`、`POST /boards/{id}/verify`、`DELETE /boards/{id}` | 同上 | 白板 CRUD、SVG 渲染、批改与拓扑校验 |
| **Base** | `POST /bases`、`GET /bases/{id}`、`GET /bases/{id}/export.csv`、`POST /bases/{id}/query`、`POST /bases/{id}/apply`、`POST /bases/{id}/verify`、`DELETE /bases/{id}` | 同上 | 多维表格 CRUD、CSV 导出、查询、批改与校验 |
| **实时协同 (`sync`)** | `GET /rooms/{id}/events` | `read` | SSE 订阅（先发 `snapshot`，后续推送 `message` 事件） |
| | `POST /rooms/{id}/ops` / `GET /rooms/{id}/ops?after=<seq>` | `write` / `read` | 乐观 `baseSeq` 提交 op（冲突返回 `409` + `latestSeq`）与增量追帧 |
| | `POST /rooms/{id}/presence` / `GET /rooms/{id}/presence` | `write` / `read` | 更新/查询房间在线协作者光标与状态 |
| **AI & MCP** | `GET /ai/tools` | `read` | 列出 `ToolRegistry` 中全部已注册 AI 工具定义 |
| | `POST /ai/tools/{name}` | `write` | 通过普通 REST JSON 直接调用任意已注册 AI 工具 |
| | `POST /mcp` | `write` | JSON-RPC 2.0 MCP 端点（`initialize`/`ping`/`tools/list`/`tools/call`） |

### 1.4 强类型 Go 客户端（`sdk/go/client`）

```go
c := client.NewClient("http://127.0.0.1:8080/api/v1", client.WithBearerToken("prod-token"))

wb, err := c.CreateSheet(ctx, "q1-plan", "Q1 Plan", sheet.NewWorkbook("Revenue"))
if err != nil {
	log.Fatal(err)
}
_, err = c.ApplySheet(ctx, wb.ID, []sheet.Op{
	{Op: "setCell", Sheet: "Revenue", A1: "A1", Raw: "1200"},
	{Op: "setCell", Sheet: "Revenue", A1: "A2", Raw: "=A1*1.15"},
}, false)
diags, _ := c.VerifySheet(ctx, wb.ID)
mcpOut, _ := c.CallMCPTool(ctx, "sheet_inspect", map[string]any{"id": wb.ID})
```

---

## 2. PostgreSQL 持久化适配器（`github.com/ZSeven-W/jiange/sdk/go-pgstore`）

`sdk/go-pgstore` 完整实现 `storage.Store` 接口，直接基于 Go 标准库 `database/sql` 与 PostgreSQL 原生参数占位符（`$1..$N`）编写，**自身零第三方依赖**，由调用方自由选择 `github.com/jackc/pgx/v5/stdlib` 或 `github.com/lib/pq` 并掌握 `*sql.DB` 连接池生命周期。

```bash
go get github.com/ZSeven-W/jiange/sdk/go-pgstore
go get github.com/jackc/pgx/v5/stdlib
```

### 完整接入示例（`pgx/v5/stdlib` + `EnsureSchema` + `server.New`）

```go
package main

import (
	"context"
	"database/sql"
	"log"
	"net/http"
	"os"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/ZSeven-W/jiange/sdk/go/server"
	pgstore "github.com/ZSeven-W/jiange/sdk/go-pgstore"
)

func main() {
	ctx := context.Background()

	db, err := sql.Open("pgx", os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(25)
	db.SetConnMaxLifetime(30 * time.Minute)

	// 默认表名为 pgstore.DefaultTableName ("jiange_sdk_records")
	// WithTableName 严格校验 ^[a-z_][a-z0-9_]*$ 防止 SQL 注入
	store, err := pgstore.New(db, pgstore.WithTableName("jiange_sdk_records"))
	if err != nil {
		log.Fatal(err)
	}
	if err := store.EnsureSchema(ctx); err != nil {
		log.Fatal(err)
	}

	jiange := server.New(server.Config{Store: store, Version: "0.2.0"})
	log.Fatal(http.ListenAndServe(":8080", jiange))
}
```

### 乐观并发控制与表结构

- `EnsureSchema(ctx)` 幂等创建表（`id TEXT PRIMARY KEY`, `kind`, `title`, `version BIGINT`, `data BYTEA`, `metadata JSONB`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ`）及组合索引 `idx_<table>_kind_id (kind, id)`。
- **新建 (`rec.Version == 0`)**：执行原子 `INSERT ... ON CONFLICT (id) DO NOTHING`，冲突时返回 `storage.ErrVersionConflict`。
- **更新 (`rec.Version > 0`)**：执行原子 CAS `UPDATE ... SET version = version + 1 ... WHERE id = $6 AND version = $7 RETURNING version, created_at`，记录不存在或版本不匹配时返回 `storage.ErrVersionConflict`，同时无损保留原 `created_at`。

---

## 3. Go 原生 CLI & MCP Server（`cli/`）

模块 `github.com/ZSeven-W/jiange/cli`（Go 1.23，0 外部依赖）编译为跨平台单静态二进制 `jiange`。

### 3.1 本地文件命令参考

| 命令 | 子动作与常用参数 |
| --- | --- |
| `jiange sheet` | `<inspect\|query\|patch\|verify\|convert> <file>` — `--detail summary\|standard\|full`、`--sheet`、`--search`、`--formulas`、`--errors`、`--ops '<json>'`、`--dry-run`、`--out <path>` |
| `jiange doc` | `<inspect\|query\|patch\|verify\|convert> <file>` — `--detail`、`--search`、`--type`、`--ops '<json>'`、`--dry-run`、`--out <path>` |
| `jiange slides` | `<inspect\|patch\|verify\|render> <file>` — `--slide <0-based>`、`--ops '<json>'`、`--dry-run`、`--out <path>` |
| `jiange board` | `<inspect\|verify\|render> <file>` — 支持 `.mmd` / `.xmind` / `.json`，`--out <path>` |
| `jiange base` | `<inspect\|query\|patch\|verify> <file>` — 支持 `.json` / `.csv`，`--table <id>`、`--search`、`--ops '<json>'`、`--dry-run`、`--out <path>` |
| `jiange version` | 打印版本信息（`jiange 0.2.0 (Go native CLI & MCP Server)`） |

### 3.2 远程后端操控模式（`jiange remote`）

直接操控任意运行中的 `sdk/go/server` 实例（默认 `--prefix /api/v1`，`--server` 与 `--token` 自动读取环境变量 `JIANGE_SERVER` 与 `JIANGE_TOKEN`）：

```bash
export JIANGE_SERVER=http://127.0.0.1:8080
export JIANGE_TOKEN=prod-token

jiange remote health
jiange remote tools
jiange remote call   --tool sheet_inspect --args '{"id":"q1","detail":"summary"}'
jiange remote get    --path /sheets/q1
jiange remote post   --path /sheets --body '{"id":"q1","title":"Q1 Plan"}'
jiange remote patch  --path /sheets/q1 --body '{"title":"Q1 Final"}'
jiange remote delete --path /sheets/q1
```

### 3.3 MCP Server 模式（`stdio` 与 Streamable HTTP）

```bash
# 1. Stdio 传输（适合本地 IDE / 桌面 Agent）
jiange mcp --transport stdio

# 2. Streamable HTTP 传输（暴露 /mcp 与 /healthz）
jiange mcp --transport http --addr 127.0.0.1:8787
```

Streamable HTTP 端点 `/mcp` 完整支持：
- `OPTIONS /mcp`：返回 `204 No Content` 与 CORS 头（放行 `Mcp-Session-Id`、`Authorization`）；
- `POST /mcp`：处理 JSON-RPC 2.0 请求并签发/透传 `Mcp-Session-Id`（`notifications/*` 返回 `202 Accepted`）；
- `GET /mcp`：建立 SSE 长连接并发送 `event: ready`（附加 `?once=1` 可做单次探活）；
- `DELETE /mcp`：销毁指定 `Mcp-Session-Id` 会话并返回 `204 No Content`。
