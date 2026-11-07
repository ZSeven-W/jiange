package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func validCoverFixtures(t *testing.T) (jpegBytes, pngBytes, gifBytes []byte) {
	t.Helper()
	im := image.NewRGBA(image.Rect(0, 0, 8, 4))
	im.Set(1, 1, color.RGBA{R: 255, G: 123, A: 255})
	var b bytes.Buffer
	if err := jpeg.Encode(&b, im, nil); err != nil {
		t.Fatal(err)
	}
	jpegBytes = bytes.Clone(b.Bytes())
	b.Reset()
	if err := png.Encode(&b, im); err != nil {
		t.Fatal(err)
	}
	pngBytes = bytes.Clone(b.Bytes())
	b.Reset()
	pal := image.NewPaletted(image.Rect(0, 0, 2, 2), color.Palette{color.Black, color.White})
	if err := gif.EncodeAll(&b, &gif.GIF{Image: []*image.Paletted{pal, pal}, Delay: []int{1, 1}}); err != nil {
		t.Fatal(err)
	}
	gifBytes = bytes.Clone(b.Bytes())
	return
}

type revokeOnCoverSystemStore struct {
	store.Store
	once   sync.Once
	before func()
}

func (s *revokeOnCoverSystemStore) DocCoverSystem(ctx context.Context, doc int64) (store.DocCover, error) {
	cover, err := s.Store.DocCoverSystem(ctx, doc)
	if s.before != nil {
		s.once.Do(s.before)
	}
	return cover, err
}

func TestPublicDocumentRechecksLinkAfterCoverRead(t *testing.T) {
	ctx := context.Background()
	base := store.NewMemory()
	wrapped := &revokeOnCoverSystemStore{Store: base}
	ts, owner := newTestServer(t, wrapped, nil)
	r := post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "cover-snapshot@example.test", "name": "Owner", "password": "password123"})
	r.Body.Close()
	var doc store.DocMeta
	r = post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "Cover public"})
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if _, err := base.ChangeLinkRole(ctx, doc.ID, "anon", "synthetic-snapshot-cover"); err != nil {
		t.Fatal(err)
	}
	publicURL := ts.URL + "/api/public/synthetic-snapshot-cover"
	r = send(t, &http.Client{}, "GET", publicURL, nil)
	var got struct {
		Cover store.DocCover `json:"cover"`
	}
	if r.StatusCode != http.StatusOK {
		t.Fatal(r.StatusCode)
	}
	if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if got.Cover.Kind != "none" || got.Cover.Revision != 0 {
		t.Fatalf("public cover: %+v", got.Cover)
	}
	wrapped.before = func() { _, _ = base.ChangeLinkRole(ctx, doc.ID, "none", "") }
	r = send(t, &http.Client{}, "GET", publicURL, nil)
	defer r.Body.Close()
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("revoked while reading cover: %d", r.StatusCode)
	}
}

func TestPublicDocumentRechecksPolicyAfterCoverRead(t *testing.T) {
	ctx := context.Background()
	base := store.NewMemory()
	wrapped := &revokeOnCoverSystemStore{Store: base}
	ts, owner := newTestServer(t, wrapped, nil)
	r := post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "cover-policy@example.test", "name": "Owner", "password": "password123"})
	r.Body.Close()
	var doc store.DocMeta
	r = post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "Cover policy"})
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if _, err := base.ChangeLinkRole(ctx, doc.ID, "anon", "synthetic-cover-policy"); err != nil {
		t.Fatal(err)
	}
	wrapped.before = func() { _ = base.SetCopyProtected(ctx, doc.ID, true) }
	r = send(t, &http.Client{}, "GET", ts.URL+"/api/public/synthetic-cover-policy", nil)
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatal(r.StatusCode)
	}
	var result struct {
		CopyProtected   bool   `json:"copyProtected"`
		CopyMinRole     string `json:"copyMinRole"`
		DownloadMinRole string `json:"downloadMinRole"`
	}
	if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if !result.CopyProtected || result.CopyMinRole != "manage" || result.DownloadMinRole != "manage" {
		t.Fatalf("stale policy after cover read: %+v", result)
	}
}

