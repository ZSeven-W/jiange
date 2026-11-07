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

type beforeIconGuardStore struct {
	store.Store
	once   sync.Once
	before func(store.RestoreGuard)
}

func (s *beforeIconGuardStore) SetDocIconGuarded(ctx context.Context, g store.RestoreGuard, doc int64, icon string, rev int64) (store.DocIcon, error) {
	if s.before != nil {
		s.once.Do(func() { s.before(g) })
	}
	return s.Store.SetDocIconGuarded(ctx, g, doc, icon, rev)
}

func TestDocumentIconAPI(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	jar, _ := cookiejar.New(nil)
	guest := &http.Client{Jar: jar}
	for _, u := range []struct {
		client *http.Client
		email  string
	}{{owner, "icon-owner@example.test"}, {guest, "icon-guest@example.test"}} {
		r := post(t, u.client, ts.URL+"/api/auth/register", map[string]string{"email": u.email, "name": "Example", "password": "password123"})
		r.Body.Close()
	}
	var doc store.DocMeta
	r := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "Icon example"})
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	base := fmt.Sprintf("%s/api/docs/%d", ts.URL, doc.ID)
	r = send(t, owner, "PUT", base+"/shares", map[string]string{"email": "icon-guest@example.test", "role": "view"})
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatal(r.StatusCode)
	}
	read := func(client *http.Client, status int) store.DocIcon {
		t.Helper()
		r := send(t, client, "GET", base+"/icon", nil)
		defer r.Body.Close()
		if r.StatusCode != status {
			t.Fatalf("GET status=%d want=%d", r.StatusCode, status)
		}
		var got store.DocIcon
		if status == http.StatusOK {
			if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
				t.Fatal(err)
			}
		}
		return got
	}
	if got := read(guest, http.StatusOK); got.Icon != "" || got.Revision != 0 {
		t.Fatalf("initial read: %+v", got)
	}
	put := func(client *http.Client, body map[string]any, status int) store.DocIcon {
		t.Helper()
		r := send(t, client, "PUT", base+"/icon", body)
		defer r.Body.Close()
		if r.StatusCode != status {
			t.Fatalf("PUT status=%d want=%d", r.StatusCode, status)
		}
		var got store.DocIcon
		if status == http.StatusOK {
			if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
				t.Fatal(err)
			}
		}
		return got
	}
	put(guest, map[string]any{"icon": "😀", "expectedRevision": 0}, http.StatusForbidden)
	put(owner, map[string]any{"icon": "<img>", "expectedRevision": 0}, http.StatusBadRequest)
	put(owner, map[string]any{"icon": "😀"}, http.StatusBadRequest)
	got := put(owner, map[string]any{"icon": "🧑‍💻", "expectedRevision": 0}, http.StatusOK)
	if got.Icon != "🧑‍💻" || got.Revision != 1 || read(guest, http.StatusOK) != got {
		t.Fatalf("icon mismatch: %+v", got)
	}
	put(owner, map[string]any{"icon": "😀", "expectedRevision": 0}, http.StatusConflict)
	got = put(owner, map[string]any{"icon": "", "expectedRevision": 1}, http.StatusOK)
	if got.Icon != "" || got.Revision != 2 {
		t.Fatalf("remove mismatch: %+v", got)
	}
	guestUser, err := st.UserByEmail(context.Background(), "icon-guest@example.test")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(context.Background(), doc.ID, guestUser.ID, ""); err != nil {
		t.Fatal(err)
	}
	read(guest, http.StatusNotFound)
}

func TestDocumentIconRejectsRevocationBeforeWrite(t *testing.T) {
	for _, event := range []string{"permission", "session"} {
		t.Run(event, func(t *testing.T) {
			ctx := context.Background()
			base := store.NewMemory()
			wrapped := &beforeIconGuardStore{Store: base}
			ts, owner := newTestServer(t, wrapped, nil)
			jar, _ := cookiejar.New(nil)
			editor := &http.Client{Jar: jar}
			for _, u := range []struct {
				client *http.Client
				email  string
			}{{owner, "icon-owner-guard@example.test"}, {editor, "icon-editor-guard@example.test"}} {
				r := post(t, u.client, ts.URL+"/api/auth/register", map[string]string{"email": u.email, "name": "Example", "password": "password123"})
				r.Body.Close()
			}
			var doc store.DocMeta
			r := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "Icon"})
			if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
				t.Fatal(err)
			}
			r.Body.Close()
			url := fmt.Sprintf("%s/api/docs/%d", ts.URL, doc.ID)
			r = send(t, owner, "PUT", url+"/shares", map[string]string{"email": "icon-editor-guard@example.test", "role": "edit"})
			r.Body.Close()
			if r.StatusCode != http.StatusOK {
				t.Fatal(r.StatusCode)
			}
			u, err := base.UserByEmail(ctx, "icon-editor-guard@example.test")
			if err != nil {
				t.Fatal(err)
			}
			hookErr := make(chan error, 1)
			wrapped.before = func(g store.RestoreGuard) {
				if event == "session" {
					hookErr <- base.DeleteSession(ctx, g.SessionHash)
				} else {
					hookErr <- base.SetShare(ctx, doc.ID, u.ID, store.RoleView)
				}
			}
			r = send(t, editor, "PUT", url+"/icon", map[string]any{"icon": "💡", "expectedRevision": 0})
			r.Body.Close()
			if err := <-hookErr; err != nil {
				t.Fatal(err)
			}
			want := http.StatusForbidden
			if event == "session" {
				want = http.StatusUnauthorized
			}
			if r.StatusCode != want {
				t.Fatalf("status=%d want=%d", r.StatusCode, want)
			}
			current, err := base.GetDocSystem(ctx, doc.ID)
			if err != nil || current.Icon != "" {
				t.Fatalf("revoked update modified icon: %+v %v", current, err)
			}
		})
	}
}
