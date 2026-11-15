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

func TestMemoryAccountSlidesTitle(t *testing.T) { checkAccountSlidesTitle(t, store.NewMemory()) }
func TestPostgresAccountSlidesTitle(t *testing.T) {
	checkAccountSlidesTitle(t, postgresBaseSecurityStore(t))
}

func checkAccountSlidesTitle(t *testing.T, st store.Store) {
	t.Helper()
	ts, client := newTestServer(t, st, nil)
	res := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "rename-slides@example.test", "name": "User", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(res.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = post(t, client, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "旧标题", "scope": "personal"})
	var node store.DriveEntry
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d", res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(&node); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	call := func(account string, revision int64) int {
		t.Helper()
		req, err := http.NewRequest("POST", fmt.Sprintf("%s/api/slides/%d/account-title", ts.URL, node.ID), bytes.NewBufferString(fmt.Sprintf(`{"title":"新标题","expectedTitle":"旧标题","expected":%d}`, revision)))
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
	if got := call("", node.Revision); got != http.StatusBadRequest {
		t.Fatalf("missing account: %d", got)
	}
	if got := call("999999", node.Revision); got != http.StatusUnauthorized {
		t.Fatalf("wrong account: %d", got)
	}
	account := fmt.Sprint(me.User.ID)
	req, err := http.NewRequest("POST", fmt.Sprintf("%s/api/slides/%d/account-title", ts.URL, node.ID), bytes.NewBufferString(`{"title":"新标题"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Jiange-User-Id", account)
	missingRevision, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	missingRevision.Body.Close()
	if missingRevision.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing revision: %d", missingRevision.StatusCode)
	}
	if got := call(account, -1); got != http.StatusBadRequest {
		t.Fatalf("invalid revision: %d", got)
	}
	if got := call(account, node.Revision+1); got != http.StatusConflict {
		t.Fatalf("stale revision: %d", got)
	}
	res = send(t, client, "PATCH", fmt.Sprintf("%s/api/docs/%d", ts.URL, node.ID), map[string]string{"title": "别人的修改"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("legacy rename: %d", res.StatusCode)
	}
	res.Body.Close()
	if got := call(account, node.Revision); got != http.StatusConflict {
		t.Fatalf("stale title: %d", got)
	}
	res = send(t, client, "PATCH", fmt.Sprintf("%s/api/docs/%d", ts.URL, node.ID), map[string]string{"title": "旧标题"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("restore title: %d", res.StatusCode)
	}
	res.Body.Close()
	if got := call(account, node.Revision); got != http.StatusOK {
		t.Fatalf("rename: %d", got)
	}
	if got := call(account, node.Revision); got != http.StatusConflict {
		t.Fatalf("replay: %d", got)
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	viewer := &http.Client{Jar: jar}
	res = post(t, viewer, ts.URL+"/api/auth/register", map[string]string{"email": "rename-viewer@example.test", "name": "Viewer", "password": "password123"})
	var guest struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(res.Body).Decode(&guest); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = send(t, client, "PUT", fmt.Sprintf("%s/api/docs/%d/shares", ts.URL, node.ID), map[string]string{"email": "rename-viewer@example.test", "role": "view"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("share: %d", res.StatusCode)
	}
	res.Body.Close()
	viewerReq, err := http.NewRequest("POST", fmt.Sprintf("%s/api/slides/%d/account-title", ts.URL, node.ID), bytes.NewBufferString(fmt.Sprintf(`{"title":"不允许","expectedTitle":"新标题","expected":%d}`, node.Revision+1)))
	if err != nil {
		t.Fatal(err)
	}
	viewerReq.Header.Set("Content-Type", "application/json")
	viewerReq.Header.Set("X-Jiange-User-Id", fmt.Sprint(guest.User.ID))
	res, err = viewer.Do(viewerReq)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer rename: %d", res.StatusCode)
	}
	res = send(t, client, "PUT", fmt.Sprintf("%s/api/docs/%d/shares", ts.URL, node.ID), map[string]string{"email": "rename-viewer@example.test", "role": "edit"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("grant edit: %d", res.StatusCode)
	}
	res.Body.Close()
	viewerReq, err = http.NewRequest("POST", fmt.Sprintf("%s/api/slides/%d/account-title", ts.URL, node.ID), bytes.NewBufferString(fmt.Sprintf(`{"title":"编辑者名称","expectedTitle":"新标题","expected":%d}`, node.Revision+1)))
	if err != nil {
		t.Fatal(err)
	}
	viewerReq.Header.Set("Content-Type", "application/json")
	viewerReq.Header.Set("X-Jiange-User-Id", fmt.Sprint(guest.User.ID))
	res, err = viewer.Do(viewerReq)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("editor rename: %d", res.StatusCode)
	}
}
