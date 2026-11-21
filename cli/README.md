# Jiange Go CLI & MCP Server (`jiange`)

Zero-dependency native Go CLI and Streamable HTTP / stdio JSON-RPC 2.0 MCP Server for Jiange's AI-Native Office suite (Sheet, Doc, Slides, Whiteboard, Base), plus Remote Backend mode for live `sdk/go/server` instances.

Compiles to a single static binary with no Node.js runtime or external Go dependencies.

## Build

```bash
cd cli
go build -o jiange ./cmd/jiange
```

## Local CLI Usage

```bash
jiange sheet inspect budget.xlsx --detail full
jiange sheet query budget.xlsx --search "Revenue"
jiange sheet patch budget.xlsx --ops '[{"op":"setCell","sheet":"Sheet1","a1":"B2","raw":"=SUM(A1:A10)"}]' --out out.xlsx
jiange sheet verify budget.xlsx

jiange doc inspect spec.docx
jiange doc convert spec.md --out spec.docx

jiange slides inspect deck.pptx
jiange slides render deck.pptx --slide 0 --out slide1.svg

jiange board inspect arch.mmd
jiange board render arch.mmd --out arch.svg

jiange base inspect crm.json
jiange base query crm.json --search "Enterprise"
```

## MCP Server (Stdio & Streamable HTTP)

```bash
# stdio transport (Claude Desktop / Cursor / Antigravity)
jiange mcp --transport stdio

# Streamable HTTP MCP transport (OPTIONS / POST / GET SSE / DELETE on /mcp)
jiange mcp --transport http --addr 127.0.0.1:8787
```

### Streamable HTTP MCP Examples

```bash
# CORS preflight (204 No Content)
curl -i -X OPTIONS http://127.0.0.1:8787/mcp

# Initialize session (returns Mcp-Session-Id response header)
curl -i -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# Send JSON-RPC notification (202 Accepted)
curl -i -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Mcp-Session-Id: jiange-mcp-session-1' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# Open SSE stream (returns initial ready event; append ?once=1 for one-shot probe)
curl -N -H 'Mcp-Session-Id: jiange-mcp-session-1' 'http://127.0.0.1:8787/mcp?once=1'

# Terminate session (204 No Content)
curl -i -X DELETE -H 'Mcp-Session-Id: jiange-mcp-session-1' http://127.0.0.1:8787/mcp
```

## Remote Backend Server Mode (`jiange remote`)

Operate directly against any live Jiange Go Backend SDK server (`sdk/go/server`, default prefix `/api/v1`, overridable via `--prefix`).

`--server` and `--token` automatically fall back to `JIANGE_SERVER` and `JIANGE_TOKEN` environment variables.

```bash
export JIANGE_SERVER=http://127.0.0.1:8080
export JIANGE_TOKEN=your-bearer-token

# Check backend health (GET /api/v1/health)
jiange remote health

# List registered AI tools (GET /api/v1/ai/tools)
jiange remote tools

# Call an AI tool (POST /api/v1/ai/tools/sheet_inspect)
jiange remote call --tool sheet_inspect --args '{"id":"q1-budget","detail":"standard"}'

# Generic REST JSON requests (GET / POST / PATCH / DELETE)
jiange remote get    --path /sheets/q1-budget
jiange remote post   --path /sheets --body '{"id":"q1-budget","title":"Q1 Budget"}'
jiange remote patch  --path /sheets/q1-budget --body '{"title":"Q1 Final"}'
jiange remote delete --path /sheets/q1-budget

# Override server, token, or API prefix explicitly
jiange remote health --server http://127.0.0.1:8080 --token prod-tok --prefix /api/jiange
```
