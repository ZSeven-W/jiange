package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

type titleCheckStore struct {
	store.Store
	revoke  bool
	invalid bool
	after   bool
	expire  bool
}

func (s *titleCheckStore) SessionUser(ctx context.Context, hash []byte, now time.Time) (store.User, error) {
	if s.after && s.expire {
		return store.User{}, store.ErrNotFound
	}
	return s.Store.SessionUser(ctx, hash, now)
}

func (s *titleCheckStore) ReadTitleSnapshot(ctx context.Context, id int64) (store.TitleSnapshot, error) {
	r, err := s.Store.ReadTitleSnapshot(ctx, id)
	if s.invalid && len(r.Ops) > 0 {
		r.Ops[0].Bytes = []byte{0xff}
	}
	s.after = true
	return r, err
}
func (s *titleCheckStore) GetDoc(ctx context.Context, uid, id int64) (store.DocMeta, error) {
	if s.after && s.revoke {
		return store.DocMeta{}, store.ErrNotFound
	}
	return s.Store.GetDoc(ctx, uid, id)
}

func TestTitleConsistencyRejectsCorruptionAndRevokedAccess(t *testing.T) {
	for _, tc := range []struct {
		name                      string
		revoked, invalid, expired bool
		want                      int
	}{
		{"revoked", true, false, false, http.StatusNotFound}, {"corrupt", false, true, false, http.StatusInternalServerError}, {"session-expired", false, false, true, http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := &titleCheckStore{Store: store.NewMemory(), revoke: tc.revoked, invalid: tc.invalid, expire: tc.expired}
			ts, owner := newTestServer(t, st, nil)
			resp := post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "title-" + tc.name + "@test", "name": "Owner", "password": "password123"})
			resp.Body.Close()
			resp = post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "私有标题"})
			var doc store.DocMeta
			if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			resp, err := owner.Get(ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10) + "/title-consistency")
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.want || resp.Header.Get("Cache-Control") != "private, no-store" {
				t.Fatalf("status %d, want %d", resp.StatusCode, tc.want)
			}
		})
	}
}

func TestTitleConsistencyShowsBothSourcesWithoutChangingThem(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	resp := post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "title-check@test", "name": "Owner", "password": "password123"})
	resp.Body.Close()
	resp = post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "原文标题"})
	var doc store.DocMeta
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	url := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10)
	resp = send(t, owner, http.MethodPatch, url, map[string]string{"title": "侧栏标题"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("rename: %d", resp.StatusCode)
	}
	resp, err := owner.Get(url + "/title-consistency")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		DirectoryTitle string `json:"directoryTitle"`
		DocumentTitle  string `json:"documentTitle"`
		Head           int64  `json:"head"`
		Differs        bool   `json:"differs"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || resp.Header.Get("Cache-Control") != "private, no-store" || body.DirectoryTitle != "侧栏标题" || body.DocumentTitle != "原文标题" || !body.Differs || body.Head < 1 {
		t.Fatalf("unexpected response: %d %+v", resp.StatusCode, body)
	}
	resp, err = owner.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil || doc.Title != "侧栏标题" {
		t.Fatalf("check changed title: %+v %v", doc, err)
	}
}
