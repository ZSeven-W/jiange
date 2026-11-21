package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/ZSeven-W/jiange/cli/internal/engine"
)

type errWriter struct{ err error }

func (e errWriter) Write([]byte) (int, error) { return 0, e.err }

type errReader struct{ err error }

func (e errReader) Read([]byte) (int, error) { return 0, e.err }

func TestMCPStdioAndHTTPTransports(t *testing.T) {
	dir := t.TempDir()
	xlsxPath := filepath.Join(dir, "sales.xlsx")
	wb, _ := engine.ParseCSVWorkbook([]byte("Item,Rev\nA,100\nB,=B2*2\n"), "Sales")
	if err := engine.SaveWorkbook(xlsxPath, wb); err != nil {
		t.Fatalf("SaveWorkbook: %v", err)
	}

	if def := NewServer(""); def.Version != "0.2.0" {
		t.Fatalf("expected default version 0.2.0, got %q", def.Version)
	}
	srv := NewServer("0.2.0")

	// 1. Test stdio loop: blank line, parse error, initialize, notifications, tools/list, tools/call (ok + err + invalid params), unknown method, ping
	callParams, _ := json.Marshal(map[string]any{
		"name":      "sheet_inspect",
		"arguments": map[string]any{"path": xlsxPath, "detail": "standard"},
	})
	errCallParams, _ := json.Marshal(map[string]any{
		"name":      "unknown_tool",
		"arguments": map[string]any{"path": xlsxPath},
	})
	input := strings.Join([]string{
		"",
		"   ",
		"{not-json",
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","method":"notifications/cancelled"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":` + string(callParams) + `}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":` + string(errCallParams) + `}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":"not-an-object"}`,
		`{"jsonrpc":"2.0","id":6,"method":"no/such/method"}`,
		`{"jsonrpc":"2.0","id":7,"method":"ping"}`,
	}, "\n") + "\n"

	var out bytes.Buffer
	if err := srv.ServeStdio(strings.NewReader(input), &out); err != nil {
		t.Fatalf("ServeStdio: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 8 {
		t.Fatalf("expected 8 JSON-RPC responses (blank lines & notifications ignored), got %d:\n%s", len(lines), out.String())
	}
	if !strings.Contains(lines[0], "-32700") {
		t.Fatalf("expected parse error -32700: %s", lines[0])
	}
	if !strings.Contains(lines[1], ProtocolVersion) {
		t.Fatalf("missing protocolVersion in initialize: %s", lines[1])
	}
	if !strings.Contains(lines[2], `"sheet_inspect"`) || !strings.Contains(lines[2], `"base_verify"`) {
		t.Fatalf("tools/list missing expected tools: %s", lines[2])
	}
	if !strings.Contains(lines[3], `Sales`) || !strings.Contains(lines[3], `200`) {
		t.Fatalf("sheet_inspect response unexpected: %s", lines[3])
	}
	if !strings.Contains(lines[4], `"isError":true`) {
		t.Fatalf("expected isError on unknown tool: %s", lines[4])
	}
	if !strings.Contains(lines[5], "-32602") {
		t.Fatalf("expected invalid params -32602: %s", lines[5])
	}
	if !strings.Contains(lines[6], "-32601") {
		t.Fatalf("expected method not found -32601: %s", lines[6])
	}

	// ServeStdio write error & read error
	if err := srv.ServeStdio(strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`+"\n"), errWriter{err: errors.New("write boom")}); err == nil {
		t.Fatalf("expected ServeStdio write error")
	}
	if err := srv.ServeStdio(errReader{err: errors.New("read boom")}, &bytes.Buffer{}); err == nil {
		t.Fatalf("expected ServeStdio read error")
	}

	// 2. Test Streamable HTTP handler (/healthz, OPTIONS, POST, GET SSE, DELETE, unsupported 405)
	ts := httptest.NewServer(srv.HTTPHandler())
	defer ts.Close()

	hResp, err := http.Get(ts.URL + "/healthz")
	if err != nil || hResp.StatusCode != http.StatusOK {
		t.Fatalf("healthz failed: %v", err)
	}
	hResp.Body.Close()

	// OPTIONS /mcp -> 204 No Content + CORS headers
	optReq, _ := http.NewRequest(http.MethodOptions, ts.URL+"/mcp", nil)
	optResp, err := http.DefaultClient.Do(optReq)
	if err != nil || optResp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 for OPTIONS /mcp, got %v %v", optResp, err)
	}
	if got := optResp.Header.Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("unexpected Access-Control-Allow-Origin: %q", got)
	}
	if got := optResp.Header.Get("Access-Control-Allow-Methods"); got != "GET, POST, DELETE, OPTIONS" {
		t.Fatalf("unexpected Access-Control-Allow-Methods: %q", got)
	}
	if got := optResp.Header.Get("Access-Control-Allow-Headers"); got != "Content-Type, Mcp-Session-Id, Authorization" {
		t.Fatalf("unexpected Access-Control-Allow-Headers: %q", got)
	}
	optResp.Body.Close()

	// Unsupported method (PUT /mcp) -> 405 Method Not Allowed
	putReq, _ := http.NewRequest(http.MethodPut, ts.URL+"/mcp", nil)
	putResp, err := http.DefaultClient.Do(putReq)
	if err != nil || putResp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for PUT /mcp, got %v %v", putResp, err)
	}
	putResp.Body.Close()

	// POST /mcp bad JSON -> 400 + deterministic Mcp-Session-Id
	badResp, err := http.Post(ts.URL+"/mcp", "application/json", strings.NewReader("{bad"))
	if err != nil || badResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for bad JSON, got %v %v", badResp, err)
	}
	firstSession := badResp.Header.Get("Mcp-Session-Id")
	if firstSession == "" || !srv.HasSession(firstSession) {
		t.Fatalf("expected assigned session header tracked in server, got %q", firstSession)
	}
	badResp.Body.Close()

	// POST /mcp notification reusing session -> 202 Accepted + echoed Mcp-Session-Id
	notifReq, _ := http.NewRequest(http.MethodPost, ts.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	notifReq.Header.Set("Content-Type", "application/json")
	notifReq.Header.Set("Mcp-Session-Id", firstSession)
	notifResp, err := http.DefaultClient.Do(notifReq)
	if err != nil || notifResp.StatusCode != http.StatusAccepted {
		t.Fatalf("expected 202 for notification, got %v %v", notifResp, err)
	}
	if echoed := notifResp.Header.Get("Mcp-Session-Id"); echoed != firstSession {
		t.Fatalf("expected echoed session %q, got %q", firstSession, echoed)
	}
	notifResp.Body.Close()

	// POST /mcp JSON-RPC request generating a second unique session ID
	reqBody := `{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"sheet_verify","arguments":{"path":` + mustJSON(xlsxPath) + `}}}`
	resp, err := http.Post(ts.URL+"/mcp", "application/json", strings.NewReader(reqBody))
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /mcp failed: %v", err)
	}
	defer resp.Body.Close()
	secondSession := resp.Header.Get("Mcp-Session-Id")
	if secondSession == "" || secondSession == firstSession {
		t.Fatalf("expected distinct generated session ID, got first=%q second=%q", firstSession, secondSession)
	}
	var rpcResp RPCResponse
	if err := json.NewDecoder(resp.Body).Decode(&rpcResp); err != nil {
		t.Fatalf("decode rpcResp: %v", err)
	}
	if rpcResp.Error != nil {
		t.Fatalf("unexpected RPC error: %#v", rpcResp.Error)
	}

	// GET /mcp?once=1 -> SSE event-stream with initial ready event and deterministic exit
	sseReq, _ := http.NewRequest(http.MethodGet, ts.URL+"/mcp?once=1", nil)
	sseReq.Header.Set("Mcp-Session-Id", firstSession)
	sseResp, err := http.DefaultClient.Do(sseReq)
	if err != nil || sseResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /mcp?once=1 failed: %v %v", sseResp, err)
	}
	if ct := sseResp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("expected text/event-stream, got %q", ct)
	}
	if cc := sseResp.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("expected Cache-Control no-cache, got %q", cc)
	}
	if sid := sseResp.Header.Get("Mcp-Session-Id"); sid != firstSession {
		t.Fatalf("expected echoed SSE session %q, got %q", firstSession, sid)
	}
	sseBody, err := io.ReadAll(sseResp.Body)
	sseResp.Body.Close()
	if err != nil {
		t.Fatalf("read SSE body: %v", err)
	}
	wantSSE := "event: ready\ndata: {\"protocolVersion\":\"2024-11-05\",\"server\":\"jiange-mcp\"}\n\n"
	if string(sseBody) != wantSSE {
		t.Fatalf("SSE payload mismatch:\ngot:  %q\nwant: %q", string(sseBody), wantSSE)
	}

	// GET /mcp without once=1 -> flushes ready event, exits cleanly when context is cancelled
	ctx, cancel := context.WithCancel(context.Background())
	streamReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/mcp", nil)
	streamResp, err := http.DefaultClient.Do(streamReq)
	if err != nil || streamResp.StatusCode != http.StatusOK {
		cancel()
		t.Fatalf("GET /mcp stream failed: %v %v", streamResp, err)
	}
	streamSession := streamResp.Header.Get("Mcp-Session-Id")
	reader := bufio.NewReader(streamResp.Body)
	evLine, err := reader.ReadString('\n')
	if err != nil || evLine != "event: ready\n" {
		cancel()
		streamResp.Body.Close()
		t.Fatalf("expected SSE event line, got %q err=%v", evLine, err)
	}
	dataLine, err := reader.ReadString('\n')
	if err != nil || dataLine != "data: {\"protocolVersion\":\"2024-11-05\",\"server\":\"jiange-mcp\"}\n" {
		cancel()
		streamResp.Body.Close()
		t.Fatalf("expected SSE data line, got %q err=%v", dataLine, err)
	}
	cancel()
	streamResp.Body.Close()

	// DELETE /mcp without session header -> 204 No Content (no-op)
	delEmptyReq, _ := http.NewRequest(http.MethodDelete, ts.URL+"/mcp", nil)
	delEmptyResp, err := http.DefaultClient.Do(delEmptyReq)
	if err != nil || delEmptyResp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 for empty DELETE /mcp, got %v %v", delEmptyResp, err)
	}
	delEmptyResp.Body.Close()

	// DELETE /mcp with session header -> deletes from active session map + 204 No Content
	beforeCount := srv.ActiveSessions()
	delReq, _ := http.NewRequest(http.MethodDelete, ts.URL+"/mcp", nil)
	delReq.Header.Set("Mcp-Session-Id", streamSession)
	delResp, err := http.DefaultClient.Do(delReq)
	if err != nil || delResp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 for DELETE /mcp, got %v %v", delResp, err)
	}
	delResp.Body.Close()
	if srv.HasSession(streamSession) || srv.ActiveSessions() != beforeCount-1 {
		t.Fatalf("expected session %q deleted; active=%d before=%d", streamSession, srv.ActiveSessions(), beforeCount)
	}

	// Concurrent POST/DELETE safety check for -race
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := http.Post(ts.URL+"/mcp", "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
			if err != nil {
				t.Errorf("concurrent POST: %v", err)
				return
			}
			sid := r.Header.Get("Mcp-Session-Id")
			r.Body.Close()
			dReq, _ := http.NewRequest(http.MethodDelete, ts.URL+"/mcp", nil)
			dReq.Header.Set("Mcp-Session-Id", sid)
			dResp, err := http.DefaultClient.Do(dReq)
			if err != nil {
				t.Errorf("concurrent DELETE: %v", err)
				return
			}
			dResp.Body.Close()
		}()
	}
	wg.Wait()
}