func TestCoverRasterValidation(t *testing.T) {
	jpg, pngData, gifData := validCoverFixtures(t)
	for _, tc := range []struct {
		name, mime string
		body       []byte
		valid      bool
	}{
		{"jpeg", "image/jpeg", jpg, true},
		{"png", "image/png", pngData, true},
		{"animated gif", "image/gif", gifData, true},
		{"declared mime mismatch", "image/png", jpg, false},
		{"svg disguised as png", "image/png", []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`), false},
		{"truncated png", "image/png", pngData[:len(pngData)-8], false},
		{"truncated gif", "image/gif", gifData[:len(gifData)-1], false},
		{"empty", "image/png", nil, false},
		{"too large", "image/png", make([]byte, maxCoverBytes+1), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := validateCoverImage(tc.body, tc.mime) == nil; got != tc.valid {
				t.Fatalf("valid=%v want %v", got, tc.valid)
			}
		})
	}
	wide := image.NewRGBA(image.Rect(0, 0, maxCoverDimension+1, 1))
	var b bytes.Buffer
	if err := png.Encode(&b, wide); err != nil {
		t.Fatal(err)
	}
	if err := validateCoverImage(b.Bytes(), "image/png"); err == nil {
		t.Fatal("oversized dimension accepted")
	}
}

func TestCoverGIFFrameBudgetBeforeDecode(t *testing.T) {
	pal := image.NewPaletted(image.Rect(0, 0, 1, 1), color.Palette{color.Black, color.White})
	animation := &gif.GIF{}
	for i := 0; i < maxCoverGIFFrames+1; i++ {
		animation.Image = append(animation.Image, pal)
		animation.Delay = append(animation.Delay, 1)
	}
	var b bytes.Buffer
	if err := gif.EncodeAll(&b, animation); err != nil {
		t.Fatal(err)
	}
	if err := validateCoverImage(b.Bytes(), "image/gif"); err == nil {
		t.Fatal("frame budget not enforced")
	}
}

func TestCoverPreviewRevisionIsRequired(t *testing.T) {
	for _, tc := range []struct {
		query    string
		revision int64
		valid    bool
	}{
		{"?revision=0", 0, true}, {"?revision=17", 17, true}, {"", 0, false},
		{"?revision=-1", 0, false}, {"?revision=1&revision=2", 0, false},
		{"?revision=9007199254740992", 0, false}, {"?revision=" + strings.Repeat("9", 30), 0, false},
	} {
		r := httptest.NewRequest("GET", "/cover/image"+tc.query, nil)
		n, ok := requestedCoverRevision(r)
		if ok != tc.valid || ok && n != tc.revision {
			t.Fatalf("query %q: %d %v", tc.query, n, ok)
		}
	}
}

type pausingCoverBlob struct {
	blob.Store
	active  atomic.Bool
	started chan struct{}
	release chan struct{}
}

func (b *pausingCoverBlob) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	if b.active.CompareAndSwap(true, false) {
		close(b.started)
		select {
		case <-b.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return b.Store.Get(ctx, key)
}

func TestCoverImagePreviewAccessAndRevocation(t *testing.T) {
	for _, mutation := range []string{"cover", "permission", "session", "bytes", "anonymous-link"} {
		t.Run(mutation, func(t *testing.T) {
			ctx := context.Background()
			st := store.NewMemory()
			baseBlob := blob.NewMemory()
			gate := &pausingCoverBlob{Store: baseBlob, started: make(chan struct{}), release: make(chan struct{})}
			s := &Server{Store: st, Blobs: gate, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
			ts := httptest.NewServer(s.Handler())
			defer ts.Close()
			client := func() *http.Client { jar, _ := cookiejar.New(nil); return &http.Client{Jar: jar} }
			owner, viewer, outsider := client(), client(), client()
			for _, u := range []struct {
				client *http.Client
				email  string
			}{{owner, "cover-owner@example.test"}, {viewer, "cover-viewer@example.test"}, {outsider, "cover-other@example.test"}} {
				r := post(t, u.client, ts.URL+"/api/auth/register", map[string]string{"email": u.email, "name": "Test", "password": "password123"})
				r.Body.Close()
				if r.StatusCode != http.StatusCreated {
					t.Fatal(r.StatusCode)
				}
			}
			var doc store.DocMeta
			r := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "Cover preview"})
			if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
				t.Fatal(err)
			}
			r.Body.Close()
			url := fmt.Sprintf("%s/api/docs/%d", ts.URL, doc.ID)
			r = send(t, owner, "PUT", url+"/shares", map[string]string{"email": "cover-viewer@example.test", "role": "view"})
			r.Body.Close()
			if r.StatusCode != http.StatusOK {
				t.Fatal(r.StatusCode)
			}
			_, pngData, _ := validCoverFixtures(t)
			if err := baseBlob.Put(ctx, "cover/test", "image/png", pngData); err != nil {
				t.Fatal(err)
			}
			file, err := st.CreateFile(ctx, store.FileMeta{DocID: doc.ID, Name: "cover.png", Mime: "image/png", Size: int64(len(pngData)), ObjectKey: "cover/test"})
			if err != nil {
				t.Fatal(err)
			}
			r = send(t, owner, "PUT", url+"/cover", map[string]any{"kind": "file", "fileId": file.ID, "position": 0.5, "expectedRevision": 0})
			r.Body.Close()
			if r.StatusCode != http.StatusOK {
				t.Fatalf("bind cover: %d", r.StatusCode)
			}
			for _, check := range []struct {
				c      *http.Client
				target string
				want   int
			}{{viewer, url + "/cover/image?revision=1", http.StatusOK}, {viewer, url + "/cover/image?revision=0", http.StatusNotFound}, {outsider, url + "/cover/image?revision=1", http.StatusNotFound}} {
				r, err = check.c.Get(check.target)
				if err != nil {
					t.Fatal(err)
				}
				r.Body.Close()
				if r.StatusCode != check.want {
					t.Fatalf("preview: got %d want %d", r.StatusCode, check.want)
				}
				if check.want == http.StatusOK && (r.Header.Get("Content-Type") != "image/png" || r.Header.Get("Cache-Control") != "private, no-store" || r.Header.Get("X-Content-Type-Options") != "nosniff") {
					t.Fatalf("preview headers: %v", r.Header)
				}
			}
			previewURL := url + "/cover/image?revision=1"
			who := viewer
			if mutation == "anonymous-link" {
				if _, err := st.ChangeLinkRole(ctx, doc.ID, "anon", "synthetic-cover-token"); err != nil {
					t.Fatal(err)
				}
				previewURL, who = ts.URL+"/api/public/synthetic-cover-token/cover/image?revision=1", client()
				r, err = who.Get(previewURL)
				if err != nil {
					t.Fatal(err)
				}
				r.Body.Close()
				if r.StatusCode != http.StatusOK {
					t.Fatalf("anonymous preview: %d", r.StatusCode)
				}
			}
			gate.active.Store(true)
			result := make(chan *http.Response, 1)
			failure := make(chan error, 1)
			go func() {
				r, err := who.Get(previewURL)
				if err != nil {
					failure <- err
				} else {
					result <- r
				}
			}()
			select {
			case <-gate.started:
			case <-time.After(5 * time.Second):
				t.Fatal("preview did not open blob")
			}
			switch mutation {
			case "cover":
				r := send(t, owner, "PUT", url+"/cover", map[string]any{"kind": "none", "position": 0.5, "expectedRevision": 1})
				r.Body.Close()
				if r.StatusCode != http.StatusOK {
					t.Fatal(r.StatusCode)
				}
			case "permission":
				u, err := st.UserByEmail(ctx, "cover-viewer@example.test")
				if err != nil {
					t.Fatal(err)
				}
				if err := st.SetShare(ctx, doc.ID, u.ID, ""); err != nil {
					t.Fatal(err)
				}
			case "session":
				r := post(t, viewer, ts.URL+"/api/auth/logout", nil)
				r.Body.Close()
				if r.StatusCode != http.StatusNoContent {
					t.Fatalf("logout: %d", r.StatusCode)
				}
			case "bytes":
				if err := baseBlob.Put(ctx, "cover/test", "image/png", bytes.Repeat([]byte{'x'}, len(pngData))); err != nil {
					t.Fatal(err)
				}
			case "anonymous-link":
				if _, err := st.ChangeLinkRole(ctx, doc.ID, "none", ""); err != nil {
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
					t.Fatalf("%s while blob open: %d", mutation, r.StatusCode)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("preview did not finish")
			}
		})
	}
}

// Verify the global decode budget through actual HTTP handlers, rather than
// only testing the semaphore helper. Both bind and preview share the budget.
type budgetPausingCoverBlob struct {
	blob.Store
	active  atomic.Bool
	started chan struct{}
	release chan struct{}
}

func (b *budgetPausingCoverBlob) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	if b.active.Load() {
		select {
		case b.started <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		select {
		case <-b.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return b.Store.Get(ctx, key)
}

func TestCoverDecodeBudgetAcrossPreviewAndBind(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	baseBlob := blob.NewMemory()
	gate := &budgetPausingCoverBlob{Store: baseBlob, started: make(chan struct{}, 2), release: make(chan struct{})}
	var releaseOnce sync.Once
	release := func() { gate.active.Store(false); releaseOnce.Do(func() { close(gate.release) }) }
	t.Cleanup(release)
	s := &Server{Store: st, Blobs: gate, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	defer release()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 5 * time.Second}
	r := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "cover-budget@example.test", "name": "Owner", "password": "password123"})
	r.Body.Close()
	if r.StatusCode != http.StatusCreated {
		t.Fatal(r.StatusCode)
	}
	var doc store.DocMeta
	r = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "Cover budget"})
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	_, pngData, _ := validCoverFixtures(t)
	if err := baseBlob.Put(ctx, "cover/budget", "image/png", pngData); err != nil {
		t.Fatal(err)
	}
	file, err := st.CreateFile(ctx, store.FileMeta{DocID: doc.ID, Name: "cover.png", Mime: "image/png", Size: int64(len(pngData)), ObjectKey: "cover/budget"})
	if err != nil {
		t.Fatal(err)
	}
	url := fmt.Sprintf("%s/api/docs/%d/cover", ts.URL, doc.ID)
	body := map[string]any{"kind": "file", "fileId": file.ID, "position": 0.5, "expectedRevision": 0}
	r = send(t, client, "PUT", url, body)
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("initial bind: %d", r.StatusCode)
	}
	gate.active.Store(true)
	type outcome struct {
		status int
		err    error
	}
	results := make(chan outcome, 2)
	for i := 0; i < 2; i++ {
		go func() {
			response, err := client.Get(url + "/image?revision=1")
			if err != nil {
				results <- outcome{err: err}
				return
			}
			response.Body.Close()
			results <- outcome{status: response.StatusCode}
		}()
	}
	for i := 0; i < 2; i++ {
		select {
		case <-gate.started:
		case <-time.After(5 * time.Second):
			t.Fatal("two previews did not reach blob storage")
		}
	}
	r, err = client.Get(url + "/image?revision=1")
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("third preview: %d", r.StatusCode)
	}
	body["expectedRevision"] = 1
	r = send(t, client, "PUT", url, body)
	r.Body.Close()
	if r.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("bind while busy: %d", r.StatusCode)
	}
	release()
	for i := 0; i < 2; i++ {
		select {
		case got := <-results:
			if got.err != nil || got.status != http.StatusOK {
				t.Fatalf("released preview: %+v", got)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("released preview did not finish")
		}
	}
	r, err = client.Get(url + "/image?revision=1")
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("preview after release: %d", r.StatusCode)
	}
}
