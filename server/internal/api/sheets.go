package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const sheetProtocolVersion = "1"

func (s *Server) sheetRequestGuard(w http.ResponseWriter, r *http.Request) (store.User, store.RestoreGuard, int64, bool) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "请重新登录")
		return store.User{}, store.RestoreGuard{}, 0, false
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "操作账号未确认")
		return store.User{}, store.RestoreGuard{}, 0, false
	}
	if !driveExpectedUser(w, r, u.ID) {
		return store.User{}, store.RestoreGuard{}, 0, false
	}
	if r.Header.Get("X-Jiange-Sheet-Version") != sheetProtocolVersion {
		httpx.Error(w, http.StatusUpgradeRequired, "sheet_client_outdated", "请刷新以使用兼容当前电子表格的版本")
		return store.User{}, store.RestoreGuard{}, 0, false
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return store.User{}, store.RestoreGuard{}, 0, false
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "表格标识无效")
		return store.User{}, store.RestoreGuard{}, 0, false
	}
	return u, g, id, true
}

func (s *Server) getSheetWorkbook(w http.ResponseWriter, r *http.Request) {
	_, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	snap, err := s.Store.GetSheetWorkbook(r.Context(), g, id)
	if driveWriteErr(w, err, "get sheet") {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, snap)
}

func (s *Server) postAccountSheetTitle(w http.ResponseWriter, r *http.Request) {
	_, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	var in struct {
		Title         *string `json:"title"`
		Expected      *int64  `json:"expected"`
		ExpectedTitle *string `json:"expectedTitle"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Title == nil || in.Expected == nil || in.ExpectedTitle == nil || *in.Expected < 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_revision", "名称和版本不能为空")
		return
	}
	title := driveCleanTitle(w, *in.Title)
	if title == "" {
		return
	}
	entry, err := s.Store.RenameSheetTitle(r.Context(), g, id, title, *in.ExpectedTitle, *in.Expected)
	if driveWriteErr(w, err, "rename sheet") {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, entry)
}

func (s *Server) writeSheetCells(w http.ResponseWriter, r *http.Request) {
	u, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	var batch store.SheetCellBatch
	if !httpx.Decode(w, r, &batch) {
		return
	}
	res, err := s.Store.WriteSheetCells(r.Context(), g, id, batch)
	if errors.Is(err, store.ErrSheetValidation) {
		httpx.Error(w, http.StatusUnprocessableEntity, "validation_failed", "单元格内容不符合数据验证规则")
		return
	}
	if driveWriteErr(w, err, "write sheet cells") {
		return
	}
	if s.SheetHub != nil && !res.Replayed {
		s.SheetHub.Notify(id, res.WorkbookRevision, u.ID)
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, res)
}

func (s *Server) createWorksheet(w http.ResponseWriter, r *http.Request) {
	u, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	var in struct {
		Title string `json:"title"`
	}
	if r.ContentLength != 0 && !httpx.Decode(w, r, &in) {
		return
	}
	ws, rev, err := s.Store.CreateWorksheet(r.Context(), g, id, in.Title)
	if driveWriteErr(w, err, "create worksheet") {
		return
	}
	if s.SheetHub != nil {
		s.SheetHub.Notify(id, rev, u.ID)
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusCreated, map[string]any{"worksheet": ws, "workbookRevision": rev})
}

func (s *Server) updateWorksheetMeta(w http.ResponseWriter, r *http.Request) {
	u, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	wid, err := strconv.ParseInt(r.PathValue("wid"), 10, 64)
	if err != nil || wid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "工作表标识无效")
		return
	}
	var patch store.WorksheetPatch
	if !httpx.Decode(w, r, &patch) {
		return
	}
	ws, rev, err := s.Store.UpdateWorksheetMeta(r.Context(), g, id, wid, patch)
	if driveWriteErr(w, err, "update worksheet") {
		return
	}
	if s.SheetHub != nil {
		s.SheetHub.Notify(id, rev, u.ID)
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"worksheet": ws, "workbookRevision": rev})
}

func (s *Server) deleteWorksheet(w http.ResponseWriter, r *http.Request) {
	u, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	wid, err := strconv.ParseInt(r.PathValue("wid"), 10, 64)
	if err != nil || wid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "工作表标识无效")
		return
	}
	rev, err := s.Store.DeleteWorksheet(r.Context(), g, id, wid)
	if driveWriteErr(w, err, "delete worksheet") {
		return
	}
	if s.SheetHub != nil {
		s.SheetHub.Notify(id, rev, u.ID)
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"workbookRevision": rev})
}

func (s *Server) mutateSheetAxis(w http.ResponseWriter, r *http.Request) {
	u, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	wid, err := strconv.ParseInt(r.PathValue("wid"), 10, 64)
	if err != nil || wid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "工作表标识无效")
		return
	}
	var op store.SheetAxisOp
	if !httpx.Decode(w, r, &op) {
		return
	}
	ws, rev, err := s.Store.MutateSheetAxis(r.Context(), g, id, wid, op)
	if driveWriteErr(w, err, "mutate sheet axis") {
		return
	}
	if s.SheetHub != nil {
		s.SheetHub.Notify(id, rev, u.ID)
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"worksheet": ws, "workbookRevision": rev})
}

func (s *Server) importSheetXlsx(w http.ResponseWriter, r *http.Request) {
	u, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	var in struct {
		ExpectedWorkbookRevision *int64                    `json:"expectedWorkbookRevision"`
		MutationID               string                    `json:"mutationId"`
		Sheets                   []store.ImportedWorksheet `json:"sheets"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.ExpectedWorkbookRevision == nil || *in.ExpectedWorkbookRevision < 1 {
		httpx.Error(w, http.StatusBadRequest, "invalid_revision", "工作簿版本无效")
		return
	}
	snap, err := s.Store.ReplaceSheetWorkbook(r.Context(), g, id, *in.ExpectedWorkbookRevision, in.MutationID, in.Sheets)
	if driveWriteErr(w, err, "import xlsx") {
		return
	}
	if s.SheetHub != nil {
		s.SheetHub.Notify(id, snap.WorkbookRevision, u.ID)
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, snap)
}

func (s *Server) serveSheetWS(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "请重新登录")
		return
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "表格标识无效")
		return
	}
	if _, err := s.Store.GetSheetWorkbook(r.Context(), g, id); driveWriteErr(w, err, "sheet ws") {
		return
	}
	check := func(ctx context.Context) error {
		sessionUser, err := s.Store.SessionUser(ctx, g.SessionHash, s.now())
		if err != nil || sessionUser.ID != u.ID {
			return store.ErrUnauthenticated
		}
		meta, err := s.Store.GetDoc(ctx, u.ID, id)
		if err != nil || meta.Kind != "sheet" || store.RoleRank(meta.Role) < store.RoleRank(store.RoleView) {
			return store.ErrNotFound
		}
		return nil
	}
	s.SheetHub.Serve(w, r, id, u, check)
}
