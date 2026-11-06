package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type revokeOnFileStore struct {
	store.Store
	once   sync.Once
	active bool
	docID  int64
}

type onHeadStore struct {
	store.Store
	once sync.Once
	hook func()
}

func (s *onHeadStore) Head(ctx context.Context, docID int64) (int64, error) {
	head, err := s.Store.Head(ctx, docID)
	s.once.Do(s.hook)
	return head, err
}

func (s *revokeOnFileStore) GetFile(ctx context.Context, id int64) (store.FileMeta, error) {
	f, err := s.Store.GetFile(ctx, id)
	if s.active {
		s.once.Do(func() { _ = s.Store.SetLink(ctx, s.docID, store.Link{Role: "none"}) })
	}
	return f, err
}

func TestInlineImageAllowlist(t *testing.T) {
	for value, want := range map[string]bool{
		"image/png": true, "IMAGE/JPEG; charset=utf-8": true,
		"image/svg+xml": false, "image/svg+xml; charset=utf-8": false,
		"application/pdf": false, "image/png; bad": false,
	} {
		if got := canInlineImage(value); got != want {
			t.Errorf("canInlineImage(%q) = %v, want %v", value, got, want)
		}
	}
}

func TestRasterImageSignature(t *testing.T) {
	for _, tc := range []struct {
		name string
		data []byte
		want bool
	}{
		{"png", []byte("\x89PNG\r\n\x1a\ncontent"), true},
		{"avif major", []byte("\x00\x00\x00\x18ftypavif\x00\x00\x00\x00mif1avif"), true},
		{"avif compatible", []byte("\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00avifmif1"), true},
		{"non-avif heif", []byte("\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00heicmif1"), false},
		{"invalid box", []byte("\x00\x00\x00\x07ftypavif\x00\x00\x00\x00"), false},
		{"pdf", []byte("%PDF-1.4\ncontent"), false},
	} {
		if got := isRasterImage(tc.data); got != tc.want {
			t.Errorf("%s: isRasterImage() = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestPublicAttachmentsRespectDocumentAndLink(t *testing.T) {
	ctx := context.Background()
	mem := store.NewMemory()
	st := &revokeOnFileStore{Store: mem}
	blobs := blob.NewMemory()
	s := &Server{Store: st, Blobs: blobs, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	jar, _ := cookiejar.New(nil)
	owner := &http.Client{Jar: jar}
	guest := &http.Client{}
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "public-files@x.test", "name": "Owner", "password": "password123"})
	var doc, other store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "公开文档"}).Body).Decode(&doc)
	json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "私密文档"}).Body).Decode(&other)
	makeFile := func(docID int64, name, mime, content string) store.FileMeta {
		t.Helper()
		key := "test/" + name
		if err := blobs.Put(ctx, key, mime, []byte(content)); err != nil {
			t.Fatal(err)
		}
		f, err := st.CreateFile(ctx, store.FileMeta{DocID: docID, Name: name, Mime: mime, Size: int64(len(content)), ObjectKey: key})
		if err != nil {
			t.Fatal(err)
		}
		return f
	}
	imageBytes := "\x89PNG\r\n\x1a\nimage-bytes"
	image := makeFile(doc.ID, "image.png", "image/png", imageBytes)
	attachment := makeFile(doc.ID, "proposal.pdf", "application/pdf", "file-bytes")
	disguised := makeFile(doc.ID, "disguised.pdf", "application/pdf", "private-bytes")
	svg := makeFile(doc.ID, "unsafe.svg", "image/svg+xml; charset=utf-8", "<svg/>")
	spoofed := makeFile(doc.ID, "spoofed.png", "image/png", "%PDF-1.4\nprivate")
	orphan := makeFile(doc.ID, "old.pdf", "application/pdf", "old-bytes")
	foreign := makeFile(other.ID, "private.pdf", "application/pdf", "private-bytes")
	state, _, err := StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	var ops []collab.Op
	for i, f := range []store.FileMeta{image, attachment, disguised, svg, spoofed} {
		typ := "image"
		if i == 1 {
			typ = "file"
		}
		create := state.CreateBlock(9, collab.Root, string(rune('W'+i)), typ)
		id := strconv.FormatInt(f.ID, 10)
		set := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 9, Clock: create.ID.Clock + 1}, Block: create.ID, Key: "fileId", Value: &id}
		state.Apply(set)
		ops = append(ops, create, set)
	}
	var raws []store.RawOp
	for _, op := range ops {
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		raws = append(raws, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
	}
	if _, err := st.AppendOps(ctx, doc.ID, raws); err != nil {
		t.Fatal(err)
	}
	url := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10)
	var link store.Link
	json.NewDecoder(send(t, owner, "PUT", url+"/link", map[string]string{"role": "anon"}).Body).Decode(&link)
	public := func(token string, id int64) *http.Response {
		t.Helper()
		r, err := guest.Get(ts.URL + "/api/public/" + token + "/files/" + strconv.FormatInt(id, 10))
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	for _, tc := range []struct {
		file              store.FileMeta
		body, disposition string
	}{{image, imageBytes, "inline"}, {attachment, "file-bytes", "attachment"}} {
		r := public(link.Token, tc.file.ID)
		data, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode != 200 || string(data) != tc.body || r.Header.Get("Cache-Control") != "no-store" || r.Header.Get("Referrer-Policy") != "no-referrer" || !strings.HasPrefix(r.Header.Get("Content-Disposition"), tc.disposition) {
			t.Fatalf("public file: status=%d headers=%v body=%q", r.StatusCode, r.Header, data)
		}
	}
	for _, f := range []store.FileMeta{orphan, foreign} {
		if r := public(link.Token, f.ID); r.StatusCode != 404 {
			t.Fatalf("unreferenced/foreign file: %d", r.StatusCode)
		}
	}
	for _, f := range []store.FileMeta{disguised, svg, spoofed} {
		if r := public(link.Token, f.ID); r.StatusCode != 404 {
			t.Fatalf("non-raster file disguised as image: %d", r.StatusCode)
		}
	}
	if r, _ := guest.Get(ts.URL + "/api/files/" + strconv.FormatInt(image.ID, 10)); r.StatusCode != 401 {
		t.Fatalf("ordinary route must remain authenticated: %d", r.StatusCode)
	}
	if r := send(t, owner, "PATCH", url, map[string]bool{"copyProtected": true}); r.StatusCode != 200 {
		t.Fatalf("protection: %d", r.StatusCode)
	}
	if r := public(link.Token, attachment.ID); r.StatusCode != 404 {
		t.Fatalf("protected download: %d", r.StatusCode)
	}
	if r := public(link.Token, image.ID); r.StatusCode != 200 {
		t.Fatalf("protected document should still render image: %d", r.StatusCode)
	}
	// Toggle protection after the request has started materializing the doc;
	// authorization must use the updated setting before returning file bytes.
	if err := mem.SetCopyProtected(ctx, doc.ID, false); err != nil {
		t.Fatal(err)
	}
	protect := &onHeadStore{Store: mem, hook: func() { _ = mem.SetCopyProtected(ctx, doc.ID, true) }}
	protectServer := httptest.NewServer((&Server{Store: protect, Blobs: blobs, Log: s.Log, Iterations: 100}).Handler())
	r, err := guest.Get(protectServer.URL + "/api/public/" + link.Token + "/files/" + strconv.FormatInt(attachment.ID, 10))
	if err != nil || r.StatusCode != 404 {
		t.Fatalf("protection changed during request: %v %v", r, err)
	}
	protectServer.Close()
	if r := send(t, owner, "PUT", url+"/link", map[string]string{"role": "view"}); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	if r := public(link.Token, image.ID); r.StatusCode != 404 {
		t.Fatalf("login-only link served anonymously: %d", r.StatusCode)
	}
	json.NewDecoder(send(t, owner, "PUT", url+"/link", map[string]string{"role": "anon"}).Body).Decode(&link)
	// The public document snapshot also rechecks the link after replay.
	revoke := &onHeadStore{Store: mem, hook: func() { _ = mem.SetLink(ctx, doc.ID, store.Link{Role: "none"}) }}
	revokeServer := httptest.NewServer((&Server{Store: revoke, Blobs: blobs, Log: s.Log, Iterations: 100}).Handler())
	r, err = guest.Get(revokeServer.URL + "/api/public/" + link.Token)
	if err != nil || r.StatusCode != 404 {
		t.Fatalf("snapshot revoked during replay: %v %v", r, err)
	}
	revokeServer.Close()
	json.NewDecoder(send(t, owner, "PUT", url+"/link", map[string]string{"role": "anon"}).Body).Decode(&link)
	st.docID, st.active = doc.ID, true
	if r := public(link.Token, image.ID); r.StatusCode != 404 {
		t.Fatalf("concurrent revocation: %d", r.StatusCode)
	}
}
