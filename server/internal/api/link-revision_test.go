package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestLinkRevisionGuardedAPI(t *testing.T) {
	e := newCopyTestEnv(t)
	ctx := context.Background()
	if err := e.store.SetShare(ctx, e.source.ID, e.guestUser.ID, store.RoleManage); err != nil {
		t.Fatal(err)
	}
	read := func(c *http.Client) store.Link {
		t.Helper()
		r, err := c.Get(e.url() + "/shares")
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		var out struct {
			Link store.Link `json:"link"`
		}
		if err = json.NewDecoder(r.Body).Decode(&out); err != nil || r.StatusCode != 200 {
			t.Fatalf("read %d %v", r.StatusCode, err)
		}
		return out.Link
	}
	accountRead := func(uid int64) int {
		req, _ := http.NewRequest("GET", e.url()+"/shares-account", nil)
		if uid > 0 {
			req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(uid, 10))
		}
		r, err := e.owner.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		return r.StatusCode
	}
	if code := accountRead(0); code != 400 {
		t.Fatalf("missing account on read: %d", code)
	}
	if code := accountRead(e.guestUser.ID); code != 401 {
		t.Fatalf("wrong account on read: %d", code)
	}
	if code := accountRead(e.ownerUser.ID); code != 200 {
		t.Fatalf("bound read: %d", code)
	}
	write := func(c *http.Client, uid int64, role string, revision any) int {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"role": role, "expectedRevision": revision})
		req, _ := http.NewRequest("PUT", e.url()+"/link-guarded", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if uid > 0 {
			req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(uid, 10))
		}
		r, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		io.Copy(io.Discard, r.Body)
		return r.StatusCode
	}
	a, b := read(e.owner), read(e.guest)
	if a.Revision != 0 || b.Revision != 0 {
		t.Fatalf("initial: %+v %+v", a, b)
	}
	if code := write(e.owner, 0, "view", 0); code != 400 {
		t.Fatalf("missing account: %d", code)
	}
	if code := write(e.owner, e.guestUser.ID, "view", 0); code != 401 {
		t.Fatalf("wrong account: %d", code)
	}
	if code := write(e.owner, e.ownerUser.ID, "view", nil); code != 400 {
		t.Fatalf("missing revision: %d", code)
	}
	if code := write(e.owner, e.ownerUser.ID, "view", a.Revision); code != 200 {
		t.Fatalf("first update: %d", code)
	}
	if code := write(e.guest, e.guestUser.ID, "edit", b.Revision); code != 409 {
		t.Fatalf("stale update: %d", code)
	}
	current := read(e.owner)
	if current.Role != "view" || current.Revision != 1 || current.Token == "" {
		t.Fatalf("stale update changed link: %+v", current)
	}
	// Legacy writers also advance the fence, including an ABA role cycle.
	for _, role := range []string{"none", "view"} {
		r := send(t, e.owner, "PUT", e.url()+"/link", map[string]any{"role": role})
		if r.StatusCode != 200 {
			t.Fatalf("legacy %s: %d", role, r.StatusCode)
		}
		r.Body.Close()
	}
	if code := write(e.guest, e.guestUser.ID, "edit", current.Revision); code != 409 {
		t.Fatalf("ABA update: %d", code)
	}
	current = read(e.owner)
	if current.Role != "view" || current.Revision != 3 {
		t.Fatalf("ABA state: %+v", current)
	}
	if err := e.store.SetShare(ctx, e.source.ID, e.guestUser.ID, ""); err != nil {
		t.Fatal(err)
	}
	if code := write(e.guest, e.guestUser.ID, "none", current.Revision); code != 403 && code != 404 {
		t.Fatalf("revoked manager: %d", code)
	}
}

type revokeDuringLinkRead struct {
	store.Store
	once   sync.Once
	revoke func()
}

type revokeBeforeRevisionWrite struct {
	store.Store
	before func()
}

func (s *revokeBeforeRevisionWrite) ChangeLinkRoleAtRevision(ctx context.Context, g store.RestoreGuard, doc int64, role, candidate string, revision int64) (store.Link, error) {
	s.before()
	return s.Store.(revisionLinkStore).ChangeLinkRoleAtRevision(ctx, g, doc, role, candidate, revision)
}

func TestLinkRevisionRechecksAccessInsideWrite(t *testing.T) {
	e := newCopyTestEnv(t)
	ctx := context.Background()
	if err := e.store.SetShare(ctx, e.source.ID, e.guestUser.ID, store.RoleManage); err != nil {
		t.Fatal(err)
	}
	wrapper := &revokeBeforeRevisionWrite{Store: e.store, before: func() {
		if err := e.store.SetShare(ctx, e.source.ID, e.guestUser.ID, ""); err != nil {
			t.Error(err)
		}
	}}
	ts := httptest.NewServer((&Server{Store: wrapper, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}).Handler())
	defer ts.Close()
	req, _ := http.NewRequest("PUT", ts.URL+"/api/docs/"+strconv.FormatInt(e.source.ID, 10)+"/link-guarded", bytes.NewBufferString(`{"role":"view","expectedRevision":0}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(e.guestUser.ID, 10))
	r, err := e.guest.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != 403 {
		t.Fatalf("revoked manager write: %d", r.StatusCode)
	}
	link, err := e.store.GetLink(ctx, e.source.ID)
	if err != nil || link.Role != "none" || link.Revision != 0 {
		t.Fatalf("revoked write changed link: %+v %v", link, err)
	}
}

func (s *revokeDuringLinkRead) GetLink(ctx context.Context, id int64) (store.Link, error) {
	link, err := s.Store.GetLink(ctx, id)
	s.once.Do(s.revoke)
	return link, err
}

func TestAccountSharesReadRechecksRevocation(t *testing.T) {
	e := newCopyTestEnv(t)
	ctx := context.Background()
	if err := e.store.SetShare(ctx, e.source.ID, e.guestUser.ID, store.RoleManage); err != nil {
		t.Fatal(err)
	}
	if err := e.store.SetLink(ctx, e.source.ID, store.Link{Role: "view", Token: "private-link-token"}); err != nil {
		t.Fatal(err)
	}
	wrapper := &revokeDuringLinkRead{Store: e.store, revoke: func() {
		if err := e.store.SetShare(ctx, e.source.ID, e.guestUser.ID, ""); err != nil {
			t.Error(err)
		}
	}}
	ts := httptest.NewServer((&Server{Store: wrapper, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}).Handler())
	defer ts.Close()
	req, _ := http.NewRequest("GET", ts.URL+"/api/docs/"+strconv.FormatInt(e.source.ID, 10)+"/shares-account", nil)
	req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(e.guestUser.ID, 10))
	r, err := e.guest.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	body, _ := io.ReadAll(r.Body)
	if r.StatusCode != 404 || bytes.Contains(body, []byte("private-link-token")) {
		t.Fatalf("revoked read leaked data: %d %s", r.StatusCode, body)
	}
}
