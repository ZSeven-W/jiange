package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

func TestDocsAndSyncEndpoint(t *testing.T) {
	st := store.NewMemory()
	s := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 1000,
		Hub: &syncsrv.Hub{Store: st}}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}

	if res, _ := c.Get(ts.URL + "/api/docs"); res.StatusCode != 401 {
		t.Fatalf("docs without session: %d", res.StatusCode)
	}
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "kay@example.com", "name": "Kay", "password": "password123"})
	res := post(t, c, ts.URL+"/api/docs", map[string]string{"title": " 周报 "})
	var d store.DocMeta
	_ = json.NewDecoder(res.Body).Decode(&d)
	if res.StatusCode != 201 || d.Title != "周报" {
		t.Fatalf("create: %d %+v", res.StatusCode, d)
	}
	b, _ := json.Marshal(map[string]string{"title": "周报 v2"})
	req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/docs/"+strconv.FormatInt(d.ID, 10), bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if res, _ := c.Do(req); res.StatusCode != 200 {
		t.Fatalf("patch: %d", res.StatusCode)
	}
	res, _ = c.Get(ts.URL + "/api/docs")
	var list struct{ Docs []store.DocMeta }
	_ = json.NewDecoder(res.Body).Decode(&list)
	if len(list.Docs) != 1 || list.Docs[0].Title != "周报 v2" {
		t.Fatalf("list: %+v", list)
	}
	if res, _ := c.Get(ts.URL + "/api/docs/999"); res.StatusCode != 404 {
		t.Fatalf("missing doc: %d", res.StatusCode)
	}

	// the sync socket authenticates with the session cookie
	u := strings.Replace(ts.URL, "http", "ws", 1) + "/api/sync"
	if _, _, err := websocket.Dial(t.Context(), u, nil); err == nil {
		t.Fatal("anonymous sync socket accepted")
	}
	ws, _, err := websocket.Dial(t.Context(), u, &websocket.DialOptions{HTTPClient: c})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	_ = ws.Write(t.Context(), websocket.MessageBinary, collab.EncodeHello(uint64(d.ID), 0, 0))
	_, msg, err := ws.Read(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	m, _ := collab.DecodeServerMsg(msg)
	if m.Type != collab.MsgWelcome || m.ClientID == 0 || m.HeadSeq != 3 {
		t.Fatalf("welcome %+v", m)
	}
}

func TestTrashAndMove(t *testing.T) {
	st := store.NewMemory()
	s := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 1000}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "k@example.com", "name": "K", "password": "password123"})
	mk := func(body any) store.DocMeta {
		var d store.DocMeta
		_ = json.NewDecoder(post(t, c, ts.URL+"/api/docs", body).Body).Decode(&d)
		return d
	}
	parent := mk(map[string]any{"title": "p"})
	child := mk(map[string]any{"title": "c", "parentId": parent.ID})
	do := func(method, path string, body any) int {
		b, _ := json.Marshal(body)
		req, _ := http.NewRequest(method, ts.URL+path, bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode
	}
	if code := do("PATCH", "/api/docs/"+strconv.FormatInt(parent.ID, 10), map[string]any{"move": true, "parentId": child.ID}); code != 409 {
		t.Fatalf("cycle move: %d", code)
	}
	if code := do("PATCH", "/api/docs/"+strconv.FormatInt(child.ID, 10), map[string]any{"move": true, "parentId": nil}); code != 200 {
		t.Fatalf("move to root: %d", code)
	}
	_ = do("PATCH", "/api/docs/"+strconv.FormatInt(child.ID, 10), map[string]any{"move": true, "parentId": parent.ID})
	if code := do("DELETE", "/api/docs/"+strconv.FormatInt(parent.ID, 10), nil); code != 204 {
		t.Fatalf("trash: %d", code)
	}
	res, _ := c.Get(ts.URL + "/api/docs")
	var list struct{ Docs []store.DocMeta }
	_ = json.NewDecoder(res.Body).Decode(&list)
	if len(list.Docs) != 0 {
		t.Fatalf("trashed subtree still listed: %+v", list.Docs)
	}
	if code := do("POST", "/api/trash/"+strconv.FormatInt(parent.ID, 10)+"/restore", nil); code != 204 {
		t.Fatalf("restore: %d", code)
	}
	res, _ = c.Get(ts.URL + "/api/docs")
	_ = json.NewDecoder(res.Body).Decode(&list)
	if len(list.Docs) != 2 {
		t.Fatalf("restore: %+v", list.Docs)
	}
}
