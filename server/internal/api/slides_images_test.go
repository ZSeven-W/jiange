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

type revokeSlidesUpload struct{ store.Store }

func (s revokeSlidesUpload) CreateSlidesFile(ctx context.Context, guard store.RestoreGuard, deck int64, file store.FileMeta) (store.FileMeta, error) {
	if err := s.Store.DeleteSession(ctx, guard.SessionHash); err != nil {
		return store.FileMeta{}, err
	}
	return s.Store.CreateSlidesFile(ctx, guard, deck, file)
}

func TestSlidesUploadRevalidatesSession(t *testing.T) {
	st := store.NewMemory()
	s := &Server{Store: revokeSlidesUpload{st}, Blobs: blob.NewMemory(), Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "revoke-slide@test.dev", "name": "Test", "password": "password123"})
	u, _ := st.UserByEmail(context.Background(), "revoke-slide@test.dev")
	var deck store.DriveEntry
	json.NewDecoder(post(t, c, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "Deck"}).Body).Decode(&deck)
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, _ := form.CreateFormFile("file", "test.png")
	_, _ = part.Write(png)
	_ = form.Close()
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/slides/"+strconv64(deck.ID)+"/images", &body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("X-Jiange-Upload", "1")
	req.Header.Set("X-Jiange-User-Id", strconv64(u.ID))
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expired upload: %d", res.StatusCode)
	}
	if _, err = st.GetFile(context.Background(), 1); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoked upload published file: %v", err)
	}
}

