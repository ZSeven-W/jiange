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
	"sync/atomic"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type protectDuringFileAccess struct {
	store.Store
	active atomic.Bool
	once   sync.Once
	docID  int64
	userID int64
}

type blockingFileBlob struct {
	blob.Store
	started chan struct{}
	release chan struct{}
}

func (b *blockingFileBlob) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	close(b.started)
	select {
	case <-b.release:
		return b.Store.Get(ctx, key)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func TestAuthenticatedFileRechecksAfterBlobOpen(t *testing.T) {
	for _, change := range []string{"protection", "revocation"} {
		t.Run(change, func(t *testing.T) {
			ctx := context.Background()
			st := store.NewMemory()
			data := blob.NewMemory()
			gate := &blockingFileBlob{Store: data, started: make(chan struct{}), release: make(chan struct{})}
			s := &Server{Store: st, Blobs: gate, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
			ts := httptest.NewServer(s.Handler())
			defer ts.Close()
			client := func() *http.Client { jar, _ := cookiejar.New(nil); return &http.Client{Jar: jar} }
			owner, viewer := client(), client()
			post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "owner-blob@x.test", "name": "Owner", "password": "password123"})
			post(t, viewer, ts.URL+"/api/auth/register", map[string]string{"email": "viewer-blob@x.test", "name": "Viewer", "password": "password123"})
			var doc store.DocMeta
			json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "doc"}).Body).Decode(&doc)
			url := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10)
			if r := send(t, owner, "PUT", url+"/shares", map[string]string{"email": "viewer-blob@x.test", "role": "view"}); r.StatusCode != 200 {
				t.Fatal(r.StatusCode)
			}
			if err := data.Put(ctx, "test/document.pdf", "application/pdf", []byte("secret")); err != nil {
				t.Fatal(err)
			}
			file, err := st.CreateFile(ctx, store.FileMeta{DocID: doc.ID, Name: "document.pdf", Mime: "application/pdf", Size: 6, ObjectKey: "test/document.pdf"})
			if err != nil {
				t.Fatal(err)
			}
			result := make(chan *http.Response, 1)
			failure := make(chan error, 1)
			go func() {
				r, err := viewer.Get(ts.URL + "/api/files/" + strconv.FormatInt(file.ID, 10))
				if err != nil {
					failure <- err
					return
				}
				result <- r
			}()
			select {
			case <-gate.started:
			case <-time.After(5 * time.Second):
				t.Fatal("blob access did not start")
			}
			if change == "protection" {
				if err := st.SetCopyProtected(ctx, doc.ID, true); err != nil {
					t.Fatal(err)
				}
			} else {
				user, err := st.UserByEmail(ctx, "viewer-blob@x.test")
				if err != nil {
					t.Fatal(err)
				}
				if err := st.SetShare(ctx, doc.ID, user.ID, ""); err != nil {
					t.Fatal(err)
				}
			}
			close(gate.release)
			select {
			case err := <-failure:
				t.Fatal(err)
			case r := <-result:
				defer r.Body.Close()
				if r.StatusCode != http.StatusNotFound {
					t.Fatalf("%s during blob access: %d", change, r.StatusCode)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("file response did not finish")
			}
		})
	}
}

func (s *protectDuringFileAccess) GetDoc(ctx context.Context, uid, doc int64) (store.DocMeta, error) {
	meta, err := s.Store.GetDoc(ctx, uid, doc)
	if s.active.Load() && uid == s.userID && doc == s.docID {
		s.once.Do(func() { _ = s.Store.SetCopyProtected(ctx, doc, true) })
	}
	return meta, err
}

