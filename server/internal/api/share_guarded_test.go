package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"sync"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

type beforeShareGuardStore struct {
	store.Store
	once   sync.Once
	before func(store.RestoreGuard)
}

func (s *beforeShareGuardStore) run(guard store.RestoreGuard) {
	if s.before != nil {
		s.once.Do(func() { s.before(guard) })
	}
}
func (s *beforeShareGuardStore) SetShareGuarded(ctx context.Context, guard store.RestoreGuard, doc, user int64, role string, createOnly bool) error {
	s.run(guard)
	return s.Store.SetShareGuarded(ctx, guard, doc, user, role, createOnly)
}
func (s *beforeShareGuardStore) ChangeLinkRoleGuarded(ctx context.Context, guard store.RestoreGuard, doc int64, role, token string) (store.Link, error) {
	s.run(guard)
	return s.Store.ChangeLinkRoleGuarded(ctx, guard, doc, role, token)
}
func (s *beforeShareGuardStore) PatchManagedDocGuarded(ctx context.Context, guard store.RestoreGuard, doc int64, patch store.ManagedDocPatch) error {
	s.run(guard)
	return s.Store.PatchManagedDocGuarded(ctx, guard, doc, patch)
}

func TestShareMutationsRejectRevocationBetweenAuthorizationAndWrite(t *testing.T) {
	for _, endpoint := range []string{"invite", "link", "mixed_patch"} {
		for _, event := range []string{"permission", "session"} {
			t.Run(endpoint+"/"+event, func(t *testing.T) {
				ctx := context.Background()
				base := store.NewMemory()
				wrapper := &beforeShareGuardStore{Store: base}
				ts, owner := newTestServer(t, wrapper, nil)
				jar, _ := cookiejar.New(nil)
				manager := &http.Client{Jar: jar}
				jar2, _ := cookiejar.New(nil)
				guest := &http.Client{Jar: jar2}
				post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "guard-owner@x.test", "name": "Owner", "password": "password123"})
				post(t, manager, ts.URL+"/api/auth/register", map[string]string{"email": "guard-manager@x.test", "name": "Manager", "password": "password123"})
				post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "guard-guest@x.test", "name": "Guest", "password": "password123"})
				var doc store.DocMeta
				if err := json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "Original"}).Body).Decode(&doc); err != nil {
					t.Fatal(err)
				}
				docURL := fmt.Sprintf("%s/api/docs/%d", ts.URL, doc.ID)
				if r := send(t, owner, "PUT", docURL+"/shares", map[string]string{"email": "guard-manager@x.test", "role": "manage"}); r.StatusCode != 200 {
					t.Fatal(r.StatusCode)
				}
				managerUser, err := base.UserByEmail(ctx, "guard-manager@x.test")
				if err != nil {
					t.Fatal(err)
				}
				hookErr := make(chan error, 1)
				wrapper.before = func(g store.RestoreGuard) {
					if event == "session" {
						hookErr <- base.DeleteSession(ctx, g.SessionHash)
					} else {
						hookErr <- base.SetShare(ctx, doc.ID, managerUser.ID, "")
					}
				}
				var res *http.Response
				switch endpoint {
				case "invite":
					res = send(t, manager, "PUT", docURL+"/shares", map[string]any{"email": "guard-guest@x.test", "role": "edit", "createOnly": true})
				case "link":
					res = send(t, manager, "PUT", docURL+"/link", map[string]string{"role": "view"})
				default:
					res = send(t, manager, "PATCH", docURL, map[string]any{"title": "Must not commit", "copyProtected": true, "move": true, "parentId": nil})
				}
				defer res.Body.Close()
				if err := <-hookErr; err != nil {
					t.Fatal(err)
				}
				want := http.StatusForbidden
				if event == "session" {
					want = http.StatusUnauthorized
				}
				if res.StatusCode != want {
					t.Fatalf("status=%d want=%d", res.StatusCode, want)
				}
				current, err := base.GetDocSystem(ctx, doc.ID)
				if err != nil || current.Title != "Original" || current.CopyProtected || current.ParentID != nil {
					t.Fatalf("partial metadata mutation: %+v %v", current, err)
				}
				links, err := base.GetLink(ctx, doc.ID)
				if err != nil || links.Role != "none" {
					t.Fatalf("link mutation: %+v %v", links, err)
				}
				shares, err := base.ListShares(ctx, doc.ID)
				if err != nil {
					t.Fatal(err)
				}
				for _, share := range shares {
					if share.Email == "guard-guest@x.test" {
						t.Fatalf("unauthorized invitation: %+v", share)
					}
				}
			})
		}
	}
}

