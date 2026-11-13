package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestClipboardAssetsAccessAndRetry(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	blobs := blob.NewMemory()
	s := &Server{Store: st, Blobs: blobs, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	register := func(email string) (*http.Client, store.User) {
		jar, _ := cookiejar.New(nil)
		c := &http.Client{Jar: jar}
		res := post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": email, "name": "Test", "password": "password123"})
		defer res.Body.Close()
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("register %s: %d", email, res.StatusCode)
		}
		var body struct {
			User store.User `json:"user"`
		}
		if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return c, body.User
	}
	owner, ownerUser := register("clip-owner@example.test")
	guest, guestUser := register("clip-guest@example.test")
	create := func(title string) store.DocMeta {
		res := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": title})
		defer res.Body.Close()
		var d store.DocMeta
		if err := json.NewDecoder(res.Body).Decode(&d); err != nil || res.StatusCode != 201 {
			t.Fatalf("create %s: %d %v", title, res.StatusCode, err)
		}
		return d
	}
	source, target := create("源"), create("目标")
	data := []byte("clipboard attachment bytes")
	if err := blobs.Put(ctx, "clip/object", "application/octet-stream", data); err != nil {
		t.Fatal(err)
	}
	file, err := st.CreateFile(ctx, store.FileMeta{DocID: source.ID, UploaderID: ownerUser.ID, Name: "计划.txt", Mime: "application/octet-stream", Size: int64(len(data)), ObjectKey: "clip/object"})
	if err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, target.ID, guestUser.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	request := func(c *http.Client, userID int64, sourceID int64, requestID string, ids []int64) (*http.Response, map[int64]int64) {
		body, _ := json.Marshal(map[string]any{"sourceDocId": sourceID, "requestId": requestID, "fileIds": ids})
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/docs/"+strconv64(target.ID)+"/clipboard-assets", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Jiange-User-Id", strconv64(userID))
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var out struct {
			Mapping map[int64]int64 `json:"mapping"`
		}
		_ = json.NewDecoder(res.Body).Decode(&out)
		res.Body.Close()
		return res, out.Mapping
	}
	id := "0123456789abcdef0123456789abcdef"
	if res, _ := request(guest, guestUser.ID, source.ID, id, []int64{file.ID}); res.StatusCode != 404 {
		t.Fatalf("unshared source: %d", res.StatusCode)
	}
	if err = st.SetShare(ctx, source.ID, guestUser.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	res, mapping := request(guest, guestUser.ID, source.ID, id, []int64{file.ID})
	if res.StatusCode != 200 || mapping[file.ID] <= 0 || mapping[file.ID] == file.ID {
		t.Fatalf("copy: %d %v", res.StatusCode, mapping)
	}
	res, retry := request(guest, guestUser.ID, source.ID, id, []int64{file.ID})
	if res.StatusCode != 200 || retry[file.ID] != mapping[file.ID] {
		t.Fatalf("retry: %d %v", res.StatusCode, retry)
	}
	res, _ = request(guest, ownerUser.ID, source.ID, id, []int64{file.ID})
	if res.StatusCode != 401 {
		t.Fatalf("wrong account: %d", res.StatusCode)
	}
	other, _ := register("clip-reader@example.test")
	reader, err := st.UserByEmail(ctx, "clip-reader@example.test")
	if err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, target.ID, reader.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	res, err = other.Get(ts.URL + "/api/files/" + strconv64(file.ID))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 404 {
		t.Fatalf("reader must not access source file: %d", res.StatusCode)
	}
	res, err = other.Get(ts.URL + "/api/files/" + strconv64(mapping[file.ID]))
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !bytes.Equal(got, data) {
		t.Fatalf("target collaborator cannot read copy: %d %q", res.StatusCode, got)
	}
	if err = st.SetShare(ctx, source.ID, guestUser.ID, ""); err != nil {
		t.Fatal(err)
	}
	if res, _ = request(guest, guestUser.ID, source.ID, id, []int64{file.ID}); res.StatusCode != 404 {
		t.Fatalf("revoked retry: %d", res.StatusCode)
	}
}
