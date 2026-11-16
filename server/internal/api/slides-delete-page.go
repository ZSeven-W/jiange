package api

import (
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
)

func (s *Server) deleteSlidesPageVersion(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "请重新登录")
		return
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "删除账号未确认")
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
	page, err := strconv.ParseInt(r.PathValue("pid"), 10, 64)
	if err != nil || page <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "页面标识无效")
		return
	}
	var in struct {
		ExpectedRevision *int64 `json:"expectedRevision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.ExpectedRevision == nil || *in.ExpectedRevision < 1 {
		httpx.Error(w, http.StatusBadRequest, "invalid_revision", "页面版本无效")
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if driveWriteErr(w, s.Store.DeleteSlidesPageVersion(r.Context(), guard, deck, page, *in.ExpectedRevision), "delete slide page") {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]int64{"deletedId": page, "slidesId": deck, "revision": *in.ExpectedRevision})
}
