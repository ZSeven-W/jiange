package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestDuplicateSlidePageAccountAndRevision(t *testing.T) {
	ts, owner := newTestServer(t, store.NewMemory(), nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "slide-api@example.test", "name": "Owner", "password": "password123"}).Body.Close()
	var deck store.DriveEntry
	r := post(t, owner, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "Deck", "scope": "personal"})
	if r.StatusCode != 201 {
		t.Fatalf("deck: %d", r.StatusCode)
	}
	if err := json.NewDecoder(r.Body).Decode(&deck); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	r, err := owner.Get(fmt.Sprintf("%s/api/slides/%d/pages", ts.URL, deck.ID))
	if err != nil {
		t.Fatal(err)
	}
	var initial struct {
		Pages []store.SlidesPage `json:"pages"`
	}
	if err = json.NewDecoder(r.Body).Decode(&initial); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if len(initial.Pages) != 1 {
		t.Fatalf("initial: %+v", initial.Pages)
	}
	url := fmt.Sprintf("%s/api/slides/%d/pages/%d/duplicate", ts.URL, deck.ID, initial.Pages[0].ID)
	call := func(account, body string) int {
		req, e := http.NewRequest("POST", url, bytes.NewBufferString(body))
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
	if status := call("", `{"expectedRevision":1}`); status != 400 {
		t.Fatalf("missing account: %d", status)
	}
	if status := call("999999", `{"expectedRevision":1}`); status != 401 {
		t.Fatalf("wrong account: %d", status)
	}
	if status := call(fmt.Sprint(deck.CreatorID), `{"expectedRevision":99}`); status != 409 {
		t.Fatalf("stale version: %d", status)
	}
	if status := call(fmt.Sprint(deck.CreatorID), `{"expectedRevision":1}`); status != 201 {
		t.Fatalf("copy: %d", status)
	}
	r, err = owner.Get(fmt.Sprintf("%s/api/slides/%d/pages", ts.URL, deck.ID))
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
	if len(after.Pages) != 2 {
		t.Fatalf("expected only one successful copy: %+v", after.Pages)
	}
}
