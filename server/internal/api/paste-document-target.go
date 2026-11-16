package api

import (
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// Return just enough metadata to label a document link. The client sends an
// expected account, and both session and document access are checked again
// before returning. No link join or authorization is performed here.
func (s *Server) pasteDocumentTarget(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	if !requireActionAccount(w, r) {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	doc, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	if doc.Kind != "doc" {
		httpx.Error(w, http.StatusNotFound, "not_found", "文档不存在或无权访问")
		return
	}
	user, err := s.Store.SessionUser(r.Context(), guard.SessionHash, s.now())
	if err != nil || user.ID != guard.UserID {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
		return
	}
	doc, ok = s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	if doc.Kind != "doc" {
		httpx.Error(w, http.StatusNotFound, "not_found", "文档不存在或无权访问")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": doc.ID, "title": doc.Title})
}
