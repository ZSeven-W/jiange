package mcp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/ZSeven-W/jiange/cli/internal/engine"
)

const ProtocolVersion = "2024-11-05"

// RPCRequest is an inbound JSON-RPC 2.0 frame.
type RPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// RPCError is a JSON-RPC 2.0 error object.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// RPCResponse is an outbound JSON-RPC 2.0 frame.
type RPCResponse struct {
	JSONRPC string    `json:"jsonrpc"`
	ID      any       `json:"id,omitempty"`
	Result  any       `json:"result,omitempty"`
	Error   *RPCError `json:"error,omitempty"`
}

// ToolDefinition matches MCP tools/list schema.
type ToolDefinition struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

// Server serves Jiange's AI-Native Office tools over MCP (stdio or Streamable HTTP).
type Server struct {
	Version     string
	mu          sync.Mutex
	nextSession uint64
	sessions    map[string]struct{}
}

// NewServer constructs a native Go MCP Server.
func NewServer(version string) *Server {
	if version == "" {
		version = "0.2.0"
	}
	return &Server{Version: version}
}

// Tools returns all MCP tool definitions across Sheet, Doc, Slides, Whiteboard, and Base.
func (s *Server) Tools() []ToolDefinition {
	pathProp := map[string]any{"type": "string", "description": "Local file path"}
	return []ToolDefinition{
		{
			Name:        "sheet_inspect",
			Description: "Inspect an .xlsx or .csv workbook structure, cell counts, formulas, and error summary.",
			InputSchema: map[string]any{"type": "object", "required": []string{"path"}, "properties": map[string]any{"path": pathProp, "detail": map[string]any{"type": "string", "enum": []string{"summary", "standard", "full"}}}},
		},
		{
			Name:        "sheet_query",
			Description: "Search cells in an .xlsx or .csv workbook by sheet, keyword, formulas, or errors.",
			InputSchema: map[string]any{"type": "object", "required": []string{"path"}, "properties": map[string]any{"path": pathProp, "sheet": map[string]any{"type": "string"}, "search": map[string]any{"type": "string"}, "onlyFormulas": map[string]any{"type": "boolean"}, "onlyErrors": map[string]any{"type": "boolean"}, "limit": map[string]any{"type": "number"}}},
		},
		{
			Name:        "sheet_patch",
			Description: "Atomically apply SheetOp edits (setCell, addSheet) with optional dryRun and save to output path.",
			InputSchema: map[string]any{"type": "object", "required": []string{"path", "ops"}, "properties": map[string]any{"path": pathProp, "outPath": pathProp, "ops": map[string]any{"type": "array"}, "dryRun": map[string]any{"type": "boolean"}}},
		},
		{
			Name:        "sheet_verify",
			Description: "Verify all workbook formulas and report error diagnostics (#DIV/0!, #CYCLE!, #VALUE!, #NAME?).",
			InputSchema: map[string]any{"type": "object", "required": []string{"path"}, "properties": map[string]any{"path": pathProp}},
		},
		{
			Name:        "doc_inspect",
			Description: "Inspect a .docx or .md document outline, block count, and word count.",
			InputSchema: map[string]any{"type": "object", "required": []string{"path"}, "properties": map[string]any{"path": pathProp, "detail": map[string]any{"type": "string", "enum": []string{"summary", "standard", "full"}}}},
		},
		{
			Name:        "doc_query",
			Description: "Search blocks in a .docx or .md document by text or block type.",
			InputSchema: map[string]any{"type": "object", "required": []string{"path"}, "properties": map[string]any{"path": pathProp, "text": map[string]any{"type": "string"}, "type": map[string]any{"type": "string"}}},
		},
		{
			Name:        "doc_patch",
			Description: "Atomically apply DocOp edits (appendBlock, replaceText, deleteBlock) with optional dryRun.",
			InputSchema: map[string]any{"type": "object", "required": []string{"path", "ops"}, "properties": map[string]any{"path": pathProp, "outPath": pathProp, "ops": map[string]any{"type": "array"}, "dryRun": map[string]any{"type": "boolean"}}},
		},
		{
			Name:        "doc_verify",
			Description: "Verify document heading hierarchy and structure.",
			InputSchema: map[string]any{"type": "object", "required": []string{"path"}, "properties": map[string]any{"path": pathProp}},
		},
		{
			Name:        "slides_inspect",
			Description: "Inspect a .pptx presentation outline and slide contents.",
			InputSchema: map[string]any{"type": "object", "required": []string{"path"}, "properties": map[string]any{"path": pathProp}},
		},
		{
			Name:        "slides_patch",
			Description: "Atomically apply slide mutations (addSlide, updateSlide, deleteSlide) with optional dryRun.",
			InputSchema: map[string]any{"type": "object", "required": []string{"path", "ops"}, "properties": map[string]any{"path": pathProp, "outPath": pathProp, "ops": map[string]any{"type": "array"}, "dryRun": map[string]any{"type": "boolean"}}},
		},
		{
			Name:        "slides_verify",
			Description: "Audit a .pptx presentation for empty slides and text overflow.",
			InputSchema: map[string]any{"type": "object", "required": []string{"path"}, "properties": map[string]any{"path": pathProp}},
		},
		{
			Name:        "slides_render_svg",
			Description: "Render a slide from a .pptx deck to a deterministic 16:9 SVG string.",
			InputSchema: map[string]any{"type": "object", "required": []string{"path"}, "properties": map[string]any{"path": pathProp, "slideIndex": map[string]any{"type": "number"}}},
		},
		{
			Name:        "board_inspect",
			Description: "Inspect a Mermaid (.mmd), XMind (.xmind), or JSON whiteboard graph.",
			InputSchema: map[string]any{"type": "object", "required": []string{"path"}, "properties": map[string]any{"path": pathProp}},
		},
		{
			Name:        "board_verify",
			Description: "Verify whiteboard graph topology (dangling edges, isolated nodes).",
			InputSchema: map[string]any{"type": "object", "required": []string{"path"}, "properties": map[string]any{"path": pathProp}},
		},
		{
			Name:        "board_render_svg",
			Description: "Render a whiteboard (.mmd / .xmind / .json) to SVG.",
			InputSchema: map[string]any{"type": "object", "required": []string{"path"}, "properties": map[string]any{"path": pathProp}},
		},
		{
			Name:        "base_inspect",
			Description: "Inspect a Jiange Base (.json or .csv) tables, field schemas, and record counts.",
			InputSchema: map[string]any{"type": "object", "required": []string{"path"}, "properties": map[string]any{"path": pathProp}},
		},
		{
			Name:        "base_query",
			Description: "Query Base records by tableId and search keyword.",
			InputSchema: map[string]any{"type": "object", "required": []string{"path"}, "properties": map[string]any{"path": pathProp, "tableId": map[string]any{"type": "number"}, "search": map[string]any{"type": "string"}, "limit": map[string]any{"type": "number"}}},
		},
		{
			Name:        "base_patch",
			Description: "Atomically apply BasePatchOps (addRecord, addField, deleteRecord) with optional dryRun.",
			InputSchema: map[string]any{"type": "object", "required": []string{"path", "ops"}, "properties": map[string]any{"path": pathProp, "outPath": pathProp, "ops": map[string]any{"type": "array"}, "dryRun": map[string]any{"type": "boolean"}}},
		},
		{
			Name:        "base_verify",
			Description: "Verify Base schema consistency and duplicate field names.",
			InputSchema: map[string]any{"type": "object", "required": []string{"path"}, "properties": map[string]any{"path": pathProp}},
		},
	}
}

