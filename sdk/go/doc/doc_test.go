package doc

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

func (errReader) Read([]byte) (int, error) { return 0, errors.New("read failed") }

type limitWriter struct {
	limit int
	wrote int
	buf   bytes.Buffer
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if l.wrote+len(p) > l.limit {
		return 0, errors.New("limit reached")
	}
	l.wrote += len(p)
	return l.buf.Write(p)
}

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

func makeCorruptMethodZip(entryName string) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	fh := &zip.FileHeader{Name: entryName, Method: zip.Deflate}
	fw, _ := zw.CreateHeader(fh)
	_, _ = fw.Write([]byte("hello world hello world"))
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
	_, _ = fw.Write([]byte("some docx xml content to compress"))
	_ = zw.Close()
	raw := buf.Bytes()
	start := 30 + len(entryName)
	for i := start; i < start+5 && i < len(raw); i++ {
		raw[i] ^= 0xff
	}
	return raw
}

func TestMarkdownDOCXInspectQueryApplyVerify(t *testing.T) {
	md := "# Title\r\n\r\nIntro paragraph.\n\n- Bullet item\n\n> Quoted line\n\n```go\nfoo := bar\n```\n\n### Skipped H3\n"
	d := ParseMarkdown(md, "Spec")
	if len(d.Blocks) != 6 || d.Blocks[0].Type != "heading" || d.Blocks[4].Type != "code" {
		t.Fatalf("unexpected parsed blocks: %+v", d.Blocks)
	}
	// Invalid heading level clamping in ToMarkdown & WriteDOCX
	d.Blocks = append(d.Blocks, Block{ID: "b7", Type: "heading", Level: 0, Text: "ZeroLevel"})
	outMD := d.ToMarkdown()
	if !strings.Contains(outMD, "# ZeroLevel") || !strings.Contains(outMD, "```\nfoo := bar\n```") {
		t.Fatalf("unexpected markdown: %s", outMD)
	}

	// WriteDOCX & ParseDOCX roundtrip + nil fallback
	if _, err := WriteDOCX(nil); err != nil {
		t.Fatalf("WriteDOCX(nil) failed: %v", err)
	}
	docxBytes, err := WriteDOCX(d)
	if err != nil {
		t.Fatalf("WriteDOCX failed: %v", err)
	}
	parsed, err := ParseDOCX(docxBytes, "RoundTrip")
	if err != nil || len(parsed.Blocks) != 7 || parsed.Blocks[0].Level != 1 || parsed.Blocks[5].Level != 3 {
		t.Fatalf("ParseDOCX roundtrip failed: %+v err=%v", parsed, err)
	}

	// ParseDOCX error paths: bad zip, missing document.xml, bad xml, open error, read error, blank paragraph
	if _, err := ParseDOCX([]byte("notzip"), "x"); err == nil {
		t.Fatal("expected invalid zip error")
	}
	noDocZip, _ := buildZipBytes([]zipEntry{{name: "other.xml", body: "<x/>"}})
	if _, err := ParseDOCX(noDocZip, "x"); err == nil {
		t.Fatal("expected missing document.xml error")
	}
	badXMLZip, _ := buildZipBytes([]zipEntry{{name: "word/document.xml", body: "<broken"}})
	if _, err := ParseDOCX(badXMLZip, "x"); err == nil {
		t.Fatal("expected invalid xml error")
	}
	if _, err := ParseDOCX(makeCorruptMethodZip("word/document.xml"), "x"); err == nil {
		t.Fatal("expected open error")
	}
	if _, err := ParseDOCX(makeCorruptDeflateZip("word/document.xml"), "x"); err == nil {
		t.Fatal("expected read error")
	}
	blankParaZip, _ := buildZipBytes([]zipEntry{{name: "word/document.xml", body: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>   </w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading"/></w:pPr><w:r><w:t>H</w:t></w:r></w:p></w:body></w:document>`}})
	bp, err := ParseDOCX(blankParaZip, "B")
	if err != nil || len(bp.Blocks) != 1 || bp.Blocks[0].Level != 1 {
		t.Fatalf("blank para test failed: %+v err=%v", bp, err)
	}

	// buildZipBytes errors (create, write, close)
	origWriter := newBytesWriter
	newBytesWriter = func(*bytes.Buffer) io.Writer { return &limitWriter{limit: 0} }
	if _, err := buildZipBytes([]zipEntry{{name: strings.Repeat("a", 5000), body: "x"}}); err == nil {
		t.Fatal("expected create error")
	}
	var large strings.Builder
	state := uint32(1)
	for i := 0; i < 80000; i++ {
		state = state*1664525 + 1013904223
		large.WriteByte(byte(state >> 24))
	}
	newBytesWriter = func(*bytes.Buffer) io.Writer { return &limitWriter{limit: 100} }
	if _, err := buildZipBytes([]zipEntry{{name: "big.xml", body: large.String()}}); err == nil {
		t.Fatal("expected write error")
	}
	newBytesWriter = func(*bytes.Buffer) io.Writer { return &limitWriter{limit: 50} }
	if _, err := buildZipBytes([]zipEntry{{name: "a.xml", body: "hi"}}); err == nil {
		t.Fatal("expected close error")
	}
	newBytesWriter = origWriter

	// Inspect & Query
	if info := d.Inspect("full"); info["blockCount"] != 7 || info["blocks"] == nil {
		t.Fatalf("inspect full failed: %+v", info)
	}
	if q := d.Query("bullet", "bullet"); len(q) != 1 {
		t.Fatalf("query bullet failed: %+v", q)
	}
	if q := d.Query("nonexistent", ""); len(q) != 0 {
		t.Fatalf("expected 0 query hits, got %d", len(q))
	}

	// Verify (skipped heading + empty doc)
	diags := d.Verify()
	if len(diags) != 1 || diags[0].Code != "SKIPPED_HEADING_LEVEL" {
		t.Fatalf("expected SKIPPED_HEADING_LEVEL, got %+v", diags)
	}
	if emptyDiags := (&Document{}).Verify(); len(emptyDiags) != 1 || emptyDiags[0].Code != "EMPTY_DOC" {
		t.Fatalf("expected EMPTY_DOC, got %+v", emptyDiags)
	}

	// Apply (appendBlock, replaceText skipping code blocks, deleteBlock, dryRun, error rollbacks)
	doc2 := ParseMarkdown("# Hello\n\nfoo text\n\n```\nfoo code\n```", "D2")
	n, diff, err := doc2.Apply([]Op{
		{Op: "appendBlock", Text: "added"},
		{Op: "replaceText", Search: "foo", Replacement: "bar"},
		{Op: "deleteBlock", BlockID: "b1"},
	}, true)
	if err != nil || n != 3 || len(diff) != 3 || len(doc2.Blocks) != 3 || doc2.Blocks[1].Text != "foo text" {
		t.Fatalf("dryRun apply failed: n=%d blocks=%+v err=%v", n, doc2.Blocks, err)
	}
	if _, _, err := doc2.Apply([]Op{
		{Op: "replaceText", Search: "foo", Replacement: "bar"},
	}, false); err != nil {
		t.Fatal(err)
	}
	if doc2.Blocks[1].Text != "bar text" || doc2.Blocks[2].Text != "foo code" {
		t.Fatalf("replaceText must skip code blocks: %+v", doc2.Blocks)
	}
	for _, badOps := range [][]Op{
		{{Op: "replaceText", Search: ""}},
		{{Op: "deleteBlock", BlockID: "missing"}},
		{{Op: "unsupported"}},
	} {
		if _, _, err := doc2.Apply(badOps, false); err == nil {
			t.Fatalf("expected apply error for %+v", badOps)
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

	// POST /docs JSON, Markdown, DOCX, errors
	if rec := doReq(http.MethodPost, "/docs", strings.NewReader(""), "application/json"); rec.Code != http.StatusCreated {
		t.Fatalf("empty POST /docs failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/docs", strings.NewReader(`{"id":"d1","title":"Handbook","document":{"title":"Handbook","blocks":[{"id":"b1","type":"heading","level":1,"text":"Intro"}]}}`), "application/json"); rec.Code != http.StatusCreated {
		t.Fatalf("JSON POST /docs failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doReq(http.MethodPost, "/docs", strings.NewReader(`{"id":"d1"}`), "application/json"); rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/docs", strings.NewReader(`{"id":"../bad"}`), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 invalid id, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/docs", strings.NewReader("{bad"), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad json, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/docs", errReader{}, "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 read err, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/docs?format=md&id=md1&title=Notes", strings.NewReader("# Hi\n\nBody"), "text/markdown"); rec.Code != http.StatusCreated {
		t.Fatalf("MD import failed: %d", rec.Code)
	}
	docxBytes, _ := WriteDOCX(ParseMarkdown("# Hello", "Hello"))
	if rec := doReq(http.MethodPost, "/docs?format=docx&id=dx1", bytes.NewReader(docxBytes), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"); rec.Code != http.StatusCreated {
		t.Fatalf("DOCX import failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/docs?format=docx", strings.NewReader("bad"), "application/octet-stream"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad docx, got %d", rec.Code)
	}

	// GET /docs/{id}
	if rec := doReq(http.MethodGet, "/docs/d1?detail=full", nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("GET /docs/d1 failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/docs/missing", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}

	// GET /docs/{id}/export
	if rec := doReq(http.MethodGet, "/docs/d1/export", nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("export docx failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/docs/d1/export?format=md", nil, ""); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "# Intro") {
		t.Fatalf("export md failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doReq(http.MethodGet, "/docs/d1/export?format=pdf", nil, ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 unsupported format, got %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/docs/missing/export", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 export, got %d", rec.Code)
	}
	origW := newBytesWriter
	newBytesWriter = func(*bytes.Buffer) io.Writer { return &limitWriter{limit: 0} }
	if rec := doReq(http.MethodGet, "/docs/d1/export?format=docx", nil, ""); rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on WriteDOCX failure, got %d", rec.Code)
	}
	newBytesWriter = origW

	// POST /docs/{id}/query
	if rec := doReq(http.MethodPost, "/docs/d1/query", strings.NewReader(`{"text":"intro"}`), "application/json"); rec.Code != http.StatusOK {
		t.Fatalf("query failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/docs/d1/query", strings.NewReader("{bad"), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad query, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/docs/missing/query", strings.NewReader(`{}`), "application/json"); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 query, got %d", rec.Code)
	}

	// POST /docs/{id}/apply
	if rec := doReq(http.MethodPost, "/docs/d1/apply", strings.NewReader(`{"ops":[{"op":"appendBlock","text":"More"}]}`), "application/json"); rec.Code != http.StatusOK {
		t.Fatalf("apply failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doReq(http.MethodPost, "/docs/d1/apply", strings.NewReader(`{"ops":[{"op":"bad"}]}`), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad op, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/docs/d1/apply", strings.NewReader("{bad"), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad json, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/docs/missing/apply", strings.NewReader(`{"ops":[]}`), "application/json"); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 apply, got %d", rec.Code)
	}

	// POST /docs/{id}/verify
	if rec := doReq(http.MethodPost, "/docs/d1/verify", nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("verify failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/docs/missing/verify", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 verify, got %d", rec.Code)
	}

	// Failing store & corrupt JSON
	fh := NewHandler(&failingStore{Store: mem, putErr: errors.New("put err"), delErr: errors.New("del err")})
	rec := httptest.NewRecorder()
	fh.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/docs/d1/apply", strings.NewReader(`{"ops":[{"op":"appendBlock","text":"x"}]}`)))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on failing store put, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	fh.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/docs/d1", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on failing store delete, got %d", rec.Code)
	}
	_ = mem.Put(context.Background(), &storage.DocumentRecord{ID: "corrupt", Kind: "doc", Data: []byte("{bad")})
	if rec := doReq(http.MethodGet, "/docs/corrupt", nil, ""); rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on corrupt stored doc, got %d", rec.Code)
	}

	// DELETE /docs/{id}
	if rec := doReq(http.MethodDelete, "/docs/dx1", nil, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("delete failed: %d", rec.Code)
	}
	if whHits < 4 {
		t.Fatalf("expected webhook calls, got %d", whHits)
	}

	// RegisterTools
	reg := ai.NewToolRegistry()
	if err := RegisterTools(nil, mem); err == nil {
		t.Fatal("expected nil registry error")
	}
	if err := RegisterTools(reg, mem); err != nil {
		t.Fatalf("RegisterTools failed: %v", err)
	}
	if err := RegisterTools(reg, mem); !errors.Is(err, ai.ErrDuplicateTool) {
		t.Fatalf("expected duplicate error, got %v", err)
	}
	ctx := context.Background()
	if _, err := reg.Call(ctx, "doc_inspect", map[string]any{"id": "d1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Call(ctx, "doc_inspect", map[string]any{"id": "missing"}); err == nil {
		t.Fatal("expected error")
	}
	if _, err := reg.Call(ctx, "doc_query", map[string]any{"id": "d1", "text": "intro"}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Call(ctx, "doc_query", map[string]any{"id": "missing"}); err == nil {
		t.Fatal("expected error")
	}
	if _, err := reg.Call(ctx, "doc_verify", map[string]any{"id": "d1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Call(ctx, "doc_verify", map[string]any{"id": "missing"}); err == nil {
		t.Fatal("expected error")
	}
	if _, err := reg.Call(ctx, "doc_apply", map[string]any{"id": "d1", "ops": []any{map[string]any{"op": "appendBlock", "text": "via mcp"}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Call(ctx, "doc_apply", map[string]any{"id": "missing", "ops": []any{}}); err == nil {
		t.Fatal("expected missing error")
	}
	if _, err := reg.Call(ctx, "doc_apply", map[string]any{"id": "d1", "ops": make(chan int)}); err == nil {
		t.Fatal("expected marshal error")
	}
	if _, err := reg.Call(ctx, "doc_apply", map[string]any{"id": "d1", "ops": "bad"}); err == nil {
		t.Fatal("expected unmarshal error")
	}
	if _, err := reg.Call(ctx, "doc_apply", map[string]any{"id": "d1", "ops": []any{map[string]any{"op": "bad"}}}); err == nil {
		t.Fatal("expected apply op error")
	}
	regFail := ai.NewToolRegistry()
	_ = RegisterTools(regFail, &failingStore{Store: mem, putErr: errors.New("put fail")})
	if _, err := regFail.Call(ctx, "doc_apply", map[string]any{"id": "d1", "ops": []any{map[string]any{"op": "appendBlock", "text": "x"}}}); err == nil {
		t.Fatal("expected store put error")
	}
}
