package api

import (
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
)

func (s *Server) notifySheetCommentChange(r *http.Request, nodeID, userID int64) {
	if s.SheetHub == nil {
		return
	}
	rev, err := s.Store.SheetHead(r.Context(), nodeID)
	if err != nil {
		return
	}
	s.SheetHub.Notify(nodeID, rev, userID)
}

func (s *Server) listSheetComments(w http.ResponseWriter, r *http.Request) {
	_, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	var wid *int64
	if raw := r.URL.Query().Get("worksheetId"); raw != "" {
		v, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || v <= 0 {
			httpx.Error(w, http.StatusBadRequest, "invalid_id", "工作表标识无效")
			return
		}
		wid = &v
	}
	items, err := s.Store.ListSheetComments(r.Context(), g, id, wid)
	if driveWriteErr(w, err, "list sheet comments") {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"comments": items})
}

func (s *Server) createSheetComment(w http.ResponseWriter, r *http.Request) {
	u, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	var in struct {
		WorksheetID int64  `json:"worksheetId"`
		RowID       int64  `json:"rowId"`
		ColumnID    int64  `json:"columnId"`
		Body        string `json:"body"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.WorksheetID <= 0 || in.RowID <= 0 || in.ColumnID <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_target", "单元格坐标无效")
		return
	}
	cm, err := s.Store.CreateSheetComment(r.Context(), g, id, in.WorksheetID, in.RowID, in.ColumnID, in.Body)
	if driveWriteErr(w, err, "create sheet comment") {
		return
	}
	s.notifySheetCommentChange(r, id, u.ID)
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusCreated, map[string]any{"comment": cm})
}

func (s *Server) patchSheetComment(w http.ResponseWriter, r *http.Request) {
	u, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	cid, err := strconv.ParseInt(r.PathValue("cid"), 10, 64)
	if err != nil || cid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "评论标识无效")
		return
	}
	var in struct {
		Body     *string `json:"body"`
		Resolved *bool   `json:"resolved"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Body == nil && in.Resolved == nil {
		httpx.Error(w, http.StatusBadRequest, "empty_patch", "未指定需要修改的内容")
		return
	}
	cm, err := s.Store.UpdateSheetComment(r.Context(), g, id, cid, in.Body, in.Resolved)
	if driveWriteErr(w, err, "patch sheet comment") {
		return
	}
	s.notifySheetCommentChange(r, id, u.ID)
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"comment": cm})
}

func (s *Server) deleteSheetComment(w http.ResponseWriter, r *http.Request) {
	u, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	cid, err := strconv.ParseInt(r.PathValue("cid"), 10, 64)
	if err != nil || cid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "评论标识无效")
		return
	}
	if err := s.Store.DeleteSheetComment(r.Context(), g, id, cid); driveWriteErr(w, err, "delete sheet comment") {
		return
	}
	s.notifySheetCommentChange(r, id, u.ID)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
