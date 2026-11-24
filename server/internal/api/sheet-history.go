package api

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) sheetHistoryStore(w http.ResponseWriter) (store.SheetHistoryStore, bool) {
	hs, ok := s.Store.(store.SheetHistoryStore)
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "not_supported", "当前存储不支持表格历史记录")
		return nil, false
	}
	return hs, true
}

func (s *Server) listSheetVersions(w http.ResponseWriter, r *http.Request) {
	_, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	hs, ok := s.sheetHistoryStore(w)
	if !ok {
		return
	}
	versions, err := hs.ListSheetVersions(r.Context(), g, id)
	if driveWriteErr(w, err, "list sheet versions") {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"versions": versions})
}

func (s *Server) createSheetVersion(w http.ResponseWriter, r *http.Request) {
	_, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	hs, ok := s.sheetHistoryStore(w)
	if !ok {
		return
	}
	var in struct {
		Label string `json:"label"`
	}
	if r.ContentLength != 0 && !httpx.Decode(w, r, &in) {
		return
	}
	version, err := hs.CreateSheetVersionGuarded(r.Context(), g, id, in.Label, false)
	if driveWriteErr(w, err, "create sheet version") {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusCreated, map[string]any{"version": version})
}

func (s *Server) restoreSheetVersion(w http.ResponseWriter, r *http.Request) {
	u, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	hs, ok := s.sheetHistoryStore(w)
	if !ok {
		return
	}
	vid, err := strconv.ParseInt(r.PathValue("vid"), 10, 64)
	if err != nil || vid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "版本标识无效")
		return
	}
	snap, err := hs.RestoreSheetVersionGuarded(r.Context(), g, id, vid)
	if driveWriteErr(w, err, "restore sheet version") {
		return
	}
	if s.SheetHub != nil {
		s.SheetHub.Notify(id, snap.WorkbookRevision, u.ID)
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, snap)
}

func (s *Server) listSheetCellHistory(w http.ResponseWriter, r *http.Request) {
	_, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	hs, ok := s.sheetHistoryStore(w)
	if !ok {
		return
	}
	q := r.URL.Query()
	wid, err := strconv.ParseInt(q.Get("worksheetId"), 10, 64)
	if err != nil || wid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "工作表标识无效")
		return
	}
	rowIdx, err := strconv.Atoi(q.Get("row"))
	if err != nil || rowIdx < 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_target", "行坐标无效")
		return
	}
	colIdx, err := strconv.Atoi(q.Get("col"))
	if err != nil || colIdx < 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_target", "列坐标无效")
		return
	}
	limit := 50
	if rawLimit := strings.TrimSpace(q.Get("limit")); rawLimit != "" {
		parsed, err := strconv.Atoi(rawLimit)
		if err != nil || parsed <= 0 {
			httpx.Error(w, http.StatusBadRequest, "invalid_limit", "条数限制无效")
			return
		}
		if parsed > 100 {
			parsed = 100
		}
		limit = parsed
	}
	entries, err := hs.ListSheetCellHistory(r.Context(), g, id, wid, rowIdx, colIdx, limit)
	if driveWriteErr(w, err, "list sheet cell history") {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"entries": entries})
}

type sheetCellHistoryPreState struct {
	store   store.SheetHistoryStore
	rowPos  map[int64]int
	colPos  map[int64]int
	prevRaw map[[2]int64]string
}

func batchHasRawCellWrite(batch store.SheetCellBatch) bool {
	for _, c := range batch.Cells {
		if c.Raw != nil {
			return true
		}
	}
	return false
}

func splitSheetCellRaw(raw string) (value, formula string) {
	if strings.HasPrefix(raw, "=") {
		return "", raw
	}
	return raw, ""
}

// snapshotSheetCellHistoryPreState captures pre-write raw cell values on a best-effort basis
// so post-write cell edit history can record accurate before/after diffs without impacting writes.
func (s *Server) snapshotSheetCellHistoryPreState(ctx context.Context, g store.RestoreGuard, sheetID int64, batch store.SheetCellBatch) *sheetCellHistoryPreState {
	hs, ok := s.Store.(store.SheetHistoryStore)
	if !ok || batch.WorksheetID <= 0 || !batchHasRawCellWrite(batch) {
		return nil
	}
	snap, err := s.Store.GetSheetWorkbook(ctx, g, sheetID)
	if err != nil {
		return nil
	}
	var targetWS *store.SheetWorksheet
	for i := range snap.Sheets {
		if snap.Sheets[i].ID == batch.WorksheetID {
			targetWS = &snap.Sheets[i]
			break
		}
	}
	if targetWS == nil {
		return nil
	}
	rowPos := make(map[int64]int, len(targetWS.Rows))
	for _, r := range targetWS.Rows {
		rowPos[r.ID] = r.Pos
	}
	colPos := make(map[int64]int, len(targetWS.Columns))
	for _, c := range targetWS.Columns {
		colPos[c.ID] = c.Pos
	}
	prevRaw := make(map[[2]int64]string, len(targetWS.Cells))
	for _, c := range targetWS.Cells {
		prevRaw[[2]int64{c.RowID, c.ColumnID}] = c.Raw
	}
	return &sheetCellHistoryPreState{
		store:   hs,
		rowPos:  rowPos,
		colPos:  colPos,
		prevRaw: prevRaw,
	}
}

func (s *Server) recordSheetCellHistoryPostWrite(ctx context.Context, pre *sheetCellHistoryPreState, u store.User, sheetID int64, res store.SheetBatchResult) {
	if pre == nil || res.Replayed || len(res.Cells) == 0 {
		return
	}
	now := s.now().UTC()
	entries := make([]store.SheetCellHistoryEntry, 0, len(res.Cells))
	for _, written := range res.Cells {
		rPos, okR := pre.rowPos[written.RowID]
		cPos, okC := pre.colPos[written.ColumnID]
		if !okR || !okC {
			continue
		}
		beforeRaw := pre.prevRaw[[2]int64{written.RowID, written.ColumnID}]
		afterRaw := written.Raw
		if beforeRaw == afterRaw {
			continue
		}
		prevVal, prevFormula := splitSheetCellRaw(beforeRaw)
		nextVal, nextFormula := splitSheetCellRaw(afterRaw)
		entries = append(entries, store.SheetCellHistoryEntry{
			SheetID:     sheetID,
			WorksheetID: res.WorksheetID,
			Row:         rPos,
			Col:         cPos,
			PrevValue:   prevVal,
			NextValue:   nextVal,
			PrevFormula: prevFormula,
			NextFormula: nextFormula,
			ActorID:     u.ID,
			ActorName:   u.Name,
			CreatedAt:   now,
		})
	}
	if len(entries) == 0 {
		return
	}
	if err := pre.store.RecordSheetCellHistory(ctx, entries); err != nil && s.Log != nil {
		s.Log.Warn("record sheet cell history failed", "sheetId", sheetID, "err", err)
	}
}
