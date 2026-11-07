package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// compareDateCells changes schedule dates only if the values the user saw
// still match, with session/permission/view checks in the same transaction.
func (s *Server) compareDateCells(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	var in struct {
		Expected map[string]json.RawMessage `json:"expected"`
		Cells    map[string]json.RawMessage `json:"cells"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	u, _ := UserFrom(r.Context())
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
		return
	}
	guard := store.BaseWriteGuard{UserID: u.ID, SessionHash: auth.HashToken(cookie.Value), Now: s.now}
	record, changed, err := s.Store.CompareDateCells(r.Context(), guard, b.ID, pathID(r, "rid"), in.Expected, in.Cells)
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效，未修改记录")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限不允许修改记录")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "记录不存在")
	case errors.Is(err, store.ErrInvalidDateCells):
		httpx.Error(w, http.StatusBadRequest, "invalid_cell", "日期字段或预期值无效")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "conflict", "日期已变化，请刷新后重试")
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
