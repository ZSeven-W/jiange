# Jiange Go Backend SDK (`github.com/ZSeven-W/jiange/sdk/go`)

Standalone, ultra-lightweight, **zero-external-dependency** Go 1.23 SDK for embedding Jiange's pure-Go Office engines (Spreadsheet, Document, Slides, Whiteboard/MindMap, Multidimensional Base), real-time collaboration hub, storage/auth/webhook hooks, REST APIs, and MCP server into any Go backend (`net/http`, Gin, Echo, Chi, Fiber).

Import **only** the domain packages your service needs — every domain package (`sheet`, `doc`, `slides`, `whiteboard`, `base`) is independently usable and built 100% on the Go standard library.

## Installation

```bash
go get github.com/ZSeven-W/jiange/sdk/go
```

## 3-Line Quickstart (`net/http` & Gin)

### Standard `net/http`

```go
store := storage.NewMemoryStore()
jiange := server.New(server.Config{Store: store})
log.Fatal(http.ListenAndServe(":8080", jiange))
```

Mount under a prefix in an existing `http.ServeMux`:

```go
mux := http.NewServeMux()
mux.Handle("/api/jiange/", http.StripPrefix("/api/jiange", server.New(server.Config{})))
```

### Gin

```go
r := gin.Default()
jiange := server.New(server.Config{Store: storage.NewMemoryStore()})
r.Any("/api/jiange/*any", gin.WrapH(http.StripPrefix("/api/jiange", jiange)))
```

*(Works identically with Chi `r.Mount`, Echo `echo.WrapHandler`, and Fiber adaptor.)*

## Independent Per-Domain Imports

Only need Spreadsheets (XLSX/CSV + formula engine + REST API)? Import just `storage` and `sheet`:

```go
package main

import (
	"log"
	"net/http"

	"github.com/ZSeven-W/jiange/sdk/go/sheet"
	"github.com/ZSeven-W/jiange/sdk/go/storage"
)

func main() {
	store, err := storage.NewFileStore("./data/sheets")
	if err != nil {
		log.Fatal(err)
	}
	log.Fatal(http.ListenAndServe(":8080", sheet.NewHandler(store)))
}
```

### Available Packages

| Package | Purpose | Key Types & APIs |
| --- | --- | --- |
| `storage` | Persistence, AuthN/AuthZ, Signed Webhooks | `Store`, `MemoryStore`, `FileStore`, `BearerTokenAuth`, `RoleAuthorizer`, `AuthMiddleware`, `WebhookDispatcher`, `VerifySignature` |
| `sync` | Transport-agnostic real-time collab hub | `RoomHub` (`Append`, `PullSince`, `Snapshot`, `Subscribe`, `UpdatePresence`, `ListPresence`), `TransportConn`, `NewHandler` (SSE + REST) |
| `sheet` | Pure-Go Spreadsheet engine + REST + MCP | `Workbook`, `ParseXLSX`, `WriteXLSX`, `ParseCSV`, `WriteCSV`, formulas (`SUM`/`AVERAGE`/`MIN`/`MAX`/`COUNT`/`ABS`/`ROUND`/`IF`), `Apply`, `Verify`, `NewHandler`, `RegisterTools` |
| `doc` | Pure-Go Document engine + REST + MCP | `Document`, `ParseDOCX`, `WriteDOCX`, `ParseMarkdown`, `ToMarkdown`, `Inspect`, `Query`, `Apply`, `Verify`, `NewHandler`, `RegisterTools` |
| `slides` | Pure-Go Slides engine + REST + MCP | `Deck`, `ParsePPTX`, `WritePPTX`, `RenderSlideSVG`, `Inspect`, `Apply`, `Verify`, `NewHandler`, `RegisterTools` |
| `whiteboard` | Pure-Go Whiteboard & MindMap + REST + MCP | `Board`, `ParseMermaid`, `ToMermaid`, `ParseXMind`, `RenderSVG`, `Apply`, `Verify`, `NewHandler`, `RegisterTools` |
| `base` | Pure-Go Multidimensional Base + REST + MCP | `Base`, `ParseCSV`, `ToCSV`, `[Field]` `EvalExpr`, `Inspect`, `Query`, `Apply`, `Verify`, `NewHandler`, `RegisterTools` |
| `ai` | Modular AI Tool Registry & JSON-RPC 2.0 MCP | `ToolRegistry`, `Server`, `ServeStdio`, `HTTPHandler` (`POST /mcp`, `GET /healthz`) |
| `server` | Optional all-in-one router | `server.New(server.Config{...})` with per-feature toggles |
| `client` | Strongly-typed Go HTTP client | `client.NewClient(baseURL, WithBearerToken(...))` |

