package api

import (
	"errors"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) docReactionsStore(w http.ResponseWriter) (store.DocReactionsStore, bool) {
	st, ok := s.Store.(store.DocReactionsStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "文档回应功能暂不可用")
		return nil, false
	}
	return st, true
}

func (s *Server) docReactionsError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrInvalidReaction):
		httpx.Error(w, http.StatusBadRequest, "invalid_reaction", "不支持的表情")
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前没有文档访问权限")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "文档不存在")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "reaction_conflict", "文档状态已变化，请重试")
	default:
		s.fail(w, r, err)
	}
}

// getDocReactions serves GET /api/docs/{id}/reactions.
func (s *Server) getDocReactions(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	docID := pathID(r, "id")
	if docID <= 0 {
		httpx.Error(w, http.StatusNotFound, "not_found", "文档不存在")
		return
	}
	st, ok := s.docReactionsStore(w)
	if !ok {
		return
	}
	snap, err := st.DocReactions(r.Context(), u.ID, docID)
	if err != nil {
		s.docReactionsError(w, r, err)
		return
	}
	if snap.Reactions == nil {
		snap.Reactions = []store.DocReactionItem{}
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, snap)
}

// toggleDocReaction serves POST /api/docs/{id}/reactions.
func (s *Server) toggleDocReaction(w http.ResponseWriter, r *http.Request) {
	if _, ok := UserFrom(r.Context()); !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	docID := pathID(r, "id")
	if docID <= 0 {
		httpx.Error(w, http.StatusNotFound, "not_found", "文档不存在")
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	st, ok := s.docReactionsStore(w)
	if !ok {
		return
	}
	var in struct {
		Emoji string `json:"emoji"`
		On    *bool  `json:"on"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	snap, err := st.ToggleDocReactionGuarded(r.Context(), guard, docID, in.Emoji, in.On)
	if err != nil {
		s.docReactionsError(w, r, err)
		return
	}
	if snap.Reactions == nil {
		snap.Reactions = []store.DocReactionItem{}
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, snap)
}
