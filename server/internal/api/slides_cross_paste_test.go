package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestMemoryCrossPasteImages(t *testing.T) { checkCrossPasteImages(t, store.NewMemory()) }
func TestPostgresCrossPasteImages(t *testing.T) {
	checkCrossPasteImages(t, postgresBaseSecurityStore(t))
}
func checkCrossPasteImages(t *testing.T, st store.Store) {
	t.Helper()
	blobs := blob.NewMemory()
	s := &Server{Store: st, Blobs: blobs, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	res := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "cross-paste-api@example.test", "name": "Owner", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(res.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	create := func() store.DriveEntry {
		t.Helper()
		r := post(t, client, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "Deck", "scope": "personal"})
		defer r.Body.Close()
		var d store.DriveEntry
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("create: %d", r.StatusCode)
		}
		if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
			t.Fatal(err)
		}
		return d
	}
	source, target := create(), create()
	srcPages, err := st.ListSlidesPages(context.Background(), me.User.ID, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	dstPages, err := st.ListSlidesPages(context.Background(), me.User.ID, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
	var upload bytes.Buffer
	form := multipart.NewWriter(&upload)
	part, _ := form.CreateFormFile("file", "test.png")
	_, _ = part.Write(png)
	_ = form.Close()
	req, _ := http.NewRequest("POST", fmt.Sprintf("%s/api/slides/%d/images", ts.URL, source.ID), &upload)
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("X-Jiange-Upload", "1")
	req.Header.Set("X-Jiange-User-Id", fmt.Sprint(me.User.ID))
	res, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var image store.FileMeta
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("upload: %d", res.StatusCode)
	}
	if err = json.NewDecoder(res.Body).Decode(&image); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	image, err = st.GetFile(context.Background(), image.ID)
	if err != nil {
		t.Fatal(err)
	}
	content := fmt.Sprintf(`{"title":"标题","body":"正文","background":"","layout":"","expectedRevision":%d,"notes":"备注","shapes":[{"id":"i","kind":"image","x":1,"y":1,"color":"#ffffff","fileId":%d}]}`, srcPages[0].Revision, image.ID)
	req, _ = http.NewRequest("PATCH", fmt.Sprintf("%s/api/slides/%d/pages/%d/content", ts.URL, source.ID, srcPages[0].ID), bytes.NewBufferString(content))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Jiange-User-Id", fmt.Sprint(me.User.ID))
	req.Header.Set("X-Jiange-Slides-Version", "4")
	res, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var updated store.SlidesPage
	if res.StatusCode != http.StatusOK {
		t.Fatalf("update: %d", res.StatusCode)
	}
	if err = json.NewDecoder(res.Body).Decode(&updated); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	body := fmt.Sprintf(`{"sourceDeckId":%d,"sourceId":%d,"sourceRevision":%d,"anchorId":%d,"anchorRevision":%d}`, source.ID, updated.ID, updated.Revision, dstPages[0].ID, dstPages[0].Revision)
	paste := func(account string) *http.Response {
		t.Helper()
		req, _ := http.NewRequest("POST", fmt.Sprintf("%s/api/slides/%d/pages/paste-from", ts.URL, target.ID), bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		if account != "" {
			req.Header.Set("X-Jiange-User-Id", account)
		}
		r, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		return r
	}
	res = paste("")
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing account: %d", res.StatusCode)
	}
	res.Body.Close()
	res = paste("999999")
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong account: %d", res.StatusCode)
	}
	res.Body.Close()
	if err = blobs.Delete(context.Background(), image.ObjectKey); err != nil {
		t.Fatal(err)
	}
	res = paste(fmt.Sprint(me.User.ID))
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("missing image: %d", res.StatusCode)
	}
	res.Body.Close()
	pages, err := st.ListSlidesPages(context.Background(), me.User.ID, target.ID)
	if err != nil || len(pages) != 1 {
		t.Fatalf("failed paste created page: %+v %v", pages, err)
	}
	if err = blobs.Put(context.Background(), image.ObjectKey, image.Mime, png); err != nil {
		t.Fatal(err)
	}
	res = paste(fmt.Sprint(me.User.ID))
	if res.StatusCode != http.StatusCreated {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("paste: %d %s", res.StatusCode, data)
	}
	var copied struct {
		Page    store.SlidesPage `json:"page"`
		Mapping map[string]int64 `json:"mapping"`
	}
	if err = json.NewDecoder(res.Body).Decode(&copied); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	id := copied.Mapping[fmt.Sprint(image.ID)]
	if id <= 0 || id == image.ID || copied.Page.SlidesID != target.ID {
		t.Fatalf("receipt: %+v", copied)
	}
	res = cGet(t, client, fmt.Sprintf("%s/api/files/%d", ts.URL, id))
	data, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || res.StatusCode != http.StatusOK || !bytes.Equal(data, png) {
		t.Fatalf("copied image: %d %v", res.StatusCode, err)
	}
	res = post(t, client, fmt.Sprintf("%s/api/drive/trash/%d", ts.URL, source.ID), map[string]any{"expected": source.Revision})
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("trash source: %d", res.StatusCode)
	}
	res.Body.Close()
	res = post(t, client, fmt.Sprintf("%s/api/drive/purge/%d", ts.URL, source.ID), map[string]any{"expected": source.Revision + 1, "workspaceId": source.WorkspaceID})
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("purge source: %d", res.StatusCode)
	}
	res.Body.Close()
	res = cGet(t, client, fmt.Sprintf("%s/api/files/%d", ts.URL, id))
	data, err = io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || res.StatusCode != http.StatusOK || !bytes.Equal(data, png) {
		t.Fatalf("target image after source purge: %d %v", res.StatusCode, err)
	}
}
