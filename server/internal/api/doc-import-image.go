package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type docImportImageStore interface {
	CreateDocImportImage(context.Context, store.RestoreGuard, int64, store.FileMeta) (store.FileMeta, error)
}

func (s *Server) uploadImportImage(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if d.Kind != "doc" {
		httpx.Error(w, http.StatusNotFound, "not_found", "文档不存在")
		return
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "上传账号未确认")
		return
	}
	if !driveExpectedUser(w, r, g.UserID) {
		return
	}
	st, ok := s.Store.(docImportImageStore)
	if !ok || s.Blobs == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "no_storage", "图片导入服务未配置")
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
		httpx.Error(w, http.StatusBadRequest, "invalid_title", "图片名称无效")
		return
	}
	body, err := io.ReadAll(io.LimitReader(f, maxUpload+1))
	if err != nil || len(body) > maxUpload {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "too_large", "图片不能超过 20 MB")
		return
	}
	mime := http.DetectContentType(body)
	switch mime {
	case "image/png", "image/jpeg", "image/gif":
	default:
		httpx.Error(w, http.StatusBadRequest, "invalid_image", "图片格式不受支持")
		return
	}
	tok, err := token()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !s.enforceWorkspaceStorageQuota(r.Context(), w, d.WorkspaceID, int64(len(body))) {
		return
	}
	key := fmt.Sprintf("docs/%d/%s", d.ID, tok)
	if err = s.Blobs.Put(r.Context(), key, mime, body); err != nil {
		s.fail(w, r, err)
		return
	}
	file, err := st.CreateDocImportImage(r.Context(), g, d.ID, store.FileMeta{Name: name, Mime: mime, Size: int64(len(body)), ObjectKey: key})
	if err != nil {
		// Commit outcome may be unknown; a sweep must reclaim unreferenced objects.
		s.Log.Warn("Word import upload may have left an unreferenced object", "key", key, "error", err)
		driveWriteErr(w, err, "upload imported image")
		return
	}
	httpx.JSON(w, http.StatusCreated, file)
}
