# Jiange Go CLI & MCP Server (`jiange`)

Zero-dependency native Go CLI and JSON-RPC 2.0 MCP Server for Jiange's AI-Native Office suite (Sheet, Doc, Slides, Whiteboard, Base).

Compiles to a single static binary with no Node.js runtime or external Go dependencies.

## Build

```bash
cd cli
go build -o jiange ./cmd/jiange
```

## CLI Usage

```bash
jiange sheet inspect budget.xlsx --format json
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

## MCP Server

```bash
# stdio transport (Claude Desktop / Cursor / Antigravity)
jiange mcp --transport stdio

# HTTP JSON-RPC transport
jiange mcp --transport http --addr 127.0.0.1:8787
```
