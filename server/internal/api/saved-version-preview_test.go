package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestSavedVersionEntryPreview(t *testing.T) {
	ctx := context.Background()
	e := newCopyTestEnv(t)
	e.share(t)
	seedDoc(t, &Server{Store: e.store}, e.source.ID, "可分享的版本")
	if n, err := SweepAutomaticVersions(ctx, e.store, nil); err != nil || n != 1 {
		t.Fatalf("automatic version: %d %v", n, err)
	}
	epoch, head, err := e.store.HeadVersion(ctx, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	create := func(label, request string) store.VersionEntry {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"label": label, "historyEpoch": epoch, "expectedSeq": head, "requestId": request})
		req, _ := http.NewRequest("POST", e.url()+"/version-entries", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(e.ownerUser.ID, 10))
		r, err := e.owner.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		var v store.VersionEntry
		if err = json.NewDecoder(r.Body).Decode(&v); err != nil || r.StatusCode != 201 {
			t.Fatalf("create: %d %v", r.StatusCode, err)
		}
		return v
	}
	first := create("交付版", strings.Repeat("a", 32))
	second := create("审阅版", strings.Repeat("b", 32))
	if first.ID == second.ID || first.Seq != second.Seq {
		t.Fatal("fixture must have two entries at the same sequence")
	}
	get := func(server string, client *http.Client, entry string, uid int64) (int, []byte) {
		t.Helper()
		req, _ := http.NewRequest("GET", server+"/api/docs/"+strconv.FormatInt(e.source.ID, 10)+"/version-entries/"+url.PathEscape(entry)+"/preview", nil)
		if uid > 0 {
			req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(uid, 10))
		}
		r, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		body, _ := io.ReadAll(r.Body)
		if r.StatusCode != http.StatusUnauthorized && r.Header.Get("Cache-Control") != "private, no-store" {
			t.Fatalf("cache control %q", r.Header.Get("Cache-Control"))
		}
		return r.StatusCode, body
	}
	for _, entry := range []store.VersionEntry{first, second} {
		status, body := get(e.server.URL, e.guest, entry.ID, e.guestUser.ID)
		var out struct {
			ID  string `json:"id"`
			Seq int64  `json:"seq"`
		}
		if status != 200 || json.Unmarshal(body, &out) != nil || out.ID != entry.ID || out.Seq != entry.Seq || !bytes.Contains(body, []byte("可分享的版本")) {
			t.Fatalf("preview: %d %s", status, body)
		}
	}
	for _, bad := range []string{"n:0", "n:999999", "s:" + strconv.FormatInt(head, 10), "n:9007199254740992", "oops"} {
		if status, _ := get(e.server.URL, e.guest, bad, e.guestUser.ID); status != 404 {
			t.Fatalf("invalid %s: %d", bad, status)
		}
	}
	if status, _ := get(e.server.URL, e.guest, first.ID, e.ownerUser.ID); status != 401 {
		t.Fatalf("wrong account: %d", status)
	}
	if status, _ := get(e.server.URL, e.guest, first.ID, 0); status != 400 {
		t.Fatalf("missing account: %d", status)
	}
	if status, _ := get(e.server.URL, &http.Client{}, first.ID, e.guestUser.ID); status != 401 {
		t.Fatalf("anonymous access: %d", status)
	}
	traced := &versionReadRaceStore{Memory: e.store}
	traced.afterVersionRead = func() {
		if err := e.store.SetShare(ctx, e.source.ID, e.guestUser.ID, ""); err != nil {
			t.Error(err)
		}
	}
	tracedServer := httptest.NewServer((&Server{Store: traced, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}).Handler())
	defer tracedServer.Close()
	if status, body := get(tracedServer.URL, e.guest, first.ID, e.guestUser.ID); status != 404 || bytes.Contains(body, []byte("可分享的版本")) {
		t.Fatalf("revoked during read: %d %s", status, body)
	}
}
