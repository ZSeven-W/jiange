package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func sheetDigestTag(prefix string, sum []byte) []byte {
	h := sha256.New()
	h.Write([]byte(prefix))
	h.Write([]byte{0})
	h.Write(sum)
	return h.Sum(nil)
}

func (p *Postgres) initSheetWorkbookPG(ctx context.Context, tx pgx.Tx, nodeID int64) error {
	if _, err := tx.Exec(ctx, `INSERT INTO sheet_workbooks (node_id, revision) VALUES ($1, 1)`, nodeID); err != nil {
		return err
	}
	var worksheetID int64
	if err := tx.QueryRow(ctx, `INSERT INTO sheet_worksheets (node_id, title, pos) VALUES ($1, 'Sheet1', 0) RETURNING id`, nodeID).Scan(&worksheetID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sheet_rows (worksheet_id, pos) SELECT $1, n FROM generate_series(0, $2::int - 1) n`, worksheetID, sheetInitialRows); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sheet_columns (worksheet_id, pos) SELECT $1, n FROM generate_series(0, $2::int - 1) n`, worksheetID, sheetInitialCols); err != nil {
		return err
	}
	return nil
}

type pgSheetNode struct {
	nodeID           int64
	workspaceID      int64
	parentID         *int64
	title            string
	role             string
	creatorID        int64
	creatorName      string
	driveRevision    int64
	workbookRevision int64
	updatedAt        time.Time
}

func lockSheetPG(ctx context.Context, tx pgx.Tx, g RestoreGuard, nodeID int64, minRole string, write bool) (pgSheetNode, time.Time, error) {
	expires, err := drivePGSession(ctx, tx, g)
	if err != nil {
		return pgSheetNode{}, time.Time{}, err
	}
	if !validSheetID(nodeID) {
		return pgSheetNode{}, time.Time{}, ErrNotFound
	}
	// The node row is only share-locked, even for writes: it fences trash,
	// move and permission changes without making readers (and every other
	// guarded operation on the node) queue behind cell writes. Writers
	// serialize on the sheet_workbooks row below, which owns the revision.
	workbookLock := "FOR SHARE"
	if write {
		workbookLock = "FOR UPDATE"
	}
	var info pgSheetNode
	var kind string
	var deleted bool
	err = tx.QueryRow(ctx,
		`SELECT n.id, n.workspace_id, n.parent_id, n.title, n.kind, n.creator_id, COALESCE((SELECT u.name FROM users u WHERE u.id = n.creator_id), ''), n.drive_revision, n.deleted_at IS NOT NULL, n.updated_at
		 FROM nodes n WHERE n.id=$1 FOR SHARE`, nodeID).
		Scan(&info.nodeID, &info.workspaceID, &info.parentID, &info.title, &kind, &info.creatorID, &info.creatorName, &info.driveRevision, &deleted, &info.updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return pgSheetNode{}, time.Time{}, ErrNotFound
	}
	if err != nil {
		return pgSheetNode{}, time.Time{}, err
	}
	if kind != "sheet" || deleted {
		return pgSheetNode{}, time.Time{}, ErrNotFound
	}
	if err = drivePGValidChain(ctx, tx, nodeID, info.workspaceID); err != nil {
		if errors.Is(err, ErrConflict) {
			return pgSheetNode{}, time.Time{}, ErrNotFound
		}
		return pgSheetNode{}, time.Time{}, err
	}
	role, _, _, err := lockCopySource(ctx, tx, nodeID, g.UserID)
	if err != nil {
		return pgSheetNode{}, time.Time{}, err
	}
	if RoleRank(role) < RoleRank(RoleView) {
		return pgSheetNode{}, time.Time{}, ErrNotFound
	}
	if RoleRank(role) < RoleRank(minRole) {
		return pgSheetNode{}, time.Time{}, ErrForbidden
	}
	info.role = role
	err = tx.QueryRow(ctx, `SELECT revision FROM sheet_workbooks WHERE node_id=$1 `+workbookLock, nodeID).Scan(&info.workbookRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return pgSheetNode{}, time.Time{}, ErrNotFound
	}
	if err != nil {
		return pgSheetNode{}, time.Time{}, err
	}
	return info, expires, nil
}

const worksheetMetaCols = "id, node_id, title, pos, frozen_rows, frozen_cols, merges, filter_config, validations, conditional_formats, protected_ranges, charts, pivot_tables, sparklines, outline_groups, revision"

func scanWorksheetMetaPG(row pgx.Row) (SheetWorksheet, error) {
	var ws SheetWorksheet
	var mergesRaw, filterRaw, validationsRaw, condFormatsRaw, protectedRaw, chartsRaw, pivotsRaw, sparklinesRaw, outlineGroupsRaw []byte
	err := row.Scan(
		&ws.ID, &ws.NodeID, &ws.Title, &ws.Pos, &ws.FrozenRows, &ws.FrozenCols,
		&mergesRaw, &filterRaw, &validationsRaw, &condFormatsRaw, &protectedRaw, &chartsRaw, &pivotsRaw, &sparklinesRaw, &outlineGroupsRaw, &ws.Revision,
	)
	if err != nil {
		return SheetWorksheet{}, err
	}
	ws.Merges = []SheetMerge{}
	if len(mergesRaw) > 0 {
		if err := json.Unmarshal(mergesRaw, &ws.Merges); err != nil {
			return SheetWorksheet{}, err
		}
	}
	if len(filterRaw) > 0 {
		if err := json.Unmarshal(filterRaw, &ws.Filter); err != nil {
			return SheetWorksheet{}, err
		}
	}
	ws.Validations = []SheetDataValidation{}
	if len(validationsRaw) > 0 {
		if err := json.Unmarshal(validationsRaw, &ws.Validations); err != nil {
			return SheetWorksheet{}, err
		}
	}
	ws.ConditionalFormats = []SheetConditionalFormat{}
	if len(condFormatsRaw) > 0 {
		if err := json.Unmarshal(condFormatsRaw, &ws.ConditionalFormats); err != nil {
			return SheetWorksheet{}, err
		}
	}
	ws.ProtectedRanges = []SheetProtectedRange{}
	if len(protectedRaw) > 0 {
		if err := json.Unmarshal(protectedRaw, &ws.ProtectedRanges); err != nil {
			return SheetWorksheet{}, err
		}
	}
	ws.Charts = []SheetChart{}
	if len(chartsRaw) > 0 {
		if err := json.Unmarshal(chartsRaw, &ws.Charts); err != nil {
			return SheetWorksheet{}, err
		}
	}
	ws.PivotTables = []SheetPivotTable{}
	if len(pivotsRaw) > 0 {
		if err := json.Unmarshal(pivotsRaw, &ws.PivotTables); err != nil {
			return SheetWorksheet{}, err
		}
	}
	ws.Sparklines = []SheetSparkline{}
	if len(sparklinesRaw) > 0 {
		if err := json.Unmarshal(sparklinesRaw, &ws.Sparklines); err != nil {
			return SheetWorksheet{}, err
		}
	}
	ws.OutlineGroups = []SheetOutlineGroup{}
	if len(outlineGroupsRaw) > 0 {
		if err := json.Unmarshal(outlineGroupsRaw, &ws.OutlineGroups); err != nil {
			return SheetWorksheet{}, err
		}
	}
	return ws, nil
}

