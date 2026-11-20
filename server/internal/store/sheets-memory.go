package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/text/cases"
)

type memSheetCellKey struct {
	rowID, colID int64
}

type memSheetReceiptKey struct {
	userID     int64
	mutationID string
}

type memSheetReceipt struct {
	created time.Time
	digest  string
	batch   *SheetCellBatch
	result  *SheetBatchResult
	replace *SheetSnapshot
}

type memWorksheet struct {
	id                 int64
	nodeID             int64
	title              string
	pos                int
	frozenRows         int
	frozenCols         int
	merges             []SheetMerge
	filter             SheetFilterConfig
	validations        []SheetDataValidation
	conditionalFormats []SheetConditionalFormat
	protectedRanges    []SheetProtectedRange
	charts             []SheetChart
	pivotTables        []SheetPivotTable
	revision           int64
	rows               []SheetAxis
	columns            []SheetAxis
	rowIndex           map[int64]bool
	colIndex           map[int64]bool
	cells              map[memSheetCellKey]SheetCell
	cellFieldRevs      map[memSheetCellKey]map[string]int64
	cellUpdatedBy      map[memSheetCellKey]int64
}

type memWorkbook struct {
	nodeID   int64
	revision int64
	order    []int64
	sheets   map[int64]*memWorksheet
	receipts map[memSheetReceiptKey]memSheetReceipt
}

type memSheets struct {
	nextWorksheetID int64
	nextAxisID      int64
	books           map[int64]*memWorkbook
}

func (m *Memory) ensureSheetMapsLocked() {
	if m.sheets.books == nil {
		m.sheets.books = map[int64]*memWorkbook{}
	}
}

func (m *Memory) createMemWorksheetLocked(nodeID int64, title string, pos, rows, cols int) *memWorksheet {
	m.sheets.nextWorksheetID++
	id := m.sheets.nextWorksheetID
	ws := &memWorksheet{
		id:       id,
		nodeID:   nodeID,
		title:    title,
		pos:      pos,
		merges:   []SheetMerge{},
		revision: 1,
		rows:     make([]SheetAxis, 0, rows),
		columns:  make([]SheetAxis, 0, cols),
		rowIndex:      make(map[int64]bool, rows),
		colIndex:      make(map[int64]bool, cols),
		cells:         map[memSheetCellKey]SheetCell{},
		cellFieldRevs: map[memSheetCellKey]map[string]int64{},
		cellUpdatedBy: map[memSheetCellKey]int64{},
	}
	for i := 0; i < rows; i++ {
		m.sheets.nextAxisID++
		aid := m.sheets.nextAxisID
		ws.rows = append(ws.rows, SheetAxis{ID: aid, Pos: i})
		ws.rowIndex[aid] = true
	}
	for i := 0; i < cols; i++ {
		m.sheets.nextAxisID++
		aid := m.sheets.nextAxisID
		ws.columns = append(ws.columns, SheetAxis{ID: aid, Pos: i})
		ws.colIndex[aid] = true
	}
	return ws
}

func (m *Memory) initSheetWorkbookLocked(nodeID int64) {
	m.ensureSheetMapsLocked()
	ws := m.createMemWorksheetLocked(nodeID, "Sheet1", 0, sheetInitialRows, sheetInitialCols)
	m.sheets.books[nodeID] = &memWorkbook{
		nodeID:   nodeID,
		revision: 1,
		order:    []int64{ws.id},
		sheets:   map[int64]*memWorksheet{ws.id: ws},
		receipts: map[memSheetReceiptKey]memSheetReceipt{},
	}
}

func (w *memWorksheet) toModel() SheetWorksheet {
	cells := make([]SheetCell, 0, len(w.cells))
	for _, cell := range w.cells {
		cells = append(cells, cell)
	}
	sort.Slice(cells, func(i, j int) bool {
		if cells[i].RowID != cells[j].RowID {
			return cells[i].RowID < cells[j].RowID
		}
		return cells[i].ColumnID < cells[j].ColumnID
	})
	return cloneSheetWorksheet(SheetWorksheet{
		ID:                 w.id,
		NodeID:             w.nodeID,
		Title:              w.title,
		Pos:                w.pos,
		FrozenRows:         w.frozenRows,
		FrozenCols:         w.frozenCols,
		Merges:             w.merges,
		Filter:             w.filter,
		Validations:        w.validations,
		ConditionalFormats: w.conditionalFormats,
		ProtectedRanges:    w.protectedRanges,
		Charts:             w.charts,
		PivotTables:        w.pivotTables,
		Revision:           w.revision,
		Rows:               w.rows,
		Columns:            w.columns,
		Cells:              cells,
	})
}

func (m *Memory) authorizeSheetLocked(ctx context.Context, g RestoreGuard, nodeID int64, minRole string) (*memDoc, *memWorkbook, string, time.Time, error) {
	expires, err := m.driveSessionLocked(ctx, g)
	if err != nil {
		return nil, nil, "", time.Time{}, err
	}
	if !validSheetID(nodeID) {
		return nil, nil, "", time.Time{}, ErrNotFound
	}
	d := m.doc(nodeID)
	if d == nil || d.deleted || d.purged || d.meta.Kind != "sheet" {
		return nil, nil, "", time.Time{}, ErrNotFound
	}
	role := m.roleLocked(g.UserID, d)
	if RoleRank(role) < RoleRank(RoleView) || !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) {
		return nil, nil, "", time.Time{}, ErrNotFound
	}
	if RoleRank(role) < RoleRank(minRole) {
		return nil, nil, "", time.Time{}, ErrForbidden
	}
	wb := m.sheets.books[nodeID]
	if wb == nil {
		return nil, nil, "", time.Time{}, ErrNotFound
	}
	return d, wb, role, expires, nil
}

