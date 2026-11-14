package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestMemoryAccountDriveActions(t *testing.T) { checkAccountDriveActions(t, store.NewMemory()) }
func TestPostgresAccountDriveActions(t *testing.T) {
	checkAccountDriveActions(t, postgresBaseSecurityStore(t))
}

func checkAccountDriveActions(t *testing.T, st store.Store) {
	t.Helper()
	ts, client := newTestServer(t, st, nil)
	res := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "account-action@example.test", "name": "User", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(res.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	var folder, doc store.DriveEntry
	res = post(t, client, ts.URL+"/api/drive/folders", map[string]any{"title": "计划", "scope": "personal"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("folder: %d", res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(&folder); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = post(t, client, ts.URL+"/api/drive/nodes", map[string]any{"kind": "doc", "title": "文档", "scope": "personal"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("doc: %d", res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	call := func(method, path, body, account string) int {
		t.Helper()
		req, err := http.NewRequest(method, ts.URL+path, bytes.NewBufferString(body))
		if err != nil {
			t.Fatal(err)
		}
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
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
	pin := fmt.Sprintf("/api/docs/%d/account-pin", doc.ID)
	move := fmt.Sprintf("/api/drive/account-move/%d", doc.ID)
	body := fmt.Sprintf(`{"parentId":%d,"expected":%d}`, folder.ID, doc.Revision)
	if got := call("PUT", pin, "", ""); got != http.StatusBadRequest {
		t.Fatalf("missing pin account: %d", got)
	}
	if got := call("PUT", pin, "", "999999"); got != http.StatusUnauthorized {
		t.Fatalf("wrong pin account: %d", got)
	}
	if got := call("POST", move, body, "999999"); got != http.StatusUnauthorized {
		t.Fatalf("wrong move account: %d", got)
	}
	if got := call("POST", move, body, ""); got != http.StatusBadRequest {
		t.Fatalf("missing move account: %d", got)
	}
	var pins struct {
		Docs []store.DocMeta `json:"docs"`
	}
	res = cGet(t, client, ts.URL+"/api/pins")
	if err := json.NewDecoder(res.Body).Decode(&pins); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if len(pins.Docs) != 0 {
		t.Fatalf("wrong account pinned: %+v", pins.Docs)
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	guest := &http.Client{Jar: jar}
	guestRes := post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "account-action-guest@example.test", "name": "Guest", "password": "password123"})
	var guestMe struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(guestRes.Body).Decode(&guestMe); err != nil {
		t.Fatal(err)
	}
	guestRes.Body.Close()
	share := send(t, client, "PUT", fmt.Sprintf("%s/api/docs/%d/shares", ts.URL, doc.ID), map[string]string{"email": "account-action-guest@example.test", "role": "view"})
	if share.StatusCode != http.StatusOK {
		t.Fatalf("share: %d", share.StatusCode)
	}
	share.Body.Close()
	guestMove, err := http.NewRequest("POST", ts.URL+move, bytes.NewBufferString(body))
	if err != nil {
		t.Fatal(err)
	}
	guestMove.Header.Set("Content-Type", "application/json")
	guestMove.Header.Set("X-Jiange-User-Id", fmt.Sprint(guestMe.User.ID))
	guestResponse, err := guest.Do(guestMove)
	if err != nil {
		t.Fatal(err)
	}
	if guestResponse.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer move: %d", guestResponse.StatusCode)
	}
	guestResponse.Body.Close()
	account := fmt.Sprint(me.User.ID)
	if got := call("PUT", pin, "", account); got != http.StatusNoContent {
		t.Fatalf("pin: %d", got)
	}
	if got := call("POST", move, body, account); got != http.StatusNoContent {
		t.Fatalf("move: %d", got)
	}
	if got := call("POST", move, body, account); got != http.StatusConflict {
		t.Fatalf("stale move: %d", got)
	}
	if got := call("DELETE", pin, "", account); got != http.StatusNoContent {
		t.Fatalf("unpin: %d", got)
	}
	var current store.DocMeta
	res = cGet(t, client, fmt.Sprintf("%s/api/docs/%d", ts.URL, doc.ID))
	if err := json.NewDecoder(res.Body).Decode(&current); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if current.ParentID == nil || *current.ParentID != folder.ID {
		t.Fatalf("wrong destination: %+v", current)
	}
}
