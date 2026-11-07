package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestSharedDocumentMetadataDoesNotLeakAfterRevocation(t *testing.T) {
	ts, owner := newTestServer(t, store.NewMemory(), nil)
	jar, _ := cookiejar.New(nil)
	guest := &http.Client{Jar: jar}
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "metadata-owner@x.test", "name": "Owner", "password": "password123"})
	post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "metadata-guest@x.test", "name": "Guest", "password": "password123"})
	var parent, child store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "机密父标题"}).Body).Decode(&parent)
	json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]any{"title": "共享子文档", "parentId": parent.ID}).Body).Decode(&child)
	url := ts.URL + "/api/docs/" + strconv.FormatInt(child.ID, 10)
	if r := send(t, owner, "PUT", url+"/shares", map[string]string{"email": "metadata-guest@x.test", "role": "view"}); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	if r := send(t, guest, "PUT", url+"/star", nil); r.StatusCode != 204 {
		t.Fatal(r.StatusCode)
	}
	r, err := guest.Get(url + "/ancestors")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != 200 || strings.Contains(string(body), "机密父标题") {
		t.Fatalf("ancestors exposed private parent: %d %s", r.StatusCode, body)
	}
	if r := send(t, owner, "PUT", url+"/shares", map[string]string{"email": "metadata-guest@x.test", "role": ""}); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	r, err = guest.Get(ts.URL + "/api/favorites")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != 200 || strings.Contains(string(body), "共享子文档") {
		t.Fatalf("favorites exposed revoked document: %d %s", r.StatusCode, body)
	}
	if r := send(t, owner, "PUT", url+"/shares", map[string]string{"email": "metadata-guest@x.test", "role": "view"}); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	r, err = guest.Get(ts.URL + "/api/favorites")
	if err != nil {
		t.Fatal(err)
	}
	var favorites struct {
		Docs []store.DocMeta `json:"docs"`
	}
	if err := json.NewDecoder(r.Body).Decode(&favorites); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if len(favorites.Docs) != 1 || favorites.Docs[0].ID != child.ID {
		t.Fatalf("favorite not restored after regrant: %+v", favorites.Docs)
	}
}
