package api

import (
	"errors"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) referenceVisibilityError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
	case errors.Is(err, store.ErrForbidden), errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusForbidden, "forbidden", "文档权限已变化")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "references_visibility_conflict", "显示设置已变化，请重新检查")
	default:
		s.fail(w, r, err)
	}
}
func (s *Server) getReferenceVisibility(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	if !requireActionAccount(w, r) {
		return
	}
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	st, ok := s.Store.(store.ReferenceVisibilityStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "显示设置暂不可用")
		return
	}
	result, err := st.ReferenceVisibilityGuarded(r.Context(), guard, d.ID)
	if err != nil {
		s.referenceVisibilityError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}
func (s *Server) putReferenceVisibility(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	if !requireActionAccount(w, r) {
		return
	}
	d, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	var input struct {
		Visible  *bool  `json:"visible"`
		Expected *int64 `json:"expectedRevision"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	if input.Visible == nil || input.Expected == nil || *input.Expected < 0 || *input.Expected >= 9007199254740991 {
		httpx.Error(w, http.StatusBadRequest, "invalid_setting", "无效的显示设置")
		return
	}
	st, ok := s.Store.(store.ReferenceVisibilityStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "显示设置暂不可用")
		return
	}
	result, err := st.SetReferenceVisibilityGuarded(r.Context(), guard, d.ID, *input.Visible, *input.Expected)
	if err != nil {
		s.referenceVisibilityError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}
