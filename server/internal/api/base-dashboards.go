package api

import (
	"errors"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) baseGuardFromCookie(w http.ResponseWriter, r *http.Request) (store.BaseWriteGuard, bool) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
		return store.BaseWriteGuard{}, false
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
		return store.BaseWriteGuard{}, false
	}
	return store.BaseWriteGuard{UserID: u.ID, SessionHash: auth.HashToken(cookie.Value), Now: s.now}, true
}

func (s *Server) writeBaseDashboardErr(w http.ResponseWriter, r *http.Request, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限不允许修改仪表盘")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "仪表盘不存在")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "conflict", "仪表盘配置无效或已被修改，请刷新后重试")
	default:
		s.fail(w, r, err)
	}
	return true
}

func (s *Server) listBaseDashboards(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleView)
	if !ok {
		return
	}
	u, _ := UserFrom(r.Context())
	list, err := s.Store.ListBaseDashboards(r.Context(), u.ID, b.ID)
	if s.writeBaseDashboardErr(w, r, err) {
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"dashboards": list})
}

func (s *Server) createBaseDashboard(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	guard, ok := s.baseGuardFromCookie(w, r)
	if !ok {
		return
	}
	var in struct {
		Name    string                  `json:"name"`
		Widgets []store.DashboardWidget `json:"widgets"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Name == "" {
		in.Name = "仪表盘"
	}
	db, err := s.Store.CreateBaseDashboardGuarded(r.Context(), guard, b.ID, in.Name, in.Widgets)
	if s.writeBaseDashboardErr(w, r, err) {
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusCreated, map[string]any{"dashboard": db})
}

func (s *Server) patchBaseDashboard(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	did := pathID(r, "did")
	if did <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "仪表盘标识无效")
		return
	}
	guard, ok := s.baseGuardFromCookie(w, r)
	if !ok {
		return
	}
	var in struct {
		Name             *string                  `json:"name"`
		Widgets          *[]store.DashboardWidget `json:"widgets"`
		ExpectedRevision *int64                   `json:"expectedRevision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Name == nil && in.Widgets == nil {
		httpx.Error(w, http.StatusBadRequest, "empty_patch", "未指定修改内容")
		return
	}
	db, err := s.Store.UpdateBaseDashboardGuarded(r.Context(), guard, b.ID, did, in.Name, in.Widgets, in.ExpectedRevision)
	if s.writeBaseDashboardErr(w, r, err) {
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"dashboard": db})
}

func (s *Server) deleteBaseDashboard(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	did := pathID(r, "did")
	if did <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "仪表盘标识无效")
		return
	}
	guard, ok := s.baseGuardFromCookie(w, r)
	if !ok {
		return
	}
	if err := s.Store.DeleteBaseDashboardGuarded(r.Context(), guard, b.ID, did); s.writeBaseDashboardErr(w, r, err) {
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	w.WriteHeader(http.StatusNoContent)
}