## Custom `Store`, `Authenticator`, and `Authorizer`

Plug into your existing Postgres/S3 database and JWT/RBAC middleware by implementing the minimal `storage` interfaces:

```go
type MyStore struct{ /* *sql.DB, S3 client, etc. */ }

func (s *MyStore) Get(ctx context.Context, id string) (*storage.DocumentRecord, error) { /* ... */ }
func (s *MyStore) Put(ctx context.Context, rec *storage.DocumentRecord) error          { /* check rec.Version -> storage.ErrVersionConflict */ }
func (s *MyStore) Delete(ctx context.Context, id string) error                         { /* ... */ }
func (s *MyStore) List(ctx context.Context, kind string) ([]*storage.DocumentRecord, error) { /* ... */ }

type MyJWTAuth struct{}

func (a *MyJWTAuth) Authenticate(r *http.Request) (*storage.Principal, error) {
	// Validate JWT / session cookie and return caller identity + roles.
	return &storage.Principal{ID: "user-42", Roles: []string{"editor"}}, nil
}

type MyDocACL struct{}

func (a *MyDocACL) Authorize(ctx context.Context, p *storage.Principal, docID string, action storage.Action) error {
	if p == nil {
		return storage.ErrForbidden
	}
	// Check document-level ACL for (p.ID, docID, action)
	return nil
}

handler := sheet.NewHandler(
	&MyStore{},
	sheet.WithAuth(&MyJWTAuth{}, &MyDocACL{}),
)
```

Or use the built-in helpers right out of the box:

```go
auth := storage.NewBearerTokenAuth(map[string]storage.Principal{
	"prod-token": {ID: "svc", Roles: []string{"admin"}},
})
authz := storage.NewRoleAuthorizer(nil) // viewer->read, editor->read/write, admin->all
```

## Webhook Dispatch & HMAC-SHA256 Verification

Attach a `storage.WebhookDispatcher` to any domain handler or `server.Config`:

```go
webhooks := storage.NewWebhookDispatcher("https://hooks.example.com/jiange", "whsec_123", nil)
srv := server.New(server.Config{Webhook: webhooks})
```

Verify incoming webhooks on your receiver using `storage.VerifySignature`:

```go
func handleJiangeWebhook(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	sig := r.Header.Get(storage.SignatureHeader) // "X-Jiange-Signature"
	if !storage.VerifySignature("whsec_123", body, sig) {
		http.Error(w, "invalid signature", http.StatusUnauthorized)
		return
	}
	var evt storage.WebhookEvent
	_ = json.Unmarshal(body, &evt)
	// Process evt.Type ("sheet.updated", "doc.created", ...)
	w.WriteHeader(http.StatusOK)
}
```

## Composable AI / MCP Server Mount

Register only the domains you want to expose to AI agents, then serve over HTTP (`POST /mcp`) or Stdio:

```go
store := storage.NewMemoryStore()
reg := ai.NewToolRegistry()
_ = reg.RegisterAll(
	func(r *ai.ToolRegistry) error { return sheet.RegisterTools(r, store) },
	func(r *ai.ToolRegistry) error { return doc.RegisterTools(r, store) },
)

mcpSrv := ai.NewServer(reg, "my-app-mcp", "1.0.0")
http.Handle("/mcp", mcpSrv.HTTPHandler())
// Or over stdio: _ = mcpSrv.ServeStdio(ctx, os.Stdin, os.Stdout)
```

## Real-Time Collaboration (`sync.RoomHub`)

Use the built-in SSE + REST handler directly, or bridge your preferred WebSocket library (`coder/websocket`, `gorilla/websocket`) via the 2-method `sync.TransportConn` interface (`Send([]byte) error`, `Close() error`):

```go
hub := sync.NewRoomHub(sync.WithMaxHistory(500), sync.WithPresenceTTL(30*time.Second))
http.Handle("/rooms/", sync.NewHandler(hub))
```

## Typed Go Client

```go
c := client.NewClient("http://localhost:8080", client.WithBearerToken("prod-token"))
created, _ := c.CreateSheet(ctx, "q1", "Q1 Plan", sheet.NewWorkbook("Revenue"))
_, _ = c.ApplySheet(ctx, created.ID, []sheet.Op{
	{Op: "setCell", Sheet: "Revenue", A1: "A1", Raw: "1200"},
	{Op: "setCell", Sheet: "Revenue", A1: "A2", Raw: "=A1*1.15"},
}, false)
output, _ := c.CallMCPTool(ctx, "sheet_inspect", map[string]any{"id": created.ID})
```

## Verification

```bash
go vet ./...
go test -race -cover ./...
```
