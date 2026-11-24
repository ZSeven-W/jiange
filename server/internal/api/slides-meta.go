package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) patchSlidesPageMeta(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "请重新登录")
		return
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "操作账号未确认")
		return
	}
	if !driveExpectedUser(w, r, u.ID) {
		return
	}
	deckID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || deckID <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "幻灯片标识无效")
		return
	}
	pageID, err := strconv.ParseInt(r.PathValue("pid"), 10, 64)
	if err != nil || pageID <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "页面标识无效")
		return
	}
	var in struct {
		Meta json.RawMessage `json:"meta"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if len(bytes.TrimSpace(in.Meta)) == 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_meta", "页面样式或动画元数据未提供")
		return
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	st, ok := s.Store.(store.SlidesMetaStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "slides_meta_unavailable", "服务端不支持页面元数据持久化")
		return
	}
	page, err := st.UpdateSlidesPageMeta(r.Context(), g, deckID, pageID, in.Meta)
	if errors.Is(err, store.ErrInvalidSlideMeta) {
		httpx.Error(w, http.StatusBadRequest, "invalid_meta", "页面样式或动画元数据无效")
		return
	}
	if driveWriteErr(w, err, "update slide page meta") {
		return
	}
	s.notifySlides(deckID, g.UserID)
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, page)
}

func (s *Server) batchSlidesPagesMeta(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "请重新登录")
		return
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "操作账号未确认")
		return
	}
	if !driveExpectedUser(w, r, u.ID) {
		return
	}
	deckID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || deckID <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "幻灯片标识无效")
		return
	}
	var in struct {
		Meta json.RawMessage `json:"meta"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if len(bytes.TrimSpace(in.Meta)) == 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_meta", "批量元数据未提供")
		return
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	st, ok := s.Store.(store.SlidesMetaStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "slides_meta_unavailable", "服务端不支持页面元数据持久化")
		return
	}
	pages, err := st.BatchUpdateSlidesPagesMeta(r.Context(), g, deckID, in.Meta)
	if errors.Is(err, store.ErrInvalidSlideMeta) {
		httpx.Error(w, http.StatusBadRequest, "invalid_meta", "批量页面元数据无效")
		return
	}
	if driveWriteErr(w, err, "batch update slides pages meta") {
		return
	}
	s.notifySlides(deckID, g.UserID)
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"pages": pages})
}
