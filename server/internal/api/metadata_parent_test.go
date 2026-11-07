package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"sync/atomic"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestParentMetadataRespectsCurrentAccess(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	jar, _ := cookiejar.New(nil)
	guest := &http.Client{Jar: jar}
	for _, v := range []struct {
		c     *http.Client
		email string
	}{{owner, "parent-owner@x.test"}, {guest, "parent-guest@x.test"}} {
		r := post(t, v.c, ts.URL+"/api/auth/register", map[string]string{"email": v.email, "name": "test", "password": "password123"})
		if r.StatusCode != 201 {
			t.Fatal(r.StatusCode)
		}
		r.Body.Close()
	}
	create := func(parent *int64, title, endpoint string) store.DocMeta {
		r := post(t, owner, ts.URL+endpoint, map[string]any{"parentId": parent, "title": title})
		defer r.Body.Close()
		if r.StatusCode != 201 {
			t.Fatalf("create: %d", r.StatusCode)
		}
		var d store.DocMeta
		if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
			t.Fatal(err)
		}
		return d
	}
	root := create(nil, "private root", "/api/docs")
	parent := create(&root.ID, "middle", "/api/docs")
	child := create(&parent.ID, "child", "/api/docs")
	base := create(&parent.ID, "base", "/api/bases")
	path := func(id int64) string { return ts.URL + "/api/docs/" + strconv.FormatInt(id, 10) }
	share := func(id int64, role string) {
		r := send(t, owner, "PUT", path(id)+"/shares", map[string]string{"email": "parent-guest@x.test", "role": role})
		defer r.Body.Close()
		if r.StatusCode != 200 {
			t.Fatal(r.StatusCode)
		}
	}
	get := func(url string, value any) {
		t.Helper()
		r, err := guest.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		if r.StatusCode != 200 {
			t.Fatalf("GET %s: %d", url, r.StatusCode)
		}
		if err := json.NewDecoder(r.Body).Decode(value); err != nil {
			t.Fatal(err)
		}
	}
	share(child.ID, "view")
	share(base.ID, "view")
	r := send(t, guest, "PUT", path(child.ID)+"/star", nil)
	r.Body.Close()
	if r.StatusCode != 204 {
		t.Fatal(r.StatusCode)
	}
	var d store.DocMeta
	get(path(child.ID), &d)
	if d.ParentID != nil {
		t.Fatalf("private parent leaked: %+v", d)
	}
	var entries struct {
		Docs []store.DocMeta `json:"docs"`
	}
	get(ts.URL+"/api/favorites", &entries)
	if len(entries.Docs) != 1 || entries.Docs[0].ParentID != nil {
		t.Fatalf("favorite parent leaked: %+v", entries)
	}
	entries.Docs = nil
	get(ts.URL+"/api/shared", &entries)
	for _, v := range entries.Docs {
		if v.ParentID != nil {
			t.Fatalf("shared parent leaked: %+v", v)
		}
	}
	var b struct {
		Base store.DocMeta `json:"base"`
	}
	get(ts.URL+"/api/bases/"+strconv.FormatInt(base.ID, 10), &b)
	if b.Base.ParentID != nil {
		t.Fatalf("base parent leaked: %+v", b)
	}
	share(parent.ID, "view")
	get(path(child.ID), &d)
	if d.ParentID == nil || *d.ParentID != parent.ID {
		t.Fatalf("accessible parent absent: %+v", d)
	}
	var chain struct {
		Ancestors []store.DocMeta `json:"ancestors"`
	}
	get(path(child.ID)+"/ancestors", &chain)
	if len(chain.Ancestors) != 1 || chain.Ancestors[0].ID != parent.ID || chain.Ancestors[0].ParentID != nil {
		t.Fatalf("ancestor metadata: %+v", chain)
	}
	share(parent.ID, "")
	get(path(child.ID), &d)
	if d.ParentID != nil {
		t.Fatalf("revoked parent leaked: %+v", d)
	}
	var ownerDoc store.DocMeta
	rr, err := owner.Get(path(child.ID))
	if err != nil {
		t.Fatal(err)
	}
	json.NewDecoder(rr.Body).Decode(&ownerDoc)
	rr.Body.Close()
	if ownerDoc.ParentID == nil || *ownerDoc.ParentID != parent.ID {
		t.Fatalf("internal parent changed: %+v", ownerDoc)
	}
	rr = post(t, owner, path(child.ID)+"/duplicate", map[string]any{})
	defer rr.Body.Close()
	if rr.StatusCode != 201 {
		t.Fatalf("duplicate: %d", rr.StatusCode)
	}
	var copy store.DocMeta
	json.NewDecoder(rr.Body).Decode(&copy)
	if copy.ParentID == nil || *copy.ParentID != parent.ID {
		t.Fatalf("copy destination changed: %+v", copy)
	}
	share(parent.ID, "view")
	rr = send(t, owner, "PATCH", path(parent.ID), map[string]any{"move": true, "parentId": nil})
	rr.Body.Close()
	if rr.StatusCode != 200 {
		t.Fatalf("move: %d", rr.StatusCode)
	}
	chain.Ancestors = nil
	get(path(child.ID)+"/ancestors", &chain)
	if len(chain.Ancestors) != 1 || chain.Ancestors[0].ID != parent.ID || chain.Ancestors[0].ParentID != nil {
		t.Fatalf("moved hierarchy: %+v", chain)
	}
}

