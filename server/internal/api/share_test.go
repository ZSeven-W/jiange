package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// Simulates closing the link after JoinLink commits but before GetDoc reads it.
type closeOnJoinStore struct{ store.Store }

func (s closeOnJoinStore) JoinLink(ctx context.Context, tok string, uid int64) (int64, error) {
	id, err := s.Store.JoinLink(ctx, tok, uid)
	if err == nil {
		err = s.Store.SetLink(ctx, id, store.Link{Role: "none"})
	}
	return id, err
}

func TestLinkClosedBetweenJoinAndRead(t *testing.T) {
	st := closeOnJoinStore{store.NewMemory()}
	ts, owner := newTestServer(t, st, nil)
	client := func() *http.Client { j, _ := cookiejar.New(nil); return &http.Client{Jar: j} }
	guest, invited := client(), client()
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "race-owner@x.test", "name": "Owner", "password": "password123"})
	post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "race-guest@x.test", "name": "Guest", "password": "password123"})
	post(t, invited, ts.URL+"/api/auth/register", map[string]string{"email": "race-invited@x.test", "name": "Invited", "password": "password123"})
	var d store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "doc"}).Body).Decode(&d)
	u := ts.URL + "/api/docs/" + strconv.FormatInt(d.ID, 10)
	if res := send(t, owner, "PUT", u+"/shares", map[string]string{"email": "race-invited@x.test", "role": "view"}); res.StatusCode != 200 {
		t.Fatalf("invite: %d", res.StatusCode)
	}
	var link store.Link
	json.NewDecoder(send(t, owner, "PUT", u+"/link", map[string]string{"role": "edit"}).Body).Decode(&link)
	if res := post(t, guest, ts.URL+"/api/share/"+link.Token, nil); res.StatusCode != 404 {
		t.Fatalf("concurrent close must return 404: %d", res.StatusCode)
	}
	json.NewDecoder(send(t, owner, "PUT", u+"/link", map[string]string{"role": "edit"}).Body).Decode(&link)
	res := post(t, invited, ts.URL+"/api/share/"+link.Token, nil)
	var got store.DocMeta
	json.NewDecoder(res.Body).Decode(&got)
	if res.StatusCode != 200 || got.Role != "view" {
		t.Fatalf("direct invitation must survive: status=%d role=%q", res.StatusCode, got.Role)
	}
}

func TestDisabledLegacyTokenNeverDisclosedOrReused(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "legacy-token@x.test", "name": "Owner", "password": "password123"})
	var d store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "doc"}).Body).Decode(&d)
	u := ts.URL + "/api/docs/" + strconv.FormatInt(d.ID, 10)
	// Old installations could retain a token while link_role was disabled.
	if err := st.SetLink(context.Background(), d.ID, store.Link{Role: "none", Token: "old-disabled-token"}); err != nil {
		t.Fatal(err)
	}
	res := cGet(t, owner, u+"/shares")
	b, _ := io.ReadAll(res.Body)
	if strings.Contains(string(b), "old-disabled-token") {
		t.Fatalf("disabled token was disclosed: %s", b)
	}
	var link store.Link
	json.NewDecoder(send(t, owner, "PUT", u+"/link", map[string]string{"role": "view"}).Body).Decode(&link)
	if link.Token == "" || link.Token == "old-disabled-token" {
		t.Fatal("legacy disabled token was reused")
	}
	guest := &http.Client{}
	if res := post(t, guest, ts.URL+"/api/share/old-disabled-token", nil); res.StatusCode != 401 {
		t.Fatalf("anonymous join should require login: %d", res.StatusCode)
	}
	if res, err := guest.Get(ts.URL + "/api/public/old-disabled-token"); err != nil || res.StatusCode != 404 || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("old token remained public or cacheable: %v %v", res, err)
	}
}