func TestSlidesImageAccessAndReferences(t *testing.T) {
	st := store.NewMemory()
	s := &Server{Store: st, Blobs: blob.NewMemory(), Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	client := func(email string) *http.Client {
		jar, _ := cookiejar.New(nil)
		c := &http.Client{Jar: jar}
		res := post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": email, "name": "Test", "password": "password123"})
		defer res.Body.Close()
		if res.StatusCode != 201 {
			t.Fatalf("register: %d", res.StatusCode)
		}
		return c
	}
	owner, viewer := client("slide-image-owner@test.dev"), client("slide-image-viewer@test.dev")
	user, err := st.UserByEmail(context.Background(), "slide-image-owner@test.dev")
	if err != nil {
		t.Fatal(err)
	}
	create := func() store.DriveEntry {
		res := post(t, owner, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "Deck", "scope": "personal"})
		defer res.Body.Close()
		var d store.DriveEntry
		if err := json.NewDecoder(res.Body).Decode(&d); err != nil || res.StatusCode != 201 {
			t.Fatalf("create: %d %v", res.StatusCode, err)
		}
		return d
	}
	deck, other := create(), create()
	var deckCopy store.DocMeta
	if res := post(t, owner, ts.URL+"/api/docs/"+strconv64(deck.ID)+"/duplicate", nil); res.StatusCode != 201 {
		t.Fatalf("deck copy must publish a full copy: %d", res.StatusCode)
	} else if err := json.NewDecoder(res.Body).Decode(&deckCopy); err != nil || deckCopy.ID == deck.ID || deckCopy.Kind != "slides" {
		t.Fatalf("deck copy meta: %+v %v", deckCopy, err)
	}
	var deckPages, copyPages struct {
		Pages []store.SlidesPage
	}
	_ = json.NewDecoder(cGet(t, owner, ts.URL+"/api/slides/"+strconv64(deck.ID)+"/pages").Body).Decode(&deckPages)
	_ = json.NewDecoder(cGet(t, owner, ts.URL+"/api/slides/"+strconv64(deckCopy.ID)+"/pages").Body).Decode(&copyPages)
	if len(copyPages.Pages) != len(deckPages.Pages) || len(copyPages.Pages) == 0 || copyPages.Pages[0].ID == deckPages.Pages[0].ID {
		t.Fatalf("deck copy pages: %+v vs %+v", copyPages.Pages, deckPages.Pages)
	}
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
	upload := func(c *http.Client, deckID, uid int64, content []byte) (*http.Response, store.FileMeta) {
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		part, _ := form.CreateFormFile("file", "test.png")
		_, _ = part.Write(content)
		_ = form.Close()
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/slides/"+strconv64(deckID)+"/images", &body)
		req.Header.Set("Content-Type", form.FormDataContentType())
		req.Header.Set("X-Jiange-Upload", "1")
		req.Header.Set("X-Jiange-User-Id", strconv64(uid))
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var f store.FileMeta
		_ = json.NewDecoder(res.Body).Decode(&f)
		res.Body.Close()
		return res, f
	}
	if res, _ := upload(owner, deck.ID, user.ID+123, png); res.StatusCode != 401 {
		t.Fatalf("account switch: %d", res.StatusCode)
	}
	if res, _ := upload(owner, deck.ID, user.ID, []byte("<svg></svg>")); res.StatusCode != 400 {
		t.Fatalf("svg accepted: %d", res.StatusCode)
	}
	res, image := upload(owner, deck.ID, user.ID, png)
	if res.StatusCode != 201 || image.DocID != deck.ID || image.Mime != "image/png" {
		t.Fatalf("upload: %d %+v", res.StatusCode, image)
	}
	res, foreign := upload(owner, other.ID, user.ID, png)
	if res.StatusCode != 201 {
		t.Fatalf("other upload: %d", res.StatusCode)
	}
	if res := send(t, owner, "PUT", ts.URL+"/api/docs/"+strconv64(deck.ID)+"/shares", map[string]string{"email": "slide-image-viewer@test.dev", "role": "view"}); res.StatusCode != 200 {
		t.Fatalf("share: %d", res.StatusCode)
	}
	if res := send(t, owner, "PATCH", ts.URL+"/api/docs/"+strconv64(deck.ID), map[string]any{"copyProtected": true}); res.StatusCode != 200 {
		t.Fatalf("protect: %d", res.StatusCode)
	}
	url := ts.URL + "/api/files/" + strconv64(image.ID)
	if res := cGet(t, viewer, url); res.StatusCode != 404 {
		t.Fatalf("unreferenced image visible: %d", res.StatusCode)
	}
	var pages struct{ Pages []store.SlidesPage }
	_ = json.NewDecoder(cGet(t, owner, ts.URL+"/api/slides/"+strconv64(deck.ID)+"/pages").Body).Decode(&pages)
	p := pages.Pages[0]
	shape := func(id int64) []any {
		return []any{map[string]any{"id": "img", "kind": "image", "x": 10, "y": 10, "width": 30, "height": 30, "color": "#ffffff", "fileId": id}}
	}
	patch := func(shapes []any, revision int64) *http.Response {
		return send(t, owner, "PATCH", ts.URL+"/api/slides/pages/"+strconv64(p.ID), map[string]any{"title": "", "body": "", "background": "", "shapes": shapes, "expectedRevision": revision})
	}
	if res := patch(shape(foreign.ID), p.Revision); res.StatusCode != 409 {
		t.Fatalf("foreign image accepted: %d", res.StatusCode)
	}
	if res := patch(shape(image.ID), p.Revision); res.StatusCode != 200 {
		t.Fatalf("attach: %d", res.StatusCode)
	}
	res = cGet(t, viewer, url)
	got, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !bytes.Equal(got, png) {
		t.Fatalf("viewer image: %d", res.StatusCode)
	}
	if res := send(t, owner, "DELETE", url, nil); res.StatusCode != 409 {
		t.Fatalf("attachment deleted: %d", res.StatusCode)
	}
	if res := patch([]any{}, p.Revision+1); res.StatusCode != 200 {
		t.Fatalf("remove image: %d", res.StatusCode)
	}
	if res := cGet(t, viewer, url); res.StatusCode != 404 {
		t.Fatalf("removed image visible: %d", res.StatusCode)
	}
	if res := patch(shape(image.ID), p.Revision+2); res.StatusCode != 200 {
		t.Fatalf("restore image: %d", res.StatusCode)
	}
	// 附图后的整份复制：新文稿获得自己的附件行，图片引用重映射，blob 共享。
	var withImage store.DocMeta
	if res := post(t, owner, ts.URL+"/api/docs/"+strconv64(deck.ID)+"/duplicate", nil); res.StatusCode != 201 {
		t.Fatalf("deck copy with image: %d", res.StatusCode)
	} else if err := json.NewDecoder(res.Body).Decode(&withImage); err != nil {
		t.Fatal(err)
	}
	var imgPages struct {
		Pages []store.SlidesPage
	}
	_ = json.NewDecoder(cGet(t, owner, ts.URL+"/api/slides/"+strconv64(withImage.ID)+"/pages").Body).Decode(&imgPages)
	if len(imgPages.Pages) != 1 {
		t.Fatalf("copy with image pages: %+v", imgPages.Pages)
	}
	var imgShapes []map[string]any
	if err := json.Unmarshal(imgPages.Pages[0].Shapes, &imgShapes); err != nil || len(imgShapes) != 1 {
		t.Fatalf("copy shapes: %s %v", imgPages.Pages[0].Shapes, err)
	}
	remapped := int64(imgShapes[0]["fileId"].(float64))
	if remapped == image.ID {
		t.Fatal("copy still references the source image row")
	}
	original, err := st.GetFile(context.Background(), image.ID)
	if err != nil {
		t.Fatal(err)
	}
	cloned, err := st.GetFile(context.Background(), remapped)
	if err != nil || cloned.DocID != withImage.ID || cloned.ObjectKey != original.ObjectKey || cloned.Mime != original.Mime || cloned.Size != original.Size {
		t.Fatalf("remapped attachment: %+v %v", cloned, err)
	}
	copyPatch := func(fileID int64, revision int64) *http.Response {
		return send(t, owner, "PATCH", ts.URL+"/api/slides/pages/"+strconv64(imgPages.Pages[0].ID), map[string]any{"title": "", "body": "", "background": "", "shapes": shape(fileID), "expectedRevision": revision})
	}
	if res := copyPatch(image.ID, imgPages.Pages[0].Revision); res.StatusCode != 409 {
		t.Fatalf("copy accepted source image: %d", res.StatusCode)
	}
	if res := copyPatch(remapped, imgPages.Pages[0].Revision); res.StatusCode != 200 {
		t.Fatalf("copy edit own image: %d", res.StatusCode)
	}
	if res := send(t, owner, "PUT", ts.URL+"/api/docs/"+strconv64(deck.ID)+"/shares", map[string]string{"email": "slide-image-viewer@test.dev", "role": ""}); res.StatusCode != 200 {
		t.Fatalf("revoke: %d", res.StatusCode)
	}
	if res := cGet(t, viewer, url); res.StatusCode != 404 {
		t.Fatalf("revoked viewer: %d", res.StatusCode)
	}
}