func TestExecuteAll19ToolsHappyAndErrorPaths(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "does-not-exist")
	badOut := filepath.Join(dir, "no-such-dir", "out")

	// Prepare fixtures across all 5 suites
	xlsxPath := filepath.Join(dir, "wb.xlsx")
	wb, _ := engine.ParseCSVWorkbook([]byte("Name,Val\nA,10\nB,=B2*2\n"), "Data")
	if err := engine.SaveWorkbook(xlsxPath, wb); err != nil {
		t.Fatal(err)
	}

	docPath := filepath.Join(dir, "doc.md")
	if err := os.WriteFile(docPath, []byte("# Title\n\nHello world\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	pptxPath := filepath.Join(dir, "deck.pptx")
	deck := &engine.DeckData{Title: "Deck", Slides: []engine.SlidePageData{{Index: 0, Title: "S1", Body: "Hello"}}}
	if err := engine.SaveDeck(pptxPath, deck); err != nil {
		t.Fatal(err)
	}

	boardPath := filepath.Join(dir, "flow.mmd")
	if err := os.WriteFile(boardPath, []byte("flowchart TD\n  A[Start] --> B[End]\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	basePath := filepath.Join(dir, "base.json")
	baseData := &engine.BaseData{
		Name:    "CRM",
		Tables:  []engine.BaseTableData{{ID: 1, Name: "Deals"}},
		Fields:  []engine.BaseFieldData{{ID: 1, TableID: 1, Name: "Deal", Type: "text"}},
		Records: []engine.BaseRecordData{{ID: 1, TableID: 1, Cells: map[string]any{"1": "Alpha"}}},
	}
	if err := engine.SaveBase(basePath, baseData); err != nil {
		t.Fatal(err)
	}

	srv := NewServer("0.2.0")

	// Missing path & unknown tool
	if _, err := srv.ExecuteTool("sheet_inspect", map[string]any{}); err == nil {
		t.Fatalf("expected missing path error")
	}
	if _, err := srv.ExecuteTool("nope", map[string]any{"path": xlsxPath}); err == nil {
		t.Fatalf("expected unknown tool error")
	}

	// Sheet tools (4)
	if _, err := srv.ExecuteTool("sheet_inspect", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected sheet_inspect load error")
	}
	if _, err := srv.ExecuteTool("sheet_inspect", map[string]any{"path": xlsxPath, "detail": "full"}); err != nil {
		t.Fatalf("sheet_inspect failed: %v", err)
	}
	if _, err := srv.ExecuteTool("sheet_query", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected sheet_query load error")
	}
	if _, err := srv.ExecuteTool("sheet_query", map[string]any{
		"path": xlsxPath, "sheet": "Data", "search": "20", "onlyFormulas": true, "onlyErrors": false, "limit": float64(5),
	}); err != nil {
		t.Fatalf("sheet_query failed: %v", err)
	}
	if _, err := srv.ExecuteTool("sheet_query", map[string]any{"path": xlsxPath}); err != nil {
		t.Fatalf("sheet_query defaults failed: %v", err)
	}
	if _, err := srv.ExecuteTool("sheet_verify", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected sheet_verify load error")
	}
	if _, err := srv.ExecuteTool("sheet_verify", map[string]any{"path": xlsxPath}); err != nil {
		t.Fatalf("sheet_verify failed: %v", err)
	}
	if _, err := srv.ExecuteTool("sheet_patch", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected sheet_patch load error")
	}
	if _, err := srv.ExecuteTool("sheet_patch", map[string]any{"path": xlsxPath, "ops": "invalid"}); err == nil {
		t.Fatalf("expected sheet_patch ops unmarshal error")
	}
	if _, err := srv.ExecuteTool("sheet_patch", map[string]any{
		"path": xlsxPath, "ops": []map[string]any{{"op": "bad"}},
	}); err == nil {
		t.Fatalf("expected sheet_patch apply error")
	}
	if _, err := srv.ExecuteTool("sheet_patch", map[string]any{
		"path": xlsxPath, "dryRun": true,
		"ops": []map[string]any{{"op": "setCell", "sheet": "Data", "a1": "C1", "raw": "99"}},
	}); err != nil {
		t.Fatalf("sheet_patch dryRun failed: %v", err)
	}
	if _, err := srv.ExecuteTool("sheet_patch", map[string]any{
		"path": xlsxPath,
		"ops":  []map[string]any{{"op": "setCell", "sheet": "Data", "a1": "C1", "raw": "99"}},
	}); err != nil {
		t.Fatalf("sheet_patch in-place failed: %v", err)
	}
	if _, err := srv.ExecuteTool("sheet_patch", map[string]any{
		"path": xlsxPath, "outPath": badOut + ".xlsx",
		"ops": []map[string]any{{"op": "setCell", "sheet": "Data", "a1": "C1", "raw": "100"}},
	}); err == nil {
		t.Fatalf("expected sheet_patch save error")
	}

	// Doc tools (4)
	if _, err := srv.ExecuteTool("doc_inspect", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected doc_inspect load error")
	}
	if _, err := srv.ExecuteTool("doc_inspect", map[string]any{"path": docPath, "detail": "full"}); err != nil {
		t.Fatalf("doc_inspect failed: %v", err)
	}
	if _, err := srv.ExecuteTool("doc_query", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected doc_query load error")
	}
	if _, err := srv.ExecuteTool("doc_query", map[string]any{"path": docPath, "text": "Hello", "type": "paragraph"}); err != nil {
		t.Fatalf("doc_query failed: %v", err)
	}
	if _, err := srv.ExecuteTool("doc_verify", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected doc_verify load error")
	}
	if _, err := srv.ExecuteTool("doc_verify", map[string]any{"path": docPath}); err != nil {
		t.Fatalf("doc_verify failed: %v", err)
	}
	if _, err := srv.ExecuteTool("doc_patch", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected doc_patch load error")
	}
	if _, err := srv.ExecuteTool("doc_patch", map[string]any{"path": docPath, "ops": "bad"}); err == nil {
		t.Fatalf("expected doc_patch ops unmarshal error")
	}
	if _, err := srv.ExecuteTool("doc_patch", map[string]any{
		"path": docPath, "ops": []map[string]any{{"op": "bad"}},
	}); err == nil {
		t.Fatalf("expected doc_patch apply error")
	}
	if _, err := srv.ExecuteTool("doc_patch", map[string]any{
		"path": docPath, "dryRun": true,
		"ops": []map[string]any{{"op": "appendBlock", "text": "Preview"}},
	}); err != nil {
		t.Fatalf("doc_patch dryRun failed: %v", err)
	}
	if _, err := srv.ExecuteTool("doc_patch", map[string]any{
		"path": docPath,
		"ops":  []map[string]any{{"op": "appendBlock", "text": "Saved"}},
	}); err != nil {
		t.Fatalf("doc_patch in-place failed: %v", err)
	}
	if _, err := srv.ExecuteTool("doc_patch", map[string]any{
		"path": docPath, "outPath": badOut + ".md",
		"ops": []map[string]any{{"op": "appendBlock", "text": "Fail"}},
	}); err == nil {
		t.Fatalf("expected doc_patch save error")
	}

	// Slides tools (4)
	if _, err := srv.ExecuteTool("slides_inspect", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected slides_inspect load error")
	}
	if _, err := srv.ExecuteTool("slides_inspect", map[string]any{"path": pptxPath}); err != nil {
		t.Fatalf("slides_inspect failed: %v", err)
	}
	if _, err := srv.ExecuteTool("slides_verify", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected slides_verify load error")
	}
	if _, err := srv.ExecuteTool("slides_verify", map[string]any{"path": pptxPath}); err != nil {
		t.Fatalf("slides_verify failed: %v", err)
	}
	if _, err := srv.ExecuteTool("slides_render_svg", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected slides_render_svg load error")
	}
	if _, err := srv.ExecuteTool("slides_render_svg", map[string]any{"path": pptxPath, "slideIndex": float64(99)}); err == nil {
		t.Fatalf("expected slides_render_svg range error")
	}
	if _, err := srv.ExecuteTool("slides_render_svg", map[string]any{"path": pptxPath, "slideIndex": float64(0)}); err != nil {
		t.Fatalf("slides_render_svg failed: %v", err)
	}
	if _, err := srv.ExecuteTool("slides_patch", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected slides_patch load error")
	}
	if _, err := srv.ExecuteTool("slides_patch", map[string]any{"path": pptxPath, "ops": "bad"}); err == nil {
		t.Fatalf("expected slides_patch ops unmarshal error")
	}
	if _, err := srv.ExecuteTool("slides_patch", map[string]any{
		"path": pptxPath, "ops": []map[string]any{{"op": "bad"}},
	}); err == nil {
		t.Fatalf("expected slides_patch apply error")
	}
	if _, err := srv.ExecuteTool("slides_patch", map[string]any{
		"path": pptxPath, "dryRun": true,
		"ops": []map[string]any{{"op": "addSlide", "title": "Preview"}},
	}); err != nil {
		t.Fatalf("slides_patch dryRun failed: %v", err)
	}
	if _, err := srv.ExecuteTool("slides_patch", map[string]any{
		"path": pptxPath,
		"ops":  []map[string]any{{"op": "addSlide", "title": "S2", "body": "Body2"}},
	}); err != nil {
		t.Fatalf("slides_patch in-place failed: %v", err)
	}
	if _, err := srv.ExecuteTool("slides_patch", map[string]any{
		"path": pptxPath, "outPath": badOut + ".pptx",
		"ops": []map[string]any{{"op": "addSlide", "title": "Fail"}},
	}); err == nil {
		t.Fatalf("expected slides_patch save error")
	}

	// Board tools (3)
	if _, err := srv.ExecuteTool("board_inspect", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected board_inspect load error")
	}
	if _, err := srv.ExecuteTool("board_inspect", map[string]any{"path": boardPath}); err != nil {
		t.Fatalf("board_inspect failed: %v", err)
	}
	if _, err := srv.ExecuteTool("board_verify", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected board_verify load error")
	}
	if _, err := srv.ExecuteTool("board_verify", map[string]any{"path": boardPath}); err != nil {
		t.Fatalf("board_verify failed: %v", err)
	}
	if _, err := srv.ExecuteTool("board_render_svg", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected board_render_svg load error")
	}
	if _, err := srv.ExecuteTool("board_render_svg", map[string]any{"path": boardPath}); err != nil {
		t.Fatalf("board_render_svg failed: %v", err)
	}

	// Base tools (4)
	if _, err := srv.ExecuteTool("base_inspect", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected base_inspect load error")
	}
	if _, err := srv.ExecuteTool("base_inspect", map[string]any{"path": basePath}); err != nil {
		t.Fatalf("base_inspect failed: %v", err)
	}
	if _, err := srv.ExecuteTool("base_query", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected base_query load error")
	}
	if _, err := srv.ExecuteTool("base_query", map[string]any{
		"path": basePath, "tableId": float64(1), "search": "Alpha", "limit": float64(10),
	}); err != nil {
		t.Fatalf("base_query failed: %v", err)
	}
	if _, err := srv.ExecuteTool("base_verify", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected base_verify load error")
	}
	if _, err := srv.ExecuteTool("base_verify", map[string]any{"path": basePath}); err != nil {
		t.Fatalf("base_verify failed: %v", err)
	}
	if _, err := srv.ExecuteTool("base_patch", map[string]any{"path": missing}); err == nil {
		t.Fatalf("expected base_patch load error")
	}
	if _, err := srv.ExecuteTool("base_patch", map[string]any{"path": basePath, "ops": "bad"}); err == nil {
		t.Fatalf("expected base_patch ops unmarshal error")
	}
	if _, err := srv.ExecuteTool("base_patch", map[string]any{
		"path": basePath, "ops": []map[string]any{{"op": "bad"}},
	}); err == nil {
		t.Fatalf("expected base_patch apply error")
	}
	if _, err := srv.ExecuteTool("base_patch", map[string]any{
		"path": basePath, "dryRun": true,
		"ops": []map[string]any{{"op": "addRecord", "cells": map[string]any{"1": "Preview"}}},
	}); err != nil {
		t.Fatalf("base_patch dryRun failed: %v", err)
	}
	if _, err := srv.ExecuteTool("base_patch", map[string]any{
		"path": basePath,
		"ops":  []map[string]any{{"op": "addRecord", "cells": map[string]any{"1": "Beta"}}},
	}); err != nil {
		t.Fatalf("base_patch in-place failed: %v", err)
	}
	if _, err := srv.ExecuteTool("base_patch", map[string]any{
		"path": basePath, "outPath": badOut + ".json",
		"ops": []map[string]any{{"op": "addRecord", "cells": map[string]any{"1": "Fail"}}},
	}); err == nil {
		t.Fatalf("expected base_patch save error")
	}
}

func mustJSON(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