func TestAuthenticatedProtectedFileAccess(t *testing.T) {
	ctx := context.Background()
	mem := store.NewMemory()
	st := &protectDuringFileAccess{Store: mem}
	blobs := blob.NewMemory()
	s := &Server{Store: st, Blobs: blobs, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	client := func() *http.Client { jar, _ := cookiejar.New(nil); return &http.Client{Jar: jar} }
	owner, viewer, editor, outsider := client(), client(), client(), client()
	for _, u := range []struct {
		client *http.Client
		email  string
	}{{owner, "owner-protected@x.test"}, {viewer, "view-protected@x.test"}, {editor, "edit-protected@x.test"}, {outsider, "other-protected@x.test"}} {
		if r := post(t, u.client, ts.URL+"/api/auth/register", map[string]string{"email": u.email, "name": u.email, "password": "password123"}); r.StatusCode != 201 {
			t.Fatal(r.StatusCode)
		}
	}
	var doc store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "受保护文档"}).Body).Decode(&doc)
	url := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10)
	for _, share := range []struct{ email, role string }{{"view-protected@x.test", "view"}, {"edit-protected@x.test", "edit"}} {
		if r := send(t, owner, "PUT", url+"/shares", map[string]string{"email": share.email, "role": share.role}); r.StatusCode != 200 {
			t.Fatal(r.StatusCode)
		}
	}
	makeFile := func(name, mime, content string) store.FileMeta {
		t.Helper()
		key := "protected-test/" + name
		if err := blobs.Put(ctx, key, mime, []byte(content)); err != nil {
			t.Fatal(err)
		}
		file, err := st.CreateFile(ctx, store.FileMeta{DocID: doc.ID, Name: name, Mime: mime, Size: int64(len(content)), ObjectKey: key})
		if err != nil {
			t.Fatal(err)
		}
		return file
	}
	png := "\x89PNG\r\n\x1a\nimage"
	image := makeFile("current.png", "image/png", png)
	attachedImage := makeFile("attached.png", "image/png", png)
	oldImage := makeFile("old.png", "image/png", png)
	spoofed := makeFile("spoofed.png", "image/png", "%PDF-1.4\nprivate")
	pdf := makeFile("proposal.pdf", "application/pdf", "%PDF-1.4\nproposal")
	svg := makeFile("unsafe.svg", "image/svg+xml; charset=utf-8", "<svg/>")
	state, _, err := StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	var ops []collab.Op
	var oldBlock collab.OpID
	for i, file := range []store.FileMeta{image, attachedImage, oldImage, spoofed, pdf, svg} {
		typ := "image"
		if i == 1 {
			typ = "file"
		}
		create := state.CreateBlock(9, collab.Root, string(rune('W'+i)), typ)
		if i == 2 {
			oldBlock = create.ID
		}
		id := strconv.FormatInt(file.ID, 10)
		set := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 9, Clock: create.ID.Clock + 1}, Block: create.ID, Key: "fileId", Value: &id}
		state.Apply(set)
		ops = append(ops, create, set)
	}
	appendOps := func(ops []collab.Op) {
		t.Helper()
		var rows []store.RawOp
		for _, op := range ops {
			encoded, err := collab.EncodeOps([]collab.Op{op})
			if err != nil {
				t.Fatal(err)
			}
			rows = append(rows, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: encoded})
		}
		if _, err := st.AppendOps(ctx, doc.ID, rows); err != nil {
			t.Fatal(err)
		}
	}
	appendOps(ops)
	snapshot, seq, err := StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SaveSnapshot(ctx, doc.ID, seq, snapshot.EncodeState()); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveVersion(ctx, doc.ID, seq, "版本", doc.CreatorID); err != nil {
		t.Fatal(err)
	}
	appendOps([]collab.Op{{T: collab.TBlockDelete, ID: collab.OpID{Client: 9, Clock: 1000}, Block: oldBlock}})
	if r := send(t, owner, "PATCH", url, map[string]bool{"copyProtected": true}); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	get := func(c *http.Client, file store.FileMeta, query string) *http.Response {
		t.Helper()
		r, err := c.Get(ts.URL + "/api/files/" + strconv.FormatInt(file.ID, 10) + query)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	for _, c := range []*http.Client{viewer, editor} {
		if r := get(c, image, ""); r.StatusCode != 200 || !strings.HasPrefix(r.Header.Get("Content-Disposition"), "inline") || r.Header.Get("Cache-Control") != "private, no-store" {
			t.Fatalf("image preview: %d %v", r.StatusCode, r.Header)
		}
		for _, file := range []store.FileMeta{attachedImage, spoofed, pdf, svg, oldImage} {
			if r := get(c, file, ""); r.StatusCode != 404 {
				t.Fatalf("protected file %s: %d", file.Name, r.StatusCode)
			}
		}
		if r := get(c, oldImage, "?version="+strconv.FormatInt(seq, 10)); r.StatusCode != 200 {
			t.Fatalf("historical image: %d", r.StatusCode)
		}
		for _, query := range []string{"?version=0", "?version=invalid", "?version=999999", "?version=1&version=2"} {
			if r := get(c, oldImage, query); r.StatusCode != 404 {
				t.Fatalf("invalid version %q: %d", query, r.StatusCode)
			}
		}
	}
	if r := get(owner, pdf, ""); r.StatusCode != 200 {
		t.Fatalf("manager download: %d", r.StatusCode)
	}
	if r := get(outsider, image, ""); r.StatusCode != 404 {
		t.Fatalf("outsider: %d", r.StatusCode)
	}
	if r := send(t, owner, "PATCH", url, map[string]bool{"copyProtected": false}); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	if r := get(viewer, pdf, ""); r.StatusCode != 200 {
		t.Fatalf("download after protection disabled: %d", r.StatusCode)
	}
	viewUser, err := st.UserByEmail(ctx, "view-protected@x.test")
	if err != nil {
		t.Fatal(err)
	}
	st.docID, st.userID = doc.ID, viewUser.ID
	st.active.Store(true)
	if r := get(viewer, pdf, ""); r.StatusCode != 404 {
		t.Fatalf("protection changed during authorization: %d", r.StatusCode)
	}
	st.active.Store(false)
	if r := send(t, owner, "PUT", url+"/shares", map[string]string{"email": "view-protected@x.test", "role": ""}); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	if r := get(viewer, image, ""); r.StatusCode != 404 {
		t.Fatalf("revoked viewer: %d", r.StatusCode)
	}
}
