package api

import (
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"net/http"
	"strconv"
)

func (s *Server) reorderSlides(w http.ResponseWriter, r *http.Request) {
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
	var in struct {
		Expected []store.SlidePosition `json:"expected"`
		PageID   int64                 `json:"pageId"`
		To       *int                  `json:"to"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.To == nil || in.PageID <= 0 || len(in.Expected) == 0 || len(in.Expected) > 1000 {
		httpx.Error(w, http.StatusBadRequest, "invalid_order", "页面顺序无效")
		return
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	backend, ok := s.Store.(store.SlidesOrderStore)
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "unsupported", "服务端不支持排序")
		return
	}
	result, err := backend.ReorderSlides(r.Context(), g, deck, in.Expected, in.PageID, *in.To)
	if driveWriteErr(w, err, "reorder slides") {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"positions": result})
}