// HandleRequest processes a single JSON-RPC 2.0 MCP request. Returns nil for notifications.
func (s *Server) HandleRequest(req RPCRequest) *RPCResponse {
	if req.Method == "notifications/initialized" || strings.HasPrefix(req.Method, "notifications/") {
		return nil
	}
	switch req.Method {
	case "initialize":
		return &RPCResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"protocolVersion": ProtocolVersion,
				"capabilities": map[string]any{
					"tools": map[string]any{"listChanged": false},
				},
				"serverInfo": map[string]any{
					"name":    "jiange-mcp",
					"version": s.Version,
				},
			},
		}
	case "ping":
		return &RPCResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{}}
	case "tools/list":
		return &RPCResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  map[string]any{"tools": s.Tools()},
		}
	case "tools/call":
		var params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return &RPCResponse{JSONRPC: "2.0", ID: req.ID, Error: &RPCError{Code: -32602, Message: "invalid params: " + err.Error()}}
		}
		res, err := s.ExecuteTool(params.Name, params.Arguments)
		if err != nil {
			return &RPCResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Result: map[string]any{
					"isError": true,
					"content": []map[string]any{{"type": "text", "text": err.Error()}},
				},
			}
		}
		payload, _ := json.MarshalIndent(res, "", "  ")
		return &RPCResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"content": []map[string]any{{"type": "text", "text": string(payload)}},
			},
		}
	default:
		return &RPCResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &RPCError{Code: -32601, Message: "method not found: " + req.Method},
		}
	}
}