func loadWorksheetChildrenPG(ctx context.Context, tx pgx.Tx, ws *SheetWorksheet) error {
	rows, err := tx.Query(ctx, `SELECT id, pos, size FROM sheet_rows WHERE worksheet_id=$1 ORDER BY pos, id`, ws.ID)
	if err != nil {
		return err
	}
	ws.Rows = []SheetAxis{}
	for rows.Next() {
		var a SheetAxis
		if err = rows.Scan(&a.ID, &a.Pos, &a.Size); err != nil {
			rows.Close()
			return err
		}
		ws.Rows = append(ws.Rows, a)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	cols, err := tx.Query(ctx, `SELECT id, pos, size FROM sheet_columns WHERE worksheet_id=$1 ORDER BY pos, id`, ws.ID)
	if err != nil {
		return err
	}
	ws.Columns = []SheetAxis{}
	for cols.Next() {
		var a SheetAxis
		if err = cols.Scan(&a.ID, &a.Pos, &a.Size); err != nil {
			cols.Close()
			return err
		}
		ws.Columns = append(ws.Columns, a)
	}
	if err = cols.Err(); err != nil {
		cols.Close()
		return err
	}
	cols.Close()

	cells, err := tx.Query(ctx, `SELECT row_id, column_id, raw, style, revision FROM sheet_cells WHERE worksheet_id=$1 ORDER BY row_id, column_id`, ws.ID)
	if err != nil {
		return err
	}
	ws.Cells = []SheetCell{}
	for cells.Next() {
		var c SheetCell
		var styleRaw []byte
		if err = cells.Scan(&c.RowID, &c.ColumnID, &c.Raw, &styleRaw, &c.Revision); err != nil {
			cells.Close()
			return err
		}
		if len(styleRaw) > 0 {
			if err = json.Unmarshal(styleRaw, &c.Style); err != nil {
				cells.Close()
				return err
			}
		}
		ws.Cells = append(ws.Cells, c)
	}
	err = cells.Err()
	cells.Close()
	return err
}

func loadSheetSnapshotPG(ctx context.Context, tx pgx.Tx, info pgSheetNode) (SheetSnapshot, error) {
	rows, err := tx.Query(ctx, `SELECT `+worksheetMetaCols+` FROM sheet_worksheets WHERE node_id=$1 ORDER BY pos, id`, info.nodeID)
	if err != nil {
		return SheetSnapshot{}, err
	}
	sheets := []SheetWorksheet{}
	for rows.Next() {
		ws, err := scanWorksheetMetaPG(rows)
		if err != nil {
			rows.Close()
			return SheetSnapshot{}, err
		}
		sheets = append(sheets, ws)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return SheetSnapshot{}, err
	}
	rows.Close()

	for i := range sheets {
		if err := loadWorksheetChildrenPG(ctx, tx, &sheets[i]); err != nil {
			return SheetSnapshot{}, err
		}
	}
	return SheetSnapshot{
		NodeID:           info.nodeID,
		WorkspaceID:      info.workspaceID,
		ParentID:         info.parentID,
		Title:            info.title,
		Role:             info.role,
		CreatorID:        info.creatorID,
		CreatorName:      info.creatorName,
		DriveRevision:    info.driveRevision,
		WorkbookRevision: info.workbookRevision,
		Sheets:           sheets,
		UpdatedAt:        info.updatedAt,
	}, nil
}

func (p *Postgres) GetSheetWorkbook(ctx context.Context, g RestoreGuard, nodeID int64) (snap SheetSnapshot, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		info, expires, e := lockSheetPG(ctx, tx, g, nodeID, RoleView, false)
		if e != nil {
			return e
		}
		snap, e = loadSheetSnapshotPG(ctx, tx, info)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, g, expires)
	})
	return snap, drivePGError(err)
}

func (p *Postgres) SheetHead(ctx context.Context, nodeID int64) (int64, error) {
	var rev int64
	err := p.Pool.QueryRow(ctx, `SELECT sw.revision FROM sheet_workbooks sw JOIN nodes n ON n.id = sw.node_id WHERE sw.node_id=$1 AND n.kind='sheet' AND n.deleted_at IS NULL`, nodeID).Scan(&rev)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return rev, err
}

func (p *Postgres) RenameSheetTitle(ctx context.Context, g RestoreGuard, nodeID int64, title, expectedTitle string, expectedDriveRevision int64) (out DriveEntry, err error) {
	if !validDriveTitle(title) {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		ws, e := drivePGNodeWorkspace(ctx, tx, nodeID)
		if e != nil {
			return e
		}
		if e = drivePGLockWorkspace(ctx, tx, ws); e != nil {
			return e
		}
		expires, e := drivePGSession(ctx, tx, g)
		if e != nil {
			return e
		}
		var currentWS, rev int64
		var currentTitle, kind string
		var deleted bool
		e = tx.QueryRow(ctx, `SELECT workspace_id, drive_revision, title, kind, deleted_at IS NOT NULL FROM nodes WHERE id=$1 FOR UPDATE`, nodeID).
			Scan(&currentWS, &rev, &currentTitle, &kind, &deleted)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if currentWS != ws || deleted || kind != "sheet" {
			return ErrForbidden
		}
		if e = drivePGValidChain(ctx, tx, nodeID, ws); e != nil {
			return e
		}
		role, _, _, e := lockCopySource(ctx, tx, nodeID, g.UserID)
		if e != nil {
			return e
		}
		if RoleRank(role) < RoleRank(RoleEdit) {
			return ErrForbidden
		}
		if rev != expectedDriveRevision || rev >= maxDriveRevision || currentTitle != expectedTitle {
			return ErrConflict
		}
		if e = drivePGEnd(ctx, g, expires); e != nil {
			return e
		}
		e = tx.QueryRow(ctx, `UPDATE nodes SET title=$2, drive_revision=drive_revision+1, updated_at=now() WHERE id=$1 RETURNING id, workspace_id, parent_id, kind, doc_type, title, icon, creator_id, COALESCE((SELECT u.name FROM users u WHERE u.id=nodes.creator_id),''), drive_revision, personal, created_at, updated_at`, nodeID, title).
			Scan(&out.ID, &out.WorkspaceID, &out.ParentID, &out.Kind, &out.DocType, &out.Title, &out.Icon, &out.CreatorID, &out.CreatorName, &out.Revision, &out.Personal, &out.CreatedAt, &out.UpdatedAt)
		if e != nil {
			return e
		}
		if e = recordDocumentModifier(ctx, tx, nodeID, g.UserID); e != nil {
			return e
		}
		out.Role = role
		return drivePGEnd(ctx, g, expires)
	})
	return out, drivePGError(err)
}

// pruneSheetReceiptsPG drops expired idempotency receipts for the workbook
// being written; the caller holds the workbook row lock.
func pruneSheetReceiptsPG(ctx context.Context, tx pgx.Tx, nodeID int64) error {
	_, err := tx.Exec(ctx, `DELETE FROM sheet_write_receipts WHERE node_id=$1 AND created_at < now() - make_interval(secs => $2)`, nodeID, sheetReceiptRetention.Seconds())
	return err
}

func touchSheetWorkbookPG(ctx context.Context, tx pgx.Tx, nodeID, userID int64) (int64, error) {
	var nextRev int64
	if err := tx.QueryRow(ctx, `UPDATE sheet_workbooks SET revision=revision+1, updated_at=now() WHERE node_id=$1 RETURNING revision`, nodeID).Scan(&nextRev); err != nil {
		return 0, err
	}
	// Bump the listing timestamp at most every few seconds and never wait
	// for it: readers hold share locks on the node row, and waiting here while
	// holding the workbook lock could deadlock with them.
	if _, err := tx.Exec(ctx, `UPDATE nodes SET updated_at=now() WHERE id=(
		SELECT id FROM nodes WHERE id=$1 AND updated_at < now() - interval '5 seconds' FOR UPDATE SKIP LOCKED)`, nodeID); err != nil {
		return 0, err
	}
	if err := recordDocumentModifier(ctx, tx, nodeID, userID); err != nil {
		return 0, err
	}
	return nextRev, nil
}

