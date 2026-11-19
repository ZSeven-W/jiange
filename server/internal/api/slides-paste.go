package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) pasteSlidesPage(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "请重新登录")
		return
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "粘贴账号未确认")
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
	var in struct {
		SourceID       *int64 `json:"sourceId"`
		SourceRevision *int64 `json:"sourceRevision"`
		AnchorID       *int64 `json:"anchorId"`
		AnchorRevision *int64 `json:"anchorRevision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.SourceID == nil || in.SourceRevision == nil || in.AnchorID == nil || in.AnchorRevision == nil || *in.SourceID <= 0 || *in.SourceRevision <= 0 || *in.AnchorID <= 0 || *in.AnchorRevision <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_page", "复制页面或粘贴位置无效")
		return
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	guarded, ok := s.Store.(store.SlidesPasteStore)
	if !ok {
		httpx.Error(w, http.StatusUpgradeRequired, "upgrade_required", "请升级服务端以粘贴幻灯片")
		return
	}
	page, err := guarded.PasteSlidesPage(r.Context(), g, deck, *in.SourceID, *in.SourceRevision, *in.AnchorID, *in.AnchorRevision)
	if errors.Is(err, store.ErrCopyProtected) {
		httpx.Error(w, http.StatusForbidden, "copy_protected", "文档不允许复制")
		return
	}
	if driveWriteErr(w, err, "paste slide page") {
		return
	}
	s.notifySlides(deck, u.ID)
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusCreated, page)
}
