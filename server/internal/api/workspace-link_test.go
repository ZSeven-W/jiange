package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestWorkspaceLinkGuardedAPI(t *testing.T) {
	e := newCopyTestEnv(t)
	ctx := context.Background()
	if err := e.store.AddWorkspaceMember(ctx, e.ownerSpace.ID, e.guestUser.ID); err != nil {
		t.Fatal(err)
	}
	jar, _ := cookiejar.New(nil)
	outsider := &http.Client{Jar: jar}
	r := post(t, outsider, e.server.URL+"/api/auth/register", map[string]string{"email": "workspace-outsider@example.test", "name": "Outside", "password": "password123"})
	defer r.Body.Close()
	var me meResponse
	if err := json.NewDecoder(r.Body).Decode(&me); err != nil || r.StatusCode != 201 {
		t.Fatalf("register: %d %v", r.StatusCode, err)
	}
	u, _ := url.Parse(e.server.URL)
	var token string
	for _, c := range e.owner.Jar.Cookies(u) {
		if c.Name == CookieName {
			token = c.Value
		}
	}
	if token == "" {
		t.Fatal("missing owner session")
	}
	guard := store.RestoreGuard{UserID: e.ownerUser.ID, SessionHash: auth.HashToken(token)}
	node, err := e.store.CreateDriveNode(ctx, guard, e.ownerSpace.ID, nil, "doc", "Private", true)
	if err != nil {
		t.Fatal(err)
	}
	body := bytes.NewBufferString(`{"role":"workspace_view","expectedRevision":0}`)
	req, _ := http.NewRequest("PUT", e.server.URL+"/api/docs/"+strconv.FormatInt(node.ID, 10)+"/link-guarded", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(e.ownerUser.ID, 10))
	r, err = e.owner.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	var link store.Link
	if err = json.NewDecoder(r.Body).Decode(&link); err != nil || r.StatusCode != 200 || link.Role != store.LinkWorkspaceView || link.Token == "" {
		t.Fatalf("scope: %d %+v %v", r.StatusCode, link, err)
	}
	join := func(client *http.Client, uid int64) (int, []byte) {
		t.Helper()
		req, _ := http.NewRequest("POST", e.server.URL+"/api/share/"+link.Token+"/join-guarded", nil)
		if uid > 0 {
			req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(uid, 10))
		}
		r, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		return r.StatusCode, b
	}
	if code, _ := join(e.guest, 0); code != 400 {
		t.Fatalf("missing account: %d", code)
	}
	if code, _ := join(e.guest, me.User.ID); code != 401 {
		t.Fatalf("wrong account: %d", code)
	}
	if code, b := join(outsider, me.User.ID); code != 404 || bytes.Contains(b, []byte("Private")) {
		t.Fatalf("outsider: %d %s", code, b)
	}
	if code, b := join(e.guest, e.guestUser.ID); code != 200 || !bytes.Contains(b, []byte(`"role":"view"`)) {
		t.Fatalf("member: %d %s", code, b)
	}
	public, err := http.Get(e.server.URL + "/api/public/" + link.Token)
	if err != nil {
		t.Fatal(err)
	}
	defer public.Body.Close()
	if public.StatusCode != 401 {
		t.Fatalf("scope was public: %d", public.StatusCode)
	}
}
