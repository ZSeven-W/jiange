package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) enrichWikiShortcut(ctx context.Context, userID int64, sc store.WikiShortcut) store.WikiShortcut {
	doc, err := s.Store.GetDoc(ctx, userID, sc.TargetNodeID)
	if err != nil {
		sc.TargetAccessible = false
		sc.Title = ""
		sc.TargetKind = ""
		sc.TargetDocType = ""
		sc.TargetTitle = ""
		sc.TargetIcon = ""
		sc.TargetWikiSpaceID = nil
		sc.TargetWikiSpaceName = ""
		return sc
	}
	sc.TargetAccessible = true
	sc.TargetKind = doc.Kind
	sc.TargetDocType = doc.DocType
	sc.TargetTitle = doc.Title
	sc.TargetIcon = doc.Icon
	sc.TargetWikiSpaceID = doc.WikiSpaceID
	sc.TargetWikiSpaceName = doc.WikiSpaceName
	return sc
}

func (s *Server) wikiError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "没有知识库操作权限")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "知识库或节点不存在")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "wiki_conflict", "参数无效或知识库目录存在冲突")
	default:
		s.fail(w, r, err)
	}
}

func (s *Server) listWikiSpaces(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	spaces, err := s.Store.ListWikiSpaces(r.Context(), guard, wsID)
	if err != nil {
		s.wikiError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"spaces": spaces})
}

func (s *Server) postWikiSpace(w http.ResponseWriter, r *http.Request) {
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Icon        string `json:"icon"`
		Visibility  string `json:"visibility"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_name", "知识库名称不能为空")
		return
	}
	sp, err := s.Store.CreateWikiSpaceGuarded(r.Context(), guard, wsID, in.Name, in.Description, in.Icon, in.Visibility)
	if err != nil {
		s.wikiError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, sp)
}

func (s *Server) getWikiSpace(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	spaceID, ok := s.parsePositivePathID(w, r, "spaceId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	detail, err := s.Store.GetWikiSpaceDetail(r.Context(), guard, spaceID)
	if err != nil {
		s.wikiError(w, r, err)
		return
	}
	for i := range detail.Shortcuts {
		detail.Shortcuts[i] = s.enrichWikiShortcut(r.Context(), guard.UserID, detail.Shortcuts[i])
	}
	httpx.JSON(w, http.StatusOK, detail)
}

func (s *Server) patchWikiSpace(w http.ResponseWriter, r *http.Request) {
	spaceID, ok := s.parsePositivePathID(w, r, "spaceId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
		Icon        *string `json:"icon"`
		Visibility  *string `json:"visibility"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	sp, err := s.Store.UpdateWikiSpaceGuarded(r.Context(), guard, spaceID, in.Name, in.Description, in.Icon, in.Visibility)
	if err != nil {
		s.wikiError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, sp)
}