// ExecuteTool executes a single MCP tool call against local files.
func (s *Server) ExecuteTool(name string, args map[string]any) (any, error) {
	strArg := func(k string) string {
		if v, ok := args[k].(string); ok {
			return v
		}
		return ""
	}
	boolArg := func(k string) bool {
		if v, ok := args[k].(bool); ok {
			return v
		}
		return false
	}
	intArg := func(k string) int {
		if v, ok := args[k].(float64); ok {
			return int(v)
		}
		return 0
	}

	path := strArg("path")
	if path == "" {
		return nil, fmt.Errorf("missing required argument: path")
	}

	switch name {
	case "sheet_inspect":
		wb, err := engine.LoadWorkbook(path)
		if err != nil {
			return nil, err
		}
		return wb.Inspect(strArg("detail")), nil
	case "sheet_query":
		wb, err := engine.LoadWorkbook(path)
		if err != nil {
			return nil, err
		}
		return wb.Query(strArg("sheet"), strArg("search"), boolArg("onlyFormulas"), boolArg("onlyErrors"), intArg("limit")), nil
	case "sheet_patch":
		wb, err := engine.LoadWorkbook(path)
		if err != nil {
			return nil, err
		}
		opsRaw, _ := json.Marshal(args["ops"])
		var ops []engine.SheetOp
		if err := json.Unmarshal(opsRaw, &ops); err != nil {
			return nil, err
		}
		dryRun := boolArg("dryRun")
		applied, diff, err := wb.Apply(ops, dryRun)
		if err != nil {
			return nil, err
		}
		if !dryRun {
			outPath := strArg("outPath")
			if outPath == "" {
				outPath = path
			}
			if err := engine.SaveWorkbook(outPath, wb); err != nil {
				return nil, err
			}
		}
		return map[string]any{"ok": true, "applied": applied, "dryRun": dryRun, "diff": diff}, nil
	case "sheet_verify":
		wb, err := engine.LoadWorkbook(path)
		if err != nil {
			return nil, err
		}
		return wb.Verify(), nil
	case "doc_inspect":
		doc, err := engine.LoadDoc(path)
		if err != nil {
			return nil, err
		}
		return doc.Inspect(strArg("detail")), nil
	case "doc_query":
		doc, err := engine.LoadDoc(path)
		if err != nil {
			return nil, err
		}
		return doc.Query(strArg("text"), strArg("type")), nil
	case "doc_patch":
		doc, err := engine.LoadDoc(path)
		if err != nil {
			return nil, err
		}
		opsRaw, _ := json.Marshal(args["ops"])
		var ops []engine.DocOp
		if err := json.Unmarshal(opsRaw, &ops); err != nil {
			return nil, err
		}
		dryRun := boolArg("dryRun")
		applied, diff, err := doc.Apply(ops, dryRun)
		if err != nil {
			return nil, err
		}
		if !dryRun {
			outPath := strArg("outPath")
			if outPath == "" {
				outPath = path
			}
			if err := engine.SaveDoc(outPath, doc); err != nil {
				return nil, err
			}
		}
		return map[string]any{"ok": true, "applied": applied, "dryRun": dryRun, "diff": diff}, nil
	case "doc_verify":
		doc, err := engine.LoadDoc(path)
		if err != nil {
			return nil, err
		}
		return doc.Verify(), nil
	case "slides_inspect":
		deck, err := engine.LoadDeck(path)
		if err != nil {
			return nil, err
		}
		return deck.Inspect(), nil
	case "slides_patch":
		deck, err := engine.LoadDeck(path)
		if err != nil {
			return nil, err
		}
		opsRaw, _ := json.Marshal(args["ops"])
		var ops []engine.SlidePatchOp
		if err := json.Unmarshal(opsRaw, &ops); err != nil {
			return nil, err
		}
		dryRun := boolArg("dryRun")
		applied, diff, err := deck.Apply(ops, dryRun)
		if err != nil {
			return nil, err
		}
		if !dryRun {
			outPath := strArg("outPath")
			if outPath == "" {
				outPath = path
			}
			if err := engine.SaveDeck(outPath, deck); err != nil {
				return nil, err
			}
		}
		return map[string]any{"ok": true, "applied": applied, "dryRun": dryRun, "diff": diff}, nil
	case "slides_verify":
		deck, err := engine.LoadDeck(path)
		if err != nil {
			return nil, err
		}
		return deck.Verify(), nil
	case "slides_render_svg":
		deck, err := engine.LoadDeck(path)
		if err != nil {
			return nil, err
		}
		svg, err := deck.RenderSlideSVG(intArg("slideIndex"))
		if err != nil {
			return nil, err
		}
		return map[string]any{"svg": svg}, nil
	case "board_inspect":
		board, err := engine.LoadBoard(path)
		if err != nil {
			return nil, err
		}
		return board.Inspect(), nil
	case "board_verify":
		board, err := engine.LoadBoard(path)
		if err != nil {
			return nil, err
		}
		return board.Verify(), nil
	case "board_render_svg":
		board, err := engine.LoadBoard(path)
		if err != nil {
			return nil, err
		}
		return map[string]any{"svg": board.RenderSVG()}, nil
	case "base_inspect":
		b, err := engine.LoadBase(path)
		if err != nil {
			return nil, err
		}
		return b.Inspect(), nil
	case "base_query":
		b, err := engine.LoadBase(path)
		if err != nil {
			return nil, err
		}
		return b.Query(intArg("tableId"), strArg("search"), intArg("limit")), nil
	case "base_patch":
		b, err := engine.LoadBase(path)
		if err != nil {
			return nil, err
		}
		opsRaw, _ := json.Marshal(args["ops"])
		var ops []engine.BasePatchOp
		if err := json.Unmarshal(opsRaw, &ops); err != nil {
			return nil, err
		}
		dryRun := boolArg("dryRun")
		applied, diff, err := b.Apply(ops, dryRun)
		if err != nil {
			return nil, err
		}
		if !dryRun {
			outPath := strArg("outPath")
			if outPath == "" {
				outPath = path
			}
			if err := engine.SaveBase(outPath, b); err != nil {
				return nil, err
			}
		}
		return map[string]any{"ok": true, "applied": applied, "dryRun": dryRun, "diff": diff}, nil
	case "base_verify":
		b, err := engine.LoadBase(path)
		if err != nil {
			return nil, err
		}
		return b.Verify(), nil
	default:
		return nil, fmt.Errorf("unknown tool: %s", name)
	}
}

