package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
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

type revokeImportUpload struct {
	store.Store
	underlying *store.Memory
}

func (s revokeImportUpload) CreateDocImportImage(ctx context.Context, g store.RestoreGuard, id int64, f store.FileMeta) (store.FileMeta, error) {
	if err := s.Store.DeleteSession(ctx, g.SessionHash); err != nil {
		return store.FileMeta{}, err
	}
	return s.underlying.CreateDocImportImage(ctx, g, id, f)
}

func TestDocImportImageSessionAndAccount(t *testing.T) {
	for _, revoke := range []bool{false, true} {
		t.Run(map[bool]string{false: "account", true: "revoked"}[revoke], func(t *testing.T) {
			mem := store.NewMemory()
			var st store.Store = mem
			if revoke {
				st = revokeImportUpload{Store: mem, underlying: mem}
			}
			s := &Server{Store: st, Blobs: blob.NewMemory(), Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
			ts := httptest.NewServer(s.Handler())
			defer ts.Close()
			jar, _ := cookiejar.New(nil)
			c := &http.Client{Jar: jar}
			res := post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "import@test.dev", "name": "测试", "password": "password123"})
			res.Body.Close()
			u, err := mem.UserByEmail(context.Background(), "import@test.dev")
			if err != nil {
				t.Fatal(err)
			}
			var doc store.DocMeta
			res = post(t, c, ts.URL+"/api/docs", map[string]string{"title": "导入图片"})
			if err := json.NewDecoder(res.Body).Decode(&doc); err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
			upload := func(uid string) int {
				var body bytes.Buffer
				form := multipart.NewWriter(&body)
				part, _ := form.CreateFormFile("file", "word-image.png")
				_, _ = part.Write(png)
				_ = form.Close()
				req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/docs/"+strconv64(doc.ID)+"/import-images", &body)
				req.Header.Set("Content-Type", form.FormDataContentType())
				req.Header.Set("X-Jiange-Upload", "1")
				if uid != "" {
					req.Header.Set("X-Jiange-User-Id", uid)
				}
				r, err := c.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer r.Body.Close()
				return r.StatusCode
			}
			if got := upload(""); got != 400 {
				t.Fatalf("missing account: %d", got)
			}
			if got := upload("999999"); got != 401 {
				t.Fatalf("wrong account: %d", got)
			}
			want := 201
			if revoke {
				want = 401
			}
			if got := upload(strconv64(u.ID)); got != want {
				t.Fatalf("upload: got %d want %d", got, want)
			}
			_, err = mem.GetFile(context.Background(), 1)
			if revoke && !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("revoked upload published metadata: %v", err)
			}
			if !revoke && err != nil {
				t.Fatalf("missing uploaded metadata: %v", err)
			}
		})
	}
}
