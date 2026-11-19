package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) suggestionStore(w http.ResponseWriter) (store.SuggestionStore, bool) {
	st, ok := s.Store.(store.SuggestionStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "修订建议功能暂不可用")
		return nil, false
	}
	return st, true
}

func (s *Server) listDocSuggestions(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	st, ok := s.suggestionStore(w)
	if !ok {
		return
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status != "" && status != "open" && status != "resolved" && status != "all" {
		httpx.Error(w, http.StatusBadRequest, "invalid_status", "无效的修订状态筛选")
		return
	}
	items, err := st.ListDocSuggestions(r.Context(), d.ID, status)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"suggestions": items})
}

func (s *Server) createDocSuggestion(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	u, _ := UserFrom(r.Context())
	if d.CommentMinRole == store.RoleEdit && d.Role != store.RoleEdit && d.Role != store.RoleManage {
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前仅限可编辑协作者发起修订建议")
		return
	}
	st, ok := s.suggestionStore(w)
	if !ok {
		return
	}
	var in struct {
		BlockID      string `json:"blockId"`
		Kind         string `json:"kind"`
		OriginalText string `json:"originalText"`
		ProposedText string `json:"proposedText"`
		Note         string `json:"note"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	blockID := strings.TrimSpace(in.BlockID)
	if blockID == "" || len(blockID) > 64 {
		httpx.Error(w, http.StatusBadRequest, "invalid_block", "修订目标段落无效")
		return
	}
	kind := strings.TrimSpace(in.Kind)
	if kind == "" {
		kind = "replace"
	}
	if kind != "replace" && kind != "insert" && kind != "delete" {
		httpx.Error(w, http.StatusBadRequest, "invalid_kind", "修订类型无效")
		return
	}
	if len(in.OriginalText) > 50000 || len(in.ProposedText) > 50000 || utf8.RuneCountInString(in.Note) > 2000 {
		httpx.Error(w, http.StatusBadRequest, "too_large", "修订内容或批注超过长度限制")
		return
	}
	if kind == "replace" && in.OriginalText == in.ProposedText {
		httpx.Error(w, http.StatusBadRequest, "unchanged", "修订后的内容与原文一致")
		return
	}
	if kind == "insert" && in.ProposedText == "" {
		httpx.Error(w, http.StatusBadRequest, "empty_insert", "新增修订内容不能为空")
		return
	}
	created, err := st.CreateDocSuggestion(r.Context(), store.DocSuggestion{
		DocID:        d.ID,
		BlockID:      blockID,
		AuthorID:     u.ID,
		Kind:         kind,
		OriginalText: in.OriginalText,
		ProposedText: in.ProposedText,
		Note:         strings.TrimSpace(in.Note),
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, created)
}

func (s *Server) resolveDocSuggestionHandler(targetStatus string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		minRole := store.RoleEdit
		if targetStatus == "withdrawn" {
			minRole = store.RoleView
		}
		d, ok := s.need(w, r, minRole)
		if !ok {
			return
		}
		u, _ := UserFrom(r.Context())
		st, ok := s.suggestionStore(w)
		if !ok {
			return
		}
		sid, err := strconv.ParseInt(r.PathValue("sid"), 10, 64)
		if err != nil || sid <= 0 {
			httpx.Error(w, http.StatusBadRequest, "invalid_id", "无效的修订编号")
			return
		}
		if targetStatus == "withdrawn" {
			existing, err := st.GetDocSuggestion(r.Context(), d.ID, sid)
			if errors.Is(err, store.ErrNotFound) {
				httpx.Error(w, http.StatusNotFound, "not_found", "修订建议不存在")
				return
			}
			if err != nil {
				s.fail(w, r, err)
				return
			}
			if existing.AuthorID != u.ID && d.Role != store.RoleManage {
				httpx.Error(w, http.StatusForbidden, "forbidden", "仅发起人或管理员可撤回该修订建议")
				return
			}
		}
		updated, err := st.ResolveDocSuggestion(r.Context(), d.ID, sid, targetStatus, u.ID)
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "修订建议不存在")
			return
		}
		if errors.Is(err, store.ErrConflict) {
			httpx.Error(w, http.StatusConflict, "already_resolved", "该修订建议已被处理")
			return
		}
		if err != nil {
			s.fail(w, r, err)
			return
		}
		httpx.JSON(w, http.StatusOK, updated)
	}
}

func (s *Server) resolveAllDocSuggestionsHandler(targetStatus string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		d, ok := s.need(w, r, store.RoleEdit)
		if !ok {
			return
		}
		u, _ := UserFrom(r.Context())
		st, ok := s.suggestionStore(w)
		if !ok {
			return
		}
		items, err := st.ResolveAllDocSuggestions(r.Context(), d.ID, targetStatus, u.ID)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"suggestions": items})
	}
}

func (s *Server) patchDocSuggestionNote(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	u, _ := UserFrom(r.Context())
	st, ok := s.suggestionStore(w)
	if !ok {
		return
	}
	sid, err := strconv.ParseInt(r.PathValue("sid"), 10, 64)
	if err != nil || sid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "无效的修订编号")
		return
	}
	var in struct {
		Note string `json:"note"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if utf8.RuneCountInString(in.Note) > 2000 {
		httpx.Error(w, http.StatusBadRequest, "too_large", "修订批注不能超过 2000 字")
		return
	}
	updated, err := st.UpdateDocSuggestionNote(r.Context(), d.ID, sid, u.ID, strings.TrimSpace(in.Note))
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "修订建议不存在")
		return
	}
	if errors.Is(err, store.ErrForbidden) {
		httpx.Error(w, http.StatusForbidden, "forbidden", "仅发起人可修改修订批注")
		return
	}
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "already_resolved", "该修订建议已被处理")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, updated)
}