func send(t *testing.T, c *http.Client, method, url string, body any) *http.Response {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(method, url, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestSharingRolesLinkAndFiles(t *testing.T) {
	st := store.NewMemory()
	s := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 1000, Blobs: blob.NewMemory()}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	client := func() *http.Client { j, _ := cookiejar.New(nil); return &http.Client{Jar: j} }
	kay, bob, eve := client(), client(), client()
	post(t, kay, ts.URL+"/api/auth/register", map[string]string{"email": "kay@x.com", "name": "Kay", "password": "password123"})
	post(t, bob, ts.URL+"/api/auth/register", map[string]string{"email": "bob@x.com", "name": "Bob", "password": "password123"})
	post(t, eve, ts.URL+"/api/auth/register", map[string]string{"email": "eve@x.com", "name": "Eve", "password": "password123"})
	var d, child store.DocMeta
	json.NewDecoder(post(t, kay, ts.URL+"/api/docs", map[string]string{"title": "方案"}).Body).Decode(&d)
	json.NewDecoder(post(t, kay, ts.URL+"/api/docs", map[string]any{"title": "子页", "parentId": d.ID}).Body).Decode(&child)
	docURL := ts.URL + "/api/docs/" + strconv.FormatInt(d.ID, 10)
	childURL := ts.URL + "/api/docs/" + strconv.FormatInt(child.ID, 10)

	if res, _ := bob.Get(docURL); res.StatusCode != 404 {
		t.Fatalf("bob before share: %d", res.StatusCode)
	}
	if res := send(t, kay, "PUT", docURL+"/shares", map[string]string{"email": "bob@x.com", "role": "view"}); res.StatusCode != 200 {
		t.Fatalf("share: %d", res.StatusCode)
	}
	var got store.DocMeta
	res, _ := bob.Get(childURL) // inherited from parent
	json.NewDecoder(res.Body).Decode(&got)
	if res.StatusCode != 200 || got.Role != "view" {
		t.Fatalf("bob child: %d %+v", res.StatusCode, got)
	}
	if res := send(t, bob, "PATCH", docURL, map[string]string{"title": "x"}); res.StatusCode != 403 {
		t.Fatalf("viewer rename: %d", res.StatusCode)
	}
	if res := send(t, bob, "PUT", docURL+"/shares", map[string]string{"email": "eve@x.com", "role": "edit"}); res.StatusCode != 403 {
		t.Fatalf("viewer share: %d", res.StatusCode)
	}
	res, _ = bob.Get(ts.URL + "/api/shared")
	var shared struct{ Docs []store.DocMeta }
	json.NewDecoder(res.Body).Decode(&shared)
	if len(shared.Docs) != 1 || shared.Docs[0].ID != d.ID {
		t.Fatalf("shared: %+v", shared)
	}

	// link sharing grants edit to anyone signed in with the token
	var l store.Link
	json.NewDecoder(send(t, kay, "PUT", docURL+"/link", map[string]string{"role": "edit"}).Body).Decode(&l)
	if l.Token == "" || l.Role != "edit" {
		t.Fatalf("link: %+v", l)
	}
	json.NewDecoder(post(t, eve, ts.URL+"/api/share/"+l.Token, nil).Body).Decode(&got)
	if got.ID != d.ID || got.Role != "edit" {
		t.Fatalf("join: %+v", got)
	}
	if res := send(t, eve, "PATCH", docURL, map[string]string{"title": "方案 v2"}); res.StatusCode != 200 {
		t.Fatalf("editor rename: %d", res.StatusCode)
	}
	if res := send(t, eve, "DELETE", docURL, nil); res.StatusCode != 403 {
		t.Fatalf("editor delete: %d", res.StatusCode)
	}
	// attachments: editors upload, viewers read, outsiders get 404
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "图.png")
	fw.Write([]byte("\x89PNG\r\n\x1a\nfake"))
	mw.Close()
	req, _ := http.NewRequest("POST", docURL+"/files", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if res, _ := eve.Do(req); res.StatusCode != 415 {
		t.Fatalf("upload without header: %d", res.StatusCode)
	}
	buf.Reset()
	mw = multipart.NewWriter(&buf)
	fw, _ = mw.CreateFormFile("file", "图.png")
	fw.Write([]byte("\x89PNG\r\n\x1a\nfake"))
	mw.Close()
	req, _ = http.NewRequest("POST", docURL+"/files", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("X-Jiange-Upload", "1")
	res, _ = eve.Do(req)
	var f store.FileMeta
	json.NewDecoder(res.Body).Decode(&f)
	if res.StatusCode != 201 || f.Size != 12 {
		t.Fatalf("upload: %d %+v", res.StatusCode, f)
	}
	res, _ = bob.Get(ts.URL + "/api/files/" + strconv.FormatInt(f.ID, 10))
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || string(b[:4]) != "\x89PNG" {
		t.Fatalf("viewer download: %d", res.StatusCode)
	}
	if res.Header.Get("Cache-Control") != "private, no-store" {
		t.Fatalf("permission-protected attachment may be cached: %q", res.Header.Get("Cache-Control"))
	}
	send(t, kay, "PUT", docURL+"/link", map[string]string{"role": "none"})
	if res := post(t, bob, ts.URL+"/api/share/"+l.Token, nil); res.StatusCode != 404 {
		t.Fatalf("disabled link: %d", res.StatusCode)
	}
	if res, _ := eve.Get(docURL); res.StatusCode != 404 {
		t.Fatalf("link participant should lose access on close: %d", res.StatusCode)
	}
	if res, _ := eve.Get(ts.URL + "/api/files/" + strconv.FormatInt(f.ID, 10)); res.StatusCode != 404 {
		t.Fatalf("revoked link attachment: %d", res.StatusCode)
	}
	if res, _ := bob.Get(docURL); res.StatusCode != 200 {
		t.Fatalf("direct invitation should survive closing link: %d", res.StatusCode)
	}
	send(t, kay, "PUT", docURL+"/shares", map[string]string{"email": "bob@x.com", "role": ""})
	if res, _ := bob.Get(ts.URL + "/api/files/" + strconv.FormatInt(f.ID, 10)); res.StatusCode != 404 {
		t.Fatalf("revoked download: %d", res.StatusCode)
	}
}

func TestLinkGrantTracksLinkAndPreservesInvitations(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	client := func() *http.Client { j, _ := cookiejar.New(nil); return &http.Client{Jar: j} }
	alice, bob := client(), client()
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "owner@link.test", "name": "Owner", "password": "password123"})
	post(t, alice, ts.URL+"/api/auth/register", map[string]string{"email": "alice@link.test", "name": "Alice", "password": "password123"})
	post(t, bob, ts.URL+"/api/auth/register", map[string]string{"email": "bob@link.test", "name": "Bob", "password": "password123"})
	var parent, child store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "parent"}).Body).Decode(&parent)
	json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]any{"title": "child", "parentId": parent.ID}).Body).Decode(&child)
	url := ts.URL + "/api/docs/" + strconv.FormatInt(parent.ID, 10)
	childURL := ts.URL + "/api/docs/" + strconv.FormatInt(child.ID, 10)
	if res := send(t, owner, "PUT", url+"/shares", map[string]string{"email": "alice@link.test", "role": "view"}); res.StatusCode != 200 {
		t.Fatalf("invite: %d", res.StatusCode)
	}
	var link store.Link
	json.NewDecoder(send(t, owner, "PUT", url+"/link", map[string]string{"role": "edit"}).Body).Decode(&link)
	for _, c := range []*http.Client{alice, bob} {
		if res := post(t, c, ts.URL+"/api/share/"+link.Token, nil); res.StatusCode != 200 {
			t.Fatalf("join: %d", res.StatusCode)
		}
	}
	check := func(c *http.Client, docURL string, status int, role string) {
		t.Helper()
		res, err := c.Get(docURL)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != status {
			t.Fatalf("GET %s = %d, want %d", docURL, res.StatusCode, status)
		}
		if status == 200 {
			var d store.DocMeta
			if err := json.NewDecoder(res.Body).Decode(&d); err != nil || d.Role != role {
				t.Fatalf("role = %q want %q: %v", d.Role, role, err)
			}
		}
	}
	check(alice, url, 200, "edit")
	check(bob, childURL, 200, "edit") // link grant is inherited
	var shares struct{ Members []store.Share }
	json.NewDecoder(cGet(t, owner, url+"/shares").Body).Decode(&shares)
	if len(shares.Members) != 1 || shares.Members[0].Role != "view" {
		t.Fatalf("link must not overwrite invitation: %+v", shares.Members)
	}
	if res := send(t, owner, "PUT", url+"/link", map[string]string{"role": "view"}); res.StatusCode != 200 {
		t.Fatalf("downgrade: %d", res.StatusCode)
	}
	check(alice, url, 200, "view")
	check(bob, childURL, 200, "view")
	if res := send(t, bob, "PATCH", url, map[string]string{"title": "denied"}); res.StatusCode != 403 {
		t.Fatalf("downgraded write: %d", res.StatusCode)
	}
	if res := send(t, owner, "PUT", url+"/shares", map[string]string{"email": "alice@link.test", "role": "edit"}); res.StatusCode != 200 {
		t.Fatalf("upgrade invitation: %d", res.StatusCode)
	}
	closed := send(t, owner, "PUT", url+"/link", map[string]string{"role": "none"})
	closedBody, _ := io.ReadAll(closed.Body)
	if closed.StatusCode != 200 || strings.Contains(string(closedBody), link.Token) {
		t.Fatalf("close response exposed token: %d %s", closed.StatusCode, closedBody)
	}
	closedShares := cGet(t, owner, url+"/shares")
	closedSharesBody, _ := io.ReadAll(closedShares.Body)
	if strings.Contains(string(closedSharesBody), link.Token) {
		t.Fatal("disabled link token exposed in shares")
	}
	check(alice, childURL, 200, "edit")
	check(bob, url, 404, "")
	check(bob, childURL, 404, "")
	var shared struct{ Docs []store.DocMeta }
	json.NewDecoder(cGet(t, bob, ts.URL+"/api/shared").Body).Decode(&shared)
	if len(shared.Docs) != 0 {
		t.Fatalf("closed link remains shared: %+v", shared.Docs)
	}
	// Re-enabling does not restore an old grant until the link is visited again.
	oldToken := link.Token
	link = store.Link{}
	json.NewDecoder(send(t, owner, "PUT", url+"/link", map[string]string{"role": "view"}).Body).Decode(&link)
	if link.Token == "" || link.Token == oldToken {
		t.Fatalf("reopened link must use a new token")
	}
	if res := post(t, bob, ts.URL+"/api/share/"+oldToken, nil); res.StatusCode != 404 {
		t.Fatalf("old link regained access after reopen: %d", res.StatusCode)
	}
	check(bob, url, 404, "")
	if res := post(t, bob, ts.URL+"/api/share/"+link.Token, nil); res.StatusCode != 200 {
		t.Fatalf("rejoin: %d", res.StatusCode)
	}
	check(bob, url, 200, "view")
}