func (p *Postgres) WriteSheetCells(ctx context.Context, g RestoreGuard, nodeID int64, batch SheetCellBatch) (out SheetBatchResult, err error) {
	prepared, sum, err := prepareSheetBatch(batch)
	if err != nil {
		return out, err
	}
	digest := sheetDigestTag("batch-v1", sum)
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		info, expires, e := lockSheetPG(ctx, tx, g, nodeID, RoleEdit, true)
		if e != nil {
			return e
		}
		var savedDigest, savedResult []byte
		e = tx.QueryRow(ctx, `SELECT digest, result FROM sheet_write_receipts WHERE node_id=$1 AND user_id=$2 AND mutation_id=$3`, nodeID, g.UserID, prepared.MutationID).
			Scan(&savedDigest, &savedResult)
		if e == nil {
			if !slices.Equal(savedDigest, digest) {
				return ErrConflict
			}
			if e = json.Unmarshal(savedResult, &out); e != nil {
				return ErrConflict
			}
			out.Replayed = true
			return drivePGEnd(ctx, g, expires)
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}

		var wsRev int64
		var mergesRaw, validationsRaw, protectedRaw []byte
		e = tx.QueryRow(ctx, `SELECT revision, merges, validations, protected_ranges FROM sheet_worksheets WHERE id=$1 AND node_id=$2 FOR UPDATE`, prepared.WorksheetID, nodeID).
			Scan(&wsRev, &mergesRaw, &validationsRaw, &protectedRaw)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if info.workbookRevision >= sheetMaxRevision || wsRev >= sheetMaxRevision {
			return ErrConflict
		}
		var merges []SheetMerge
		if len(mergesRaw) > 0 {
			if e = json.Unmarshal(mergesRaw, &merges); e != nil {
				return e
			}
		}
		var validations []SheetDataValidation
		if len(validationsRaw) > 0 {
			if e = json.Unmarshal(validationsRaw, &validations); e != nil {
				return e
			}
		}
		var protectedRanges []SheetProtectedRange
		if len(protectedRaw) > 0 {
			if e = json.Unmarshal(protectedRaw, &protectedRanges); e != nil {
				return e
			}
		}

		rowIDSet := map[int64]bool{}
		colIDSet := map[int64]bool{}
		rowIDs := make([]int64, 0, len(prepared.Cells))
		colIDs := make([]int64, 0, len(prepared.Cells))
		for _, c := range prepared.Cells {
			if !rowIDSet[c.RowID] {
				rowIDSet[c.RowID] = true
				rowIDs = append(rowIDs, c.RowID)
			}
			if !colIDSet[c.ColumnID] {
				colIDSet[c.ColumnID] = true
				colIDs = append(colIDs, c.ColumnID)
			}
		}

		rowPosMap := make(map[int64]int, len(rowIDs))
		rRows, e := tx.Query(ctx, `SELECT id, pos FROM sheet_rows WHERE worksheet_id=$1 AND id=ANY($2)`, prepared.WorksheetID, rowIDs)
		if e != nil {
			return e
		}
		for rRows.Next() {
			var id int64
			var pos int
			if e = rRows.Scan(&id, &pos); e != nil {
				rRows.Close()
				return e
			}
			rowPosMap[id] = pos
		}
		if e = rRows.Err(); e != nil {
			rRows.Close()
			return e
		}
		rRows.Close()
		if len(rowPosMap) != len(rowIDs) {
			return ErrNotFound
		}

		colPosMap := make(map[int64]int, len(colIDs))
		cRows, e := tx.Query(ctx, `SELECT id, pos FROM sheet_columns WHERE worksheet_id=$1 AND id=ANY($2)`, prepared.WorksheetID, colIDs)
		if e != nil {
			return e
		}
		for cRows.Next() {
			var id int64
			var pos int
			if e = cRows.Scan(&id, &pos); e != nil {
				cRows.Close()
				return e
			}
			colPosMap[id] = pos
		}
		if e = cRows.Err(); e != nil {
			cRows.Close()
			return e
		}
		cRows.Close()
		if len(colPosMap) != len(colIDs) {
			return ErrNotFound
		}

		if len(protectedRanges) > 0 || len(validations) > 0 {
			for _, w := range prepared.Cells {
				rPos := rowPosMap[w.RowID]
				cPos := colPosMap[w.ColumnID]
				if len(protectedRanges) > 0 {
					if e = checkProtectedCellWrite(info.role, g.UserID, rPos, cPos, protectedRanges); e != nil {
						return e
					}
				}
				if w.Raw != nil && len(validations) > 0 {
					if e = checkCellValidationWrite(*w.Raw, rPos, cPos, validations); e != nil {
						return e
					}
				}
			}
		}

		type pgExistingCell struct {
			cell          SheetCell
			fieldRevs     map[string]int64
			updatedBy     int64
			updatedByName string
		}
		existing := make(map[memSheetCellKey]pgExistingCell, len(prepared.Cells))
		cellRows, e := tx.Query(ctx, `SELECT sc.row_id, sc.column_id, sc.raw, sc.style, sc.revision, sc.field_revs, COALESCE(sc.updated_by, 0), COALESCE(u.name, '')
			FROM sheet_cells sc
			LEFT JOIN users u ON u.id = sc.updated_by
			WHERE sc.worksheet_id=$1 AND sc.row_id=ANY($2) AND sc.column_id=ANY($3)
			FOR UPDATE OF sc`, prepared.WorksheetID, rowIDs, colIDs)
		if e != nil {
			return e
		}
		for cellRows.Next() {
			var ec pgExistingCell
			var styleRaw, fieldRevsRaw []byte
			if e = cellRows.Scan(&ec.cell.RowID, &ec.cell.ColumnID, &ec.cell.Raw, &styleRaw, &ec.cell.Revision, &fieldRevsRaw, &ec.updatedBy, &ec.updatedByName); e != nil {
				cellRows.Close()
				return e
			}
			if len(styleRaw) > 0 {
				if e = json.Unmarshal(styleRaw, &ec.cell.Style); e != nil {
					cellRows.Close()
					return e
				}
			}
			if len(fieldRevsRaw) > 0 {
				if e = json.Unmarshal(fieldRevsRaw, &ec.fieldRevs); e != nil {
					cellRows.Close()
					return e
				}
			}
			existing[memSheetCellKey{rowID: ec.cell.RowID, colID: ec.cell.ColumnID}] = ec
		}
		if e = cellRows.Err(); e != nil {
			cellRows.Close()
			return e
		}
		cellRows.Close()

		autoMerge := prepared.MergeMode == SheetMergeModeAuto
		uRowIDs := make([]int64, 0, len(prepared.Cells))
		uColIDs := make([]int64, 0, len(prepared.Cells))
		uRaws := make([]string, 0, len(prepared.Cells))
		uStyles := make([]string, 0, len(prepared.Cells))
		uRevs := make([]int64, 0, len(prepared.Cells))
		uFieldRevs := make([]string, 0, len(prepared.Cells))
		resCells := make([]SheetCellRevision, 0, len(prepared.Cells))
		conflicts := make([]SheetCellConflict, 0)
		mergedCount := 0

		for _, w := range prepared.Cells {
			rPos := rowPosMap[w.RowID]
			cPos := colPosMap[w.ColumnID]
			ec := existing[memSheetCellKey{rowID: w.RowID, colID: w.ColumnID}]
			cur := ec.cell

			if autoMerge && len(merges) > 0 && w.Raw != nil && *w.Raw != "" {
				if mRect, covered := findMergeCovering(merges, rPos, cPos); covered && !(rPos == mRect.Top && cPos == mRect.Left) {
					var anchorRowID, anchorColID int64
					if e = tx.QueryRow(ctx, `SELECT id FROM sheet_rows WHERE worksheet_id=$1 AND pos=$2`, prepared.WorksheetID, mRect.Top).Scan(&anchorRowID); e != nil {
						return e
					}
					if e = tx.QueryRow(ctx, `SELECT id FROM sheet_columns WHERE worksheet_id=$1 AND pos=$2`, prepared.WorksheetID, mRect.Left).Scan(&anchorColID); e != nil {
						return e
					}
					var anchorRaw string
					var anchorRev int64
					_ = tx.QueryRow(ctx, `SELECT raw, revision FROM sheet_cells WHERE worksheet_id=$1 AND row_id=$2 AND column_id=$3`, prepared.WorksheetID, anchorRowID, anchorColID).Scan(&anchorRaw, &anchorRev)
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
						AnchorRaw:           anchorRaw,
						AnchorRevision:      anchorRev,
					})
					continue
				}
			}

			resolved, ok := resolveSheetCellWrite(cur, ec.fieldRevs, ec.updatedBy, ec.updatedByName, rPos, cPos, w, autoMerge)
			if !ok {
				return ErrConflict
			}
			if resolved.conflict != nil {
				conflicts = append(conflicts, *resolved.conflict)
				continue
			}
			if resolved.merged {
				mergedCount++
			}
			styleBytes, e := json.Marshal(resolved.nextStyle)
			if e != nil {
				return e
			}
			fieldRevsBytes, e := json.Marshal(resolved.nextFieldRevs)
			if e != nil {
				return e
			}
			uRowIDs = append(uRowIDs, w.RowID)
			uColIDs = append(uColIDs, w.ColumnID)
			uRaws = append(uRaws, resolved.nextRaw)
			uStyles = append(uStyles, string(styleBytes))
			uRevs = append(uRevs, resolved.nextRev)
			uFieldRevs = append(uFieldRevs, string(fieldRevsBytes))
			resCells = append(resCells, SheetCellRevision{
				RowID:    w.RowID,
				ColumnID: w.ColumnID,
				Revision: resolved.nextRev,
				Raw:      resolved.nextRaw,
				Style:    cloneSheetStyle(resolved.nextStyle),
				Merged:   resolved.merged,
			})
		}

		if e = drivePGEnd(ctx, g, expires); e != nil {
			return e
		}

		nextWBRev := info.workbookRevision
		if len(uRowIDs) > 0 {
			if _, e = tx.Exec(ctx, `
				INSERT INTO sheet_cells (worksheet_id, row_id, column_id, raw, style, revision, field_revs, updated_by, updated_at)
				SELECT $1, r, c, raw, st::jsonb, rev, fr::jsonb, $8, now()
				FROM unnest($2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::bigint[], $7::text[]) AS t(r, c, raw, st, rev, fr)
				ON CONFLICT (worksheet_id, row_id, column_id) DO UPDATE SET
					raw = EXCLUDED.raw,
					style = EXCLUDED.style,
					revision = EXCLUDED.revision,
					field_revs = EXCLUDED.field_revs,
					updated_by = EXCLUDED.updated_by,
					updated_at = EXCLUDED.updated_at`,
				prepared.WorksheetID, uRowIDs, uColIDs, uRaws, uStyles, uRevs, uFieldRevs, g.UserID); e != nil {
				return e
			}

			if _, e = tx.Exec(ctx, `UPDATE sheet_worksheets SET revision=revision+1, updated_at=now() WHERE id=$1`, prepared.WorksheetID); e != nil {
				return e
			}
			nextWBRev, e = touchSheetWorkbookPG(ctx, tx, nodeID, g.UserID)
			if e != nil {
				return e
			}
		}
		out = SheetBatchResult{
			MutationID:       prepared.MutationID,
			WorksheetID:      prepared.WorksheetID,
			WorkbookRevision: nextWBRev,
			Cells:            resCells,
			Conflicts:        conflicts,
			MergedCount:      mergedCount,
		}
		rawOut, e := json.Marshal(out)
		if e != nil {
			return e
		}
		if e = pruneSheetReceiptsPG(ctx, tx, nodeID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO sheet_write_receipts (node_id, user_id, mutation_id, digest, result) VALUES ($1,$2,$3,$4,$5)`, nodeID, g.UserID, prepared.MutationID, digest, rawOut); e != nil {
			return e
		}
		return drivePGEnd(ctx, g, expires)
	})
	return out, drivePGError(err)
}

func (p *Postgres) CreateWorksheet(ctx context.Context, g RestoreGuard, nodeID int64, rawTitle string) (out SheetWorksheet, workbookRev int64, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		info, expires, e := lockSheetPG(ctx, tx, g, nodeID, RoleEdit, true)
		if e != nil {
			return e
		}
		if info.workbookRevision >= sheetMaxRevision {
			return ErrConflict
		}
		rows, e := tx.Query(ctx, `SELECT id, title, pos FROM sheet_worksheets WHERE node_id=$1 ORDER BY pos, id FOR UPDATE`, nodeID)
		if e != nil {
			return e
		}
		var titles []string
		for rows.Next() {
			var id int64
			var t string
			var pos int
			if e = rows.Scan(&id, &t, &pos); e != nil {
				rows.Close()
				return e
			}
			titles = append(titles, t)
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			return e
		}
		rows.Close()

		if len(titles) >= sheetMaxWorksheets {
			return ErrConflict
		}
		title := strings.TrimSpace(rawTitle)
		if title == "" {
			existing := map[string]bool{}
			for _, t := range titles {
				existing[strings.ToLower(t)] = true
			}
			for n := len(titles) + 1; ; n++ {
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
				return ErrConflict
			}
			for _, existingTitle := range titles {
				if strings.EqualFold(existingTitle, title) {
					return ErrConflict
				}
			}
		}

		if e = drivePGEnd(ctx, g, expires); e != nil {
			return e
		}

		var wid int64
		if e = tx.QueryRow(ctx, `INSERT INTO sheet_worksheets (node_id, title, pos) VALUES ($1, $2, $3) RETURNING id`, nodeID, title, len(titles)).Scan(&wid); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO sheet_rows (worksheet_id, pos) SELECT $1, n FROM generate_series(0, $2::int - 1) n`, wid, sheetInitialRows); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO sheet_columns (worksheet_id, pos) SELECT $1, n FROM generate_series(0, $2::int - 1) n`, wid, sheetInitialCols); e != nil {
			return e
		}
		out, e = scanWorksheetMetaPG(tx.QueryRow(ctx, `SELECT `+worksheetMetaCols+` FROM sheet_worksheets WHERE id=$1`, wid))
		if e != nil {
			return e
		}
		if e = loadWorksheetChildrenPG(ctx, tx, &out); e != nil {
			return e
		}
		workbookRev, e = touchSheetWorkbookPG(ctx, tx, nodeID, g.UserID)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, g, expires)
	})
	return out, workbookRev, drivePGError(err)
}

func (p *Postgres) UpdateWorksheetMeta(ctx context.Context, g RestoreGuard, nodeID, worksheetID int64, patch WorksheetPatch) (out SheetWorksheet, workbookRev int64, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		info, expires, e := lockSheetPG(ctx, tx, g, nodeID, RoleEdit, true)
		if e != nil {
			return e
		}
		if info.workbookRevision >= sheetMaxRevision {
			return ErrConflict
		}
		rows, e := tx.Query(ctx, `SELECT `+worksheetMetaCols+` FROM sheet_worksheets WHERE node_id=$1 ORDER BY pos, id FOR UPDATE`, nodeID)
		if e != nil {
			return e
		}
		var all []SheetWorksheet
		targetIdx := -1
		for rows.Next() {
			ws, scanErr := scanWorksheetMetaPG(rows)
			if scanErr != nil {
				rows.Close()
				return scanErr
			}
			if ws.ID == worksheetID {
				targetIdx = len(all)
			}
			all = append(all, ws)
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			return e
		}
		rows.Close()

		if targetIdx < 0 {
			return ErrNotFound
		}
		ws := all[targetIdx]
		if ws.Revision >= sheetMaxRevision {
			return ErrConflict
		}
		if patch.ExpectedRevision != nil && ws.Revision != *patch.ExpectedRevision {
			return ErrConflict
		}

		var rowCount, colCount int
		if e = tx.QueryRow(ctx, `SELECT count(*) FROM sheet_rows WHERE worksheet_id=$1`, worksheetID).Scan(&rowCount); e != nil {
			return e
		}
		if e = tx.QueryRow(ctx, `SELECT count(*) FROM sheet_columns WHERE worksheet_id=$1`, worksheetID).Scan(&colCount); e != nil {
			return e
		}

		nextTitle := ws.Title
		if patch.Title != nil {
			var ok bool
			nextTitle, ok = cleanWorksheetTitle(*patch.Title)
			if !ok {
				return ErrConflict
			}
			for _, other := range all {
				if other.ID != ws.ID && strings.EqualFold(other.titleOrEmpty(), nextTitle) {
					return ErrConflict
				}
			}
		}
		nextPos := targetIdx
		if patch.Pos != nil {
			if *patch.Pos < 0 || *patch.Pos >= len(all) {
				return ErrConflict
			}
			nextPos = *patch.Pos
		}
		nextFrozenRows := ws.FrozenRows
		if patch.FrozenRows != nil {
			if *patch.FrozenRows < 0 || *patch.FrozenRows > min(sheetMaxFrozenRows, rowCount-1) {
				return ErrConflict
			}
			nextFrozenRows = *patch.FrozenRows
		}
		nextFrozenCols := ws.FrozenCols
		if patch.FrozenCols != nil {
			if *patch.FrozenCols < 0 || *patch.FrozenCols > min(sheetMaxFrozenCols, colCount-1) {
				return ErrConflict
			}
			nextFrozenCols = *patch.FrozenCols
		}
		nextMerges := ws.Merges
		mergeOpNoop := false
		if patch.Merges != nil && patch.MergeOp != nil {
			return ErrConflict
		}
		if patch.Merges != nil {
			var ok bool
			nextMerges, ok = validateAndNormalizeSheetMerges(*patch.Merges, rowCount, colCount)
			if !ok {
				return ErrConflict
			}
		} else if patch.MergeOp != nil {
			if e = checkProtectedRectWrite(info.role, g.UserID, patch.MergeOp.Rect, ws.ProtectedRanges); e != nil {
				return e
			}
			applied, overlaps, changed, ok := applySheetMergeOp(ws.Merges, *patch.MergeOp, rowCount, colCount)
			if !ok {
				return ErrConflict
			}
			if len(overlaps) > 0 {
				latest := ws
				if loadErr := loadWorksheetChildrenPG(ctx, tx, &latest); loadErr != nil {
					return loadErr
				}
				return &SheetRegionConflictError{
					Code:              "merge_overlap_conflict",
					Message:           "所选区域与其他协作者新合并的单元格存在重叠",
					ConflictingMerges: overlaps,
					Worksheet:         latest,
					WorkbookRevision:  info.workbookRevision,
				}
			}
			nextMerges = applied
			mergeOpNoop = !changed && patch.Title == nil && patch.Pos == nil && patch.FrozenRows == nil && patch.FrozenCols == nil && patch.Filter == nil && patch.Validations == nil && patch.ConditionalFormats == nil && patch.ProtectedRanges == nil && patch.Charts == nil && patch.PivotTables == nil
		}
		nextFilter := ws.Filter
		if patch.Filter != nil {
			var ok bool
			nextFilter, ok = validateAndNormalizeSheetFilter(*patch.Filter, rowCount, colCount)
			if !ok {
				return ErrConflict
			}
		}
		nextValidations := ws.Validations
		if patch.Validations != nil {
			var ok bool
			nextValidations, ok = validateAndNormalizeSheetValidations(*patch.Validations, rowCount, colCount)
			if !ok {
				return ErrConflict
			}
		}
		nextCondFormats := ws.ConditionalFormats
		if patch.ConditionalFormats != nil {
			var ok bool
			nextCondFormats, ok = validateAndNormalizeSheetCondFormats(*patch.ConditionalFormats, rowCount, colCount)
			if !ok {
				return ErrConflict
			}
		}
		nextProtected := ws.ProtectedRanges
		if patch.ProtectedRanges != nil {
			if info.role != RoleManage {
				return ErrForbidden
			}
			var ok bool
			nextProtected, ok = validateAndNormalizeSheetProtectedRanges(*patch.ProtectedRanges, rowCount, colCount)
			if !ok {
				return ErrConflict
			}
		}
		nextCharts := ws.Charts
		if patch.Charts != nil {
			var ok bool
			nextCharts, ok = validateAndNormalizeSheetCharts(*patch.Charts, rowCount, colCount)
			if !ok {
				return ErrConflict
			}
		}
		nextPivots := ws.PivotTables
		if patch.PivotTables != nil {
			dims := make(map[int64][2]int, len(all))
			for _, item := range all {
				if item.ID == worksheetID {
					dims[item.ID] = [2]int{rowCount, colCount}
					continue
				}
				var rc, cc int
				if e = tx.QueryRow(ctx, `SELECT count(*) FROM sheet_rows WHERE worksheet_id=$1`, item.ID).Scan(&rc); e != nil {
					return e
				}
				if e = tx.QueryRow(ctx, `SELECT count(*) FROM sheet_columns WHERE worksheet_id=$1`, item.ID).Scan(&cc); e != nil {
					return e
				}
				dims[item.ID] = [2]int{rc, cc}
			}
			var ok bool
			nextPivots, ok = validateAndNormalizeSheetPivotTables(*patch.PivotTables, worksheetID, dims)
			if !ok {
				return ErrConflict
			}
		}
		nextSparklines := ws.Sparklines
		if patch.Sparklines != nil {
			var ok bool
			nextSparklines, ok = validateAndNormalizeSheetSparklines(*patch.Sparklines, rowCount, colCount)
			if !ok {
				return ErrConflict
			}
		}
		nextOutlineGroups := ws.OutlineGroups
		if patch.OutlineGroups != nil {
			var ok bool
			nextOutlineGroups, ok = validateAndNormalizeSheetOutlineGroups(*patch.OutlineGroups, rowCount, colCount)
			if !ok {
				return ErrConflict
			}
		}

		if e = drivePGEnd(ctx, g, expires); e != nil {
			return e
		}
		if mergeOpNoop {
			out = ws
			if e = loadWorksheetChildrenPG(ctx, tx, &out); e != nil {
				return e
			}
			workbookRev = info.workbookRevision
			return nil
		}

		if nextPos != targetIdx {
			orderIDs := make([]int64, 0, len(all))
			for _, item := range all {
				if item.ID != worksheetID {
					orderIDs = append(orderIDs, item.ID)
				}
			}
			orderIDs = slices.Insert(orderIDs, nextPos, worksheetID)
			posVals := make([]int, len(orderIDs))
			for i := range orderIDs {
				posVals[i] = i
			}
			if _, e = tx.Exec(ctx, `UPDATE sheet_worksheets sw SET pos = t.p FROM unnest($1::bigint[], $2::int[]) AS t(id, p) WHERE sw.id = t.id`, orderIDs, posVals); e != nil {
				return e
			}
		}

		mergesJSON, e := json.Marshal(nextMerges)
		if e != nil {
			return e
		}
		filterJSON, e := json.Marshal(nextFilter)
		if e != nil {
			return e
		}
		validationsJSON, e := json.Marshal(nextValidations)
		if e != nil {
			return e
		}
		condFormatsJSON, e := json.Marshal(nextCondFormats)
		if e != nil {
			return e
		}
		protectedJSON, e := json.Marshal(nextProtected)
		if e != nil {
			return e
		}
		chartsJSON, e := json.Marshal(nextCharts)
		if e != nil {
			return e
		}
		pivotsJSON, e := json.Marshal(nextPivots)
		if e != nil {
			return e
		}
		sparklinesJSON, e := json.Marshal(nextSparklines)
		if e != nil {
			return e
		}
		outlineGroupsJSON, e := json.Marshal(nextOutlineGroups)
		if e != nil {
			return e
		}
		out, e = scanWorksheetMetaPG(tx.QueryRow(ctx, `UPDATE sheet_worksheets SET title=$2, frozen_rows=$3, frozen_cols=$4, merges=$5::jsonb, filter_config=$6::jsonb, validations=$7::jsonb, conditional_formats=$8::jsonb, protected_ranges=$9::jsonb, charts=$10::jsonb, pivot_tables=$11::jsonb, sparklines=$12::jsonb, outline_groups=$13::jsonb, revision=revision+1, updated_at=now() WHERE id=$1 RETURNING `+worksheetMetaCols,
			worksheetID, nextTitle, nextFrozenRows, nextFrozenCols, string(mergesJSON), string(filterJSON), string(validationsJSON), string(condFormatsJSON), string(protectedJSON), string(chartsJSON), string(pivotsJSON), string(sparklinesJSON), string(outlineGroupsJSON)))
		if e != nil {
			return e
		}
		if e = loadWorksheetChildrenPG(ctx, tx, &out); e != nil {
			return e
		}
		workbookRev, e = touchSheetWorkbookPG(ctx, tx, nodeID, g.UserID)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, g, expires)
	})
	return out, workbookRev, drivePGError(err)
}

func (w SheetWorksheet) titleOrEmpty() string { return w.Title }

func (p *Postgres) DeleteWorksheet(ctx context.Context, g RestoreGuard, nodeID, worksheetID int64) (workbookRev int64, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		info, expires, e := lockSheetPG(ctx, tx, g, nodeID, RoleEdit, true)
		if e != nil {
			return e
		}
		if info.workbookRevision >= sheetMaxRevision {
			return ErrConflict
		}
		rows, e := tx.Query(ctx, `SELECT id, pos FROM sheet_worksheets WHERE node_id=$1 ORDER BY pos, id FOR UPDATE`, nodeID)
		if e != nil {
			return e
		}
		var ids []int64
		targetPos := -1
		for rows.Next() {
			var id int64
			var pos int
			if e = rows.Scan(&id, &pos); e != nil {
				rows.Close()
				return e
			}
			if id == worksheetID {
				targetPos = pos
			}
			ids = append(ids, id)
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			return e
		}
		rows.Close()
		if targetPos < 0 {
			return ErrNotFound
		}
		if len(ids) <= 1 {
			return ErrConflict
		}
		if e = drivePGEnd(ctx, g, expires); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `DELETE FROM sheet_worksheets WHERE id=$1`, worksheetID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `UPDATE sheet_worksheets SET pos=pos-1 WHERE node_id=$1 AND pos>$2`, nodeID, targetPos); e != nil {
			return e
		}
		workbookRev, e = touchSheetWorkbookPG(ctx, tx, nodeID, g.UserID)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, g, expires)
	})
	return workbookRev, drivePGError(err)
}

func (p *Postgres) MutateSheetAxis(ctx context.Context, g RestoreGuard, nodeID, worksheetID int64, op SheetAxisOp) (out SheetWorksheet, workbookRev int64, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		info, expires, e := lockSheetPG(ctx, tx, g, nodeID, RoleEdit, true)
		if e != nil {
			return e
		}
		if info.workbookRevision >= sheetMaxRevision {
			return ErrConflict
		}
		ws, e := scanWorksheetMetaPG(tx.QueryRow(ctx, `SELECT `+worksheetMetaCols+` FROM sheet_worksheets WHERE id=$1 AND node_id=$2 FOR UPDATE`, worksheetID, nodeID))
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if ws.Revision >= sheetMaxRevision {
			return ErrConflict
		}
		if op.ExpectedRevision != nil && ws.Revision != *op.ExpectedRevision {
			return ErrConflict
		}
		var rowCount, colCount int
		if e = tx.QueryRow(ctx, `SELECT count(*) FROM sheet_rows WHERE worksheet_id=$1`, worksheetID).Scan(&rowCount); e != nil {
			return e
		}
		if e = tx.QueryRow(ctx, `SELECT count(*) FROM sheet_columns WHERE worksheet_id=$1`, worksheetID).Scan(&colCount); e != nil {
			return e
		}
		count := op.Count
		if count == 0 {
			count = 1
		}
		nextMerges := ws.Merges
		nextFrozenRows := ws.FrozenRows
		nextFrozenCols := ws.FrozenCols
		nextFilter := ws.Filter
		nextValidations := ws.Validations
		nextCondFormats := ws.ConditionalFormats
		nextProtected := ws.ProtectedRanges
		nextCharts := ws.Charts
		nextPivots := ws.PivotTables
		nextSparklines := ws.Sparklines
		nextOutlineGroups := ws.OutlineGroups

		switch op.Op {
		case "insert_row":
			if count < 1 || count > 20 || op.Index < 0 || op.Index > rowCount || rowCount+count > sheetMaxRows {
				return ErrConflict
			}
			if e = drivePGEnd(ctx, g, expires); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `UPDATE sheet_rows SET pos = pos + $2 WHERE worksheet_id=$1 AND pos >= $3`, worksheetID, count, op.Index); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `INSERT INTO sheet_rows (worksheet_id, pos) SELECT $1, $2 + n FROM generate_series(0, $3::int - 1) n`, worksheetID, op.Index, count); e != nil {
				return e
			}
			nextMerges = adjustSheetMergesInsert(nextMerges, "row", op.Index, count)
			nextValidations = adjustSheetValidationsInsert(nextValidations, "row", op.Index, count)
			nextCondFormats = adjustSheetCondFormatsInsert(nextCondFormats, "row", op.Index, count)
			nextProtected = adjustSheetProtectedInsert(nextProtected, "row", op.Index, count)
			nextCharts = adjustSheetChartsInsert(nextCharts, "row", op.Index, count)
			nextPivots = adjustSheetPivotsInsert(nextPivots, worksheetID, "row", op.Index, count)
			nextSparklines = adjustSheetSparklinesInsert(nextSparklines, "row", op.Index, count)
			nextOutlineGroups = adjustSheetOutlineGroupsInsert(nextOutlineGroups, "row", op.Index, count)
		case "delete_row":
			if count < 1 || count > 50 || op.Index < 0 || op.Index+count > rowCount || rowCount-count < 1 {
				return ErrConflict
			}
			if e = checkProtectedAxisDelete(info.role, g.UserID, "row", op.Index, count, nextProtected); e != nil {
				return e
			}
			if e = drivePGEnd(ctx, g, expires); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `DELETE FROM sheet_rows WHERE worksheet_id=$1 AND pos >= $2 AND pos < $3`, worksheetID, op.Index, op.Index+count); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `UPDATE sheet_rows SET pos = pos - $2 WHERE worksheet_id=$1 AND pos >= $3`, worksheetID, count, op.Index+count); e != nil {
				return e
			}
			nextMerges = adjustSheetMergesDelete(nextMerges, "row", op.Index, count)
			nextValidations = adjustSheetValidationsDelete(nextValidations, "row", op.Index, count)
			nextCondFormats = adjustSheetCondFormatsDelete(nextCondFormats, "row", op.Index, count)
			nextProtected = adjustSheetProtectedDelete(nextProtected, "row", op.Index, count)
			nextCharts = adjustSheetChartsDelete(nextCharts, "row", op.Index, count)
			nextPivots = adjustSheetPivotsDelete(nextPivots, worksheetID, "row", op.Index, count)
			nextSparklines = adjustSheetSparklinesDelete(nextSparklines, "row", op.Index, count)
			nextOutlineGroups = adjustSheetOutlineGroupsDelete(nextOutlineGroups, "row", op.Index, count)
			newRows := rowCount - count
			if nextFrozenRows > newRows-1 {
				nextFrozenRows = max(0, newRows-1)
			}
			if nextFilter.HeaderRow >= newRows {
				nextFilter.HeaderRow = max(0, newRows-1)
			}
		case "resize_row":
			if op.Index < 0 || op.Index >= rowCount || (op.Size != 0 && (op.Size < 18 || op.Size > 1000)) {
				return ErrConflict
			}
			if e = drivePGEnd(ctx, g, expires); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `UPDATE sheet_rows SET size=$3 WHERE worksheet_id=$1 AND pos=$2`, worksheetID, op.Index, op.Size); e != nil {
				return e
			}
		case "insert_col":
			if count < 1 || count > 20 || op.Index < 0 || op.Index > colCount || colCount+count > sheetMaxCols {
				return ErrConflict
			}
			if e = drivePGEnd(ctx, g, expires); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `UPDATE sheet_columns SET pos = pos + $2 WHERE worksheet_id=$1 AND pos >= $3`, worksheetID, count, op.Index); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `INSERT INTO sheet_columns (worksheet_id, pos) SELECT $1, $2 + n FROM generate_series(0, $3::int - 1) n`, worksheetID, op.Index, count); e != nil {
				return e
			}
			nextMerges = adjustSheetMergesInsert(nextMerges, "col", op.Index, count)
			nextValidations = adjustSheetValidationsInsert(nextValidations, "col", op.Index, count)
			nextCondFormats = adjustSheetCondFormatsInsert(nextCondFormats, "col", op.Index, count)
			nextProtected = adjustSheetProtectedInsert(nextProtected, "col", op.Index, count)
			nextCharts = adjustSheetChartsInsert(nextCharts, "col", op.Index, count)
			nextPivots = adjustSheetPivotsInsert(nextPivots, worksheetID, "col", op.Index, count)
			nextSparklines = adjustSheetSparklinesInsert(nextSparklines, "col", op.Index, count)
			nextOutlineGroups = adjustSheetOutlineGroupsInsert(nextOutlineGroups, "col", op.Index, count)
		case "delete_col":
			if count < 1 || count > 50 || op.Index < 0 || op.Index+count > colCount || colCount-count < 1 {
				return ErrConflict
			}
			if e = checkProtectedAxisDelete(info.role, g.UserID, "col", op.Index, count, nextProtected); e != nil {
				return e
			}
			if e = drivePGEnd(ctx, g, expires); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `DELETE FROM sheet_columns WHERE worksheet_id=$1 AND pos >= $2 AND pos < $3`, worksheetID, op.Index, op.Index+count); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `UPDATE sheet_columns SET pos = pos - $2 WHERE worksheet_id=$1 AND pos >= $3`, worksheetID, count, op.Index+count); e != nil {
				return e
			}
			nextMerges = adjustSheetMergesDelete(nextMerges, "col", op.Index, count)
			nextValidations = adjustSheetValidationsDelete(nextValidations, "col", op.Index, count)
			nextCondFormats = adjustSheetCondFormatsDelete(nextCondFormats, "col", op.Index, count)
			nextProtected = adjustSheetProtectedDelete(nextProtected, "col", op.Index, count)
			nextCharts = adjustSheetChartsDelete(nextCharts, "col", op.Index, count)
			nextPivots = adjustSheetPivotsDelete(nextPivots, worksheetID, "col", op.Index, count)
			nextSparklines = adjustSheetSparklinesDelete(nextSparklines, "col", op.Index, count)
			nextOutlineGroups = adjustSheetOutlineGroupsDelete(nextOutlineGroups, "col", op.Index, count)
			newCols := colCount - count
			if nextFrozenCols > newCols-1 {
				nextFrozenCols = max(0, newCols-1)
			}
			if nextFilter.Sort != nil && nextFilter.Sort.Col >= newCols {
				nextFilter.Sort = nil
			}
		case "resize_col":
			if op.Index < 0 || op.Index >= colCount || (op.Size != 0 && (op.Size < 24 || op.Size > 1000)) {
				return ErrConflict
			}
			if e = drivePGEnd(ctx, g, expires); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `UPDATE sheet_columns SET size=$3 WHERE worksheet_id=$1 AND pos=$2`, worksheetID, op.Index, op.Size); e != nil {
				return e
			}
		default:
			return ErrConflict
		}

		mergesJSON, e := json.Marshal(nextMerges)
		if e != nil {
			return e
		}
		filterJSON, e := json.Marshal(nextFilter)
		if e != nil {
			return e
		}
		validationsJSON, e := json.Marshal(nextValidations)
		if e != nil {
			return e
		}
		condFormatsJSON, e := json.Marshal(nextCondFormats)
		if e != nil {
			return e
		}
		protectedJSON, e := json.Marshal(nextProtected)
		if e != nil {
			return e
		}
		chartsJSON, e := json.Marshal(nextCharts)
		if e != nil {
			return e
		}
		pivotsJSON, e := json.Marshal(nextPivots)
		if e != nil {
			return e
		}
		sparklinesJSON, e := json.Marshal(nextSparklines)
		if e != nil {
			return e
		}
		outlineGroupsJSON, e := json.Marshal(nextOutlineGroups)
		if e != nil {
			return e
		}
		out, e = scanWorksheetMetaPG(tx.QueryRow(ctx, `UPDATE sheet_worksheets SET frozen_rows=$2, frozen_cols=$3, merges=$4::jsonb, filter_config=$5::jsonb, validations=$6::jsonb, conditional_formats=$7::jsonb, protected_ranges=$8::jsonb, charts=$9::jsonb, pivot_tables=$10::jsonb, sparklines=$11::jsonb, outline_groups=$12::jsonb, revision=revision+1, updated_at=now() WHERE id=$1 RETURNING `+worksheetMetaCols,
			worksheetID, nextFrozenRows, nextFrozenCols, string(mergesJSON), string(filterJSON), string(validationsJSON), string(condFormatsJSON), string(protectedJSON), string(chartsJSON), string(pivotsJSON), string(sparklinesJSON), string(outlineGroupsJSON)))
		if e != nil {
			return e
		}
		if e = loadWorksheetChildrenPG(ctx, tx, &out); e != nil {
			return e
		}
		workbookRev, e = touchSheetWorkbookPG(ctx, tx, nodeID, g.UserID)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, g, expires)
	})
	return out, workbookRev, drivePGError(err)
}

func (p *Postgres) ReplaceSheetWorkbook(ctx context.Context, g RestoreGuard, nodeID, expectedWorkbookRevision int64, mutationID string, sheets []ImportedWorksheet) (snap SheetSnapshot, err error) {
	prepared, sum, err := prepareImportWorksheets(sheets, mutationID)
	if err != nil {
		return snap, err
	}
	digest := sheetDigestTag("replace-v1", sum)
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		info, expires, e := lockSheetPG(ctx, tx, g, nodeID, RoleEdit, true)
		if e != nil {
			return e
		}
		var savedDigest, savedResult []byte
		e = tx.QueryRow(ctx, `SELECT digest, result FROM sheet_write_receipts WHERE node_id=$1 AND user_id=$2 AND mutation_id=$3`, nodeID, g.UserID, mutationID).
			Scan(&savedDigest, &savedResult)
		if e == nil {
			if !slices.Equal(savedDigest, digest) {
				return ErrConflict
			}
			if e = json.Unmarshal(savedResult, &snap); e != nil {
				return ErrConflict
			}
			return drivePGEnd(ctx, g, expires)
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if info.workbookRevision != expectedWorkbookRevision || info.workbookRevision >= sheetMaxRevision {
			return ErrConflict
		}
		if e = drivePGEnd(ctx, g, expires); e != nil {
			return e
		}

		if _, e = tx.Exec(ctx, `DELETE FROM sheet_worksheets WHERE node_id=$1`, nodeID); e != nil {
			return e
		}
		for pos, item := range prepared {
			mergesJSON, e := json.Marshal(item.Merges)
			if e != nil {
				return e
			}
			var wid int64
			if e = tx.QueryRow(ctx, `INSERT INTO sheet_worksheets (node_id, title, pos, frozen_rows, frozen_cols, merges) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
				nodeID, item.Title, pos, item.FrozenRows, item.FrozenCols, string(mergesJSON)).Scan(&wid); e != nil {
				return e
			}
			rowRows, e := tx.Query(ctx, `INSERT INTO sheet_rows (worksheet_id, pos) SELECT $1, n FROM generate_series(0, $2::int - 1) n RETURNING id, pos`, wid, item.Rows)
			if e != nil {
				return e
			}
			rowIDs := make([]int64, item.Rows)
			for rowRows.Next() {
				var id int64
				var p int
				if e = rowRows.Scan(&id, &p); e != nil {
					rowRows.Close()
					return e
				}
				rowIDs[p] = id
			}
			if e = rowRows.Err(); e != nil {
				rowRows.Close()
				return e
			}
			rowRows.Close()

			colRows, e := tx.Query(ctx, `INSERT INTO sheet_columns (worksheet_id, pos) SELECT $1, n FROM generate_series(0, $2::int - 1) n RETURNING id, pos`, wid, item.Cols)
			if e != nil {
				return e
			}
			colIDs := make([]int64, item.Cols)
			for colRows.Next() {
				var id int64
				var p int
				if e = colRows.Scan(&id, &p); e != nil {
					colRows.Close()
					return e
				}
				colIDs[p] = id
			}
			if e = colRows.Err(); e != nil {
				colRows.Close()
				return e
			}
			colRows.Close()

			if len(item.Cells) > 0 {
				cRows := make([]int64, 0, len(item.Cells))
				cCols := make([]int64, 0, len(item.Cells))
				cRaws := make([]string, 0, len(item.Cells))
				cStyles := make([]string, 0, len(item.Cells))
				for _, c := range item.Cells {
					styleBytes, e := json.Marshal(c.Style)
					if e != nil {
						return e
					}
					cRows = append(cRows, rowIDs[c.Row])
					cCols = append(cCols, colIDs[c.Col])
					cRaws = append(cRaws, c.Raw)
					cStyles = append(cStyles, string(styleBytes))
				}
				if _, e = tx.Exec(ctx, `
					INSERT INTO sheet_cells (worksheet_id, row_id, column_id, raw, style, revision, updated_by)
					SELECT $1, r, c, raw, st::jsonb, 1, $6
					FROM unnest($2::bigint[], $3::bigint[], $4::text[], $5::text[]) AS t(r, c, raw, st)`,
					wid, cRows, cCols, cRaws, cStyles, g.UserID); e != nil {
					return e
				}
			}
		}

		nextWBRev, e := touchSheetWorkbookPG(ctx, tx, nodeID, g.UserID)
		if e != nil {
			return e
		}
		info.workbookRevision = nextWBRev
		info.updatedAt = time.Now()
		snap, e = loadSheetSnapshotPG(ctx, tx, info)
		if e != nil {
			return e
		}
		rawSnap, e := json.Marshal(snap)
		if e != nil {
			return e
		}
		if e = pruneSheetReceiptsPG(ctx, tx, nodeID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO sheet_write_receipts (node_id, user_id, mutation_id, digest, result) VALUES ($1,$2,$3,$4,$5)`, nodeID, g.UserID, mutationID, digest, rawSnap); e != nil {
			return e
		}
		return drivePGEnd(ctx, g, expires)
	})
	return snap, drivePGError(err)
}

func (p *Postgres) CopySheetWorkbook(ctx context.Context, c SheetWorkbookCopy) (meta DocMeta, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		srcWS, e := drivePGNodeWorkspace(ctx, tx, c.SourceID)
		if e != nil {
			return e
		}
		if srcWS <= c.WorkspaceID {
			if e = drivePGLockWorkspace(ctx, tx, srcWS); e != nil {
				return e
			}
			if c.WorkspaceID != srcWS {
				if e = drivePGLockWorkspace(ctx, tx, c.WorkspaceID); e != nil {
					return e
				}
			}
		} else {
			if e = drivePGLockWorkspace(ctx, tx, c.WorkspaceID); e != nil {
				return e
			}
			if e = drivePGLockWorkspace(ctx, tx, srcWS); e != nil {
				return e
			}
		}

		var expiry time.Time
		if c.Guard != nil {
			guard := c.Guard
			var sessionUser int64
			e = tx.QueryRow(ctx, `SELECT user_id, expires_at FROM sessions WHERE token_hash=$1 FOR SHARE`, guard.SessionHash).Scan(&sessionUser, &expiry)
			if errors.Is(e, pgx.ErrNoRows) || e == nil && (guard.UserID != c.UserID || sessionUser != c.UserID || !guard.currentTime().Before(expiry)) {
				return ErrUnauthenticated
			}
			if e != nil {
				return e
			}
		}

		sourceRole, protected, kind, e := lockCopySource(ctx, tx, c.SourceID, c.UserID)
		if e != nil {
			return e
		}
		if RoleRank(sourceRole) < RoleRank(RoleView) {
			return ErrNotFound
		}
		if kind != "sheet" {
			return ErrConflict
		}
		var downloadMinRole string
		var sourcePersonal bool
		var sourceWorkspace int64
		if e = tx.QueryRow(ctx, `SELECT download_min_role, personal, workspace_id FROM nodes WHERE id=$1`, c.SourceID).Scan(&downloadMinRole, &sourcePersonal, &sourceWorkspace); e != nil {
			return e
		}
		if !DocumentDownloadAllowed(DocMeta{Kind: kind, CopyProtected: protected, DownloadMinRole: downloadMinRole}, sourceRole) {
			return ErrCopyProtected
		}
		var member int64
		if e = tx.QueryRow(ctx, `SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, c.WorkspaceID, c.UserID).Scan(&member); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrForbidden
			}
			return e
		}
		personal := sourcePersonal
		if c.WorkspaceID != sourceWorkspace {
			personal = true
		}
		if c.Personal != nil {
			personal = *c.Personal
		}
		if c.ParentID != nil {
			personal, e = drivePGDestination(ctx, tx, RestoreGuard{UserID: c.UserID}, c.WorkspaceID, c.ParentID, RoleEdit)
			if e != nil {
				return e
			}
		}

		srcRows, e := tx.Query(ctx, `SELECT `+worksheetMetaCols+` FROM sheet_worksheets WHERE node_id=$1 ORDER BY pos, id FOR SHARE`, c.SourceID)
		if e != nil {
			return e
		}
		var sourceSheets []SheetWorksheet
		for srcRows.Next() {
			ws, scanErr := scanWorksheetMetaPG(srcRows)
			if scanErr != nil {
				srcRows.Close()
				return scanErr
			}
			sourceSheets = append(sourceSheets, ws)
		}
		if e = srcRows.Err(); e != nil {
			srcRows.Close()
			return e
		}
		srcRows.Close()

		for i := range sourceSheets {
			if e = loadWorksheetChildrenPG(ctx, tx, &sourceSheets[i]); e != nil {
				return e
			}
		}

		if c.Guard != nil && !c.Guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}

		meta, e = scanDocWithPermissions(tx.QueryRow(ctx, `INSERT INTO nodes (workspace_id, parent_id, kind, sort_key, title, creator_id, drive_revision, personal)
			VALUES ($1,$2,'sheet','V',$3,$4,1,$5) RETURNING `+docCols+creatorName+`, copy_protected, copy_min_role, download_min_role, comment_min_role, permissions_revision`,
			c.WorkspaceID, c.ParentID, c.Title, c.UserID, personal))
		if e != nil {
			return e
		}
		meta.DriveRevision = 1
		meta.Role = RoleManage

		if _, e = tx.Exec(ctx, `INSERT INTO sheet_workbooks (node_id, revision) VALUES ($1, 1)`, meta.ID); e != nil {
			return e
		}

		wsIDMap := make(map[int64]int64, len(sourceSheets))
		copiedPivots := make(map[int64][]SheetPivotTable, len(sourceSheets))
		for pos, src := range sourceSheets {
			mergesJSON, e := json.Marshal(src.Merges)
			if e != nil {
				return e
			}
			filterJSON, e := json.Marshal(src.Filter)
			if e != nil {
				return e
			}
			validationsJSON, e := json.Marshal(src.Validations)
			if e != nil {
				return e
			}
			condFormatsJSON, e := json.Marshal(src.ConditionalFormats)
			if e != nil {
				return e
			}
			protectedJSON, e := json.Marshal(src.ProtectedRanges)
			if e != nil {
				return e
			}
			chartsJSON, e := json.Marshal(src.Charts)
			if e != nil {
				return e
			}
			sparklinesJSON, e := json.Marshal(cloneSheetSparklines(src.Sparklines))
			if e != nil {
				return e
			}
			outlineGroupsJSON, e := json.Marshal(cloneSheetOutlineGroups(src.OutlineGroups))
			if e != nil {
				return e
			}
			var wid int64
			if e = tx.QueryRow(ctx, `INSERT INTO sheet_worksheets (node_id, title, pos, frozen_rows, frozen_cols, merges, filter_config, validations, conditional_formats, protected_ranges, charts, pivot_tables, sparklines, outline_groups, revision) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,'[]'::jsonb,$12::jsonb,$13::jsonb,1) RETURNING id`,
				meta.ID, src.Title, pos, src.FrozenRows, src.FrozenCols, string(mergesJSON), string(filterJSON), string(validationsJSON), string(condFormatsJSON), string(protectedJSON), string(chartsJSON), string(sparklinesJSON), string(outlineGroupsJSON)).Scan(&wid); e != nil {
				return e
			}
			wsIDMap[src.ID] = wid
			if len(src.PivotTables) > 0 {
				copiedPivots[wid] = src.PivotTables
			}
			rPos := make([]int, len(src.Rows))
			rSize := make([]int, len(src.Rows))
			for i, r := range src.Rows {
				rPos[i] = r.Pos
				rSize[i] = r.Size
			}
			rowMap := make(map[int64]int64, len(src.Rows))
			insertedRows, e := tx.Query(ctx, `INSERT INTO sheet_rows (worksheet_id, pos, size) SELECT $1, p, s FROM unnest($2::int[], $3::int[]) AS t(p, s) RETURNING id, pos`, wid, rPos, rSize)
			if e != nil {
				return e
			}
			for insertedRows.Next() {
				var newID int64
				var p int
				if e = insertedRows.Scan(&newID, &p); e != nil {
					insertedRows.Close()
					return e
				}
				if p >= 0 && p < len(src.Rows) {
					rowMap[src.Rows[p].ID] = newID
				}
			}
			if e = insertedRows.Err(); e != nil {
				insertedRows.Close()
				return e
			}
			insertedRows.Close()

			cPos := make([]int, len(src.Columns))
			cSize := make([]int, len(src.Columns))
			for i, col := range src.Columns {
				cPos[i] = col.Pos
				cSize[i] = col.Size
			}
			colMap := make(map[int64]int64, len(src.Columns))
			insertedCols, e := tx.Query(ctx, `INSERT INTO sheet_columns (worksheet_id, pos, size) SELECT $1, p, s FROM unnest($2::int[], $3::int[]) AS t(p, s) RETURNING id, pos`, wid, cPos, cSize)
			if e != nil {
				return e
			}
			for insertedCols.Next() {
				var newID int64
				var p int
				if e = insertedCols.Scan(&newID, &p); e != nil {
					insertedCols.Close()
					return e
				}
				if p >= 0 && p < len(src.Columns) {
					colMap[src.Columns[p].ID] = newID
				}
			}
			if e = insertedCols.Err(); e != nil {
				insertedCols.Close()
				return e
			}
			insertedCols.Close()

			if len(src.Cells) > 0 {
				var cRows []int64
				var cCols []int64
				var cRaws []string
				var cStyles []string
				for _, cell := range src.Cells {
					if cell.Raw == "" && cell.Style == (SheetCellStyle{}) {
						continue
					}
					nr, okR := rowMap[cell.RowID]
					nc, okC := colMap[cell.ColumnID]
					if !okR || !okC {
						continue
					}
					styleBytes, e := json.Marshal(cell.Style)
					if e != nil {
						return e
					}
					cRows = append(cRows, nr)
					cCols = append(cCols, nc)
					cRaws = append(cRaws, cell.Raw)
					cStyles = append(cStyles, string(styleBytes))
				}
				if len(cRows) > 0 {
					if _, e = tx.Exec(ctx, `INSERT INTO sheet_cells (worksheet_id, row_id, column_id, raw, style, revision, updated_by) SELECT $1, r, c, raw, st::jsonb, 1, $6 FROM unnest($2::bigint[], $3::bigint[], $4::text[], $5::text[]) AS t(r, c, raw, st)`,
						wid, cRows, cCols, cRaws, cStyles, c.UserID); e != nil {
						return e
					}
				}
			}
		}

		for newWID, pivots := range copiedPivots {
			remapped := remapSheetPivotSourceIDs(pivots, wsIDMap)
			pivotsJSON, e := json.Marshal(remapped)
			if e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `UPDATE sheet_worksheets SET pivot_tables=$2::jsonb WHERE id=$1`, newWID, string(pivotsJSON)); e != nil {
				return e
			}
		}

		if c.Guard != nil && !c.Guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	return meta, drivePGError(err)
}

func (p *Postgres) SearchSheetContent(ctx context.Context, userID, nodeID int64, foldedNeedle string) (bool, error) {
	meta, err := p.GetDoc(ctx, userID, nodeID)
	if err != nil || meta.Kind != "sheet" || RoleRank(meta.Role) < RoleRank(RoleView) {
		return false, nil
	}
	if foldedNeedle == "" {
		return true, nil
	}
	// Match inside PostgreSQL with an early exit instead of streaming every
	// cell to Go. lower() agrees with Unicode case folding for CJK and the
	// common Latin alphabets; rare full-folding cases (e.g. "ß" → "ss")
	// still match by title through the generic search path.
	var matched bool
	err = p.Pool.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM sheet_worksheets w WHERE w.node_id=$1 AND strpos(lower(w.title), $2) > 0
		) OR EXISTS (
			SELECT 1 FROM sheet_worksheets w JOIN sheet_cells c ON c.worksheet_id = w.id
			WHERE w.node_id=$1 AND c.raw <> '' AND strpos(lower(c.raw), $2) > 0
		)`, nodeID, foldedNeedle).Scan(&matched)
	return matched, err
}
