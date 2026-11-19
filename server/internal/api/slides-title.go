package api

import (
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// Unlike the legacy endpoint, this route fails closed on older servers and
// binds the rename to the account that initiated the edit.
func (s *Server) postAccountSlidesTitle(w http.ResponseWriter, r *http.Request) {
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
	var in struct {
		Title         *string `json:"title"`
		Expected      *int64  `json:"expected"`
		ExpectedTitle *string `json:"expectedTitle"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Title == nil || in.Expected == nil || in.ExpectedTitle == nil || *in.Expected < 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_revision", "名称和版本不能为空")
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "node id required")
		return
	}
	title := driveCleanTitle(w, *in.Title)
	if title == "" {
		return
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	guarded, ok := s.Store.(store.SlidesTitleStore)
	if !ok {
		httpx.Error(w, http.StatusUpgradeRequired, "upgrade_required", "请升级服务端以安全重命名")
		return
	}
	entry, err := guarded.RenameSlidesTitle(r.Context(), g, id, title, *in.ExpectedTitle, *in.Expected)
	if driveWriteErr(w, err, "rename") {
		return
	}
	s.notifySlides(id, u.ID)
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, entry)
}
