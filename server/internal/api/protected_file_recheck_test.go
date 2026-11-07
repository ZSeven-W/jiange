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
	"sync/atomic"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type blockingImageReferenceStore struct {
	store.Store
	kind    string
	active  atomic.Bool
	calls   atomic.Int32
	started chan struct{}
	release chan struct{}
}

func (s *blockingImageReferenceStore) wait(ctx context.Context, kind string) error {
	if !s.active.Load() || s.kind != kind || s.calls.Add(1) != 2 {
		return nil
	}
	close(s.started)
	select {
	case <-s.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *blockingImageReferenceStore) Head(ctx context.Context, doc int64) (int64, error) {
	if err := s.wait(ctx, "head"); err != nil {
		return 0, err
	}
	return s.Store.Head(ctx, doc)
}

func (s *blockingImageReferenceStore) VersionState(ctx context.Context, doc, seq int64) ([]byte, error) {
	if err := s.wait(ctx, "version"); err != nil {
		return nil, err
	}
	return s.Store.VersionState(ctx, doc, seq)
}

func TestProtectedImageRechecksAccessAfterReferenceRead(t *testing.T) {
	for _, kind := range []string{"head", "version"} {
		t.Run(kind, func(t *testing.T) {
			ctx := context.Background()
			mem := store.NewMemory()
			st := &blockingImageReferenceStore{Store: mem, kind: kind, started: make(chan struct{}), release: make(chan struct{})}
			blobs := blob.NewMemory()
			srv := &Server{Store: st, Blobs: blobs, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
			ts := httptest.NewServer(srv.Handler())
			defer ts.Close()
			client := func() *http.Client { jar, _ := cookiejar.New(nil); return &http.Client{Jar: jar} }
			owner, viewer := client(), client()
			post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "ref-owner@x.test", "name": "Owner", "password": "password123"})
			post(t, viewer, ts.URL+"/api/auth/register", map[string]string{"email": "ref-viewer@x.test", "name": "Viewer", "password": "password123"})
			var doc store.DocMeta
			json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "doc"}).Body).Decode(&doc)
			url := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10)
			if r := send(t, owner, "PUT", url+"/shares", map[string]string{"email": "ref-viewer@x.test", "role": "view"}); r.StatusCode != 200 {
				t.Fatal(r.StatusCode)
			}
			content := []byte("\x89PNG\r\n\x1a\nimage")
			if err := blobs.Put(ctx, "test/reference.png", "image/png", content); err != nil {
				t.Fatal(err)
			}
			file, err := st.CreateFile(ctx, store.FileMeta{DocID: doc.ID, Name: "reference.png", Mime: "image/png", Size: int64(len(content)), ObjectKey: "test/reference.png"})
			if err != nil {
				t.Fatal(err)
			}
			state, _, err := StateAtHead(ctx, st, doc.ID)
			if err != nil {
				t.Fatal(err)
			}
			created := state.CreateBlock(9, collab.Root, "W", "image")
			id := strconv.FormatInt(file.ID, 10)
			set := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 9, Clock: created.ID.Clock + 1}, Block: created.ID, Key: "fileId", Value: &id}
			var raws []store.RawOp
			for _, op := range []collab.Op{created, set} {
				encoded, err := collab.EncodeOps([]collab.Op{op})
				if err != nil {
					t.Fatal(err)
				}
				raws = append(raws, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: encoded})
			}
			if _, err := st.AppendOps(ctx, doc.ID, raws); err != nil {
				t.Fatal(err)
			}
			state, seq, err := StateAtHead(ctx, st, doc.ID)
			if err != nil {
				t.Fatal(err)
			}
			if err := st.SaveSnapshot(ctx, doc.ID, seq, state.EncodeState()); err != nil {
				t.Fatal(err)
			}
			if err := st.SaveVersion(ctx, doc.ID, seq, "version", doc.CreatorID); err != nil {
				t.Fatal(err)
			}
			if err := st.SetCopyProtected(ctx, doc.ID, true); err != nil {
				t.Fatal(err)
			}
			query := ""
			if kind == "version" {
				query = "?version=" + strconv.FormatInt(seq, 10)
			}
			st.active.Store(true)
			result, failure := make(chan *http.Response, 1), make(chan error, 1)
			go func() {
				r, err := viewer.Get(ts.URL + "/api/files/" + id + query)
				if err != nil {
					failure <- err
					return
				}
				result <- r
			}()
			select {
			case <-st.started:
			case <-time.After(5 * time.Second):
				t.Fatal("second image reference lookup did not start")
			}
			user, err := st.UserByEmail(ctx, "ref-viewer@x.test")
			if err != nil {
				t.Fatal(err)
			}
			if err := st.SetShare(ctx, doc.ID, user.ID, ""); err != nil {
				t.Fatal(err)
			}
			close(st.release)
			select {
			case err := <-failure:
				t.Fatal(err)
			case response := <-result:
				defer response.Body.Close()
				if response.StatusCode != http.StatusNotFound {
					t.Fatalf("revoked during %s read: %d", kind, response.StatusCode)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("file response did not finish")
			}
		})
	}
}
