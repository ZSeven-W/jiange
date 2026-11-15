package api

import (
	"encoding/json"
	"fmt"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"net/http"
	"testing"
)

func TestMemoryHomeAccountActions(t *testing.T) { checkHomeAccountActions(t, store.NewMemory()) }
func TestPostgresHomeAccountActions(t *testing.T) {
	checkHomeAccountActions(t, postgresBaseSecurityStore(t))
}

func checkHomeAccountActions(t *testing.T, st store.Store) {
	t.Helper()
	ts, c := newTestServer(t, st, nil)
	res := post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "home-actions@example.test", "name": "Owner", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(res.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = post(t, c, ts.URL+"/api/drive/nodes", map[string]any{"kind": "doc", "title": "测试", "scope": "personal"})
	var doc store.DriveEntry
	if err := json.NewDecoder(res.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	call := func(method, path, account string) (int, int) {
		req, err := http.NewRequest(method, ts.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if account != "" {
			req.Header.Set("X-Jiange-User-Id", account)
		}
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var body struct {
			Docs []store.DocMeta `json:"docs"`
		}
		json.NewDecoder(res.Body).Decode(&body)
		return res.StatusCode, len(body.Docs)
	}
	star := fmt.Sprintf("/api/docs/%d/account-star", doc.ID)
	account := fmt.Sprint(me.User.ID)
	if status, _ := call("PUT", star, ""); status != 400 {
		t.Fatalf("missing account %d", status)
	}
	if status, _ := call("PUT", star, "99999"); status != 401 {
		t.Fatalf("wrong account %d", status)
	}
	if status, _ := call("GET", "/api/account-favorites", "99999"); status != 401 {
		t.Fatalf("wrong list account %d", status)
	}
	if status, n := call("GET", "/api/account-favorites", account); status != 200 || n != 0 {
		t.Fatalf("empty %d %d", status, n)
	}
	if status, _ := call("PUT", star, account); status != 204 {
		t.Fatalf("add %d", status)
	}
	if status, n := call("GET", "/api/account-favorites", account); status != 200 || n != 1 {
		t.Fatalf("favorite %d %d", status, n)
	}
	if status, _ := call("DELETE", star, account); status != 204 {
		t.Fatalf("remove %d", status)
	}
	if status, n := call("GET", "/api/account-favorites", account); status != 200 || n != 0 {
		t.Fatalf("removed %d %d", status, n)
	}
	if status, _ := call("GET", "/api/account-pins", ""); status != 400 {
		t.Fatalf("missing pins account %d", status)
	}
	if status, n := call("GET", "/api/account-pins", account); status != 200 || n != 0 {
		t.Fatalf("pins %d %d", status, n)
	}
	pin := fmt.Sprintf("/api/docs/%d/account-pin", doc.ID)
	if status, _ := call("PUT", pin, account); status != 204 {
		t.Fatalf("pin %d", status)
	}
	if status, n := call("GET", "/api/account-pins", account); status != 200 || n != 1 {
		t.Fatalf("pinned %d %d", status, n)
	}
	if status, _ := call("DELETE", pin, account); status != 204 {
		t.Fatalf("unpin %d", status)
	}
}