// ServeStdio runs the newline-delimited JSON-RPC 2.0 MCP loop on r/w.
func (s *Server) ServeStdio(r io.Reader, w io.Writer) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	enc := json.NewEncoder(w)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var req RPCRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			_ = enc.Encode(RPCResponse{
				JSONRPC: "2.0",
				Error:   &RPCError{Code: -32700, Message: "parse error: " + err.Error()},
			})
			continue
		}
		if resp := s.HandleRequest(req); resp != nil {
			if err := enc.Encode(resp); err != nil {
				return err
			}
		}
	}
	return scanner.Err()
}

func (s *Server) ensureSession(incoming string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions == nil {
		s.sessions = make(map[string]struct{})
	}
	id := strings.TrimSpace(incoming)
	if id == "" {
		s.nextSession++
		id = fmt.Sprintf("jiange-mcp-session-%d", s.nextSession)
	}
	s.sessions[id] = struct{}{}
	return id
}

func (s *Server) deleteSession(sessionID string) {
	id := strings.TrimSpace(sessionID)
	if id == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, id)
}

// ActiveSessions returns the number of currently active Streamable HTTP MCP sessions.
func (s *Server) ActiveSessions() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sessions)
}

// HasSession reports whether sessionID is tracked in the active HTTP session map.
func (s *Server) HasSession(sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.sessions[sessionID]
	return ok
}

func setMCPCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Authorization")
	w.Header().Set("Access-Control-Expose-Headers", "Mcp-Session-Id")
}

// HTTPHandler exposes the MCP Server over Streamable HTTP (OPTIONS/POST/GET/DELETE /mcp + GET /healthz).
func (s *Server) HTTPHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"service":"jiange-mcp"}`))
	})
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		setMCPCORSHeaders(w)
		switch r.Method {
		case http.MethodOptions:
			w.WriteHeader(http.StatusNoContent)
		case http.MethodPost:
			sessionID := s.ensureSession(r.Header.Get("Mcp-Session-Id"))
			w.Header().Set("Mcp-Session-Id", sessionID)
			var req RPCRequest
			if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024*1024)).Decode(&req); err != nil {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32700, Message: err.Error()}})
				return
			}
			resp := s.HandleRequest(req)
			if resp == nil {
				w.WriteHeader(http.StatusAccepted)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(resp)
		case http.MethodGet:
			sessionID := s.ensureSession(r.Header.Get("Mcp-Session-Id"))
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Mcp-Session-Id", sessionID)
			_, _ = fmt.Fprintf(w, "event: ready\ndata: {\"protocolVersion\":%q,\"server\":\"jiange-mcp\"}\n\n", ProtocolVersion)
			_ = http.NewResponseController(w).Flush()
			if r.URL.Query().Get("once") == "1" {
				return
			}
			<-r.Context().Done()
		case http.MethodDelete:
			s.deleteSession(r.Header.Get("Mcp-Session-Id"))
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	return mux
}
