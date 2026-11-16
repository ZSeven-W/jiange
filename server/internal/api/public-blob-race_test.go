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

type blockingPublicMetaStore struct {
	store.Store
	active  atomic.Bool
	calls   atomic.Int32
	started chan struct{}
	release chan struct{}
}

func (s *blockingPublicMetaStore) GetDocSystem(ctx context.Context, doc int64) (store.DocMeta, error) {
	meta, err := s.Store.GetDocSystem(ctx, doc)
	// The first authorization reads metadata twice; block the first read
	// following Blob.Get, after the backing store has returned its value.
	if s.active.Load() && s.calls.Add(1) == 3 {
		close(s.started)
		select {
		case <-s.release:
		case <-ctx.Done():
			return store.DocMeta{}, ctx.Err()
		}
	}
	return meta, err
}

func TestPublicFileRechecksAfterBlobOpen(t *testing.T) {
	for _, change := range []string{"protection", "revocation", "removed_block", "meta_protection", "meta_revocation"} {
		t.Run(change, func(t *testing.T) {
			ctx := context.Background()
			st := &blockingPublicMetaStore{Store: store.NewMemory(), started: make(chan struct{}), release: make(chan struct{})}
			data := blob.NewMemory()
			gate := &blockingFileBlob{Store: data, started: make(chan struct{}), release: make(chan struct{})}
			s := &Server{Store: st, Blobs: gate, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
			ts := httptest.NewServer(s.Handler())
			defer ts.Close()
			jar, _ := cookiejar.New(nil)
			owner, guest := &http.Client{Jar: jar}, &http.Client{}
			post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "owner-public-blob@x.test", "name": "Owner", "password": "password123"})
			var doc store.DocMeta
			json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "doc"}).Body).Decode(&doc)
			if err := data.Put(ctx, "test/public.pdf", "application/pdf", []byte("secret")); err != nil {
				t.Fatal(err)
			}
			file, err := st.CreateFile(ctx, store.FileMeta{DocID: doc.ID, Name: "public.pdf", Mime: "application/pdf", Size: 6, ObjectKey: "test/public.pdf"})
			if err != nil {
				t.Fatal(err)
			}
			state, _, err := StateAtHead(ctx, st, doc.ID)
			if err != nil {
				t.Fatal(err)
			}
			create := state.CreateBlock(9, collab.Root, "W", "file")
			id := strconv.FormatInt(file.ID, 10)
			set := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 9, Clock: create.ID.Clock + 1}, Block: create.ID, Key: "fileId", Value: &id}
			appendOps := func(ops ...collab.Op) {
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
			appendOps(create, set)
			url := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10)
			var link store.Link
			json.NewDecoder(send(t, owner, "PUT", url+"/link", map[string]string{"role": "anon"}).Body).Decode(&link)
			if change == "meta_protection" || change == "meta_revocation" {
				st.active.Store(true)
				close(gate.release)
			}
			result, failure := make(chan *http.Response, 1), make(chan error, 1)
			go func() {
				r, err := guest.Get(ts.URL + "/api/public/" + link.Token + "/files/" + id)
				if err != nil {
					failure <- err
					return
				}
				result <- r
			}()
			if change == "meta_protection" || change == "meta_revocation" {
				select {
				case <-st.started:
				case <-time.After(5 * time.Second):
					t.Fatal("metadata read did not start")
				}
			} else {
				select {
				case <-gate.started:
				case <-time.After(5 * time.Second):
					t.Fatal("blob access did not start")
				}
			}
			switch change {
			case "protection", "meta_protection":
				if err := st.SetCopyProtected(ctx, doc.ID, true); err != nil {
					t.Fatal(err)
				}
			case "revocation", "meta_revocation":
				if err := st.SetLink(ctx, doc.ID, store.Link{Role: "none"}); err != nil {
					t.Fatal(err)
				}
			case "removed_block":
				appendOps(collab.Op{T: collab.TBlockDelete, ID: collab.OpID{Client: 9, Clock: set.ID.Clock + 1}, Block: create.ID})
			}
			if change == "meta_protection" || change == "meta_revocation" {
				close(st.release)
			} else {
				close(gate.release)
			}
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
