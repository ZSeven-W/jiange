package api

import (
	"errors"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) pasteShareTarget(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	if !requireActionAccount(w, r) {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	st, ok := s.Store.(store.PasteShareTargetReader)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "无法确认链接")
		return
	}
	result, err := st.ResolvePasteShareTarget(r.Context(), guard, r.PathValue("token"))
	if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrForbidden) {
		httpx.Error(w, http.StatusNotFound, "not_found", "链接已失效或无权访问")
		return
	}
	if errors.Is(err, store.ErrUnauthenticated) {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if r.URL.Query().Get("public") == "1" && result.Role != "anon" {
		httpx.Error(w, http.StatusNotFound, "not_found", "链接已失效或无权访问")
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}