func (m *Memory) sheetSnapshotLocked(d *memDoc, wb *memWorkbook, role string) SheetSnapshot {
	sheets := make([]SheetWorksheet, 0, len(wb.order))
	for _, wid := range wb.order {
		if ws := wb.sheets[wid]; ws != nil {
			sheets = append(sheets, ws.toModel())
		}
	}
	sort.Slice(sheets, func(i, j int) bool {
		if sheets[i].Pos != sheets[j].Pos {
			return sheets[i].Pos < sheets[j].Pos
		}
		return sheets[i].ID < sheets[j].ID
	})
	return SheetSnapshot{
		NodeID:           d.meta.ID,
		WorkspaceID:      d.meta.WorkspaceID,
		ParentID:         cloneDriveParent(d.meta.ParentID),
		Title:            d.meta.Title,
		Role:             role,
		CreatorID:        d.meta.CreatorID,
		CreatorName:      d.meta.CreatorName,
		DriveRevision:    d.driveRevision,
		WorkbookRevision: wb.revision,
		Sheets:           sheets,
		UpdatedAt:        d.meta.UpdatedAt,
	}
}

func (m *Memory) GetSheetWorkbook(ctx context.Context, g RestoreGuard, nodeID int64) (SheetSnapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, wb, role, expires, err := m.authorizeSheetLocked(ctx, g, nodeID, RoleView)
	if err != nil {
		return SheetSnapshot{}, err
	}
	snap := m.sheetSnapshotLocked(d, wb, role)
	if err := driveMemoryEnd(ctx, g, expires); err != nil {
		return SheetSnapshot{}, err
	}
	return snap, nil
}

func (m *Memory) SheetHead(ctx context.Context, nodeID int64) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(nodeID)
	wb := m.sheets.books[nodeID]
	if d == nil || d.deleted || d.purged || d.meta.Kind != "sheet" || wb == nil {
		return 0, ErrNotFound
	}
	return wb.revision, nil
}

