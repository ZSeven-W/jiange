package api

import (
	"context"
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) notifySlides(deckID, actorID int64) {
	if s.SlidesHub != nil && deckID > 0 {
		s.SlidesHub.Notify(deckID, actorID)
	}
}

func (s *Server) serveSlidesWS(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "请重新登录")
		return
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "幻灯片标识无效")
		return
	}
	if _, err := s.Store.ListSlidesPages(r.Context(), u.ID, id); driveWriteErr(w, err, "slides ws") {
		return
	}
	check := func(ctx context.Context) error {
		sessionUser, err := s.Store.SessionUser(ctx, g.SessionHash, s.now())
		if err != nil || sessionUser.ID != u.ID {
			return store.ErrUnauthenticated
		}
		meta, err := s.Store.GetDoc(ctx, u.ID, id)
		if err != nil || meta.Kind != "slides" || store.RoleRank(meta.Role) < store.RoleRank(store.RoleView) {
			return store.ErrNotFound
		}
		return nil
	}
	s.SlidesHub.Serve(w, r, id, u, check)
}

func (s *Server) importSlidesPptx(w http.ResponseWriter, r *http.Request) {
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
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "幻灯片标识无效")
		return
	}
	var in struct {
		Pages []store.ImportedSlidePage `json:"pages"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if len(in.Pages) == 0 || len(in.Pages) > 100 {
		httpx.Error(w, http.StatusBadRequest, "invalid_pages", "导入页面数量需在 1 至 100 页之间")
		return
	}
	for _, p := range in.Pages {
		if len(p.Shapes) > 0 && !validSlideShapes(p.Shapes) {
			httpx.Error(w, http.StatusBadRequest, "invalid_shapes", "导入页面包含无效图形数据")
			return
		}
	}
	pages, err := s.Store.ReplaceSlidesDeckGuarded(r.Context(), g, id, in.Pages)
	if driveWriteErr(w, err, "import pptx") {
		return
	}
	s.notifySlides(id, u.ID)
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"pages": pages})
}

func (s *Server) restoreSlidesPage(w http.ResponseWriter, r *http.Request) {
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
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "幻灯片标识无效")
		return
	}
	var in struct {
		Page        store.ImportedSlidePage `json:"page"`
		TargetIndex int                     `json:"targetIndex"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if len(in.Page.Shapes) > 0 && !validSlideShapes(in.Page.Shapes) {
		httpx.Error(w, http.StatusBadRequest, "invalid_shapes", "恢复页面包含无效图形数据")
		return
	}
	pages, page, err := s.Store.RestoreSlidesPageGuarded(r.Context(), g, id, in.Page, in.TargetIndex)
	if driveWriteErr(w, err, "restore slides page") {
		return
	}
	s.notifySlides(id, u.ID)
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusCreated, map[string]any{"page": page, "pages": pages})
}
