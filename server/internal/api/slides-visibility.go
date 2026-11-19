package api

import (
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
)

func (s *Server) setSlidesPageVisibility(w http.ResponseWriter, r *http.Request) {
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
		Hidden           *bool  `json:"hidden"`
		ExpectedRevision *int64 `json:"expectedRevision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Hidden == nil || in.ExpectedRevision == nil || *in.ExpectedRevision < 1 {
		httpx.Error(w, http.StatusBadRequest, "invalid_visibility", "页面状态或版本无效")
		return
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	page, err := s.Store.SetSlidesPageHidden(r.Context(), g, deck, pageID, *in.ExpectedRevision, *in.Hidden)
	if driveWriteErr(w, err, "set slide visibility") {
		return
	}
	s.notifySlides(deck, u.ID)
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, page)
}
