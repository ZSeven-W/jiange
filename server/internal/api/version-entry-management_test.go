package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestManageSavedVersionEntry(t *testing.T) {
	e := newCopyTestEnv(t)
	e.share(t)
	ctx := context.Background()
	seedDoc(t, &Server{Store: e.store}, e.source.ID, "只属于这个版本")
	epoch, head, err := e.store.HeadVersion(ctx, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	create := func(label, request string) store.VersionEntry {
		body, _ := json.Marshal(map[string]any{"label": label, "historyEpoch": epoch, "expectedSeq": head, "requestId": request})
		req, _ := http.NewRequest("POST", e.url()+"/version-entries", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(e.ownerUser.ID, 10))
		resp, err := e.owner.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var v store.VersionEntry
		if err = json.NewDecoder(resp.Body).Decode(&v); err != nil || resp.StatusCode != 201 {
			t.Fatalf("create %d: %v", resp.StatusCode, err)
		}
		return v
	}
	one, two := create("初稿", strings.Repeat("a", 32)), create("交付稿", strings.Repeat("b", 32))
	manage := func(client *http.Client, user int64, id string, body map[string]any) int {
		t.Helper()
		data, _ := json.Marshal(body)
		req, _ := http.NewRequest("PATCH", e.url()+"/version-entries/"+url.PathEscape(id), bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(user, 10))
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}
	rename := map[string]any{"action": "rename", "expectedRevision": 1, "label": "新名称"}
	del := map[string]any{"action": "delete", "expectedRevision": 1}
	if got := manage(e.guest, e.guestUser.ID, one.ID, rename); got != 403 && got != 404 {
		t.Fatalf("viewer rename %d", got)
	}
	if got := manage(e.owner, e.ownerUser.ID, one.ID, rename); got != 204 {
		t.Fatalf("rename %d", got)
	}
	if got := manage(e.owner, e.ownerUser.ID, one.ID, del); got != 409 {
		t.Fatalf("stale delete %d", got)
	}
	del["expectedRevision"] = 2
	if got := manage(e.owner, e.ownerUser.ID, one.ID, del); got != 204 {
		t.Fatalf("delete %d", got)
	}
	get := func(entry string) (int, []byte) {
		req, _ := http.NewRequest("GET", e.url()+"/version-entries/"+url.PathEscape(entry)+"/preview", nil)
		req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(e.guestUser.ID, 10))
		r, err := e.guest.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		return r.StatusCode, b
	}
	if status, body := get(one.ID); status != 404 || bytes.Contains(body, []byte("只属于这个版本")) {
		t.Fatalf("deleted link: %d %s", status, body)
	}
	if status, body := get(two.ID); status != 200 || !bytes.Contains(body, []byte("只属于这个版本")) {
		t.Fatalf("other entry: %d %s", status, body)
	}
	trash := func(client *http.Client, user int64) (int, []byte) {
		req, _ := http.NewRequest("GET", e.url()+"/version-entries/trash", nil)
		req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(user, 10))
		r, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		return r.StatusCode, b
	}
	if status, _ := trash(e.guest, e.guestUser.ID); status != 403 && status != 404 {
		t.Fatalf("viewer trash %d", status)
	}
	if status, body := trash(e.owner, e.ownerUser.ID); status != 200 || !bytes.Contains(body, []byte("新名称")) {
		t.Fatalf("trash: %d %s", status, body)
	}
	if got := manage(e.guest, e.guestUser.ID, one.ID, map[string]any{"action": "restore", "expectedRevision": 3}); got != 403 && got != 404 {
		t.Fatalf("viewer restore: %d", got)
	}
	if got := manage(e.owner, e.ownerUser.ID, one.ID, map[string]any{"action": "restore", "expectedRevision": 2}); got != 409 {
		t.Fatalf("stale restore: %d", got)
	}
	if got := manage(e.owner, e.ownerUser.ID, one.ID, map[string]any{"action": "restore", "expectedRevision": 3}); got != 204 {
		t.Fatalf("restore: %d", got)
	}
	if status, body := get(one.ID); status != 200 || !bytes.Contains(body, []byte("只属于这个版本")) {
		t.Fatalf("restored link: %d %s", status, body)
	}
	if status, body := trash(e.owner, e.ownerUser.ID); status != 200 || bytes.Contains(body, []byte("新名称")) {
		t.Fatalf("restored still trashed: %d %s", status, body)
	}
	for _, body := range []map[string]any{{"action": "rename", "expectedRevision": 1, "label": " "}, {"action": "delete", "expectedRevision": 1, "label": "bad"}, {"action": "delete", "expectedRevision": 0}} {
		if got := manage(e.owner, e.ownerUser.ID, two.ID, body); got != 400 {
			t.Fatalf("invalid body %v: %d", body, got)
		}
	}
}
