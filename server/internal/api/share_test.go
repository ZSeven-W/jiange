package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

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
	send(t, kay, "PUT", docURL+"/link", map[string]string{"role": "none"})
	if res := post(t, bob, ts.URL+"/api/share/"+l.Token, nil); res.StatusCode != 404 {
		t.Fatalf("disabled link: %d", res.StatusCode)
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
	send(t, kay, "PUT", docURL+"/shares", map[string]string{"email": "bob@x.com", "role": ""})
	if res, _ := bob.Get(ts.URL + "/api/files/" + strconv.FormatInt(f.ID, 10)); res.StatusCode != 404 {
		t.Fatalf("revoked download: %d", res.StatusCode)
	}
}
