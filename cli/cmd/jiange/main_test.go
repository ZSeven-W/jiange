package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/cli/internal/engine"
)

func setupIO(t *testing.T) (*bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	origIn, origOut, origErr, origExit, origListen := stdin, stdout, stderr, exitFn, listenAndServe
	var outBuf, errBuf bytes.Buffer
	stdin = strings.NewReader("")
	stdout = &outBuf
	stderr = &errBuf
	t.Cleanup(func() {
		stdin, stdout, stderr, exitFn, listenAndServe = origIn, origOut, origErr, origExit, origListen
	})
	return &outBuf, &errBuf
}

func TestMainEntryAndHelpVersionMCP(t *testing.T) {
	outBuf, errBuf := setupIO(t)

	// Test main() success and failure via injectable exitFn
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })

	exitCode := 0
	exitFn = func(code int) { exitCode = code }

	os.Args = []string{"jiange", "version"}
	main()
	if exitCode != 0 || !strings.Contains(outBuf.String(), version) {
		t.Fatalf("main(version) failed: exit=%d out=%q", exitCode, outBuf.String())
	}

	os.Args = []string{"jiange", "unknown-cmd"}
	main()
	if exitCode != 1 || !strings.Contains(errBuf.String(), "unknown command") {
		t.Fatalf("main(unknown) failed: exit=%d err=%q", exitCode, errBuf.String())
	}

	// Help variants
	for _, args := range [][]string{nil, {"-h"}, {"--help"}, {"help"}} {
		outBuf.Reset()
		if err := run(args); err != nil {
			t.Fatalf("run(%v) error: %v", args, err)
		}
		if !strings.Contains(outBuf.String(), "Usage:") {
			t.Fatalf("expected usage for %v, got %q", args, outBuf.String())
		}
	}

	// MCP flag parse error
	if err := run([]string{"mcp", "--bad-flag"}); err == nil {
		t.Fatalf("expected mcp flag error")
	}

	// MCP stdio transport
	outBuf.Reset()
	stdin = strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}` + "\n")
	if err := run([]string{"mcp", "--transport", "stdio"}); err != nil {
		t.Fatalf("mcp stdio failed: %v", err)
	}
	if !strings.Contains(outBuf.String(), `"jsonrpc":"2.0"`) {
		t.Fatalf("unexpected mcp stdio output: %q", outBuf.String())
	}

	// MCP http transport via injected listenAndServe
	errBuf.Reset()
	var gotAddr string
	listenAndServe = func(addr string, handler http.Handler) error {
		gotAddr = addr
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("healthz status = %d", rec.Code)
		}
		return nil
	}
	if err := run([]string{"mcp", "--transport", "http", "--addr", "127.0.0.1:18787"}); err != nil {
		t.Fatalf("mcp http failed: %v", err)
	}
	if gotAddr != "127.0.0.1:18787" || !strings.Contains(errBuf.String(), "127.0.0.1:18787") {
		t.Fatalf("mcp http addr mismatch: addr=%q stderr=%q", gotAddr, errBuf.String())
	}
}

func TestRunSheetSubcommand(t *testing.T) {
	outBuf, _ := setupIO(t)
	dir := t.TempDir()
	xlsxPath := filepath.Join(dir, "sheet.xlsx")
	csvOut := filepath.Join(dir, "sheet.csv")
	badOut := filepath.Join(dir, "missing-dir", "out.xlsx")

	wb, _ := engine.ParseCSVWorkbook([]byte("Item,Val\nA,10\nB,=B2*2\n"), "S1")
	if err := engine.SaveWorkbook(xlsxPath, wb); err != nil {
		t.Fatal(err)
	}

	// Usage, flag error, load error, unknown action
	if err := run([]string{"sheet", "inspect"}); err == nil {
		t.Fatalf("expected usage error")
	}
	if err := run([]string{"sheet", "inspect", xlsxPath, "--bad"}); err == nil {
		t.Fatalf("expected flag error")
	}
	if err := run([]string{"sheet", "inspect", filepath.Join(dir, "nope.xlsx")}); err == nil {
		t.Fatalf("expected load error")
	}
	if err := run([]string{"sheet", "bogus", xlsxPath}); err == nil {
		t.Fatalf("expected unknown sheet action error")
	}

	// inspect, query, verify
	if err := run([]string{"sheet", "inspect", xlsxPath, "--detail", "full"}); err != nil {
		t.Fatalf("sheet inspect: %v", err)
	}
	if !strings.Contains(outBuf.String(), `"sheetCount": 1`) {
		t.Fatalf("unexpected inspect output: %s", outBuf.String())
	}
	if err := run([]string{"sheet", "query", xlsxPath, "--sheet", "S1", "--formulas"}); err != nil {
		t.Fatalf("sheet query: %v", err)
	}
	if err := run([]string{"sheet", "verify", xlsxPath}); err != nil {
		t.Fatalf("sheet verify: %v", err)
	}

	// patch: bad JSON, apply error, dry-run, in-place save, explicit out, save error
	if err := run([]string{"sheet", "patch", xlsxPath, "--ops", "{bad"}); err == nil {
		t.Fatalf("expected ops json error")
	}
	if err := run([]string{"sheet", "patch", xlsxPath, "--ops", `[{"op":"bad"}]`}); err == nil {
		t.Fatalf("expected apply error")
	}
	if err := run([]string{"sheet", "patch", xlsxPath, "--dry-run", "--ops", `[{"op":"setCell","sheet":"S1","a1":"C1","raw":"1"}]`}); err != nil {
		t.Fatalf("sheet patch dry-run: %v", err)
	}
	if err := run([]string{"sheet", "patch", xlsxPath, "--ops", `[{"op":"setCell","sheet":"S1","a1":"C1","raw":"1"}]`}); err != nil {
		t.Fatalf("sheet patch in-place: %v", err)
	}
	if err := run([]string{"sheet", "patch", xlsxPath, "--out", badOut, "--ops", `[{"op":"setCell","sheet":"S1","a1":"C1","raw":"2"}]`}); err == nil {
		t.Fatalf("expected save error")
	}

	// convert: missing --out + valid --out
	if err := run([]string{"sheet", "convert", xlsxPath}); err == nil {
		t.Fatalf("expected convert missing --out error")
	}
	if err := run([]string{"sheet", "convert", xlsxPath, "--out", csvOut}); err != nil {
		t.Fatalf("sheet convert: %v", err)
	}
}

func TestRunDocSubcommand(t *testing.T) {
	outBuf, _ := setupIO(t)
	dir := t.TempDir()
	mdPath := filepath.Join(dir, "spec.md")
	docxOut := filepath.Join(dir, "spec.docx")
	badOut := filepath.Join(dir, "missing-dir", "out.md")

	if err := os.WriteFile(mdPath, []byte("# Title\n\nHello world\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := run([]string{"doc", "inspect"}); err == nil {
		t.Fatalf("expected usage error")
	}
	if err := run([]string{"doc", "inspect", mdPath, "--bad"}); err == nil {
		t.Fatalf("expected flag error")
	}
	if err := run([]string{"doc", "inspect", filepath.Join(dir, "nope.md")}); err == nil {
		t.Fatalf("expected load error")
	}
	if err := run([]string{"doc", "bogus", mdPath}); err == nil {
		t.Fatalf("expected unknown doc action error")
	}

	if err := run([]string{"doc", "inspect", mdPath, "--detail", "full"}); err != nil {
		t.Fatalf("doc inspect: %v", err)
	}
	if !strings.Contains(outBuf.String(), `"title": "spec"`) {
		t.Fatalf("unexpected doc inspect output: %s", outBuf.String())
	}
	if err := run([]string{"doc", "query", mdPath, "--search", "Hello", "--type", "paragraph"}); err != nil {
		t.Fatalf("doc query: %v", err)
	}
	if err := run([]string{"doc", "verify", mdPath}); err != nil {
		t.Fatalf("doc verify: %v", err)
	}

	if err := run([]string{"doc", "patch", mdPath, "--ops", "{bad"}); err == nil {
		t.Fatalf("expected ops json error")
	}
	if err := run([]string{"doc", "patch", mdPath, "--ops", `[{"op":"bad"}]`}); err == nil {
		t.Fatalf("expected apply error")
	}
	if err := run([]string{"doc", "patch", mdPath, "--dry-run", "--ops", `[{"op":"appendBlock","text":"Dry"}]`}); err != nil {
		t.Fatalf("doc patch dry-run: %v", err)
	}
	if err := run([]string{"doc", "patch", mdPath, "--ops", `[{"op":"appendBlock","text":"Saved"}]`}); err != nil {
		t.Fatalf("doc patch in-place: %v", err)
	}
	if err := run([]string{"doc", "patch", mdPath, "--out", badOut, "--ops", `[{"op":"appendBlock","text":"Fail"}]`}); err == nil {
		t.Fatalf("expected save error")
	}

	if err := run([]string{"doc", "convert", mdPath}); err == nil {
		t.Fatalf("expected convert missing --out error")
	}
	if err := run([]string{"doc", "convert", mdPath, "--out", docxOut}); err != nil {
		t.Fatalf("doc convert: %v", err)
	}
}

func TestRunSlidesSubcommand(t *testing.T) {
	outBuf, _ := setupIO(t)
	dir := t.TempDir()
	pptxPath := filepath.Join(dir, "deck.pptx")
	svgOut := filepath.Join(dir, "slide0.svg")
	badOut := filepath.Join(dir, "missing-dir", "out.pptx")

	deck := &engine.DeckData{Title: "Demo", Slides: []engine.SlidePageData{{Index: 0, Title: "Intro", Body: "Line 1"}}}
	if err := engine.SaveDeck(pptxPath, deck); err != nil {
		t.Fatal(err)
	}

	if err := run([]string{"slides", "inspect"}); err == nil {
		t.Fatalf("expected usage error")
	}
	if err := run([]string{"slides", "inspect", pptxPath, "--bad"}); err == nil {
		t.Fatalf("expected flag error")
	}
	if err := run([]string{"slides", "inspect", filepath.Join(dir, "nope.pptx")}); err == nil {
		t.Fatalf("expected load error")
	}
	if err := run([]string{"slides", "bogus", pptxPath}); err == nil {
		t.Fatalf("expected unknown slides action error")
	}

	if err := run([]string{"slides", "inspect", pptxPath}); err != nil {
		t.Fatalf("slides inspect: %v", err)
	}
	if err := run([]string{"slides", "verify", pptxPath}); err != nil {
		t.Fatalf("slides verify: %v", err)
	}

	if err := run([]string{"slides", "patch", pptxPath, "--ops", "{bad"}); err == nil {
		t.Fatalf("expected ops json error")
	}
	if err := run([]string{"slides", "patch", pptxPath, "--ops", `[{"op":"bad"}]`}); err == nil {
		t.Fatalf("expected apply error")
	}
	if err := run([]string{"slides", "patch", pptxPath, "--dry-run", "--ops", `[{"op":"addSlide","title":"Dry"}]`}); err != nil {
		t.Fatalf("slides patch dry-run: %v", err)
	}
	if err := run([]string{"slides", "patch", pptxPath, "--ops", `[{"op":"addSlide","title":"S2","body":"B2"}]`}); err != nil {
		t.Fatalf("slides patch in-place: %v", err)
	}
	if err := run([]string{"slides", "patch", pptxPath, "--out", badOut, "--ops", `[{"op":"addSlide","title":"Fail"}]`}); err == nil {
		t.Fatalf("expected save error")
	}

	// render: range error, stdout, --out file
	if err := run([]string{"slides", "render", pptxPath, "--slide", "99"}); err == nil {
		t.Fatalf("expected slide index error")
	}
	outBuf.Reset()
	if err := run([]string{"slides", "render", pptxPath, "--slide", "0"}); err != nil {
		t.Fatalf("slides render stdout: %v", err)
	}
	if !strings.Contains(outBuf.String(), "<svg") {
		t.Fatalf("expected SVG on stdout, got %q", outBuf.String())
	}
	if err := run([]string{"slides", "render", pptxPath, "--slide", "0", "--out", svgOut}); err != nil {
		t.Fatalf("slides render out: %v", err)
	}
}

func TestRunBoardSubcommand(t *testing.T) {
	outBuf, _ := setupIO(t)
	dir := t.TempDir()
	mmdPath := filepath.Join(dir, "flow.mmd")
	svgOut := filepath.Join(dir, "flow.svg")

	if err := os.WriteFile(mmdPath, []byte("flowchart TD\n  A[Start] --> B[End]\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := run([]string{"board", "inspect"}); err == nil {
		t.Fatalf("expected usage error")
	}
	if err := run([]string{"board", "inspect", mmdPath, "--bad"}); err == nil {
		t.Fatalf("expected flag error")
	}
	if err := run([]string{"board", "inspect", filepath.Join(dir, "nope.mmd")}); err == nil {
		t.Fatalf("expected load error")
	}
	if err := run([]string{"board", "bogus", mmdPath}); err == nil {
		t.Fatalf("expected unknown board action error")
	}

	if err := run([]string{"board", "inspect", mmdPath}); err != nil {
		t.Fatalf("board inspect: %v", err)
	}
	if err := run([]string{"board", "verify", mmdPath}); err != nil {
		t.Fatalf("board verify: %v", err)
	}
	outBuf.Reset()
	if err := run([]string{"board", "render", mmdPath}); err != nil {
		t.Fatalf("board render stdout: %v", err)
	}
	if !strings.Contains(outBuf.String(), "<svg") {
		t.Fatalf("expected board SVG on stdout, got %q", outBuf.String())
	}
	if err := run([]string{"board", "render", mmdPath, "--out", svgOut}); err != nil {
		t.Fatalf("board render out: %v", err)
	}
}

func TestRunBaseSubcommand(t *testing.T) {
	outBuf, _ := setupIO(t)
	dir := t.TempDir()
	basePath := filepath.Join(dir, "crm.json")
	badOut := filepath.Join(dir, "missing-dir", "out.json")

	b := &engine.BaseData{
		Name:    "CRM",
		Tables:  []engine.BaseTableData{{ID: 1, Name: "Deals"}},
		Fields:  []engine.BaseFieldData{{ID: 1, TableID: 1, Name: "Deal", Type: "text"}},
		Records: []engine.BaseRecordData{{ID: 1, TableID: 1, Cells: map[string]any{"1": "Alpha"}}},
	}
	if err := engine.SaveBase(basePath, b); err != nil {
		t.Fatal(err)
	}

	if err := run([]string{"base", "inspect"}); err == nil {
		t.Fatalf("expected usage error")
	}
	if err := run([]string{"base", "inspect", basePath, "--bad"}); err == nil {
		t.Fatalf("expected flag error")
	}
	if err := run([]string{"base", "inspect", filepath.Join(dir, "nope.json")}); err == nil {
		t.Fatalf("expected load error")
	}
	if err := run([]string{"base", "bogus", basePath}); err == nil {
		t.Fatalf("expected unknown base action error")
	}

	if err := run([]string{"base", "inspect", basePath}); err != nil {
		t.Fatalf("base inspect: %v", err)
	}
	if !strings.Contains(outBuf.String(), `"name": "CRM"`) {
		t.Fatalf("unexpected base inspect output: %s", outBuf.String())
	}
	if err := run([]string{"base", "query", basePath, "--table", "1", "--search", "Alpha"}); err != nil {
		t.Fatalf("base query: %v", err)
	}
	if err := run([]string{"base", "verify", basePath}); err != nil {
		t.Fatalf("base verify: %v", err)
	}

	if err := run([]string{"base", "patch", basePath, "--ops", "{bad"}); err == nil {
		t.Fatalf("expected ops json error")
	}
	if err := run([]string{"base", "patch", basePath, "--ops", `[{"op":"bad"}]`}); err == nil {
		t.Fatalf("expected apply error")
	}
	if err := run([]string{"base", "patch", basePath, "--dry-run", "--ops", `[{"op":"addRecord","cells":{"1":"Dry"}}]`}); err != nil {
		t.Fatalf("base patch dry-run: %v", err)
	}
	if err := run([]string{"base", "patch", basePath, "--ops", `[{"op":"addRecord","cells":{"1":"Beta"}}]`}); err != nil {
		t.Fatalf("base patch in-place: %v", err)
	}
	if err := run([]string{"base", "patch", basePath, "--out", badOut, "--ops", `[{"op":"addRecord","cells":{"1":"Fail"}}]`}); err == nil {
		t.Fatalf("expected save error")
	}
}

func TestRunRemoteSubcommand(t *testing.T) {
	outBuf, _ := setupIO(t)

	var seenAuth string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"service":"jiange-backend"}`))
	})
	mux.HandleFunc("/api/v1/ai/tools", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tools":[{"name":"sheet_inspect"}]}`))
	})
	mux.HandleFunc("/api/v1/ai/tools/sheet_inspect", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"tool":"sheet_inspect"}`))
	})
	mux.HandleFunc("/api/v1/sheets/s1", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodGet:
			_, _ = w.Write([]byte(`{"id":"s1","method":"GET"}`))
		case http.MethodPost:
			_, _ = w.Write([]byte(`{"id":"s1","method":"POST"}`))
		case http.MethodPatch:
			_, _ = w.Write([]byte(`{"id":"s1","method":"PATCH"}`))
		case http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		}
	})
	mux.HandleFunc("/api/v1/fail", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"forbidden"}`))
	})
	mux.HandleFunc("/custom/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"prefix":"custom"}`))
	})

	ts := httptest.NewServer(mux)
	defer ts.Close()

	// Clear env fallbacks initially
	t.Setenv("JIANGE_SERVER", "")
	t.Setenv("JIANGE_TOKEN", "")

	// Usage, flag error, missing server, unknown action
	if err := run([]string{"remote"}); err == nil {
		t.Fatalf("expected remote usage error")
	}
	if err := run([]string{"remote", "health", "--bad"}); err == nil {
		t.Fatalf("expected remote flag error")
	}
	if err := run([]string{"remote", "health"}); err == nil {
		t.Fatalf("expected missing server error")
	}
	if err := run([]string{"remote", "bogus", "--server", ts.URL}); err == nil {
		t.Fatalf("expected unknown remote action error")
	}

	// Env variable fallbacks (JIANGE_SERVER, JIANGE_TOKEN)
	t.Setenv("JIANGE_SERVER", ts.URL)
	t.Setenv("JIANGE_TOKEN", "env-token")
	outBuf.Reset()
	if err := run([]string{"remote", "health"}); err != nil {
		t.Fatalf("remote health via env failed: %v", err)
	}
	if seenAuth != "Bearer env-token" || !strings.Contains(outBuf.String(), `"service": "jiange-backend"`) {
		t.Fatalf("unexpected health output/auth: auth=%q out=%s", seenAuth, outBuf.String())
	}

	// Custom prefix via --prefix flag and explicit --token override
	outBuf.Reset()
	if err := run([]string{"remote", "health", "--server", ts.URL, "--token", "flag-tok", "--prefix", "/custom"}); err != nil {
		t.Fatalf("remote health custom prefix failed: %v", err)
	}
	if !strings.Contains(outBuf.String(), `"prefix": "custom"`) {
		t.Fatalf("unexpected custom prefix output: %s", outBuf.String())
	}

	// tools
	outBuf.Reset()
	if err := run([]string{"remote", "tools", "--server", ts.URL}); err != nil {
		t.Fatalf("remote tools failed: %v", err)
	}
	if !strings.Contains(outBuf.String(), `"sheet_inspect"`) {
		t.Fatalf("unexpected tools output: %s", outBuf.String())
	}

	// call: missing --tool, invalid --args, valid call
	if err := run([]string{"remote", "call", "--server", ts.URL}); err == nil {
		t.Fatalf("expected missing --tool error")
	}
	if err := run([]string{"remote", "call", "--server", ts.URL, "--tool", "sheet_inspect", "--args", "{bad"}); err == nil {
		t.Fatalf("expected invalid --args error")
	}
	outBuf.Reset()
	if err := run([]string{"remote", "call", "--server", ts.URL, "--tool", "sheet_inspect", "--args", `{"id":"s1"}`}); err != nil {
		t.Fatalf("remote call failed: %v", err)
	}
	if !strings.Contains(outBuf.String(), `"tool": "sheet_inspect"`) {
		t.Fatalf("unexpected call output: %s", outBuf.String())
	}

	// get, post, patch, delete: missing --path, invalid --body, empty body, valid body, remote HTTP error
	if err := run([]string{"remote", "get", "--server", ts.URL}); err == nil {
		t.Fatalf("expected missing --path error")
	}
	if err := run([]string{"remote", "post", "--server", ts.URL, "--path", "/sheets/s1", "--body", "{bad"}); err == nil {
		t.Fatalf("expected invalid --body error")
	}
	outBuf.Reset()
	if err := run([]string{"remote", "get", "--server", ts.URL, "--path", "/sheets/s1"}); err != nil {
		t.Fatalf("remote get failed: %v", err)
	}
	if !strings.Contains(outBuf.String(), `"method": "GET"`) {
		t.Fatalf("unexpected get output: %s", outBuf.String())
	}
	outBuf.Reset()
	if err := run([]string{"remote", "post", "--server", ts.URL, "--path", "/sheets/s1", "--body", `{"title":"Q1"}`}); err != nil {
		t.Fatalf("remote post failed: %v", err)
	}
	if !strings.Contains(outBuf.String(), `"method": "POST"`) {
		t.Fatalf("unexpected post output: %s", outBuf.String())
	}
	outBuf.Reset()
	if err := run([]string{"remote", "patch", "--server", ts.URL, "--path", "/sheets/s1", "--body", `{"title":"Q2"}`}); err != nil {
		t.Fatalf("remote patch failed: %v", err)
	}
	if !strings.Contains(outBuf.String(), `"method": "PATCH"`) {
		t.Fatalf("unexpected patch output: %s", outBuf.String())
	}
	outBuf.Reset()
	if err := run([]string{"remote", "delete", "--server", ts.URL, "--path", "/sheets/s1"}); err != nil {
		t.Fatalf("remote delete failed: %v", err)
	}
	if !strings.Contains(outBuf.String(), `"status": 204`) {
		t.Fatalf("unexpected delete output: %s", outBuf.String())
	}

	// Propagated remote error
	if err := run([]string{"remote", "get", "--server", ts.URL, "--path", "/fail"}); err == nil || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("expected forbidden error, got %v", err)
	}
}
