package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// uploadSlidesImage publishes an attachment only after rechecking the editing
// session and deck permission in the metadata transaction.
func (s *Server) uploadSlidesImage(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if d.Kind != "slides" {
		httpx.Error(w, http.StatusNotFound, "not_found", "幻灯片不存在")
		return
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	u, _ := UserFrom(r.Context())
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "上传账号未确认")
		return
	}
	if !driveExpectedUser(w, r, u.ID) {
		return
	}
	if s.Blobs == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "no_storage", "图片存储未配置")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload+(1<<20))
	if err := r.ParseMultipartForm(maxUpload + (1 << 20)); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_upload", "请选择不超过 20 MB 的图片")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	f, header, err := r.FormFile("file")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_upload", "请选择图片")
		return
	}
	defer f.Close()
	name := strings.TrimSpace(header.Filename)
	if !store.ValidDriveFileName(name) {
		httpx.Error(w, http.StatusBadRequest, "invalid_title", "文件名无效或超过 100 字")
		return
	}
	body, err := io.ReadAll(io.LimitReader(f, maxUpload+1))
	if err != nil || len(body) > maxUpload {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "too_large", "图片不能超过 20 MB")
		return
	}
	mime := http.DetectContentType(body)
	switch mime {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp":
	default:
		httpx.Error(w, http.StatusBadRequest, "invalid_image", "请选择 PNG、JPEG、GIF、WebP 或 BMP 图片")
		return
	}
	tok, err := token()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	key := fmt.Sprintf("slides/%d/%s", d.ID, tok)
	if err = s.Blobs.Put(r.Context(), key, mime, body); err != nil {
		s.fail(w, r, err)
		return
	}
	file, err := s.Store.CreateSlidesFile(r.Context(), g, d.ID, store.FileMeta{Name: name, Mime: mime, Size: int64(len(body)), ObjectKey: key})
	if err != nil {
		// Commit status may be unknown; deleting the object could corrupt a
		// committed reference. Orphans require a later sweep.
		s.Log.Warn("slides upload may have left an unreferenced object", "key", key, "error", err)
		driveWriteErr(w, err, "upload slide image")
		return
	}
	httpx.JSON(w, http.StatusCreated, file)
}

func (s *Server) isProtectedSlidesImage(r *http.Request, userID int64, file store.FileMeta) (bool, error) {
	pages, err := s.Store.ListSlidesPages(r.Context(), userID, file.DocID)
	if err != nil {
		return false, err
	}
	for _, page := range pages {
		var shapes []struct {
			Kind   string `json:"kind"`
			FileID int64  `json:"fileId"`
		}
		if err = json.Unmarshal(page.Shapes, &shapes); err != nil {
			return false, err
		}
		for _, shape := range shapes {
			if shape.Kind == "image" && shape.FileID == file.ID {
				return true, nil
			}
		}
	}
	return false, nil
}
