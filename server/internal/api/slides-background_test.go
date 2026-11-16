package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestSlidesBackgroundAccountAndVersions(t *testing.T) {
	ts, owner := newTestServer(t, store.NewMemory(), nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "background-api@example.test", "name": "Owner", "password": "password123"}).Body.Close()
	var deck store.DriveEntry
	r := post(t, owner, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "Deck", "scope": "personal"})
	if r.StatusCode != http.StatusCreated || json.NewDecoder(r.Body).Decode(&deck) != nil {
		t.Fatalf("deck: %d", r.StatusCode)
	}
	r.Body.Close()
	pagesURL := fmt.Sprintf("%s/api/slides/%d/pages", ts.URL, deck.ID)
	r, err := owner.Get(pagesURL)
	if err != nil {
		t.Fatal(err)
	}
	var pages struct {
		Pages []store.SlidesPage `json:"pages"`
	}
	if err := json.NewDecoder(r.Body).Decode(&pages); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if len(pages.Pages) != 1 {
		t.Fatalf("pages=%+v", pages.Pages)
	}
	page := pages.Pages[0]
	path := fmt.Sprintf("%s/api/slides/%d/background-all", ts.URL, deck.ID)
	call := func(account, body string) (*http.Response, map[string]any) {
		req, e := http.NewRequest("POST", path, bytes.NewBufferString(body))
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
		var result map[string]any
		if e := json.NewDecoder(res.Body).Decode(&result); e != nil {
			t.Fatal(e)
		}
		return res, result
	}
	body := fmt.Sprintf(`{"background":"#336699","expected":[{"id":%d,"revision":%d}]}`, page.ID, page.Revision)
	if res, _ := call("", body); res.StatusCode != 400 {
		t.Fatalf("missing account: %d", res.StatusCode)
	}
	if res, _ := call("999", body); res.StatusCode != 401 {
		t.Fatalf("wrong account: %d", res.StatusCode)
	}
	if res, _ := call(fmt.Sprint(deck.CreatorID), `{}`); res.StatusCode != 400 {
		t.Fatalf("missing color: %d", res.StatusCode)
	}
	res, result := call(fmt.Sprint(deck.CreatorID), body)
	if res.StatusCode != 200 {
		t.Fatalf("apply: %d %+v", res.StatusCode, result)
	}
	receipts, ok := result["pages"].([]any)
	if !ok || len(receipts) != 1 {
		t.Fatalf("receipt=%+v", result)
	}
	item := receipts[0].(map[string]any)
	if _, leaked := item["title"]; leaked {
		t.Fatalf("receipt leaked content %+v", item)
	}
	if res, _ := call(fmt.Sprint(deck.CreatorID), body); res.StatusCode != 409 {
		t.Fatalf("stale: %d", res.StatusCode)
	}
	changePath := fmt.Sprintf("%s/api/slides/%d/background-changes", ts.URL, deck.ID)
	change := func(account, body string) int {
		req, e := http.NewRequest("POST", changePath, bytes.NewBufferString(body))
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
	if status := change(fmt.Sprint(deck.CreatorID), fmt.Sprintf(`{"changes":[{"id":%d,"revision":2}]}`, page.ID)); status != 400 {
		t.Fatalf("missing background: %d", status)
	}
	if status := change(fmt.Sprint(deck.CreatorID), fmt.Sprintf(`{"changes":[{"id":%d,"revision":2,"background":""}]}`, page.ID)); status != 200 {
		t.Fatalf("restore: %d", status)
	}
}
