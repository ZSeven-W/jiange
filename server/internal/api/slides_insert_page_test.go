package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestInsertSlidePageAccountAndAnchor(t *testing.T) {
	ts, owner := newTestServer(t, store.NewMemory(), nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "insert-api@example.test", "name": "Owner", "password": "password123"}).Body.Close()
	var deck store.DriveEntry
	r := post(t, owner, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "Deck", "scope": "personal"})
	if r.StatusCode != 201 {
		t.Fatalf("deck: %d", r.StatusCode)
	}
	if err := json.NewDecoder(r.Body).Decode(&deck); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	url := fmt.Sprintf("%s/api/slides/%d/pages", ts.URL, deck.ID)
	r, err := owner.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	var list struct {
		Pages []store.SlidesPage `json:"pages"`
	}
	if err = json.NewDecoder(r.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if len(list.Pages) != 1 {
		t.Fatalf("initial: %+v", list.Pages)
	}
	anchor := list.Pages[0]
	call := func(account, body string) int {
		req, e := http.NewRequest("POST", url+"/insert", bytes.NewBufferString(body))
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Content-Type", "application/json")
		if account != "" {
			req.Header.Set("X-Jiange-User-Id", account)
		}
		res, e := owner.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		return res.StatusCode
	}
	body := fmt.Sprintf(`{"afterPageId":%d,"expectedRevision":%d}`, anchor.ID, anchor.Revision)
	if status := call("", body); status != 400 {
		t.Fatalf("missing account: %d", status)
	}
	if status := call("999999", body); status != 401 {
		t.Fatalf("wrong account: %d", status)
	}
	if status := call(fmt.Sprint(deck.CreatorID), `{}`); status != 400 {
		t.Fatalf("missing anchor: %d", status)
	}
	if status := call(fmt.Sprint(deck.CreatorID), fmt.Sprintf(`{"afterPageId":%d,"expectedRevision":99}`, anchor.ID)); status != 409 {
		t.Fatalf("stale: %d", status)
	}
	if status := call(fmt.Sprint(deck.CreatorID), `{"afterPageId":0,"expectedRevision":0}`); status != 409 {
		t.Fatalf("non-empty first: %d", status)
	}
	if status := call(fmt.Sprint(deck.CreatorID), body); status != 201 {
		t.Fatalf("insert: %d", status)
	}
	r, err = owner.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	var after struct {
		Pages []store.SlidesPage `json:"pages"`
	}
	if err = json.NewDecoder(r.Body).Decode(&after); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if len(after.Pages) != 2 || after.Pages[0].ID != anchor.ID {
		t.Fatalf("unexpected pages: %+v", after.Pages)
	}
	for _, page := range after.Pages {
		res := send(t, owner, "DELETE", fmt.Sprintf("%s/api/slides/pages/%d", ts.URL, page.ID), nil)
		if res.StatusCode != 204 {
			t.Fatalf("delete fixture page: %d", res.StatusCode)
		}
		res.Body.Close()
	}
	if status := call(fmt.Sprint(deck.CreatorID), `{"afterPageId":0,"expectedRevision":0}`); status != 201 {
		t.Fatalf("insert first into empty deck: %d", status)
	}
	if status := call(fmt.Sprint(deck.CreatorID), `{"afterPageId":0,"expectedRevision":0}`); status != 409 {
		t.Fatalf("reject duplicate first: %d", status)
	}
}