func (m *Memory) RenameSheetTitle(ctx context.Context, g RestoreGuard, nodeID int64, title, expectedTitle string, expectedDriveRevision int64) (DriveEntry, error) {
	if !validDriveTitle(title) {
		return DriveEntry{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d, _, _, expires, err := m.authorizeSheetLocked(ctx, g, nodeID, RoleEdit)
	if err != nil {
		return DriveEntry{}, err
	}
	if d.driveRevision != expectedDriveRevision || d.driveRevision >= maxDriveRevision || d.meta.Title != expectedTitle {
		return DriveEntry{}, ErrConflict
	}
	if err := driveMemoryEnd(ctx, g, expires); err != nil {
		return DriveEntry{}, err
	}
	d.meta.Title = title
	d.driveRevision++
	d.meta.DriveRevision = d.driveRevision
	d.meta.UpdatedAt = time.Now()
	m.setDocumentModifierLocked(d, g.UserID)
	return driveMemoryEntry(m, d, g.UserID), nil
}

func (m *Memory) WriteSheetCells(ctx context.Context, g RestoreGuard, nodeID int64, batch SheetCellBatch) (SheetBatchResult, error) {
	prepared, sum, err := prepareSheetBatch(batch)
	if err != nil {
		return SheetBatchResult{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d, wb, role, expires, err := m.authorizeSheetLocked(ctx, g, nodeID, RoleEdit)
	if err != nil {
		return SheetBatchResult{}, err
	}
	rKey := memSheetReceiptKey{userID: g.UserID, mutationID: prepared.MutationID}
	digest := "batch:" + hex.EncodeToString(sum)
	if receipt, ok := wb.receipts[rKey]; ok {
		if receipt.digest != digest || receipt.result == nil {
			return SheetBatchResult{}, ErrConflict
		}
		res := *receipt.result
		res.Cells = slices.Clone(res.Cells)
		res.Conflicts = slices.Clone(res.Conflicts)
		res.Replayed = true
		return res, driveMemoryEnd(ctx, g, expires)
	}
	ws := wb.sheets[prepared.WorksheetID]
	if ws == nil {
		return SheetBatchResult{}, ErrNotFound
	}
	if wb.revision >= sheetMaxRevision || ws.revision >= sheetMaxRevision {
		return SheetBatchResult{}, ErrConflict
	}
	autoMerge := prepared.MergeMode == SheetMergeModeAuto
	rowPos := make(map[int64]int, len(ws.rows))
	rowIDByPos := make(map[int]int64, len(ws.rows))
	for _, r := range ws.rows {
		rowPos[r.ID] = r.Pos
		rowIDByPos[r.Pos] = r.ID
	}
	colPos := make(map[int64]int, len(ws.columns))
	colIDByPos := make(map[int]int64, len(ws.columns))
	for _, c := range ws.columns {
		colPos[c.ID] = c.Pos
		colIDByPos[c.Pos] = c.ID
	}

	type pendingCellWrite struct {
		key      memSheetCellKey
		resolved resolvedCellWrite
	}
	pending := make([]pendingCellWrite, 0, len(prepared.Cells))
	conflicts := make([]SheetCellConflict, 0)
	mergedCount := 0

	for _, w := range prepared.Cells {
		if !ws.rowIndex[w.RowID] || !ws.colIndex[w.ColumnID] {
			return SheetBatchResult{}, ErrNotFound
		}
		rPos := rowPos[w.RowID]
		cPos := colPos[w.ColumnID]
		if len(ws.protectedRanges) > 0 {
			if err := checkProtectedCellWrite(role, g.UserID, rPos, cPos, ws.protectedRanges); err != nil {
				return SheetBatchResult{}, err
			}
		}
		if w.Raw != nil && len(ws.validations) > 0 {
			if err := checkCellValidationWrite(*w.Raw, rPos, cPos, ws.validations); err != nil {
				return SheetBatchResult{}, err
			}
		}
		k := memSheetCellKey{rowID: w.RowID, colID: w.ColumnID}
		cur := ws.cells[k]
		if autoMerge && len(ws.merges) > 0 && w.Raw != nil && *w.Raw != "" {
			if mRect, covered := findMergeCovering(ws.merges, rPos, cPos); covered && !(rPos == mRect.Top && cPos == mRect.Left) {
				anchorRowID := rowIDByPos[mRect.Top]
				anchorColID := colIDByPos[mRect.Left]
				anchorCell := ws.cells[memSheetCellKey{rowID: anchorRowID, colID: anchorColID}]
				rawCopy := *w.Raw
				mc := mRect
				conflicts = append(conflicts, SheetCellConflict{
					RowID:               w.RowID,
					ColumnID:            w.ColumnID,
					Row:                 rPos,
					Col:                 cPos,
					ExpectedRevision:    w.ExpectedRevision,
					CurrentRevision:     cur.Revision,
					CurrentRaw:          cur.Raw,
					CurrentStyle:        cloneSheetStyle(cur.Style),
					AttemptedRaw:        &rawCopy,
					AttemptedStylePatch: cloneSheetStylePatch(w.StylePatch),
					ConflictingFields:   []string{"raw"},
					Reason:              "merge_slave_conflict",
					MergeRect:           &mc,
					AnchorRowID:         anchorRowID,
					AnchorColumnID:      anchorColID,
					AnchorRaw:           anchorCell.Raw,
					AnchorRevision:      anchorCell.Revision,
				})
				continue
			}
		}
		updatedBy := ws.cellUpdatedBy[k]
		updatedByName := ""
		if updatedBy > 0 {
			if u := m.userByID(updatedBy); u != nil {
				updatedByName = u.Name
			}
		}
		resolved, ok := resolveSheetCellWrite(cur, ws.cellFieldRevs[k], updatedBy, updatedByName, rPos, cPos, w, autoMerge)
		if !ok {
			return SheetBatchResult{}, ErrConflict
		}
		if resolved.conflict != nil {
			conflicts = append(conflicts, *resolved.conflict)
			continue
		}
		if resolved.merged {
			mergedCount++
		}
		pending = append(pending, pendingCellWrite{key: k, resolved: resolved})
	}
	if err := driveMemoryEnd(ctx, g, expires); err != nil {
		return SheetBatchResult{}, err
	}
	revisions := make([]SheetCellRevision, 0, len(pending))
	if ws.cellFieldRevs == nil {
		ws.cellFieldRevs = map[memSheetCellKey]map[string]int64{}
	}
	if ws.cellUpdatedBy == nil {
		ws.cellUpdatedBy = map[memSheetCellKey]int64{}
	}
	for _, p := range pending {
		ws.cells[p.key] = SheetCell{
			RowID:    p.key.rowID,
			ColumnID: p.key.colID,
			Raw:      p.resolved.nextRaw,
			Style:    cloneSheetStyle(p.resolved.nextStyle),
			Revision: p.resolved.nextRev,
		}
		ws.cellFieldRevs[p.key] = p.resolved.nextFieldRevs
		ws.cellUpdatedBy[p.key] = g.UserID
		revisions = append(revisions, SheetCellRevision{
			RowID:    p.key.rowID,
			ColumnID: p.key.colID,
			Revision: p.resolved.nextRev,
			Raw:      p.resolved.nextRaw,
			Style:    cloneSheetStyle(p.resolved.nextStyle),
			Merged:   p.resolved.merged,
		})
	}
	if len(pending) > 0 {
		ws.revision++
		wb.revision++
		d.meta.UpdatedAt = time.Now()
		m.setDocumentModifierLocked(d, g.UserID)
	}
	out := SheetBatchResult{
		MutationID:       prepared.MutationID,
		WorksheetID:      ws.id,
		WorkbookRevision: wb.revision,
		Cells:            revisions,
		Conflicts:        conflicts,
		MergedCount:      mergedCount,
	}
	saved := out
	saved.Cells = slices.Clone(revisions)
	saved.Conflicts = slices.Clone(conflicts)
	pruneMemSheetReceipts(wb, time.Now())
	wb.receipts[rKey] = memSheetReceipt{created: time.Now(), digest: digest, result: &saved}
	return out, nil
}

func (m *Memory) CreateWorksheet(ctx context.Context, g RestoreGuard, nodeID int64, rawTitle string) (SheetWorksheet, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, wb, _, expires, err := m.authorizeSheetLocked(ctx, g, nodeID, RoleEdit)
	if err != nil {
		return SheetWorksheet{}, 0, err
	}
	if len(wb.order) >= sheetMaxWorksheets || wb.revision >= sheetMaxRevision {
		return SheetWorksheet{}, 0, ErrConflict
	}
	title := strings.TrimSpace(rawTitle)
	if title == "" {
		existing := map[string]bool{}
		for _, id := range wb.order {
			existing[strings.ToLower(wb.sheets[id].title)] = true
		}
		for n := len(wb.order) + 1; ; n++ {
			candidate := "Sheet" + strconv.Itoa(n)
			if !existing[strings.ToLower(candidate)] {
				title = candidate
				break
			}
		}
	} else {
		var ok bool
		title, ok = cleanWorksheetTitle(title)
		if !ok {
			return SheetWorksheet{}, 0, ErrConflict
		}
		for _, id := range wb.order {
			if strings.EqualFold(wb.sheets[id].title, title) {
				return SheetWorksheet{}, 0, ErrConflict
			}
		}
	}
	if err := driveMemoryEnd(ctx, g, expires); err != nil {
		return SheetWorksheet{}, 0, err
	}
	ws := m.createMemWorksheetLocked(nodeID, title, len(wb.order), sheetInitialRows, sheetInitialCols)
	wb.sheets[ws.id] = ws
	wb.order = append(wb.order, ws.id)
	wb.revision++
	d.meta.UpdatedAt = time.Now()
	m.setDocumentModifierLocked(d, g.UserID)
	return ws.toModel(), wb.revision, nil
}

func (m *Memory) UpdateWorksheetMeta(ctx context.Context, g RestoreGuard, nodeID, worksheetID int64, patch WorksheetPatch) (SheetWorksheet, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, wb, role, expires, err := m.authorizeSheetLocked(ctx, g, nodeID, RoleEdit)
	if err != nil {
		return SheetWorksheet{}, 0, err
	}
	ws := wb.sheets[worksheetID]
	if ws == nil {
		return SheetWorksheet{}, 0, ErrNotFound
	}
	if wb.revision >= sheetMaxRevision || ws.revision >= sheetMaxRevision {
		return SheetWorksheet{}, 0, ErrConflict
	}
	if patch.ExpectedRevision != nil && ws.revision != *patch.ExpectedRevision {
		return SheetWorksheet{}, 0, ErrConflict
	}
	nextTitle := ws.title
	if patch.Title != nil {
		var ok bool
		nextTitle, ok = cleanWorksheetTitle(*patch.Title)
		if !ok {
			return SheetWorksheet{}, 0, ErrConflict
		}
		for id, other := range wb.sheets {
			if id != ws.id && strings.EqualFold(other.title, nextTitle) {
				return SheetWorksheet{}, 0, ErrConflict
			}
		}
	}
	nextPos := ws.pos
	if patch.Pos != nil {
		if *patch.Pos < 0 || *patch.Pos >= len(wb.order) {
			return SheetWorksheet{}, 0, ErrConflict
		}
		nextPos = *patch.Pos
	}
	nextFrozenRows := ws.frozenRows
	if patch.FrozenRows != nil {
		if *patch.FrozenRows < 0 || *patch.FrozenRows > min(sheetMaxFrozenRows, len(ws.rows)-1) {
			return SheetWorksheet{}, 0, ErrConflict
		}
		nextFrozenRows = *patch.FrozenRows
	}
	nextFrozenCols := ws.frozenCols
	if patch.FrozenCols != nil {
		if *patch.FrozenCols < 0 || *patch.FrozenCols > min(sheetMaxFrozenCols, len(ws.columns)-1) {
			return SheetWorksheet{}, 0, ErrConflict
		}
		nextFrozenCols = *patch.FrozenCols
	}
	nextMerges := slices.Clone(ws.merges)
	mergeOpNoop := false
	if patch.Merges != nil && patch.MergeOp != nil {
		return SheetWorksheet{}, 0, ErrConflict
	}
	if patch.Merges != nil {
		var ok bool
		nextMerges, ok = validateAndNormalizeSheetMerges(*patch.Merges, len(ws.rows), len(ws.columns))
		if !ok {
			return SheetWorksheet{}, 0, ErrConflict
		}
	} else if patch.MergeOp != nil {
		if err := checkProtectedRectWrite(role, g.UserID, patch.MergeOp.Rect, ws.protectedRanges); err != nil {
			return SheetWorksheet{}, 0, err
		}
		applied, overlaps, changed, ok := applySheetMergeOp(ws.merges, *patch.MergeOp, len(ws.rows), len(ws.columns))
		if !ok {
			return SheetWorksheet{}, 0, ErrConflict
		}
		if len(overlaps) > 0 {
			return SheetWorksheet{}, 0, &SheetRegionConflictError{
				Code:              "merge_overlap_conflict",
				Message:           "所选区域与其他协作者新合并的单元格存在重叠",
				ConflictingMerges: overlaps,
				Worksheet:         ws.toModel(),
				WorkbookRevision:  wb.revision,
			}
		}
		nextMerges = applied
		mergeOpNoop = !changed && patch.Title == nil && patch.Pos == nil && patch.FrozenRows == nil && patch.FrozenCols == nil && patch.Filter == nil && patch.Validations == nil && patch.ConditionalFormats == nil && patch.ProtectedRanges == nil && patch.Charts == nil && patch.PivotTables == nil
	}
	nextFilter := cloneSheetFilter(ws.filter)
	if patch.Filter != nil {
		var ok bool
		nextFilter, ok = validateAndNormalizeSheetFilter(*patch.Filter, len(ws.rows), len(ws.columns))
		if !ok {
			return SheetWorksheet{}, 0, ErrConflict
		}
	}
	nextValidations := cloneSheetValidations(ws.validations)
	if patch.Validations != nil {
		var ok bool
		nextValidations, ok = validateAndNormalizeSheetValidations(*patch.Validations, len(ws.rows), len(ws.columns))
		if !ok {
			return SheetWorksheet{}, 0, ErrConflict
		}
	}
	nextCondFormats := cloneSheetCondFormats(ws.conditionalFormats)
	if patch.ConditionalFormats != nil {
		var ok bool
		nextCondFormats, ok = validateAndNormalizeSheetCondFormats(*patch.ConditionalFormats, len(ws.rows), len(ws.columns))
		if !ok {
			return SheetWorksheet{}, 0, ErrConflict
		}
	}
	nextProtected := cloneSheetProtectedRanges(ws.protectedRanges)
	if patch.ProtectedRanges != nil {
		if role != RoleManage {
			return SheetWorksheet{}, 0, ErrForbidden
		}
		var ok bool
		nextProtected, ok = validateAndNormalizeSheetProtectedRanges(*patch.ProtectedRanges, len(ws.rows), len(ws.columns))
		if !ok {
			return SheetWorksheet{}, 0, ErrConflict
		}
	}
	nextCharts := cloneSheetCharts(ws.charts)
	if patch.Charts != nil {
		var ok bool
		nextCharts, ok = validateAndNormalizeSheetCharts(*patch.Charts, len(ws.rows), len(ws.columns))
		if !ok {
			return SheetWorksheet{}, 0, ErrConflict
		}
	}
	nextPivots := cloneSheetPivotTables(ws.pivotTables)
	if patch.PivotTables != nil {
		dims := make(map[int64][2]int, len(wb.sheets))
		for id, s := range wb.sheets {
			dims[id] = [2]int{len(s.rows), len(s.columns)}
		}
		var ok bool
		nextPivots, ok = validateAndNormalizeSheetPivotTables(*patch.PivotTables, ws.id, dims)
		if !ok {
			return SheetWorksheet{}, 0, ErrConflict
		}
	}
	if err := driveMemoryEnd(ctx, g, expires); err != nil {
		return SheetWorksheet{}, 0, err
	}
	if mergeOpNoop {
		return ws.toModel(), wb.revision, nil
	}
	ws.title = nextTitle
	if nextPos != ws.pos {
		idx := slices.Index(wb.order, ws.id)
		if idx >= 0 {
			wb.order = slices.Delete(wb.order, idx, idx+1)
			wb.order = slices.Insert(wb.order, nextPos, ws.id)
			for pos, id := range wb.order {
				wb.sheets[id].pos = pos
			}
		}
	}
	ws.frozenRows = nextFrozenRows
	ws.frozenCols = nextFrozenCols
	ws.merges = nextMerges
	ws.filter = nextFilter
	ws.validations = nextValidations
	ws.conditionalFormats = nextCondFormats
	ws.protectedRanges = nextProtected
	ws.charts = nextCharts
	ws.pivotTables = nextPivots
	ws.revision++
	wb.revision++
	d.meta.UpdatedAt = time.Now()
	m.setDocumentModifierLocked(d, g.UserID)
	return ws.toModel(), wb.revision, nil
}

func (m *Memory) DeleteWorksheet(ctx context.Context, g RestoreGuard, nodeID, worksheetID int64) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, wb, _, expires, err := m.authorizeSheetLocked(ctx, g, nodeID, RoleEdit)
	if err != nil {
		return 0, err
	}
	ws := wb.sheets[worksheetID]
	if ws == nil {
		return 0, ErrNotFound
	}
	if len(wb.order) <= 1 || wb.revision >= sheetMaxRevision {
		return 0, ErrConflict
	}
	if err := driveMemoryEnd(ctx, g, expires); err != nil {
		return 0, err
	}
	idx := slices.Index(wb.order, worksheetID)
	if idx >= 0 {
		wb.order = slices.Delete(wb.order, idx, idx+1)
	}
	delete(wb.sheets, worksheetID)
	m.sheetComments = slices.DeleteFunc(m.sheetComments, func(c SheetComment) bool {
		return c.WorksheetID == worksheetID
	})
	for pos, id := range wb.order {
		wb.sheets[id].pos = pos
	}
	wb.revision++
	d.meta.UpdatedAt = time.Now()
	m.setDocumentModifierLocked(d, g.UserID)
	return wb.revision, nil
}

func (m *Memory) MutateSheetAxis(ctx context.Context, g RestoreGuard, nodeID, worksheetID int64, op SheetAxisOp) (SheetWorksheet, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, wb, role, expires, err := m.authorizeSheetLocked(ctx, g, nodeID, RoleEdit)
	if err != nil {
		return SheetWorksheet{}, 0, err
	}
	ws := wb.sheets[worksheetID]
	if ws == nil {
		return SheetWorksheet{}, 0, ErrNotFound
	}
	if wb.revision >= sheetMaxRevision || ws.revision >= sheetMaxRevision {
		return SheetWorksheet{}, 0, ErrConflict
	}
	if op.ExpectedRevision != nil && ws.revision != *op.ExpectedRevision {
		return SheetWorksheet{}, 0, ErrConflict
	}
	count := op.Count
	if count == 0 {
		count = 1
	}
	switch op.Op {
	case "insert_row":
		if count < 1 || count > 20 || op.Index < 0 || op.Index > len(ws.rows) || len(ws.rows)+count > sheetMaxRows {
			return SheetWorksheet{}, 0, ErrConflict
		}
		if err := driveMemoryEnd(ctx, g, expires); err != nil {
			return SheetWorksheet{}, 0, err
		}
		inserted := make([]SheetAxis, 0, count)
		for i := 0; i < count; i++ {
			m.sheets.nextAxisID++
			aid := m.sheets.nextAxisID
			ws.rowIndex[aid] = true
			inserted = append(inserted, SheetAxis{ID: aid, Pos: op.Index + i})
		}
		ws.rows = slices.Insert(ws.rows, op.Index, inserted...)
		for i := op.Index + count; i < len(ws.rows); i++ {
			ws.rows[i].Pos = i
		}
		ws.merges = adjustSheetMergesInsert(ws.merges, "row", op.Index, count)
		ws.validations = adjustSheetValidationsInsert(ws.validations, "row", op.Index, count)
		ws.conditionalFormats = adjustSheetCondFormatsInsert(ws.conditionalFormats, "row", op.Index, count)
		ws.protectedRanges = adjustSheetProtectedInsert(ws.protectedRanges, "row", op.Index, count)
		ws.charts = adjustSheetChartsInsert(ws.charts, "row", op.Index, count)
		ws.pivotTables = adjustSheetPivotsInsert(ws.pivotTables, ws.id, "row", op.Index, count)
	case "delete_row":
		if count < 1 || count > 50 || op.Index < 0 || op.Index+count > len(ws.rows) || len(ws.rows)-count < 1 {
			return SheetWorksheet{}, 0, ErrConflict
		}
		if err := checkProtectedAxisDelete(role, g.UserID, "row", op.Index, count, ws.protectedRanges); err != nil {
			return SheetWorksheet{}, 0, err
		}
		if err := driveMemoryEnd(ctx, g, expires); err != nil {
			return SheetWorksheet{}, 0, err
		}
		removed := map[int64]bool{}
		for i := op.Index; i < op.Index+count; i++ {
			id := ws.rows[i].ID
			removed[id] = true
			delete(ws.rowIndex, id)
		}
		ws.rows = slices.Delete(ws.rows, op.Index, op.Index+count)
		for i := range ws.rows {
			ws.rows[i].Pos = i
		}
		for k := range ws.cells {
			if removed[k.rowID] {
				delete(ws.cells, k)
				delete(ws.cellFieldRevs, k)
				delete(ws.cellUpdatedBy, k)
			}
		}
		m.sheetComments = slices.DeleteFunc(m.sheetComments, func(c SheetComment) bool {
			return c.WorksheetID == ws.id && removed[c.RowID]
		})
		ws.merges = adjustSheetMergesDelete(ws.merges, "row", op.Index, count)
		ws.validations = adjustSheetValidationsDelete(ws.validations, "row", op.Index, count)
		ws.conditionalFormats = adjustSheetCondFormatsDelete(ws.conditionalFormats, "row", op.Index, count)
		ws.protectedRanges = adjustSheetProtectedDelete(ws.protectedRanges, "row", op.Index, count)
		ws.charts = adjustSheetChartsDelete(ws.charts, "row", op.Index, count)
		ws.pivotTables = adjustSheetPivotsDelete(ws.pivotTables, ws.id, "row", op.Index, count)
		if ws.frozenRows > len(ws.rows)-1 {
			ws.frozenRows = max(0, len(ws.rows)-1)
		}
		if ws.filter.HeaderRow >= len(ws.rows) {
			ws.filter.HeaderRow = max(0, len(ws.rows)-1)
		}
	case "resize_row":
		if op.Index < 0 || op.Index >= len(ws.rows) || (op.Size != 0 && (op.Size < 18 || op.Size > 1000)) {
			return SheetWorksheet{}, 0, ErrConflict
		}
		if err := driveMemoryEnd(ctx, g, expires); err != nil {
			return SheetWorksheet{}, 0, err
		}
		ws.rows[op.Index].Size = op.Size
	case "insert_col":
		if count < 1 || count > 20 || op.Index < 0 || op.Index > len(ws.columns) || len(ws.columns)+count > sheetMaxCols {
			return SheetWorksheet{}, 0, ErrConflict
		}
		if err := driveMemoryEnd(ctx, g, expires); err != nil {
			return SheetWorksheet{}, 0, err
		}
		inserted := make([]SheetAxis, 0, count)
		for i := 0; i < count; i++ {
			m.sheets.nextAxisID++
			aid := m.sheets.nextAxisID
			ws.colIndex[aid] = true
			inserted = append(inserted, SheetAxis{ID: aid, Pos: op.Index + i})
		}
		ws.columns = slices.Insert(ws.columns, op.Index, inserted...)
		for i := op.Index + count; i < len(ws.columns); i++ {
			ws.columns[i].Pos = i
		}
		ws.merges = adjustSheetMergesInsert(ws.merges, "col", op.Index, count)
		ws.validations = adjustSheetValidationsInsert(ws.validations, "col", op.Index, count)
		ws.conditionalFormats = adjustSheetCondFormatsInsert(ws.conditionalFormats, "col", op.Index, count)
		ws.protectedRanges = adjustSheetProtectedInsert(ws.protectedRanges, "col", op.Index, count)
		ws.charts = adjustSheetChartsInsert(ws.charts, "col", op.Index, count)
		ws.pivotTables = adjustSheetPivotsInsert(ws.pivotTables, ws.id, "col", op.Index, count)
	case "delete_col":
		if count < 1 || count > 50 || op.Index < 0 || op.Index+count > len(ws.columns) || len(ws.columns)-count < 1 {
			return SheetWorksheet{}, 0, ErrConflict
		}
		if err := checkProtectedAxisDelete(role, g.UserID, "col", op.Index, count, ws.protectedRanges); err != nil {
			return SheetWorksheet{}, 0, err
		}
		if err := driveMemoryEnd(ctx, g, expires); err != nil {
			return SheetWorksheet{}, 0, err
		}
		removed := map[int64]bool{}
		for i := op.Index; i < op.Index+count; i++ {
			id := ws.columns[i].ID
			removed[id] = true
			delete(ws.colIndex, id)
		}
		ws.columns = slices.Delete(ws.columns, op.Index, op.Index+count)
		for i := range ws.columns {
			ws.columns[i].Pos = i
		}
		for k := range ws.cells {
			if removed[k.colID] {
				delete(ws.cells, k)
				delete(ws.cellFieldRevs, k)
				delete(ws.cellUpdatedBy, k)
			}
		}
		m.sheetComments = slices.DeleteFunc(m.sheetComments, func(c SheetComment) bool {
			return c.WorksheetID == ws.id && removed[c.ColumnID]
		})
		ws.merges = adjustSheetMergesDelete(ws.merges, "col", op.Index, count)
		ws.validations = adjustSheetValidationsDelete(ws.validations, "col", op.Index, count)
		ws.conditionalFormats = adjustSheetCondFormatsDelete(ws.conditionalFormats, "col", op.Index, count)
		ws.protectedRanges = adjustSheetProtectedDelete(ws.protectedRanges, "col", op.Index, count)
		ws.charts = adjustSheetChartsDelete(ws.charts, "col", op.Index, count)
		ws.pivotTables = adjustSheetPivotsDelete(ws.pivotTables, ws.id, "col", op.Index, count)
		if ws.frozenCols > len(ws.columns)-1 {
			ws.frozenCols = max(0, len(ws.columns)-1)
		}
		if ws.filter.Sort != nil && ws.filter.Sort.Col >= len(ws.columns) {
			ws.filter.Sort = nil
		}
	case "resize_col":
		if op.Index < 0 || op.Index >= len(ws.columns) || (op.Size != 0 && (op.Size < 24 || op.Size > 1000)) {
			return SheetWorksheet{}, 0, ErrConflict
		}
		if err := driveMemoryEnd(ctx, g, expires); err != nil {
			return SheetWorksheet{}, 0, err
		}
		ws.columns[op.Index].Size = op.Size
	default:
		return SheetWorksheet{}, 0, ErrConflict
	}
	ws.revision++
	wb.revision++
	d.meta.UpdatedAt = time.Now()
	m.setDocumentModifierLocked(d, g.UserID)
	return ws.toModel(), wb.revision, nil
}

func (m *Memory) ReplaceSheetWorkbook(ctx context.Context, g RestoreGuard, nodeID, expectedWorkbookRevision int64, mutationID string, sheets []ImportedWorksheet) (SheetSnapshot, error) {
	prepared, sum, err := prepareImportWorksheets(sheets, mutationID)
	if err != nil {
		return SheetSnapshot{}, err
	}
	sum = append([]byte("replace-v1\x00"), sum...)
	sumHash := sha256.Sum256(sum)
	digest := "replace:" + hex.EncodeToString(sumHash[:])
	m.mu.Lock()
	defer m.mu.Unlock()
	d, wb, role, expires, err := m.authorizeSheetLocked(ctx, g, nodeID, RoleEdit)
	if err != nil {
		return SheetSnapshot{}, err
	}
	rKey := memSheetReceiptKey{userID: g.UserID, mutationID: mutationID}
	if receipt, ok := wb.receipts[rKey]; ok {
		if receipt.digest != digest || receipt.replace == nil {
			return SheetSnapshot{}, ErrConflict
		}
		if err := driveMemoryEnd(ctx, g, expires); err != nil {
			return SheetSnapshot{}, err
		}
		return *receipt.replace, nil
	}
	if wb.revision != expectedWorkbookRevision || wb.revision >= sheetMaxRevision {
		return SheetSnapshot{}, ErrConflict
	}
	if err := driveMemoryEnd(ctx, g, expires); err != nil {
		return SheetSnapshot{}, err
	}
	wb.order = make([]int64, 0, len(prepared))
	wb.sheets = make(map[int64]*memWorksheet, len(prepared))
	m.sheetComments = slices.DeleteFunc(m.sheetComments, func(c SheetComment) bool {
		return c.NodeID == nodeID
	})
	for pos, item := range prepared {
		ws := m.createMemWorksheetLocked(nodeID, item.Title, pos, item.Rows, item.Cols)
		ws.frozenRows = item.FrozenRows
		ws.frozenCols = item.FrozenCols
		ws.merges = slices.Clone(item.Merges)
		for _, cell := range item.Cells {
			rid := ws.rows[cell.Row].ID
			cid := ws.columns[cell.Col].ID
			ws.cells[memSheetCellKey{rowID: rid, colID: cid}] = SheetCell{
				RowID:    rid,
				ColumnID: cid,
				Raw:      cell.Raw,
				Style:    cloneSheetStyle(cell.Style),
				Revision: 1,
			}
		}
		wb.sheets[ws.id] = ws
		wb.order = append(wb.order, ws.id)
	}
	wb.revision++
	d.meta.UpdatedAt = time.Now()
	m.setDocumentModifierLocked(d, g.UserID)
	snap := m.sheetSnapshotLocked(d, wb, role)
	pruneMemSheetReceipts(wb, time.Now())
	wb.receipts[rKey] = memSheetReceipt{created: time.Now(), digest: digest, replace: &snap}
	return snap, nil
}

func (m *Memory) CopySheetWorkbook(ctx context.Context, c SheetWorkbookCopy) (DocMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var expiry time.Time
	if c.Guard != nil {
		guard := c.Guard
		session, ok := m.sessions[string(guard.SessionHash)]
		if !ok || guard.UserID != c.UserID || session.userID != c.UserID || !guard.currentTime().Before(session.expires) {
			return DocMeta{}, ErrUnauthenticated
		}
		expiry = session.expires
	}
	source := m.doc(c.SourceID)
	if source == nil || source.deleted || source.purged {
		return DocMeta{}, ErrNotFound
	}
	if source.meta.Kind != "sheet" {
		return DocMeta{}, ErrConflict
	}
	sourceRole := m.roleLocked(c.UserID, source)
	if RoleRank(sourceRole) < RoleRank(RoleView) {
		return DocMeta{}, ErrNotFound
	}
	if !DocumentDownloadAllowed(source.meta, sourceRole) {
		return DocMeta{}, ErrCopyProtected
	}
	if c.UserID < 1 || c.UserID > int64(len(m.users)) || !m.member(c.UserID, c.WorkspaceID) {
		return DocMeta{}, ErrForbidden
	}
	srcBook := m.sheets.books[c.SourceID]
	if srcBook == nil {
		return DocMeta{}, ErrNotFound
	}
	personal := source.personal
	if c.WorkspaceID != source.meta.WorkspaceID {
		personal = true
	}
	if c.Personal != nil {
		personal = *c.Personal
	}
	var parentID *int64
	if c.ParentID != nil {
		if err := m.driveDestinationLocked(c.UserID, c.WorkspaceID, c.ParentID, RoleEdit); err != nil {
			return DocMeta{}, err
		}
		parent := m.doc(*c.ParentID)
		personal = parent.personal
		id := *c.ParentID
		parentID = &id
	}
	if err := ctx.Err(); err != nil {
		return DocMeta{}, err
	}
	if c.Guard != nil && !c.Guard.currentTime().Before(expiry) {
		return DocMeta{}, ErrUnauthenticated
	}
	now := time.Now()
	newID := int64(len(m.d.docs) + 1)
	meta := DocMeta{
		ID:               newID,
		Kind:             "sheet",
		WorkspaceID:      c.WorkspaceID,
		ParentID:         parentID,
		Title:            c.Title,
		CreatorID:        c.UserID,
		CreatorName:      m.users[c.UserID-1].Name,
		CreatedAt:        now,
		UpdatedAt:        now,
		DriveRevision:    1,
		Role:             RoleManage,
		CopyMinRole:      RoleView,
		DownloadMinRole:  RoleView,
		CommentMinRole:   RoleView,
		InheritParentACL: true,
	}
	d := &memDoc{meta: meta, driveRevision: 1, personal: personal, ids: map[[2]int64]bool{}, snaps: map[int64][]byte{}, versions: map[int64]memVersion{}}
	dstBook := &memWorkbook{
		nodeID:   newID,
		revision: 1,
		order:    make([]int64, 0, len(srcBook.order)),
		sheets:   make(map[int64]*memWorksheet, len(srcBook.order)),
		receipts: map[memSheetReceiptKey]memSheetReceipt{},
	}
	wsIDMap := make(map[int64]int64, len(srcBook.order))
	for pos, wid := range srcBook.order {
		srcWS := srcBook.sheets[wid]
		if srcWS == nil {
			continue
		}
		dstWS := m.createMemWorksheetLocked(newID, srcWS.title, pos, len(srcWS.rows), len(srcWS.columns))
		wsIDMap[srcWS.id] = dstWS.id
		rowMap := make(map[int64]int64, len(srcWS.rows))
		colMap := make(map[int64]int64, len(srcWS.columns))
		for i, r := range srcWS.rows {
			dstWS.rows[i].Size = r.Size
			rowMap[r.ID] = dstWS.rows[i].ID
		}
		for i, col := range srcWS.columns {
			dstWS.columns[i].Size = col.Size
			colMap[col.ID] = dstWS.columns[i].ID
		}
		dstWS.frozenRows = srcWS.frozenRows
		dstWS.frozenCols = srcWS.frozenCols
		dstWS.merges = slices.Clone(srcWS.merges)
		dstWS.filter = cloneSheetFilter(srcWS.filter)
		dstWS.validations = cloneSheetValidations(srcWS.validations)
		dstWS.conditionalFormats = cloneSheetCondFormats(srcWS.conditionalFormats)
		dstWS.protectedRanges = cloneSheetProtectedRanges(srcWS.protectedRanges)
		dstWS.charts = cloneSheetCharts(srcWS.charts)
		dstWS.pivotTables = cloneSheetPivotTables(srcWS.pivotTables)
		for k, cell := range srcWS.cells {
			if cell.Raw == "" && cell.Style == (SheetCellStyle{}) {
				continue
			}
			nr, okR := rowMap[k.rowID]
			nc, okC := colMap[k.colID]
			if !okR || !okC {
				continue
			}
			dstWS.cells[memSheetCellKey{rowID: nr, colID: nc}] = SheetCell{
				RowID:    nr,
				ColumnID: nc,
				Raw:      cell.Raw,
				Style:    cloneSheetStyle(cell.Style),
				Revision: 1,
			}
		}
		dstBook.sheets[dstWS.id] = dstWS
		dstBook.order = append(dstBook.order, dstWS.id)
	}
	for _, dstWS := range dstBook.sheets {
		dstWS.pivotTables = remapSheetPivotSourceIDs(dstWS.pivotTables, wsIDMap)
	}
	m.d.docs = append(m.d.docs, d)
	m.sheets.books[newID] = dstBook
	return meta, nil
}

func (m *Memory) SearchSheetContent(ctx context.Context, userID, nodeID int64, foldedNeedle string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(nodeID)
	if d == nil || d.deleted || d.purged || d.meta.Kind != "sheet" || RoleRank(m.roleLocked(userID, d)) < RoleRank(RoleView) {
		return false, nil
	}
	wb := m.sheets.books[nodeID]
	if wb == nil {
		return false, nil
	}
	fold := cases.Fold()
	for _, wid := range wb.order {
		ws := wb.sheets[wid]
		if ws == nil {
			continue
		}
		if strings.Contains(fold.String(ws.title), foldedNeedle) {
			return true, nil
		}
		for _, cell := range ws.cells {
			if cell.Raw != "" && strings.Contains(fold.String(cell.Raw), foldedNeedle) {
				return true, nil
			}
		}
	}
	return false, nil
}

// pruneMemSheetReceipts mirrors the PostgreSQL retention window: retries are
// expected within seconds, and an expired retry fails its revision checks
// instead of being applied twice.
func pruneMemSheetReceipts(wb *memWorkbook, now time.Time) {
	for key, receipt := range wb.receipts {
		if now.Sub(receipt.created) > sheetReceiptRetention {
			delete(wb.receipts, key)
		}
	}
}