func TestPublicAnonLink(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "an@x.com", "name": "AN", "password": "password123"})
	var d store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/docs", map[string]string{"title": "公开文档"}).Body).Decode(&d)
	u := ts.URL + "/api/docs/" + strconv.FormatInt(d.ID, 10)
	send(t, c, "PUT", u+"/link", map[string]string{"role": "anon"})
	var link store.Link
	json.NewDecoder(send(t, c, "PUT", u+"/link", map[string]string{"role": "anon"}).Body).Decode(&link)

	// 匿名（无 cookie）读快照
	anon := &http.Client{}
	res, err := anon.Get(ts.URL + "/api/public/" + link.Token)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("public get: %v %v", err, res)
	}
	if res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("public snapshot may be cached: %q", res.Header.Get("Cache-Control"))
	}
	var snap struct {
		Title string
		View  map[string]any
	}
	json.NewDecoder(res.Body).Decode(&snap)
	if snap.Title != "公开文档" {
		t.Fatalf("snapshot: %+v", snap)
	}

	// view 链接（非 anon）不给匿名快照
	send(t, c, "PUT", u+"/link", map[string]string{"role": "view"})
	res2, err := anon.Get(ts.URL + "/api/public/" + link.Token)
	if err != nil {
		t.Fatal(err)
	}
	if res2.StatusCode != 401 {
		t.Fatalf("view link should require login: %d", res2.StatusCode)
	}
}
