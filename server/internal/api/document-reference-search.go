package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

var referenceSearchSlots = make(chan struct{}, 2)

// Search only returns document identities and titles. The account header
// binds the result to the session that initiated the request.
func (s *Server) searchAccountDocuments(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	if !requireActionAccount(w, r) {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" || len(query) > 1024 || utf8.RuneCountInString(query) > 100 {
		httpx.Error(w, http.StatusBadRequest, "invalid_query", "请输入不超过 100 个字符的搜索词")
		return
	}
	select {
	case referenceSearchSlots <- struct{}{}:
		defer func() { <-referenceSearchSlots }()
	default:
		httpx.Error(w, http.StatusServiceUnavailable, "search_busy", "搜索繁忙，请稍后重试")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	docs, err := s.searchMaterialized(ctx, guard.UserID, query)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
		httpx.Error(w, http.StatusServiceUnavailable, "search_incomplete", "搜索未完成，请稍后重试")
		return
	}
	user, err := s.Store.SessionUser(ctx, guard.SessionHash, s.now())
	if err != nil || user.ID != guard.UserID {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
		return
	}
	type item struct {
		ID    int64  `json:"id"`
		Title string `json:"title"`
	}
	out := make([]item, 0, 30)
	truncated := false
	for _, candidate := range docs {
		if candidate.Kind != "doc" {
			continue
		}
		current, e := s.Store.GetDoc(ctx, guard.UserID, candidate.ID)
		if errors.Is(e, store.ErrNotFound) {
			continue
		}
		if e != nil {
			s.fail(w, r, e)
			return
		}
		if current.Kind != "doc" {
			continue
		}
		if len(out) == 30 {
			truncated = true
			break
		}
		out = append(out, item{ID: current.ID, Title: current.Title})
	}
	if err = ctx.Err(); err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "search_incomplete", "搜索未完成，请稍后重试")
		return
	}
	user, err = s.Store.SessionUser(ctx, guard.SessionHash, s.now())
	if err != nil || user.ID != guard.UserID {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"docs": out, "truncated": truncated})
}
