package api

import (
	"errors"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// reorderFields requires the complete order seen by the caller; hidden fields
// must remain in the request so they cannot be silently reordered or dropped.
func (s *Server) reorderFields(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok || !s.allowBaseWrite(w, r, b) {
		return
	}
	var in struct {
		ExpectedFieldIDs []int64 `json:"expectedFieldIds"`
		DesiredFieldIDs  []int64 `json:"desiredFieldIds"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if len(in.ExpectedFieldIDs) == 0 || len(in.ExpectedFieldIDs) > 10000 || len(in.ExpectedFieldIDs) != len(in.DesiredFieldIDs) {
		httpx.Error(w, http.StatusBadRequest, "invalid_fields", "请提供完整字段顺序")
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	if err := s.Store.ReorderFieldsGuarded(r.Context(), guard, b.ID, in.ExpectedFieldIDs, in.DesiredFieldIDs); err != nil {
		if errors.Is(err, store.ErrPrimaryField) {
			httpx.Error(w, http.StatusConflict, "primary_field", "主字段不能删除、移动或隐藏")
			return
		}
		s.viewMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	w.WriteHeader(http.StatusNoContent)
}