func TestShareSelfRevocationAndProtectionComparison(t *testing.T) {
	ctx := context.Background()
	base := store.NewMemory()
	ts, owner := newTestServer(t, base, nil)
	jar, _ := cookiejar.New(nil)
	manager := &http.Client{Jar: jar}
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "self-owner@x.test", "name": "Owner", "password": "password123"})
	post(t, manager, ts.URL+"/api/auth/register", map[string]string{"email": "self-manager@x.test", "name": "Manager", "password": "password123"})
	var doc store.DocMeta
	if err := json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "Original"}).Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	url := fmt.Sprintf("%s/api/docs/%d", ts.URL, doc.ID)
	res := send(t, owner, "PUT", url+"/shares", map[string]string{"email": "self-manager@x.test", "role": "manage"})
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	res = send(t, manager, "PATCH", url, map[string]any{"copyProtected": true, "expectedCopyProtected": false})
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("initial patch %d", res.StatusCode)
	}
	res = send(t, manager, "PATCH", url, map[string]any{"copyProtected": false, "expectedCopyProtected": false, "title": "Must not commit"})
	res.Body.Close()
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("stale patch %d", res.StatusCode)
	}
	current, err := base.GetDocSystem(ctx, doc.ID)
	if err != nil || !current.CopyProtected || current.Title != "Original" {
		t.Fatalf("stale patch changed state: %+v %v", current, err)
	}
	res = send(t, manager, "PUT", url+"/shares", map[string]string{"email": "self-manager@x.test", "role": ""})
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent || res.Header.Get("X-Share-Refresh-Required") != "true" {
		t.Fatalf("self removal status=%d header=%q", res.StatusCode, res.Header.Get("X-Share-Refresh-Required"))
	}
	res, err = manager.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("revoked manager still has access: %d", res.StatusCode)
	}
}

func TestManagedPatchReportsSuccessWhenMoveRemovesOwnAccess(t *testing.T) {
	ctx := context.Background()
	base := store.NewMemory()
	ts, owner := newTestServer(t, base, nil)
	jar, _ := cookiejar.New(nil)
	manager := &http.Client{Jar: jar}
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "move-owner@x.test", "name": "Owner", "password": "password123"})
	post(t, manager, ts.URL+"/api/auth/register", map[string]string{"email": "move-manager@x.test", "name": "Manager", "password": "password123"})
	var parent, child store.DocMeta
	if err := json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "Parent"}).Body).Decode(&parent); err != nil {
		t.Fatal(err)
	}
	if err := json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]any{"title": "Child", "parentId": parent.ID}).Body).Decode(&child); err != nil {
		t.Fatal(err)
	}
	parentURL := fmt.Sprintf("%s/api/docs/%d", ts.URL, parent.ID)
	childURL := fmt.Sprintf("%s/api/docs/%d", ts.URL, child.ID)
	res := send(t, owner, "PUT", parentURL+"/shares", map[string]string{"email": "move-manager@x.test", "role": "manage"})
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	res = send(t, manager, "PATCH", childURL, map[string]any{"move": true, "parentId": nil, "title": "Moved", "copyProtected": true, "expectedCopyProtected": false})
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent || res.Header.Get("X-Share-Refresh-Required") != "true" {
		t.Fatalf("committed move status=%d header=%q", res.StatusCode, res.Header.Get("X-Share-Refresh-Required"))
	}
	result, err := base.GetDocSystem(ctx, child.ID)
	if err != nil || result.ParentID != nil || result.Title != "Moved" || !result.CopyProtected {
		t.Fatalf("move state: %+v %v", result, err)
	}
	res, err = manager.Get(childURL)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("manager retained access: %d", res.StatusCode)
	}
}
