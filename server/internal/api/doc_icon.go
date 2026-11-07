package api

import (
	"errors"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) docIconError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
	case errors.Is(err, store.ErrForbidden), errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前没有所需权限")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "icon_conflict", "图标已发生变化，请刷新后重试")
	default:
		s.fail(w, r, err)
	}
}

func (s *Server) getDocIcon(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	result, err := s.Store.DocIconGuarded(r.Context(), guard, d.ID)
	if err != nil {
		s.docIconError(w, r, err)
		return
	}
	// Recheck after the transaction; a concurrently revoked role must not
	// cause the response to expose a stale icon to an unauthorized session.
	current, docErr := s.Store.GetDoc(r.Context(), guard.UserID, d.ID)
	user, sessionErr := s.Store.SessionUser(r.Context(), guard.SessionHash, s.now())
	if docErr != nil || store.RoleRank(current.Role) < store.RoleRank(store.RoleView) || sessionErr != nil || user.ID != guard.UserID {
		httpx.Error(w, http.StatusForbidden, "forbidden", "文档权限已变化")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, result)
}

func (s *Server) putDocIcon(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	var in struct {
		Icon             *string `json:"icon"`
		ExpectedRevision *int64  `json:"expectedRevision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Icon == nil || !store.ValidDocIcon(*in.Icon) || in.ExpectedRevision == nil || *in.ExpectedRevision < 0 || *in.ExpectedRevision >= 9007199254740991 {
		httpx.Error(w, http.StatusBadRequest, "invalid_icon", "无效的图标或版本")
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	result, err := s.Store.SetDocIconGuarded(r.Context(), guard, d.ID, *in.Icon, *in.ExpectedRevision)
	if err != nil {
		s.docIconError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	current, docErr := s.Store.GetDoc(r.Context(), guard.UserID, d.ID)
	user, sessionErr := s.Store.SessionUser(r.Context(), guard.SessionHash, s.now())
	if docErr != nil || store.RoleRank(current.Role) < store.RoleRank(store.RoleView) || sessionErr != nil || user.ID != guard.UserID {
		// The write already committed; returning an authorization error would
		// misleadingly suggest the change was not applied.
		w.Header().Set("X-Icon-Refresh-Required", "true")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}
