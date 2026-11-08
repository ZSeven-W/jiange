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

type beforeMetadataGuardStore struct {
	store.Store
	once   sync.Once
	before func(store.RestoreGuard)
	after  func(store.RestoreGuard)
}

func (s *beforeMetadataGuardStore) PatchDocMetadataGuarded(ctx context.Context, guard store.RestoreGuard, id int64, patch store.DocMetadataPatch) error {
	if s.before != nil {
		s.once.Do(func() { s.before(guard) })
	}
	err := s.Store.PatchDocMetadataGuarded(ctx, guard, id, patch)
	if err == nil && s.after != nil {
		s.after(guard)
	}
	return err
}

func TestMetadataPatchReturnsNoMetadataAfterCommittedAccessLoss(t *testing.T) {
	for _, event := range []string{"permission", "session"} {
		t.Run(event, func(t *testing.T) {
			ctx := context.Background()
			base := store.NewMemory()
			wrapper := &beforeMetadataGuardStore{Store: base}
			ts, owner := newTestServer(t, wrapper, nil)
			jar, _ := cookiejar.New(nil)
			editor := &http.Client{Jar: jar}
			post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "after-owner@test.dev", "name": "Owner", "password": "password123"})
			post(t, editor, ts.URL+"/api/auth/register", map[string]string{"email": "after-editor@test.dev", "name": "Editor", "password": "password123"})
			var doc store.DocMeta
			if err := json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "Original"}).Body).Decode(&doc); err != nil {
				t.Fatal(err)
			}
			user, err := base.UserByEmail(ctx, "after-editor@test.dev")
			if err != nil {
				t.Fatal(err)
			}
			if err = base.SetShare(ctx, doc.ID, user.ID, store.RoleEdit); err != nil {
				t.Fatal(err)
			}
			hook := make(chan error, 1)
			wrapper.after = func(g store.RestoreGuard) {
				if event == "session" {
					hook <- base.DeleteSession(ctx, g.SessionHash)
				} else {
					hook <- base.SetShare(ctx, doc.ID, user.ID, "")
				}
			}
			res := send(t, editor, http.MethodPatch, fmt.Sprintf("%s/api/docs/%d", ts.URL, doc.ID), map[string]string{"title": "Committed"})
			defer res.Body.Close()
			if err = <-hook; err != nil {
				t.Fatal(err)
			}
			if res.StatusCode != http.StatusNoContent || res.Header.Get("X-Share-Refresh-Required") != "true" {
				t.Fatalf("response status=%d, header=%q", res.StatusCode, res.Header.Get("X-Share-Refresh-Required"))
			}
			current, err := base.GetDocSystem(ctx, doc.ID)
			if err != nil || current.Title != "Committed" {
				t.Fatalf("write did not commit: %+v %v", current, err)
			}
		})
	}
}

func TestMetadataPatchRejectsRevokedAccessAndSession(t *testing.T) {
	for _, mutation := range []string{"title", "move_and_title"} {
		for _, event := range []string{"permission", "session"} {
			t.Run(mutation+"/"+event, func(t *testing.T) {
				ctx := context.Background()
				base := store.NewMemory()
				wrapper := &beforeMetadataGuardStore{Store: base}
				ts, owner := newTestServer(t, wrapper, nil)
				jar, _ := cookiejar.New(nil)
				editor := &http.Client{Jar: jar}
				post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "meta-owner@test.dev", "name": "Owner", "password": "password123"})
				post(t, editor, ts.URL+"/api/auth/register", map[string]string{"email": "meta-editor@test.dev", "name": "Editor", "password": "password123"})
				var doc store.DocMeta
				if err := json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "Original"}).Body).Decode(&doc); err != nil {
					t.Fatal(err)
				}
				user, err := base.UserByEmail(ctx, "meta-editor@test.dev")
				if err != nil {
					t.Fatal(err)
				}
				role := store.RoleEdit
				if mutation == "move_and_title" {
					role = store.RoleManage
				}
				if err = base.SetShare(ctx, doc.ID, user.ID, role); err != nil {
					t.Fatal(err)
				}
				hook := make(chan error, 1)
				wrapper.before = func(g store.RestoreGuard) {
					if event == "session" {
						hook <- base.DeleteSession(ctx, g.SessionHash)
					} else {
						hook <- base.SetShare(ctx, doc.ID, user.ID, "")
					}
				}
				input := map[string]any{"title": "Should not persist"}
				if mutation == "move_and_title" {
					input["move"] = true
					input["parentId"] = nil
				}
				res := send(t, editor, http.MethodPatch, fmt.Sprintf("%s/api/docs/%d", ts.URL, doc.ID), input)
				defer res.Body.Close()
				if err = <-hook; err != nil {
					t.Fatal(err)
				}
				want := http.StatusForbidden
				if event == "session" {
					want = http.StatusUnauthorized
				}
				if res.StatusCode != want {
					t.Fatalf("status %d, want %d", res.StatusCode, want)
				}
				current, err := base.GetDocSystem(ctx, doc.ID)
				if err != nil || current.Title != "Original" || current.ParentID != nil {
					t.Fatalf("unauthorized mutation: %+v %v", current, err)
				}
			})
		}
	}
}
