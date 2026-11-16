package api

import (
	"errors"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// moveKanbanCard commits a card's group and position together after checking
// the current authorization, source and target placement under one lock.
func (s *Server) moveKanbanCard(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	var move store.KanbanMove
	if !httpx.Decode(w, r, &move) {
		return
	}
	u, _ := UserFrom(r.Context())
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
		return
	}
	guard := store.BaseWriteGuard{UserID: u.ID, SessionHash: auth.HashToken(cookie.Value), Now: s.now}
	record, changed, err := s.Store.MoveKanbanCard(r.Context(), guard, b.ID, pathID(r, "rid"), move)
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效，记录未修改")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限不允许移动记录")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "记录或字段不存在")
	case errors.Is(err, store.ErrInvalidKanbanMove):
		httpx.Error(w, http.StatusBadRequest, "invalid_move", "看板移动参数无效")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "conflict", "看板已变化，请刷新后重新拖动")
	case err != nil:
		s.fail(w, r, err)
	default:
		if changed {
			if s.BtHub != nil {
				s.BtHub.Notify(b.ID)
			}
			s.runAutomations(r.Context(), b.ID, "record_matches", record)
		}
		s.writeProjectedRecord(w, r, u.ID, b.ID, record.ID, http.StatusOK)
	}
}
