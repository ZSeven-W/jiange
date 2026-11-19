package api

import (
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) applySlidesBackground(w http.ResponseWriter, r *http.Request) {
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
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "幻灯片标识无效")
		return
	}
	var in struct {
		Background *string              `json:"background"`
		Expected   []store.SlideVersion `json:"expected"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Background == nil {
		httpx.Error(w, http.StatusBadRequest, "missing_background", "背景颜色未提供")
		return
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	st, ok := s.Store.(store.SlidesBackgroundStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "slides_background_unavailable", "服务端不支持批量设置背景")
		return
	}
	receipts, err := st.ApplySlidesBackground(r.Context(), g, id, *in.Background, in.Expected)
	if driveWriteErr(w, err, "apply slide background") {
		return
	}
	s.notifySlides(id, u.ID)
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"pages": receipts})
}

func (s *Server) applySlidesBackgroundChanges(w http.ResponseWriter, r *http.Request) {
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
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "幻灯片标识无效")
		return
	}
	// Decode pointer fields to distinguish an omitted background from the
	// intentional empty (no fill) value.
	var in struct {
		Changes []struct {
			ID         int64   `json:"id"`
			Revision   int64   `json:"revision"`
			Background *string `json:"background"`
		} `json:"changes"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	changes := make([]store.SlideBackgroundChange, 0, len(in.Changes))
	for _, item := range in.Changes {
		if item.Background == nil {
			httpx.Error(w, http.StatusBadRequest, "missing_background", "背景颜色未提供")
			return
		}
		changes = append(changes, store.SlideBackgroundChange{ID: item.ID, Revision: item.Revision, Background: *item.Background})
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	st, ok := s.Store.(store.SlidesBackgroundStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "slides_background_unavailable", "服务端不支持批量设置背景")
		return
	}
	receipts, err := st.ApplySlidesBackgroundChanges(r.Context(), g, id, changes)
	if driveWriteErr(w, err, "restore slide backgrounds") {
		return
	}
	s.notifySlides(id, u.ID)
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"pages": receipts})
}
