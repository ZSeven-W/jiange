package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) enrichShortcut(ctx context.Context, userID int64, sc store.DriveShortcut) store.DriveShortcut {
	doc, err := s.Store.GetDoc(ctx, userID, sc.TargetNodeID)
	if err != nil {
		sc.TargetAccessible = false
		sc.TargetKind = ""
		sc.TargetDocType = ""
		sc.TargetTitle = ""
		sc.TargetIcon = ""
		sc.TargetWikiSpaceID = nil
		return sc
	}
	sc.TargetAccessible = true
	sc.TargetKind = doc.Kind
	sc.TargetDocType = doc.DocType
	sc.TargetTitle = doc.Title
	sc.TargetIcon = doc.Icon
	sc.TargetWikiSpaceID = doc.WikiSpaceID
	return sc
}

func (s *Server) listDriveShortcuts(w http.ResponseWriter, r *http.Request) {
	ss, ok := s.Store.(store.DriveShortcutStore)
	if !ok {
		httpx.JSON(w, http.StatusOK, map[string]any{"shortcuts": []store.DriveShortcut{}})
		return
	}
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
	var wsID int64
	if raw := r.URL.Query().Get("workspaceId"); raw != "" {
		var err error
		wsID, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || wsID <= 0 {
			httpx.Error(w, http.StatusBadRequest, "invalid_workspace", "空间无效")
			return
		}
	}
	if wsID, ok = s.driveWorkspace(w, r, u.ID, wsID, parent); !ok {
		return
	}
	shortcuts, err := ss.ListDriveShortcuts(r.Context(), g, wsID, parent, r.URL.Query().Get("scope") == "personal")
	if driveWriteErr(w, err, "list shortcuts") {
		return
	}
	for i := range shortcuts {
		shortcuts[i] = s.enrichShortcut(r.Context(), u.ID, shortcuts[i])
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"shortcuts": shortcuts})
}

func (s *Server) postDriveShortcut(w http.ResponseWriter, r *http.Request) {
	ss, ok := s.Store.(store.DriveShortcutStore)
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "unsupported", "快捷方式暂不可用")
		return
	}
	u, _ := UserFrom(r.Context())
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, u.ID) {
		return
	}
	var in struct {
		WorkspaceID  int64  `json:"workspaceId"`
		ParentID     *int64 `json:"parentId"`
		TargetNodeID int64  `json:"targetNodeId"`
		Title        string `json:"title"`
		Scope        string `json:"scope"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.TargetNodeID <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_target", "请选择要添加快捷方式的文档")
		return
	}
	if in.WorkspaceID, ok = s.driveWorkspace(w, r, u.ID, in.WorkspaceID, in.ParentID); !ok {
		return
	}
	sc, err := ss.CreateDriveShortcut(r.Context(), g, in.WorkspaceID, in.ParentID, in.Scope == "personal", in.TargetNodeID, in.Title)
	if driveWriteErr(w, err, "create shortcut") {
		return
	}
	sc = s.enrichShortcut(r.Context(), u.ID, sc)
	httpx.JSON(w, http.StatusCreated, sc)
}

func (s *Server) deleteDriveShortcut(w http.ResponseWriter, r *http.Request) {
	ss, ok := s.Store.(store.DriveShortcutStore)
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "unsupported", "快捷方式暂不可用")
		return
	}
	u, _ := UserFrom(r.Context())
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, u.ID) {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("sid"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "shortcut id required")
		return
	}
	if err := ss.DeleteDriveShortcut(r.Context(), g, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "快捷方式不存在")
			return
		}
		if driveWriteErr(w, err, "delete shortcut") {
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}
