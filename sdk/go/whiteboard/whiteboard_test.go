package whiteboard

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/sdk/go/ai"
	"github.com/ZSeven-W/jiange/sdk/go/storage"
)

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("read fail") }

type failingStore struct {
	storage.Store
	putErr error
	delErr error
}

func (f *failingStore) Put(ctx context.Context, rec *storage.DocumentRecord) error {
	if f.putErr != nil {
		return f.putErr
	}
	return f.Store.Put(ctx, rec)
}

func (f *failingStore) Delete(ctx context.Context, id string) error {
	if f.delErr != nil {
		return f.delErr
	}
	return f.Store.Delete(ctx, id)
}

func buildTestZip(entries map[string]string) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for k, v := range entries {
		fw, _ := zw.Create(k)
		_, _ = io.WriteString(fw, v)
	}
	_ = zw.Close()
	return buf.Bytes()
}

func makeCorruptMethodZip(entryName string) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	fh := &zip.FileHeader{Name: entryName, Method: zip.Deflate}
	fw, _ := zw.CreateHeader(fh)
	_, _ = fw.Write([]byte(`[{"rootTopic":{"title":"Root"}}]`))
	_ = zw.Close()
	raw := buf.Bytes()
	binary.LittleEndian.PutUint16(raw[8:10], 99)
	if idx := bytes.Index(raw, []byte{0x50, 0x4b, 0x01, 0x02}); idx >= 0 {
		binary.LittleEndian.PutUint16(raw[idx+10:idx+12], 99)
	}
	return raw
}

func makeCorruptDeflateZip(entryName string) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	fw, _ := zw.Create(entryName)
	_, _ = fw.Write([]byte(`[{"rootTopic":{"id":"r1","title":"Root Topic Payload"}}]`))
	_ = zw.Close()
	raw := buf.Bytes()
	start := 30 + len(entryName)
	for i := start; i < start+5 && i < len(raw); i++ {
		raw[i] ^= 0xff
	}
	return raw
}

