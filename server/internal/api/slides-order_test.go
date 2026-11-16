package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"net/http"
	"testing"
)

func TestSlidesOrderAccountAndStaleSnapshot(t *testing.T) {
	ts, owner := newTestServer(t, store.NewMemory(), nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "order-api@example.test", "name": "Owner", "password": "password123"}).Body.Close()
	var deck store.DriveEntry
	r := post(t, owner, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "Deck", "scope": "personal"})
	if r.StatusCode != 201 {
		t.Fatalf("deck %d", r.StatusCode)
	}
	if err := json.NewDecoder(r.Body).Decode(&deck); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	r, err := owner.Get(fmt.Sprintf("%s/api/slides/%d/pages", ts.URL, deck.ID))
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Pages []store.SlidesPage `json:"pages"`
	}
	if err = json.NewDecoder(r.Body).Decode(&data); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	r = post(t, owner, fmt.Sprintf("%s/api/slides/%d/pages", ts.URL, deck.ID), map[string]string{"title": "second"})
	if r.StatusCode != 201 {
		t.Fatalf("create %d", r.StatusCode)
	}
	var second store.SlidesPage
	if err = json.NewDecoder(r.Body).Decode(&second); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	body := fmt.Sprintf(`{"expected":[{"id":%d,"pos":%v},{"id":%d,"pos":%v}],"pageId":%d,"to":1}`, data.Pages[0].ID, data.Pages[0].Pos, second.ID, second.Pos, data.Pages[0].ID)
	call := func(account string) int {
		req, e := http.NewRequest("POST", fmt.Sprintf("%s/api/slides/%d/pages/reorder", ts.URL, deck.ID), bytes.NewBufferString(body))
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
	if got := call(""); got != 400 {
		t.Fatalf("missing %d", got)
	}
	if got := call("99999"); got != 401 {
		t.Fatalf("wrong %d", got)
	}
	if got := call(fmt.Sprint(deck.CreatorID)); got != 200 {
		t.Fatalf("reorder %d", got)
	}
	if got := call(fmt.Sprint(deck.CreatorID)); got != 409 {
		t.Fatalf("stale %d", got)
	}
}
