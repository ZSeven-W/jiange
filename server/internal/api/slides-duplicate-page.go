package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) duplicateSlidesPage(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "请重新登录")
		return
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "复制账号未确认")
		return
	}
	if !driveExpectedUser(w, r, u.ID) {
		return
	}
	deck, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || deck <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "幻灯片标识无效")
		return
	}
	pageID, err := strconv.ParseInt(r.PathValue("pid"), 10, 64)
	if err != nil || pageID <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "页面标识无效")
		return
	}
	var in struct {
		ExpectedRevision int64 `json:"expectedRevision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.ExpectedRevision < 1 {
		httpx.Error(w, http.StatusBadRequest, "invalid_revision", "页面版本无效")
		return
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	page, err := s.Store.DuplicateSlidesPage(r.Context(), g, deck, pageID, in.ExpectedRevision)
	if errors.Is(err, store.ErrCopyProtected) {
		httpx.Error(w, http.StatusForbidden, "copy_protected", "文档不允许复制")
		return
	}
	if driveWriteErr(w, err, "duplicate slide page") {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusCreated, page)
}
