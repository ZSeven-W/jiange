package api

import (
	"bytes"
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
	copyPath := fmt.Sprintf("/api/docs/%d/account-duplicate", doc.ID)
	if status, _ := call("POST", copyPath, ""); status != 400 {
		t.Fatalf("copy missing account %d", status)
	}
	if status, _ := call("POST", copyPath, "99999"); status != 401 {
		t.Fatalf("copy wrong account %d", status)
	}
	if status, _ := call("POST", copyPath, account); status != 201 {
		t.Fatalf("copy %d", status)
	}
	if status, _ := call("GET", fmt.Sprintf("/api/docs/%d/account-metadata", doc.ID), "99999"); status != 401 {
		t.Fatalf("metadata wrong account %d", status)
	}
	metadataReq, _ := http.NewRequest("GET", fmt.Sprintf("%s/api/docs/%d/account-metadata", ts.URL, doc.ID), nil)
	metadataReq.Header.Set("X-Jiange-User-Id", account)
	metadataRes, err := c.Do(metadataReq)
	if err != nil {
		t.Fatal(err)
	}
	var meta store.DocMeta
	if err = json.NewDecoder(metadataRes.Body).Decode(&meta); err != nil {
		t.Fatal(err)
	}
	metadataRes.Body.Close()
	trash := func(account string, revision int64) int {
		req, e := http.NewRequest("POST", fmt.Sprintf("%s/api/drive/account-trash/%d", ts.URL, doc.ID), bytes.NewBufferString(fmt.Sprintf(`{"expected":%d}`, revision)))
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Content-Type", "application/json")
		if account != "" {
			req.Header.Set("X-Jiange-User-Id", account)
		}
		response, e := c.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		return response.StatusCode
	}
	if status := trash("", meta.DriveRevision); status != 400 {
		t.Fatalf("trash missing account %d", status)
	}
	if status := trash("99999", meta.DriveRevision); status != 401 {
		t.Fatalf("trash wrong account %d", status)
	}
	if status := trash(account, meta.DriveRevision+1); status != 409 {
		t.Fatalf("trash stale %d", status)
	}
	if status := trash(account, meta.DriveRevision); status != 204 {
		t.Fatalf("trash %d", status)
	}
}