func TestMermaidXMindApplyVerifyRender(t *testing.T) {
	mmd := "flowchart TD\n%% comment\nA([Start]) -->|go| B{Check}\nB -.-> C((Circle))\nC --- D(Round)\nE[Box];\n;\n"
	b := ParseMermaid(mmd)
	if len(b.Nodes) != 5 || len(b.Edges) != 3 || b.Edges[0].Label != "go" {
		t.Fatalf("unexpected parsed mermaid: %+v", b)
	}
	outMMD := b.ToMermaid()
	for _, want := range []string{"flowchart TD", `A(["Start"])`, `B{"Check"}`, `C(("Circle"))`, `D("Round")`, `E["Box"]`, "A -->|go| B", "B --> C"} {
		if !strings.Contains(outMMD, want) {
			t.Fatalf("ToMermaid missing %q:\n%s", want, outMMD)
		}
	}

	// XMind parsing + errors
	xmindBytes := buildTestZip(map[string]string{
		"content.json": `[{"rootTopic":{"title":"Root","children":{"attached":[{"id":"c1","title":"Child 1"}]}}}]`,
	})
	xb, err := ParseXMind(xmindBytes)
	if err != nil || len(xb.Nodes) != 2 || len(xb.Edges) != 1 {
		t.Fatalf("ParseXMind failed: %+v err=%v", xb, err)
	}
	if _, err := ParseXMind([]byte("notzip")); err == nil {
		t.Fatal("expected invalid zip error")
	}
	if _, err := ParseXMind(buildTestZip(map[string]string{"other.txt": "x"})); err == nil {
		t.Fatal("expected missing content.json error")
	}
	if _, err := ParseXMind(buildTestZip(map[string]string{"content.json": "{bad"})); err == nil {
		t.Fatal("expected json error")
	}
	if _, err := ParseXMind(makeCorruptMethodZip("content.json")); err == nil {
		t.Fatal("expected open error")
	}
	if _, err := ParseXMind(makeCorruptDeflateZip("content.json")); err == nil {
		t.Fatal("expected read error")
	}

	// Inspect & Verify & RenderSVG
	if info := b.Inspect(); info["nodeCount"] != 5 {
		t.Fatalf("inspect failed: %+v", info)
	}
	// Empty board
	if diags := (&Board{}).Verify(); len(diags) != 1 || diags[0].Code != "EMPTY_BOARD" {
		t.Fatalf("expected EMPTY_BOARD, got %+v", diags)
	}
	// Dangling edge + isolated node (E is already isolated in b; add dangling edge)
	b.Edges = append(b.Edges, Edge{From: "A", To: "GHOST"})
	diags := b.Verify()
	if len(diags) != 2 || diags[0].Code != "DANGLING_EDGE" || diags[1].Code != "ISOLATED_NODE" {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	// RenderSVG skips dangling edges and expands canvas when nodes exceed default size
	b.Nodes[0].X = 600
	b.Nodes[0].Y = 500
	svg := b.RenderSVG()
	if !strings.Contains(svg, "<svg") || !strings.Contains(svg, "Start") || !strings.Contains(svg, "<line") {
		t.Fatalf("unexpected svg: %s", svg)
	}

	// Apply (addNode, updateNode, deleteNode, addEdge, deleteEdge, dryRun, error rollbacks)
	b2 := &Board{}
	n, diff, err := b2.Apply([]Op{
		{Op: "addNode", Text: "AutoID"},
		{Op: "addNode", ID: "n2", Text: "Two", Shape: "diamond", X: 300, Y: 100},
		{Op: "updateNode", ID: "n1", Text: "One", Shape: "round", X: 100, Y: 80},
		{Op: "addEdge", From: "n1", To: "n2", Label: "next"},
		{Op: "deleteEdge", From: "n1", To: "n2"},
		{Op: "addEdge", From: "n1", To: "n2"},
		{Op: "deleteNode", ID: "n2"},
	}, true)
	if err != nil || n != 7 || len(diff) != 7 || len(b2.Nodes) != 0 {
		t.Fatalf("dryRun apply failed: n=%d nodes=%d err=%v", n, len(b2.Nodes), err)
	}
	if _, _, err := b2.Apply([]Op{
		{Op: "addNode", ID: "a", Text: "A"},
		{Op: "addNode", ID: "b", Text: "B"},
		{Op: "addNode", ID: "c", Text: "C"},
		{Op: "addEdge", From: "a", To: "b"},
		{Op: "addEdge", From: "b", To: "c"},
		{Op: "deleteNode", ID: "c"}, // keeps a->b, drops b->c
	}, false); err != nil || len(b2.Nodes) != 2 || len(b2.Edges) != 1 {
		t.Fatalf("real apply failed: %+v err=%v", b2, err)
	}
	for _, badOps := range [][]Op{
		{{Op: "addNode", ID: "a"}},
		{{Op: "updateNode", ID: "missing"}},
		{{Op: "deleteNode", ID: "missing"}},
		{{Op: "addEdge", From: "", To: "b"}},
		{{Op: "deleteEdge", From: "x", To: "y"}},
		{{Op: "unsupported"}},
	} {
		if _, _, err := b2.Apply(badOps, false); err == nil {
			t.Fatalf("expected error for %+v", badOps)
		}
	}
}

func TestHandlerAndTools(t *testing.T) {
	mem := storage.NewMemoryStore()
	whHits := 0
	whSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		whHits++
		w.WriteHeader(http.StatusOK)
	}))
	defer whSrv.Close()

	auth := storage.NewBearerTokenAuth(map[string]storage.Principal{
		"admin": {ID: "u1", Roles: []string{"admin"}},
	})
	h := NewHandler(mem, WithAuth(auth, storage.NewRoleAuthorizer(nil)), WithWebhook(storage.NewWebhookDispatcher(whSrv.URL, "sec", whSrv.Client())))
	doReq := func(method, path string, body io.Reader, ct string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, body)
		r.Header.Set("Authorization", "Bearer admin")
		if ct != "" {
			r.Header.Set("Content-Type", ct)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		return rec
	}

	// POST /boards JSON, Mermaid, XMind, errors
	if rec := doReq(http.MethodPost, "/boards", strings.NewReader(""), "application/json"); rec.Code != http.StatusCreated {
		t.Fatalf("empty POST /boards failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/boards", strings.NewReader(`{"id":"b1","title":"Flow","board":{"nodes":[{"id":"a","text":"Start","shape":"rect","x":60,"y":60}],"edges":[]}}`), "application/json"); rec.Code != http.StatusCreated {
		t.Fatalf("JSON POST /boards failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doReq(http.MethodPost, "/boards", strings.NewReader(`{"id":"b1"}`), "application/json"); rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/boards", strings.NewReader(`{"id":"../bad"}`), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 invalid id, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/boards", strings.NewReader("{bad"), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad json, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/boards", errReader{}, "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 read err, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/boards?format=mermaid&id=m1", strings.NewReader("flowchart TD\nA --> B"), "text/plain"); rec.Code != http.StatusCreated {
		t.Fatalf("mermaid import failed: %d", rec.Code)
	}
	xmBytes := buildTestZip(map[string]string{"content.json": `[{"rootTopic":{"title":"Root"}}]`})
	if rec := doReq(http.MethodPost, "/boards?format=xmind&id=x1", bytes.NewReader(xmBytes), "application/vnd.xmind.workbook"); rec.Code != http.StatusCreated {
		t.Fatalf("xmind import failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/boards?format=xmind", strings.NewReader("bad"), "application/octet-stream"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad xmind, got %d", rec.Code)
	}

	// GET /boards/{id} & /render.svg
	if rec := doReq(http.MethodGet, "/boards/b1", nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("GET /boards/b1 failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/boards/missing", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/boards/b1/render.svg", nil, ""); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<svg") {
		t.Fatalf("render.svg failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/boards/missing/render.svg", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 render.svg, got %d", rec.Code)
	}

	// POST /boards/{id}/apply
	if rec := doReq(http.MethodPost, "/boards/b1/apply", strings.NewReader(`{"ops":[{"op":"addNode","id":"b","text":"End"},{"op":"addEdge","from":"a","to":"b"}]}`), "application/json"); rec.Code != http.StatusOK {
		t.Fatalf("apply failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/boards/b1/apply", strings.NewReader(`{"ops":[{"op":"bad"}]}`), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad op, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/boards/b1/apply", strings.NewReader("{bad"), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad json, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/boards/missing/apply", strings.NewReader(`{"ops":[]}`), "application/json"); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 apply, got %d", rec.Code)
	}

	// POST /boards/{id}/verify
	if rec := doReq(http.MethodPost, "/boards/b1/verify", nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("verify failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/boards/missing/verify", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 verify, got %d", rec.Code)
	}

	// Failing store & corrupt JSON
	fh := NewHandler(&failingStore{Store: mem, putErr: errors.New("put err"), delErr: errors.New("del err")})
	rec := httptest.NewRecorder()
	fh.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/boards/b1/apply", strings.NewReader(`{"ops":[{"op":"addNode","id":"z"}]}`)))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on failing store put, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	fh.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/boards/b1", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on failing store delete, got %d", rec.Code)
	}
	_ = mem.Put(context.Background(), &storage.DocumentRecord{ID: "corrupt", Kind: "whiteboard", Data: []byte("{bad")})
	if rec := doReq(http.MethodGet, "/boards/corrupt", nil, ""); rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on corrupt stored board, got %d", rec.Code)
	}

	// DELETE /boards/{id}
	if rec := doReq(http.MethodDelete, "/boards/x1", nil, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("delete failed: %d", rec.Code)
	}
	if whHits < 4 {
		t.Fatalf("expected webhook hits, got %d", whHits)
	}

	// RegisterTools
	reg := ai.NewToolRegistry()
	if err := RegisterTools(nil, mem); err == nil {
		t.Fatal("expected nil registry error")
	}
	if err := RegisterTools(reg, mem); err != nil {
		t.Fatal(err)
	}
	if err := RegisterTools(reg, mem); !errors.Is(err, ai.ErrDuplicateTool) {
		t.Fatalf("expected duplicate error, got %v", err)
	}
	ctx := context.Background()
	if _, err := reg.Call(ctx, "board_inspect", map[string]any{"id": "b1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Call(ctx, "board_inspect", map[string]any{"id": "missing"}); err == nil {
		t.Fatal("expected error")
	}
	if _, err := reg.Call(ctx, "board_verify", map[string]any{"id": "b1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Call(ctx, "board_verify", map[string]any{"id": "missing"}); err == nil {
		t.Fatal("expected error")
	}
	if _, err := reg.Call(ctx, "board_render_svg", map[string]any{"id": "b1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Call(ctx, "board_render_svg", map[string]any{"id": "missing"}); err == nil {
		t.Fatal("expected error")
	}
	if _, err := reg.Call(ctx, "board_apply", map[string]any{"id": "b1", "ops": []any{map[string]any{"op": "addNode", "id": "mcp", "text": "MCP"}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Call(ctx, "board_apply", map[string]any{"id": "missing", "ops": []any{}}); err == nil {
		t.Fatal("expected missing error")
	}
	if _, err := reg.Call(ctx, "board_apply", map[string]any{"id": "b1", "ops": make(chan int)}); err == nil {
		t.Fatal("expected marshal error")
	}
	if _, err := reg.Call(ctx, "board_apply", map[string]any{"id": "b1", "ops": "bad"}); err == nil {
		t.Fatal("expected unmarshal error")
	}
	if _, err := reg.Call(ctx, "board_apply", map[string]any{"id": "b1", "ops": []any{map[string]any{"op": "bad"}}}); err == nil {
		t.Fatal("expected apply error")
	}
	regFail := ai.NewToolRegistry()
	_ = RegisterTools(regFail, &failingStore{Store: mem, putErr: errors.New("put fail")})
	if _, err := regFail.Call(ctx, "board_apply", map[string]any{"id": "b1", "ops": []any{map[string]any{"op": "addNode", "id": "z"}}}); err == nil {
		t.Fatal("expected store put error")
	}
}
