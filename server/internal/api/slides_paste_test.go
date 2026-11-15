package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestMemorySlidesPasteAPI(t *testing.T)   { checkSlidesPasteAPI(t, store.NewMemory()) }
func TestPostgresSlidesPasteAPI(t *testing.T) { checkSlidesPasteAPI(t, postgresBaseSecurityStore(t)) }
func checkSlidesPasteAPI(t *testing.T, st store.Store) {
	t.Helper()
	ts, client := newTestServer(t, st, nil)
	res := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "paste-api@example.test", "name": "User", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(res.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = post(t, client, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "Deck", "scope": "personal"})
	var deck store.DriveEntry
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d", res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(&deck); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	pages, err := st.ListSlidesPages(t.Context(), me.User.ID, deck.ID)
	if err != nil || len(pages) != 1 {
		t.Fatalf("pages: %+v %v", pages, err)
	}
	path := fmt.Sprintf("%s/api/slides/%d/pages/paste", ts.URL, deck.ID)
	call := func(account, body string) int {
		t.Helper()
		req, err := http.NewRequest("POST", path, bytes.NewBufferString(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		if account != "" {
			req.Header.Set("X-Jiange-User-Id", account)
		}
		r, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		return r.StatusCode
	}
	page := pages[0]
	body := fmt.Sprintf(`{"sourceId":%d,"sourceRevision":%d,"anchorId":%d,"anchorRevision":%d}`, page.ID, page.Revision, page.ID, page.Revision)
	if got := call("", body); got != http.StatusBadRequest {
		t.Fatalf("missing account: %d", got)
	}
	if got := call("999999", body); got != http.StatusUnauthorized {
		t.Fatalf("wrong account: %d", got)
	}
	account := fmt.Sprint(me.User.ID)
	if got := call(account, `{"sourceId":1}`); got != http.StatusBadRequest {
		t.Fatalf("invalid payload: %d", got)
	}
	stale := fmt.Sprintf(`{"sourceId":%d,"sourceRevision":%d,"anchorId":%d,"anchorRevision":%d}`, page.ID, page.Revision+1, page.ID, page.Revision)
	if got := call(account, stale); got != http.StatusConflict {
		t.Fatalf("stale: %d", got)
	}
	if got := call(account, body); got != http.StatusCreated {
		t.Fatalf("paste: %d", got)
	}
	pages, err = st.ListSlidesPages(t.Context(), me.User.ID, deck.ID)
	if err != nil || len(pages) != 2 {
		t.Fatalf("pages after paste: %+v %v", pages, err)
	}
}
