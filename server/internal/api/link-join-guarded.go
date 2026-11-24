package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type guardedLinkJoin interface {
	JoinLinkGuarded(context.Context, store.RestoreGuard, string) (int64, error)
}

func (s *Server) joinLinkGuarded(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "未确认当前账号")
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	st, ok := s.Store.(guardedLinkJoin)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "服务暂不支持安全打开链接")
		return
	}
	tok := r.PathValue("token")
	if !s.requireJoinLinkPassword(w, r, guard.UserID, tok, "链接已失效或当前账号不在访问范围内") {
		return
	}
	id, err := st.JoinLinkGuarded(r.Context(), guard, tok)
	if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrForbidden) {
		httpx.Error(w, http.StatusNotFound, "not_found", "链接已失效或当前账号不在访问范围内")
		return
	}
	if errors.Is(err, store.ErrUnauthenticated) {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
		return
	}
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "link_changed", "链接范围已变化，请重试")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	user, err := s.Store.SessionUser(r.Context(), guard.SessionHash, s.now())
	if err != nil || user.ID != guard.UserID {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
		return
	}
	d, err := s.Store.GetDoc(r.Context(), guard.UserID, id)
	if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrForbidden) {
		httpx.Error(w, http.StatusNotFound, "not_found", "链接已失效或当前账号不在访问范围内")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	d = s.sanitizeWrittenDocMeta(r.Context(), guard.UserID, d)
	httpx.JSON(w, http.StatusOK, d)
}