type failingParentStore struct {
	store.Store
	parent atomic.Int64
	fail   atomic.Bool
}

func (s *failingParentStore) GetDoc(ctx context.Context, uid, id int64) (store.DocMeta, error) {
	if s.fail.Load() && id == s.parent.Load() {
		return store.DocMeta{}, errors.New("injected parent lookup failure")
	}
	return s.Store.GetDoc(ctx, uid, id)
}
func (s *failingParentStore) UpdateTitle(ctx context.Context, id int64, title string) (store.DocMeta, error) {
	d, err := s.Store.UpdateTitle(ctx, id, title)
	if err == nil {
		s.fail.Store(true)
	}
	return d, err
}
func TestParentLookupFailureDoesNotReportCommittedWriteAsFailed(t *testing.T) {
	st := &failingParentStore{Store: store.NewMemory()}
	ts, c := newTestServer(t, st, nil)
	r := post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "failure@x.test", "name": "test", "password": "password123"})
	r.Body.Close()
	r = post(t, c, ts.URL+"/api/docs", map[string]string{"title": "parent"})
	var parent store.DocMeta
	json.NewDecoder(r.Body).Decode(&parent)
	r.Body.Close()
	st.parent.Store(parent.ID)
	r = post(t, c, ts.URL+"/api/docs", map[string]any{"title": "child", "parentId": parent.ID})
	var child store.DocMeta
	json.NewDecoder(r.Body).Decode(&child)
	r.Body.Close()
	url := ts.URL + "/api/docs/" + strconv.FormatInt(child.ID, 10)
	r = send(t, c, "PATCH", url, map[string]string{"title": "saved"})
	defer r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatalf("committed update reported failure: %d", r.StatusCode)
	}
	var result store.DocMeta
	json.NewDecoder(r.Body).Decode(&result)
	if result.ParentID != nil || result.Title != "saved" {
		t.Fatalf("failed check must hide parent and keep update: %+v", result)
	}
	r, err := c.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != 500 {
		t.Fatalf("read must fail closed: %d", r.StatusCode)
	}
	raw, err := st.Store.GetDocSystem(context.Background(), child.ID)
	if err != nil || raw.ParentID == nil || *raw.ParentID != parent.ID || raw.Title != "saved" {
		t.Fatalf("tree or title changed: %+v %v", raw, err)
	}
}
