package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestDocumentCoverAPI(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	blobs := blob.NewMemory()
	s := &Server{Store: st, Blobs: blobs, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	client := func() *http.Client { jar, _ := cookiejar.New(nil); return &http.Client{Jar: jar} }
	owner, viewer := client(), client()
	for _, u := range []struct {
		c     *http.Client
		email string
	}{{owner, "cover-api-owner@example.test"}, {viewer, "cover-api-viewer@example.test"}} {
		r := post(t, u.c, ts.URL+"/api/auth/register", map[string]string{"email": u.email, "name": "Test", "password": "password123"})
		r.Body.Close()
		if r.StatusCode != http.StatusCreated {
			t.Fatal(r.StatusCode)
		}
	}
	var doc store.DocMeta
	r := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "Cover test"})
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	base := fmt.Sprintf("%s/api/docs/%d", ts.URL, doc.ID)
	r = send(t, owner, "PUT", base+"/shares", map[string]string{"email": "cover-api-viewer@example.test", "role": "view"})
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatal(r.StatusCode)
	}
	put := func(c *http.Client, v map[string]any, want int) store.DocCover {
		t.Helper()
		r := send(t, c, "PUT", base+"/cover", v)
		defer r.Body.Close()
		if r.StatusCode != want {
			t.Fatalf("PUT got %d want %d", r.StatusCode, want)
		}
		var result store.DocCover
		if want == http.StatusOK {
			if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
				t.Fatal(err)
			}
		}
		return result
	}
	put(viewer, map[string]any{"kind": "builtin", "asset": "misty-lake", "position": 0.5, "expectedRevision": 0}, http.StatusForbidden)
	put(owner, map[string]any{"kind": "builtin", "asset": "unknown", "position": 0.5, "expectedRevision": 0}, http.StatusBadRequest)
	put(owner, map[string]any{"kind": "builtin", "asset": "misty-lake", "position": 0.5}, http.StatusBadRequest)
	c := put(owner, map[string]any{"kind": "builtin", "asset": "misty-lake", "position": 0.3, "expectedRevision": 0}, http.StatusOK)
	if c.Revision != 1 || c.Asset != "misty-lake" || c.Position != 0.3 {
		t.Fatalf("cover %+v", c)
	}
	put(owner, map[string]any{"kind": "none", "position": 0.5, "expectedRevision": 0}, http.StatusConflict)
	_, pngData, _ := validCoverFixtures(t)
	if err := blobs.Put(ctx, "cover-valid", "image/png", pngData); err != nil {
		t.Fatal(err)
	}
	file, err := st.CreateFile(ctx, store.FileMeta{DocID: doc.ID, Name: "cover.png", Mime: "image/png", ObjectKey: "cover-valid", Size: int64(len(pngData))})
	if err != nil {
		t.Fatal(err)
	}
	c = put(owner, map[string]any{"kind": "file", "fileId": file.ID, "position": 0.7, "expectedRevision": 1}, http.StatusOK)
	if c.FileID != file.ID || c.Revision != 2 {
		t.Fatalf("cover %+v", c)
	}
	if err := blobs.Put(ctx, "cover-bad", "image/png", []byte("not an image")); err != nil {
		t.Fatal(err)
	}
	bad, err := st.CreateFile(ctx, store.FileMeta{DocID: doc.ID, Name: "bad.png", Mime: "image/png", ObjectKey: "cover-bad", Size: int64(len("not an image"))})
	if err != nil {
		t.Fatal(err)
	}
	put(owner, map[string]any{"kind": "file", "fileId": bad.ID, "position": 0.5, "expectedRevision": 2}, http.StatusBadRequest)
	put(owner, map[string]any{"kind": "none", "position": 0.5, "expectedRevision": 2}, http.StatusOK)
	r = send(t, viewer, "GET", base+"/cover", nil)
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatal(r.StatusCode)
	}
	var latest store.DocCover
	if err := json.NewDecoder(r.Body).Decode(&latest); err != nil || latest.Kind != "none" || latest.Revision != 3 {
		t.Fatalf("latest %+v %v", latest, err)
	}
}