func (s *Server) deleteWikiSpace(w http.ResponseWriter, r *http.Request) {
	spaceID, ok := s.parsePositivePathID(w, r, "spaceId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	freed, err := s.Store.DeleteWikiSpaceGuarded(r.Context(), guard, spaceID)
	if err != nil {
		s.wikiError(w, r, err)
		return
	}
	if s.Blobs != nil {
		for _, key := range freed {
			_ = s.Blobs.Delete(r.Context(), key)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) putWikiSpaceGrant(w http.ResponseWriter, r *http.Request) {
	spaceID, ok := s.parsePositivePathID(w, r, "spaceId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		SubjectType string `json:"subjectType"`
		SubjectID   int64  `json:"subjectId"`
		Role        string `json:"role"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	grants, err := s.Store.SetWikiSpaceGrantGuarded(r.Context(), guard, spaceID, in.SubjectType, in.SubjectID, in.Role)
	if err != nil {
		s.wikiError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"grants": grants})
}

func (s *Server) postWikiNode(w http.ResponseWriter, r *http.Request) {
	spaceID, ok := s.parsePositivePathID(w, r, "spaceId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		ParentID *int64 `json:"parentId"`
		Kind     string `json:"kind"`
		DocType  string `json:"docType"`
		Title    string `json:"title"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	kind := in.Kind
	docType := in.DocType
	if kind == "" {
		kind = "doc"
	}
	if kind == "board" {
		kind = "doc"
		docType = "board"
	}
	title, valid := cleanTitle(w, in.Title)
	if !valid {
		return
	}
	if title == "" {
		switch {
		case kind == "sheet":
			title = "未命名表格"
		case kind == "base":
			title = "未命名多维表格"
		case kind == "slides":
			title = "未命名幻灯片"
		case kind == "folder":
			title = "未命名分组"
		case docType == "board":
			title = "未命名画板"
		default:
			title = "未命名文档"
		}
	}
	node, err := s.Store.CreateWikiNodeGuarded(r.Context(), guard, spaceID, in.ParentID, kind, docType, title)
	if err != nil {
		s.wikiError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, node)
}

func (s *Server) postWikiImportDrive(w http.ResponseWriter, r *http.Request) {
	spaceID, ok := s.parsePositivePathID(w, r, "spaceId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		NodeID           int64  `json:"nodeId"`
		TargetParentID   *int64 `json:"targetParentId"`
		ExpectedRevision int64  `json:"expectedRevision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.NodeID <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_node", "nodeId 必须为正整数")
		return
	}
	node, err := s.Store.ImportDriveNodeToWikiGuarded(r.Context(), guard, in.NodeID, spaceID, in.TargetParentID, in.ExpectedRevision)
	if err != nil {
		s.wikiError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, node)
}

func (s *Server) postWikiNodeMove(w http.ResponseWriter, r *http.Request) {
	nodeID, ok := s.parsePositivePathID(w, r, "id")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		TargetSpaceID    int64  `json:"targetSpaceId"`
		TargetParentID   *int64 `json:"targetParentId"`
		ExpectedRevision int64  `json:"expectedRevision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.TargetSpaceID <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_space", "targetSpaceId 必须为正整数")
		return
	}
	node, err := s.Store.MoveWikiNodeGuarded(r.Context(), guard, nodeID, in.TargetSpaceID, in.TargetParentID, in.ExpectedRevision)
	if err != nil {
		s.wikiError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, node)
}

func (s *Server) postWikiNodeReorder(w http.ResponseWriter, r *http.Request) {
	spaceID, ok := s.parsePositivePathID(w, r, "spaceId")
	if !ok {
		return
	}
	nodeID, ok := s.parsePositivePathID(w, r, "id")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		TargetParentID   *int64 `json:"targetParentId"`
		Position         int    `json:"position"`
		ExpectedRevision int64  `json:"expectedRevision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Position < 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_position", "排序位置必须为非负整数")
		return
	}
	node, err := s.Store.ReorderWikiNodeGuarded(r.Context(), guard, spaceID, nodeID, in.TargetParentID, in.Position, in.ExpectedRevision)
	if err != nil {
		s.wikiError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, node)
}

func (s *Server) postWikiShortcut(w http.ResponseWriter, r *http.Request) {
	spaceID, ok := s.parsePositivePathID(w, r, "spaceId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		ParentID     *int64 `json:"parentId"`
		TargetNodeID int64  `json:"targetNodeId"`
		Title        string `json:"title"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.TargetNodeID <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_target", "请选择要引用的目标页面或文档")
		return
	}
	sc, err := s.Store.CreateWikiShortcutGuarded(r.Context(), guard, spaceID, in.ParentID, in.TargetNodeID, in.Title)
	if err != nil {
		s.wikiError(w, r, err)
		return
	}
	sc = s.enrichWikiShortcut(r.Context(), guard.UserID, sc)
	httpx.JSON(w, http.StatusCreated, sc)
}

func (s *Server) deleteWikiShortcut(w http.ResponseWriter, r *http.Request) {
	spaceID, ok := s.parsePositivePathID(w, r, "spaceId")
	if !ok {
		return
	}
	shortcutID, ok := s.parsePositivePathID(w, r, "sid")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	if err := s.Store.DeleteWikiShortcutGuarded(r.Context(), guard, spaceID, shortcutID); err != nil {
		s.wikiError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
