package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// guardFrom builds the RestoreGuard (session + clock) the versioned drive
// API requires; every drive mutation revalidates the session server-side.
func (s *Server) driveGuard(w http.ResponseWriter, r *http.Request) (store.RestoreGuard, bool) {
	u, _ := UserFrom(r.Context())
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return store.RestoreGuard{}, false
	}
	return store.RestoreGuard{UserID: u.ID, SessionHash: auth.HashToken(c.Value), Now: func() time.Time { return s.now() }}, true
}

// postDriveFolder creates a folder (guarded drive operation).
func (s *Server) postDriveFolder(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	var in struct {
		WorkspaceID int64  `json:"workspaceId"`
		ParentID    *int64 `json:"parentId"`
		Title       string `json:"title"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.WorkspaceID == 0 {
		ws, werr := s.Store.Workspaces(r.Context(), u.ID)
		if werr != nil || len(ws) == 0 {
			s.fail(w, r, werr)
			return
		}
		in.WorkspaceID = ws[0].ID
	}
	title := driveCleanTitle(w, in.Title)
	if title == "" {
		return
	}
	entry, err := s.Store.CreateDriveFolder(r.Context(), g, in.WorkspaceID, in.ParentID, title)
	if driveWriteErr(w, err, "create folder") {
		return
	}
	httpx.JSON(w, http.StatusCreated, entry)
}

// postDriveNode creates a doc/base/folder inside any folder (guarded). The
// legacy creation endpoints cannot insert under a folder: the fence triggers
// require drive_revision 1 and a guarded session.
func (s *Server) postDriveNode(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	var in struct {
		WorkspaceID int64  `json:"workspaceId"`
		ParentID    *int64 `json:"parentId"`
		Kind        string `json:"kind"`
		Title       string `json:"title"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Kind != "doc" && in.Kind != "base" && in.Kind != "folder" {
		httpx.Error(w, http.StatusBadRequest, "invalid_kind", "kind 必须是 doc/base/folder")
		return
	}
	if in.WorkspaceID == 0 {
		ws, werr := s.Store.Workspaces(r.Context(), u.ID)
		if werr != nil || len(ws) == 0 {
			s.fail(w, r, werr)
			return
		}
		in.WorkspaceID = ws[0].ID
	}
	title := driveCleanTitle(w, in.Title)
	if title == "" {
		return
	}
	entry, err := s.Store.CreateDriveNode(r.Context(), g, in.WorkspaceID, in.ParentID, in.Kind, title)
	if driveWriteErr(w, err, "create node") {
		return
	}
	httpx.JSON(w, http.StatusCreated, entry)
}

// listDriveChildren lists one directory level (folder contents).
func (s *Server) listDriveChildren(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	var parent *int64
	if v := r.URL.Query().Get("parent"); v != "" {
		id, err := strconv.ParseInt(v, 10, 64)
		if err != nil || id <= 0 {
			httpx.Error(w, http.StatusBadRequest, "invalid_parent", "parent must be a node id")
			return
		}
		parent = &id
	}
	wsID, err := strconv.ParseInt(r.URL.Query().Get("workspaceId"), 10, 64)
	if err != nil || wsID <= 0 {
		ws, werr := s.Store.Workspaces(r.Context(), u.ID)
		if werr != nil || len(ws) == 0 {
			s.fail(w, r, werr)
			return
		}
		wsID = ws[0].ID
	}
	entries, err := s.Store.ListDriveChildren(r.Context(), g, wsID, parent)
	if driveWriteErr(w, err, "list children") {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"entries": entries})
}

// postDriveMove moves a node under a new parent (guarded, revision-checked).
func (s *Server) postDriveMove(w http.ResponseWriter, r *http.Request) {
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	var in struct {
		WorkspaceID int64  `json:"workspaceId"`
		ParentID    *int64 `json:"parentId"`
		Expected    int64  `json:"expected"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "node id required")
		return
	}
	if driveWriteErr(w, s.Store.MoveDriveNode(r.Context(), g, id, in.ParentID, in.Expected), "move") {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// postDriveTrash soft-deletes a subtree as a batch (guarded).
func (s *Server) postDriveTrash(w http.ResponseWriter, r *http.Request) {
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	var in struct {
		WorkspaceID int64 `json:"workspaceId"`
		Expected    int64 `json:"expected"`
	}
	if r.ContentLength != 0 && !httpx.Decode(w, r, &in) {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "node id required")
		return
	}
	if driveWriteErr(w, s.Store.TrashDriveNode(r.Context(), g, id, in.Expected), "trash") {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// postDriveRestore restores a trashed batch (guarded).
func (s *Server) postDriveRestore(w http.ResponseWriter, r *http.Request) {
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	var in struct {
		WorkspaceID int64 `json:"workspaceId"`
		Expected    int64 `json:"expected"`
	}
	if r.ContentLength != 0 && !httpx.Decode(w, r, &in) {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "node id required")
		return
	}
	if driveWriteErr(w, s.Store.RestoreDriveNode(r.Context(), g, id, in.Expected), "restore") {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// driveCleanTitle trims and length-checks a folder title.
func driveCleanTitle(w http.ResponseWriter, t string) string {
	t = strings.TrimSpace(t)
	if n := utf8.RuneCountInString(t); n == 0 || n > 100 {
		httpx.Error(w, http.StatusBadRequest, "invalid_title", "名称需要 1-100 字")
		return ""
	}
	return t
}

// driveWriteErr maps store guard errors to HTTP statuses; returns true when handled.
func driveWriteErr(w http.ResponseWriter, err error, what string) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "会话已过期，请重新登录")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "无权操作")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "条目不存在")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "conflict", "目标已变更，请刷新后重试")
	default:
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "internal error")
	}
	return true
}
