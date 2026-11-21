package slides

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
	_, _ = fw.Write([]byte("slide xml payload slide xml payload"))
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
	_, _ = fw.Write([]byte("slide xml payload to corrupt deflate"))
	_ = zw.Close()
	raw := buf.Bytes()
	start := 30 + len(entryName)
	for i := start; i < start+5 && i < len(raw); i++ {
		raw[i] ^= 0xff
	}
	return raw
}

func TestPPTXApplyVerifyRender(t *testing.T) {
	// WritePPTX(nil) & roundtrip
	nilBytes, err := WritePPTX(nil)
	if err != nil {
		t.Fatalf("WritePPTX(nil) failed: %v", err)
	}
	parsedNil, err := ParsePPTX(nilBytes)
	if err != nil || len(parsedNil.Slides) != 1 || parsedNil.Title != "Presentation" {
		t.Fatalf("ParsePPTX(nilBytes) failed: %+v err=%v", parsedNil, err)
	}

	deck := &Deck{
		Title: "Launch",
		Slides: []Slide{
			{Index: 0, Title: "Kickoff", Body: "Line 1\nLine 2", Background: "#f8fafc"},
			{Index: 1, Title: "Roadmap", Body: "Q1-Q4"},
		},
	}
	pptx, err := WritePPTX(deck)
	if err != nil {
		t.Fatalf("WritePPTX failed: %v", err)
	}
	rt, err := ParsePPTX(pptx)
	if err != nil || len(rt.Slides) != 2 || rt.Title != "Kickoff" || rt.Slides[1].Title != "Roadmap" {
		t.Fatalf("PPTX roundtrip failed: %+v err=%v", rt, err)
	}

	// ParsePPTX errors: invalid zip, no slides, empty slide XML, open error, read error, multi-slide sort
	if _, err := ParsePPTX([]byte("notzip")); err == nil {
		t.Fatal("expected invalid zip error")
	}
	noSlidesZip, _ := buildZipBytes([]zipEntry{{name: "ppt/presentation.xml", body: "<p/>"}})
	if _, err := ParsePPTX(noSlidesZip); err == nil {
		t.Fatal("expected no slides error")
	}
	emptySlideZip, _ := buildZipBytes([]zipEntry{
		{name: "ppt/slides/slide2.xml", body: `<p:sld><a:t>Two</a:t></p:sld>`},
		{name: "ppt/slides/slide1.xml", body: `<p:sld></p:sld>`},
	})
	es, err := ParsePPTX(emptySlideZip)
	if err != nil || len(es.Slides) != 2 || es.Slides[0].Title != "" || es.Slides[1].Title != "Two" {
		t.Fatalf("empty slide parse failed: %+v err=%v", es, err)
	}
	if _, err := ParsePPTX(makeCorruptMethodZip("ppt/slides/slide1.xml")); err == nil {
		t.Fatal("expected open error")
	}
	if _, err := ParsePPTX(makeCorruptDeflateZip("ppt/slides/slide1.xml")); err == nil {
		t.Fatal("expected read error")
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

	// Inspect & RenderSlideSVG
	if info := deck.Inspect(); info["slideCount"] != 2 {
		t.Fatalf("unexpected inspect: %+v", info)
	}
	svg, err := deck.RenderSlideSVG(0)
	if err != nil || !strings.Contains(svg, "Kickoff") || !strings.Contains(svg, "#f8fafc") {
		t.Fatalf("unexpected svg: %s err=%v", svg, err)
	}
	svgDefaultBg, err := deck.RenderSlideSVG(1)
	if err != nil || !strings.Contains(svgDefaultBg, "#ffffff") {
		t.Fatalf("expected default white bg: %s err=%v", svgDefaultBg, err)
	}
	if _, err := deck.RenderSlideSVG(99); err == nil {
		t.Fatal("expected out-of-range error")
	}

	// Apply (addSlide, updateSlide, deleteSlide, dryRun, rollback on errors)
	n, diff, err := deck.Apply([]Op{
		{Op: "addSlide", Title: "New", Body: "B", Background: "#000"},
		{Op: "updateSlide", SlideIndex: 0, Title: "Updated", Body: "NewBody", Background: "#eee"},
		{Op: "deleteSlide", SlideIndex: 1},
	}, true)
	if err != nil || n != 3 || len(diff) != 3 || len(deck.Slides) != 2 || deck.Slides[0].Title != "Kickoff" {
		t.Fatalf("dryRun failed: n=%d slides=%+v err=%v", n, deck.Slides, err)
	}
	if _, _, err := deck.Apply([]Op{
		{Op: "addSlide", Title: "Extra"},
		{Op: "deleteSlide", SlideIndex: 0},
	}, false); err != nil || len(deck.Slides) != 2 || deck.Slides[0].Index != 0 {
		t.Fatalf("apply failed: %+v err=%v", deck.Slides, err)
	}
	for _, badOps := range [][]Op{
		{{Op: "updateSlide", SlideIndex: 99}},
		{{Op: "deleteSlide", SlideIndex: -1}},
		{{Op: "unsupported"}},
	} {
		if _, _, err := deck.Apply(badOps, false); err == nil {
			t.Fatalf("expected error for %+v", badOps)
		}
	}

	// Verify (empty deck, empty slide, text overflow)
	if diags := (&Deck{}).Verify(); len(diags) != 1 || diags[0].Code != "EMPTY_DECK" {
		t.Fatalf("expected EMPTY_DECK, got %+v", diags)
	}
	problemDeck := &Deck{Slides: []Slide{
		{Index: 0},
		{Index: 1, Title: "Dense", Body: strings.Repeat("a", 850)},
	}}
	diags := problemDeck.Verify()
	if len(diags) != 2 || diags[0].Code != "EMPTY_SLIDE" || diags[1].Code != "TEXT_OVERFLOW" {
		t.Fatalf("unexpected diagnostics: %+v", diags)
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

	// POST /slides JSON & PPTX & error cases
	if rec := doReq(http.MethodPost, "/slides", strings.NewReader(""), "application/json"); rec.Code != http.StatusCreated {
		t.Fatalf("empty POST /slides failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/slides", strings.NewReader(`{"id":"p1","title":"Pitch","deck":{"title":"Pitch","slides":[{"index":0,"title":"Intro","body":"Hello"}]}}`), "application/json"); rec.Code != http.StatusCreated {
		t.Fatalf("JSON POST /slides failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doReq(http.MethodPost, "/slides", strings.NewReader(`{"id":"p1"}`), "application/json"); rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/slides", strings.NewReader(`{"id":"../bad"}`), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 invalid id, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/slides", strings.NewReader("{bad"), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad json, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/slides", errReader{}, "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 read err, got %d", rec.Code)
	}
	pptx, _ := WritePPTX(&Deck{Title: "P", Slides: []Slide{{Title: "Slide 1", Body: "Hi"}}})
	if rec := doReq(http.MethodPost, "/slides?format=pptx&id=px1", bytes.NewReader(pptx), "application/vnd.openxmlformats-officedocument.presentationml.presentation"); rec.Code != http.StatusCreated {
		t.Fatalf("PPTX import failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/slides?format=pptx", strings.NewReader("bad"), "application/octet-stream"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad pptx, got %d", rec.Code)
	}

	// GET /slides/{id}
	if rec := doReq(http.MethodGet, "/slides/p1", nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("GET /slides/p1 failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/slides/missing", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}

	// GET /slides/{id}/export
	if rec := doReq(http.MethodGet, "/slides/p1/export", nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("export failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/slides/missing/export", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 export, got %d", rec.Code)
	}
	origW := newBytesWriter
	newBytesWriter = func(*bytes.Buffer) io.Writer { return &limitWriter{limit: 0} }
	if rec := doReq(http.MethodGet, "/slides/p1/export", nil, ""); rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on WritePPTX failure, got %d", rec.Code)
	}
	newBytesWriter = origW

	// GET /slides/{id}/render/{index}.svg
	if rec := doReq(http.MethodGet, "/slides/p1/render/0.svg", nil, ""); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<svg") {
		t.Fatalf("render svg failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doReq(http.MethodGet, "/slides/p1/render/0.png", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for non-svg, got %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/slides/p1/render/abc.svg", nil, ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for non-int index, got %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/slides/missing/render/0.svg", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for missing deck, got %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/slides/p1/render/9.svg", nil, ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for out-of-range slide, got %d", rec.Code)
	}

	// POST /slides/{id}/apply
	if rec := doReq(http.MethodPost, "/slides/p1/apply", strings.NewReader(`{"ops":[{"op":"addSlide","title":"Slide 2"}]}`), "application/json"); rec.Code != http.StatusOK {
		t.Fatalf("apply failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/slides/p1/apply", strings.NewReader(`{"ops":[{"op":"bad"}]}`), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad op, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/slides/p1/apply", strings.NewReader("{bad"), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad json, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/slides/missing/apply", strings.NewReader(`{"ops":[]}`), "application/json"); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 apply, got %d", rec.Code)
	}

	// POST /slides/{id}/verify
	if rec := doReq(http.MethodPost, "/slides/p1/verify", nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("verify failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/slides/missing/verify", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 verify, got %d", rec.Code)
	}

	// Failing store & corrupt JSON
	fh := NewHandler(&failingStore{Store: mem, putErr: errors.New("put err"), delErr: errors.New("del err")})
	rec := httptest.NewRecorder()
	fh.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/slides/p1/apply", strings.NewReader(`{"ops":[{"op":"addSlide","title":"X"}]}`)))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on failing store put, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	fh.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/slides/p1", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on failing store delete, got %d", rec.Code)
	}
	_ = mem.Put(context.Background(), &storage.DocumentRecord{ID: "corrupt", Kind: "slides", Data: []byte("{bad")})
	if rec := doReq(http.MethodGet, "/slides/corrupt", nil, ""); rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on corrupt stored deck, got %d", rec.Code)
	}

	// DELETE /slides/{id}
	if rec := doReq(http.MethodDelete, "/slides/px1", nil, ""); rec.Code != http.StatusNoContent {
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
	if _, err := reg.Call(ctx, "slides_inspect", map[string]any{"id": "p1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Call(ctx, "slides_inspect", map[string]any{"id": "missing"}); err == nil {
		t.Fatal("expected error")
	}
	if _, err := reg.Call(ctx, "slides_verify", map[string]any{"id": "p1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Call(ctx, "slides_verify", map[string]any{"id": "missing"}); err == nil {
		t.Fatal("expected error")
	}
	if _, err := reg.Call(ctx, "slides_render_svg", map[string]any{"id": "p1", "slideIndex": 0}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Call(ctx, "slides_render_svg", map[string]any{"id": "missing", "slideIndex": 0}); err == nil {
		t.Fatal("expected error")
	}
	if _, err := reg.Call(ctx, "slides_render_svg", map[string]any{"id": "p1", "slideIndex": 99}); err == nil {
		t.Fatal("expected out-of-range error")
	}
	if _, err := reg.Call(ctx, "slides_apply", map[string]any{"id": "p1", "ops": []any{map[string]any{"op": "addSlide", "title": "MCP"}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Call(ctx, "slides_apply", map[string]any{"id": "missing", "ops": []any{}}); err == nil {
		t.Fatal("expected missing error")
	}
	if _, err := reg.Call(ctx, "slides_apply", map[string]any{"id": "p1", "ops": make(chan int)}); err == nil {
		t.Fatal("expected marshal error")
	}
	if _, err := reg.Call(ctx, "slides_apply", map[string]any{"id": "p1", "ops": "bad"}); err == nil {
		t.Fatal("expected unmarshal error")
	}
	if _, err := reg.Call(ctx, "slides_apply", map[string]any{"id": "p1", "ops": []any{map[string]any{"op": "bad"}}}); err == nil {
		t.Fatal("expected apply error")
	}
	regFail := ai.NewToolRegistry()
	_ = RegisterTools(regFail, &failingStore{Store: mem, putErr: errors.New("put fail")})
	if _, err := regFail.Call(ctx, "slides_apply", map[string]any{"id": "p1", "ops": []any{map[string]any{"op": "addSlide", "title": "X"}}}); err == nil {
		t.Fatal("expected store put error")
	}
}
