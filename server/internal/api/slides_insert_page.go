package api

import (
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) insertSlidesPage(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "请重新登录")
		return
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "新建账号未确认")
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
		AfterPageID      *int64  `json:"afterPageId"`
		ExpectedRevision *int64  `json:"expectedRevision"`
		Layout           *string `json:"layout"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.AfterPageID == nil || in.ExpectedRevision == nil || *in.AfterPageID < 0 || (*in.AfterPageID == 0 && *in.ExpectedRevision != 0) || (*in.AfterPageID > 0 && *in.ExpectedRevision < 1) {
		httpx.Error(w, http.StatusBadRequest, "invalid_anchor", "页面位置或版本无效")
		return
	}
	if in.Layout != nil {
		if _, _, valid := store.SlideCreationLayout(*in.Layout); !valid {
			httpx.Error(w, http.StatusBadRequest, "invalid_layout", "幻灯片布局无效")
			return
		}
		if r.Header.Get("X-Jiange-Slides-Version") != "4" {
			httpx.Error(w, http.StatusUpgradeRequired, "slide_client_outdated", "请刷新以使用支持布局的幻灯片编辑器")
			return
		}
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	var page store.SlidesPage
	if in.Layout == nil {
		page, err = s.Store.InsertSlidesPage(r.Context(), g, deck, *in.AfterPageID, *in.ExpectedRevision)
	} else {
		page, err = s.Store.InsertSlidesPageWithLayout(r.Context(), g, deck, *in.AfterPageID, *in.ExpectedRevision, *in.Layout)
	}
	if driveWriteErr(w, err, "insert slide page") {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusCreated, page)
}
