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
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newDocReactionsTestServer(t *testing.T, st store.Store, now func() time.Time) (*httptest.Server, *http.Client) {
	t.Helper()
	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
		Now:        now,
	}
	base := s.Handler()
	mux := http.NewServeMux()
	mux.Handle("GET /api/docs/{id}/reactions", s.requireUser(http.HandlerFunc(s.getDocReactions)))
	mux.Handle("POST /api/docs/{id}/reactions", httpx.RequireJSON(s.requireUser(http.HandlerFunc(s.toggleDocReaction))))
	mux.Handle("/", base)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	return ts, &http.Client{Jar: jar}
}

func newClientWithJar(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Jar: jar}
}

func decodeReactions(t *testing.T, res *http.Response) store.DocReactionsSnapshot {
	t.Helper()
	defer res.Body.Close()
	var snap store.DocReactionsSnapshot
	if err := json.NewDecoder(res.Body).Decode(&snap); err != nil {
		t.Fatalf("decode reactions snapshot: %v", err)
	}
	return snap
}

func TestDocReactionsHTTP(t *testing.T) {
	mem := store.NewMemory()
	curTime := time.Now()
	ts, owner := newDocReactionsTestServer(t, mem, func() time.Time { return curTime })

	// Register three users: owner, viewer, outsider.
	var ownerMe, viewerMe, outsiderMe meResponse
	res := post(t, owner, ts.URL+"/api/auth/register", map[string]string{
		"email": "doc-rx-owner@example.test", "name": "Owner", "password": "password123",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register owner: %d", res.StatusCode)
	}
	_ = json.NewDecoder(res.Body).Decode(&ownerMe)
	res.Body.Close()

	viewer := newClientWithJar(t)
	res = post(t, viewer, ts.URL+"/api/auth/register", map[string]string{
		"email": "doc-rx-viewer@example.test", "name": "Viewer", "password": "password123",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register viewer: %d", res.StatusCode)
	}
	_ = json.NewDecoder(res.Body).Decode(&viewerMe)
	res.Body.Close()

	outsider := newClientWithJar(t)
	res = post(t, outsider, ts.URL+"/api/auth/register", map[string]string{
		"email": "doc-rx-outsider@example.test", "name": "Outsider", "password": "password123",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register outsider: %d", res.StatusCode)
	}
	_ = json.NewDecoder(res.Body).Decode(&outsiderMe)
	res.Body.Close()

	// Create document owned by owner.
	var doc store.DocMeta
	res = post(t, owner, ts.URL+"/api/docs", map[string]any{"title": "Reaction Spec"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create doc: %d", res.StatusCode)
	}
	_ = json.NewDecoder(res.Body).Decode(&doc)
	res.Body.Close()

	rpath := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10) + "/reactions"
	vpath := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10) + "/visit"

	// Unauthenticated request -> 401.
	anon := newClientWithJar(t)
	if res := send(t, anon, "GET", rpath, nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anon GET status=%d", res.StatusCode)
	}
	if res := send(t, anon, "POST", rpath, map[string]any{"emoji": "👍"}); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anon POST status=%d", res.StatusCode)
	}

	// Initial GET: empty reactions, viewerCount=1, Cache-Control: no-store.
	res = send(t, owner, "GET", rpath, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("owner GET status=%d", res.StatusCode)
	}
	if got := res.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control=%q, want no-store", got)
	}
	snap := decodeReactions(t, res)
	if len(snap.Reactions) != 0 || snap.ViewerCount != 1 {
		t.Fatalf("initial snap=%+v", snap)
	}

	// Unauthorized outsider -> 403 on GET and POST.
	if res := send(t, outsider, "GET", rpath, nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("outsider GET status=%d, want 403", res.StatusCode)
	}
	if res := send(t, outsider, "POST", rpath, map[string]any{"emoji": "👍"}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("outsider POST status=%d, want 403", res.StatusCode)
	}

	// Missing / invalid doc ID -> 404.
	if res := send(t, owner, "GET", ts.URL+"/api/docs/999999/reactions", nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("missing doc GET status=%d, want 404", res.StatusCode)
	}
	if res := send(t, owner, "GET", ts.URL+"/api/docs/not-an-id/reactions", nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("bad id GET status=%d, want 404", res.StatusCode)
	}
	if res := send(t, owner, "POST", ts.URL+"/api/docs/999999/reactions", map[string]any{"emoji": "👍"}); res.StatusCode != http.StatusNotFound {
		t.Fatalf("missing doc POST status=%d, want 404", res.StatusCode)
	}

	// Invalid emojis -> 400.
	for _, bad := range []string{"", "thumbsup", "💀"} {
		res := send(t, owner, "POST", rpath, map[string]any{"emoji": bad})
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("bad emoji %q status=%d, want 400", bad, res.StatusCode)
		}
		res.Body.Close()
	}

	// Grant viewer read access.
	if err := mem.SetShare(context.Background(), doc.ID, viewerMe.User.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}

	// Visit tracking: repeated visits by owner stay 1; viewer visit increments to 2.
	if res := send(t, owner, "POST", vpath, map[string]any{}); res.StatusCode != http.StatusNoContent {
		t.Fatalf("owner visit 1 status=%d", res.StatusCode)
	}
	if res := send(t, owner, "POST", vpath, map[string]any{}); res.StatusCode != http.StatusNoContent {
		t.Fatalf("owner visit 2 status=%d", res.StatusCode)
	}
	res = send(t, owner, "GET", rpath, nil)
	snap = decodeReactions(t, res)
	if snap.ViewerCount != 1 {
		t.Fatalf("expected viewerCount=1 after repeated owner visits, got %d", snap.ViewerCount)
	}
	if res := send(t, viewer, "POST", vpath, map[string]any{}); res.StatusCode != http.StatusNoContent {
		t.Fatalf("viewer visit status=%d", res.StatusCode)
	}
	res = send(t, viewer, "GET", rpath, nil)
	snap = decodeReactions(t, res)
	if snap.ViewerCount != 2 {
		t.Fatalf("expected viewerCount=2 after distinct visits, got %d", snap.ViewerCount)
	}

	// Multi-user reactions aggregate cleanly and respect palette order.
	res = send(t, viewer, "POST", rpath, map[string]any{"emoji": "🎉"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("viewer toggle 🎉 status=%d", res.StatusCode)
	}
	snap = decodeReactions(t, res)
	if len(snap.Reactions) != 1 || snap.Reactions[0] != (store.DocReactionItem{Emoji: "🎉", Count: 1, Reacted: true}) || snap.ViewerCount != 2 {
		t.Fatalf("after viewer 🎉: %+v", snap)
	}

	res = send(t, owner, "POST", rpath, map[string]any{"emoji": "👍"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("owner toggle 👍 status=%d", res.StatusCode)
	}
	snap = decodeReactions(t, res)
	if len(snap.Reactions) != 2 ||
		snap.Reactions[0] != (store.DocReactionItem{Emoji: "👍", Count: 1, Reacted: true}) ||
		snap.Reactions[1] != (store.DocReactionItem{Emoji: "🎉", Count: 1, Reacted: false}) {
		t.Fatalf("after owner 👍: %+v", snap.Reactions)
	}

	// Viewer also likes 👍 with explicit on=true; count aggregates to 2.
	res = send(t, viewer, "POST", rpath, map[string]any{"emoji": "👍", "on": true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("viewer explicit on=true status=%d", res.StatusCode)
	}
	snap = decodeReactions(t, res)
	if len(snap.Reactions) != 2 ||
		snap.Reactions[0] != (store.DocReactionItem{Emoji: "👍", Count: 2, Reacted: true}) ||
		snap.Reactions[1] != (store.DocReactionItem{Emoji: "🎉", Count: 1, Reacted: true}) {
		t.Fatalf("after viewer 👍: %+v", snap.Reactions)
	}

	// Owner removes 👍 with explicit on=false -> count drops to 1, owner reacted=false.
	res = send(t, owner, "POST", rpath, map[string]any{"emoji": "👍", "on": false})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("owner explicit on=false status=%d", res.StatusCode)
	}
	snap = decodeReactions(t, res)
	if snap.Reactions[0] != (store.DocReactionItem{Emoji: "👍", Count: 1, Reacted: false}) {
		t.Fatalf("after owner remove 👍: %+v", snap.Reactions)
	}

	// Viewer toggles 🎉 off with on=null -> zero-count bucket disappears.
	res = send(t, viewer, "POST", rpath, map[string]any{"emoji": "🎉", "on": nil})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("viewer toggle off 🎉 status=%d", res.StatusCode)
	}
	snap = decodeReactions(t, res)
	if len(snap.Reactions) != 1 || snap.Reactions[0] != (store.DocReactionItem{Emoji: "👍", Count: 1, Reacted: true}) {
		t.Fatalf("after viewer toggle off 🎉: %+v", snap.Reactions)
	}

	// Revoking viewer's share causes 403.
	if err := mem.SetShare(context.Background(), doc.ID, viewerMe.User.ID, ""); err != nil {
		t.Fatal(err)
	}
	if res := send(t, viewer, "GET", rpath, nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("revoked viewer GET status=%d, want 403", res.StatusCode)
	}
	if res := send(t, viewer, "POST", rpath, map[string]any{"emoji": "👍"}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("revoked viewer POST status=%d, want 403", res.StatusCode)
	}

	// Trashing doc causes 404 even for owner.
	if err := mem.Trash(context.Background(), doc.ID); err != nil {
		t.Fatal(err)
	}
	if res := send(t, owner, "GET", rpath, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("trashed doc GET status=%d, want 404", res.StatusCode)
	}
	if res := send(t, owner, "POST", rpath, map[string]any{"emoji": "👍"}); res.StatusCode != http.StatusNotFound {
		t.Fatalf("trashed doc POST status=%d, want 404", res.StatusCode)
	}

	// Expired session fails with 401.
	curTime = curTime.Add(2 * time.Hour)
	if res := send(t, owner, "GET", rpath, nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expired session GET status=%d, want 401", res.StatusCode)
	}
	if res := send(t, owner, "POST", rpath, map[string]any{"emoji": "👍"}); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expired session POST status=%d, want 401", res.StatusCode)
	}
}
