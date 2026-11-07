package api

import (
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestRecentVisitsAPI(t *testing.T) {
	now := time.Date(2026, 11, 7, 10, 20, 0, 0, time.UTC)
	ts, owner := newTestServer(t, store.NewMemory(), func() time.Time { return now })
	jar, _ := cookiejar.New(nil)
	guest := &http.Client{Jar: jar}
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "recent-owner@api.test", "name": "Owner", "password": "password123"})
	post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "recent-guest@api.test", "name": "Guest", "password": "password123"})
	var doc store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "示例文档"}).Body).Decode(&doc)
	url := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10)
	if r, err := (&http.Client{}).Get(ts.URL + "/api/recent"); err != nil || r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous: %v %v", r, err)
	}
	if r := post(t, guest, url+"/visit", nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("unshared visit: %d", r.StatusCode)
	}
	// Simply reading a document must not mutate visit history.
	if r := cGet(t, owner, url); r.StatusCode != http.StatusOK {
		t.Fatalf("read: %d", r.StatusCode)
	}
	var before struct {
		Docs []store.RecentDoc `json:"docs"`
	}
	json.NewDecoder(cGet(t, owner, ts.URL+"/api/recent").Body).Decode(&before)
	if len(before.Docs) != 0 {
		t.Fatalf("GET recorded a visit: %+v", before.Docs)
	}
	req, _ := http.NewRequest(http.MethodPost, url+"/visit", strings.NewReader("x"))
	req.Header.Set("Content-Type", "text/plain")
	if r, err := owner.Do(req); err != nil || r.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("CSRF content type: %v %v", r, err)
	}
	if r := post(t, owner, url+"/visit", nil); r.StatusCode != http.StatusNoContent {
		t.Fatalf("owner visit: %d", r.StatusCode)
	}
	r := cGet(t, owner, ts.URL+"/api/recent")
	var list struct {
		Docs []store.RecentDoc `json:"docs"`
	}
	if err := json.NewDecoder(r.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if r.Header.Get("Cache-Control") != "private, no-store" || len(list.Docs) != 1 || list.Docs[0].ID != doc.ID || !list.Docs[0].ViewedAt.Equal(now) || list.Docs[0].Role != store.RoleManage {
		t.Fatalf("owner recent: header=%q docs=%+v", r.Header.Get("Cache-Control"), list.Docs)
	}
	if r := send(t, owner, "PUT", url+"/shares", map[string]string{"email": "recent-guest@api.test", "role": "view"}); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	if r := post(t, guest, url+"/visit", nil); r.StatusCode != http.StatusNoContent {
		t.Fatalf("shared visit: %d", r.StatusCode)
	}
	var shared struct {
		Docs []store.RecentDoc `json:"docs"`
	}
	json.NewDecoder(cGet(t, guest, ts.URL+"/api/recent").Body).Decode(&shared)
	if len(shared.Docs) != 1 || shared.Docs[0].ID != doc.ID || shared.Docs[0].Role != store.RoleView {
		t.Fatalf("shared: %+v", shared.Docs)
	}
	if r := send(t, owner, "PUT", url+"/shares", map[string]string{"email": "recent-guest@api.test", "role": ""}); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	shared.Docs = nil
	json.NewDecoder(cGet(t, guest, ts.URL+"/api/recent").Body).Decode(&shared)
	if len(shared.Docs) != 0 {
		t.Fatalf("revoked document leaked: %+v", shared.Docs)
	}
}

func TestRecentHidesInaccessibleParent(t *testing.T) {
	ts, owner := newTestServer(t, store.NewMemory(), nil)
	jar, _ := cookiejar.New(nil)
	guest := &http.Client{Jar: jar}
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "recent-parent@api.test", "name": "Owner", "password": "password123"})
	post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "recent-child@api.test", "name": "Guest", "password": "password123"})
	var parent, child store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "私密父文档"}).Body).Decode(&parent)
	json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]any{"title": "共享子文档", "parentId": parent.ID}).Body).Decode(&child)
	childURL := ts.URL + "/api/docs/" + strconv.FormatInt(child.ID, 10)
	if r := send(t, owner, "PUT", childURL+"/shares", map[string]string{"email": "recent-child@api.test", "role": "view"}); r.StatusCode != http.StatusOK {
		t.Fatal(r.StatusCode)
	}
	if r := post(t, guest, childURL+"/visit", nil); r.StatusCode != http.StatusNoContent {
		t.Fatal(r.StatusCode)
	}
	read := func(c *http.Client) []store.RecentDoc {
		t.Helper()
		r := cGet(t, c, ts.URL+"/api/recent")
		defer r.Body.Close()
		var result struct {
			Docs []store.RecentDoc `json:"docs"`
		}
		if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		return result.Docs
	}
	if got := read(guest); len(got) != 1 || got[0].ParentID != nil {
		t.Fatalf("inaccessible parent leaked: %+v", got)
	}
	parentURL := ts.URL + "/api/docs/" + strconv.FormatInt(parent.ID, 10)
	if r := send(t, owner, "PUT", parentURL+"/shares", map[string]string{"email": "recent-child@api.test", "role": "view"}); r.StatusCode != http.StatusOK {
		t.Fatal(r.StatusCode)
	}
	if got := read(guest); len(got) != 1 || got[0].ParentID == nil || *got[0].ParentID != parent.ID {
		t.Fatalf("accessible parent should remain: %+v", got)
	}
}
