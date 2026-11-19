package api

import (
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) syncedBlockStore(w http.ResponseWriter) (store.SyncedBlockStore, bool) {
	st, ok := s.Store.(store.SyncedBlockStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "同步块功能暂不可用")
		return nil, false
	}
	return st, true
}

func (s *Server) createSyncedBlock(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	u, _ := UserFrom(r.Context())
	st, ok := s.syncedBlockStore(w)
	if !ok {
		return
	}
	var in struct {
		Content string `json:"content"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if len(in.Content) > 200000 {
		httpx.Error(w, http.StatusBadRequest, "too_large", "同步块内容过长")
		return
	}
	sb, err := st.CreateSyncedBlock(r.Context(), d.WorkspaceID, d.ID, u.ID, in.Content)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"syncedBlock": sb, "canEdit": true})
}

func (s *Server) getSyncedBlock(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}
	st, ok := s.syncedBlockStore(w)
	if !ok {
		return
	}
	sid := strings.TrimSpace(r.PathValue("sid"))
	if sid == "" || len(sid) > 64 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "同步块标识无效")
		return
	}
	sb, err := st.GetSyncedBlock(r.Context(), sid)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "同步块不存在")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	srcDoc, err := s.Store.GetDoc(r.Context(), u.ID, sb.SourceDocID)
	if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrForbidden) {
		httpx.Error(w, http.StatusForbidden, "forbidden", "无权查看此同步块源文档")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	canEdit := srcDoc.Role == store.RoleEdit || srcDoc.Role == store.RoleManage
	httpx.JSON(w, http.StatusOK, map[string]any{"syncedBlock": sb, "canEdit": canEdit})
}

func (s *Server) updateSyncedBlock(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}
	st, ok := s.syncedBlockStore(w)
	if !ok {
		return
	}
	sid := strings.TrimSpace(r.PathValue("sid"))
	if sid == "" || len(sid) > 64 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "同步块标识无效")
		return
	}
	sb, err := st.GetSyncedBlock(r.Context(), sid)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "同步块不存在")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	srcDoc, err := s.Store.GetDoc(r.Context(), u.ID, sb.SourceDocID)
	if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrForbidden) {
		httpx.Error(w, http.StatusForbidden, "forbidden", "无权编辑此同步块")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if srcDoc.Role != store.RoleEdit && srcDoc.Role != store.RoleManage {
		httpx.Error(w, http.StatusForbidden, "forbidden", "仅源文档编辑者可修改同步块内容")
		return
	}
	var in struct {
		Content          string `json:"content"`
		ExpectedRevision int64  `json:"expectedRevision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if len(in.Content) > 200000 {
		httpx.Error(w, http.StatusBadRequest, "too_large", "同步块内容过长")
		return
	}
	updated, err := st.UpdateSyncedBlock(r.Context(), sid, u.ID, in.Content, in.ExpectedRevision)
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "revision_conflict", "同步块已被其他人更新，请刷新后重试")
		return
	}
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "同步块不存在")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"syncedBlock": updated, "canEdit": true})
}

// listDocSubpages returns direct child pages of document {id}, strictly
// filtered by the requesting user's read permissions (never leaking private
// or trashed child documents).
func (s *Server) listDocSubpages(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	u, _ := UserFrom(r.Context())
	docs, err := s.Store.ListDocs(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if shared, serr := s.Store.SharedWithMe(r.Context(), u.ID); serr == nil {
		docs = append(docs, shared...)
	}
	type subpageItem struct {
		ID        int64  `json:"id"`
		Title     string `json:"title"`
		Kind      string `json:"kind"`
		DocType   string `json:"docType,omitempty"`
		Icon      string `json:"icon,omitempty"`
		UpdatedAt string `json:"updatedAt"`
	}
	seen := make(map[int64]bool)
	out := make([]subpageItem, 0)
	for _, item := range docs {
		if item.ParentID != nil && *item.ParentID == d.ID && !seen[item.ID] {
			seen[item.ID] = true
			out = append(out, subpageItem{
				ID:        item.ID,
				Title:     item.Title,
				Kind:      item.Kind,
				DocType:   item.DocType,
				Icon:      item.Icon,
				UpdatedAt: item.UpdatedAt.Format("2006-01-02T15:04:05Z07:00"),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].ID < out[j].ID
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"subpages": out})
}
