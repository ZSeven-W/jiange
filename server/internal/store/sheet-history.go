package store

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const (
	sheetMaxVersionLabelRunes  = 120
	sheetHistoryMaxLimit       = 100
	sheetPreRestoreBackupLabel = "恢复前自动备份"
	sheetDefaultAutoLabel      = "自动备份"
	sheetDefaultManualLabel    = "未命名版本"
)

// SheetWorkbookSnapshot aliases SheetSnapshot so callers using either name share the exact type.
type SheetWorkbookSnapshot = SheetSnapshot

// SheetVersionMeta describes a persisted workbook snapshot in sheet_versions.
type SheetVersionMeta struct {
	ID             int64     `json:"id"`
	SheetID        int64     `json:"sheetId"`
	Label          string    `json:"label"`
	AutoSaved      bool      `json:"autoSaved"`
	CreatedBy      int64     `json:"createdBy"`
	ActorName      string    `json:"actorName"`
	CreatedAt      time.Time `json:"createdAt"`
	WorksheetCount int       `json:"worksheetCount"`
	CellCount      int       `json:"cellCount"`
}

// SheetCellHistoryEntry records a single before/after value or formula change on a cell.
type SheetCellHistoryEntry struct {
	ID          int64     `json:"id"`
	SheetID     int64     `json:"sheetId"`
	WorksheetID int64     `json:"worksheetId"`
	Row         int       `json:"row"`
	Col         int       `json:"col"`
	PrevValue   string    `json:"prevValue"`
	NextValue   string    `json:"nextValue"`
	PrevFormula string    `json:"prevFormula"`
	NextFormula string    `json:"nextFormula"`
	ActorID     int64     `json:"actorId"`
	ActorName   string    `json:"actorName"`
	CreatedAt   time.Time `json:"createdAt"`
}

// SheetHistoryStore manages spreadsheet version snapshots and per-cell edit audit history.
type SheetHistoryStore interface {
	ListSheetVersions(ctx context.Context, guard RestoreGuard, sheetID int64) ([]SheetVersionMeta, error)
	CreateSheetVersionGuarded(ctx context.Context, guard RestoreGuard, sheetID int64, label string, autoSaved bool) (SheetVersionMeta, error)
	RestoreSheetVersionGuarded(ctx context.Context, guard RestoreGuard, sheetID, versionID int64) (SheetWorkbookSnapshot, error)
	RecordSheetCellHistory(ctx context.Context, entries []SheetCellHistoryEntry) error
	ListSheetCellHistory(ctx context.Context, guard RestoreGuard, sheetID, worksheetID int64, row, col, limit int) ([]SheetCellHistoryEntry, error)
}

var (
	_ SheetHistoryStore = (*Memory)(nil)
	_ SheetHistoryStore = (*Postgres)(nil)
)

type memSheetVersion struct {
	meta     SheetVersionMeta
	snapshot []byte
}

// memSheetHistory holds in-memory sheet versions and cell edit history for Memory store.
type memSheetHistory struct {
	nextVersionID int64
	nextCellID    int64
	versions      map[int64][]memSheetVersion
	cellHistory   map[int64][]SheetCellHistoryEntry
}

func normalizeSheetVersionLabel(raw string, autoSaved bool) (string, bool) {
	label := strings.TrimSpace(raw)
	if !utf8.ValidString(label) || strings.ContainsRune(label, '\x00') {
		return "", false
	}
	if utf8.RuneCountInString(label) > sheetMaxVersionLabelRunes {
		return "", false
	}
	if label == "" {
		if autoSaved {
			return sheetDefaultAutoLabel, true
		}
		return sheetDefaultManualLabel, true
	}
	return label, true
}

func countSheetSnapshotStats(snap SheetWorkbookSnapshot) (int, int) {
	wsCount := len(snap.Sheets)
	cellCount := 0
	for _, ws := range snap.Sheets {
		for _, c := range ws.Cells {
			if c.Raw != "" {
				cellCount++
			}
		}
	}
	return wsCount, cellCount
}

func clampSheetHistoryLimit(limit int) int {
	if limit <= 0 || limit > sheetHistoryMaxLimit {
		return sheetHistoryMaxLimit
	}
	return limit
}

func filterSheetCellHistoryEntries(entries []SheetCellHistoryEntry, fallbackNow time.Time) []SheetCellHistoryEntry {
	if len(entries) == 0 {
		return nil
	}
	out := make([]SheetCellHistoryEntry, 0, len(entries))
	for _, e := range entries {
		if !validSheetID(e.SheetID) || !validSheetID(e.WorksheetID) || e.Row < 0 || e.Col < 0 {
			continue
		}
		if e.PrevValue == e.NextValue && e.PrevFormula == e.NextFormula {
			continue
		}
		if !utf8.ValidString(e.PrevValue) || !utf8.ValidString(e.NextValue) || !utf8.ValidString(e.PrevFormula) || !utf8.ValidString(e.NextFormula) {
			continue
		}
		if e.CreatedAt.IsZero() {
			e.CreatedAt = fallbackNow
		}
		out = append(out, e)
	}
	return out
}

func (m *Memory) ensureSheetHistoryMapsLocked() {
	if m.sheetHistory.versions == nil {
		m.sheetHistory.versions = map[int64][]memSheetVersion{}
	}
	if m.sheetHistory.cellHistory == nil {
		m.sheetHistory.cellHistory = map[int64][]SheetCellHistoryEntry{}
	}
}

func (m *Memory) actorNameLocked(userID int64) string {
	if u := m.userByID(userID); u != nil {
		return u.Name
	}
	return ""
}

func (m *Memory) ListSheetVersions(ctx context.Context, guard RestoreGuard, sheetID int64) ([]SheetVersionMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, _, _, expires, err := m.authorizeSheetLocked(ctx, guard, sheetID, RoleView); err != nil {
		return nil, err
	} else if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, err
	}
	list := m.sheetHistory.versions[sheetID]
	if len(list) == 0 {
		return []SheetVersionMeta{}, nil
	}
	ordered := make([]SheetVersionMeta, len(list))
	for i, item := range list {
		ordered[i] = item.meta
	}
	sort.Slice(ordered, func(i, j int) bool {
		if !ordered[i].CreatedAt.Equal(ordered[j].CreatedAt) {
			return ordered[i].CreatedAt.After(ordered[j].CreatedAt)
		}
		return ordered[i].ID > ordered[j].ID
	})
	if len(ordered) > sheetHistoryMaxLimit {
		ordered = ordered[:sheetHistoryMaxLimit]
	}
	return ordered, nil
}

func (m *Memory) CreateSheetVersionGuarded(ctx context.Context, guard RestoreGuard, sheetID int64, label string, autoSaved bool) (SheetVersionMeta, error) {
	cleanLabel, ok := normalizeSheetVersionLabel(label, autoSaved)
	if !ok {
		return SheetVersionMeta{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d, wb, role, expires, err := m.authorizeSheetLocked(ctx, guard, sheetID, RoleEdit)
	if err != nil {
		return SheetVersionMeta{}, err
	}
	snap := m.sheetSnapshotLocked(d, wb, role)
	rawSnap, err := json.Marshal(snap)
	if err != nil {
		return SheetVersionMeta{}, err
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return SheetVersionMeta{}, err
	}
	m.ensureSheetHistoryMapsLocked()
	m.sheetHistory.nextVersionID++
	wsCount, cellCount := countSheetSnapshotStats(snap)
	meta := SheetVersionMeta{
		ID:             m.sheetHistory.nextVersionID,
		SheetID:        sheetID,
		Label:          cleanLabel,
		AutoSaved:      autoSaved,
		CreatedBy:      guard.UserID,
		ActorName:      m.actorNameLocked(guard.UserID),
		CreatedAt:      guard.currentTime().UTC(),
		WorksheetCount: wsCount,
		CellCount:      cellCount,
	}
	m.sheetHistory.versions[sheetID] = append(m.sheetHistory.versions[sheetID], memSheetVersion{
		meta:     meta,
		snapshot: rawSnap,
	})
	return meta, nil
}

func (m *Memory) RestoreSheetVersionGuarded(ctx context.Context, guard RestoreGuard, sheetID, versionID int64) (SheetWorkbookSnapshot, error) {
	if !validSheetID(versionID) {
		return SheetWorkbookSnapshot{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d, wb, role, expires, err := m.authorizeSheetLocked(ctx, guard, sheetID, RoleEdit)
	if err != nil {
		return SheetWorkbookSnapshot{}, err
	}
	if wb.revision >= sheetMaxRevision {
		return SheetWorkbookSnapshot{}, ErrConflict
	}
	var targetRaw []byte
	for _, v := range m.sheetHistory.versions[sheetID] {
		if v.meta.ID == versionID {
			targetRaw = v.snapshot
			break
		}
	}
	if len(targetRaw) == 0 {
		return SheetWorkbookSnapshot{}, ErrNotFound
	}
	var targetSnap SheetWorkbookSnapshot
	if err := json.Unmarshal(targetRaw, &targetSnap); err != nil || len(targetSnap.Sheets) == 0 {
		return SheetWorkbookSnapshot{}, ErrConflict
	}
	for _, ws := range targetSnap.Sheets {
		if len(ws.Rows) == 0 || len(ws.Columns) == 0 {
			return SheetWorkbookSnapshot{}, ErrConflict
		}
	}
	currentSnap := m.sheetSnapshotLocked(d, wb, role)
	backupRaw, err := json.Marshal(currentSnap)
	if err != nil {
		return SheetWorkbookSnapshot{}, err
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return SheetWorkbookSnapshot{}, err
	}

	// Save automatic pre-restore backup before mutating the live workbook.
	m.ensureSheetHistoryMapsLocked()
	m.sheetHistory.nextVersionID++
	bWsCount, bCellCount := countSheetSnapshotStats(currentSnap)
	backupMeta := SheetVersionMeta{
		ID:             m.sheetHistory.nextVersionID,
		SheetID:        sheetID,
		Label:          sheetPreRestoreBackupLabel,
		AutoSaved:      true,
		CreatedBy:      guard.UserID,
		ActorName:      m.actorNameLocked(guard.UserID),
		CreatedAt:      guard.currentTime().UTC(),
		WorksheetCount: bWsCount,
		CellCount:      bCellCount,
	}
	m.sheetHistory.versions[sheetID] = append(m.sheetHistory.versions[sheetID], memSheetVersion{
		meta:     backupMeta,
		snapshot: backupRaw,
	})

	// Replace worksheets, axes, cells, styles, merges, rules, charts, and pivots cleanly.
	srcSheets := slices.Clone(targetSnap.Sheets)
	sort.Slice(srcSheets, func(i, j int) bool {
		if srcSheets[i].Pos != srcSheets[j].Pos {
			return srcSheets[i].Pos < srcSheets[j].Pos
		}
		return srcSheets[i].ID < srcSheets[j].ID
	})

	wb.order = make([]int64, 0, len(srcSheets))
	wb.sheets = make(map[int64]*memWorksheet, len(srcSheets))
	m.sheetComments = slices.DeleteFunc(m.sheetComments, func(c SheetComment) bool {
		return c.NodeID == sheetID
	})

	wsIDMap := make(map[int64]int64, len(srcSheets))
	for pos, src := range srcSheets {
		title := src.Title
		if clean, ok := cleanWorksheetTitle(title); ok {
			title = clean
		} else {
			title = "Sheet1"
		}
		dstWS := m.createMemWorksheetLocked(sheetID, title, pos, len(src.Rows), len(src.Columns))
		wsIDMap[src.ID] = dstWS.id

		rowMap := make(map[int64]int64, len(src.Rows))
		colMap := make(map[int64]int64, len(src.Columns))
		for i, r := range src.Rows {
			dstWS.rows[i].Size = r.Size
			rowMap[r.ID] = dstWS.rows[i].ID
		}
		for i, col := range src.Columns {
			dstWS.columns[i].Size = col.Size
			colMap[col.ID] = dstWS.columns[i].ID
		}
		dstWS.frozenRows = max(0, min(src.FrozenRows, min(sheetMaxFrozenRows, len(dstWS.rows)-1)))
		dstWS.frozenCols = max(0, min(src.FrozenCols, min(sheetMaxFrozenCols, len(dstWS.columns)-1)))
		dstWS.merges = slices.Clone(src.Merges)
		if dstWS.merges == nil {
			dstWS.merges = []SheetMerge{}
		}
		dstWS.filter = cloneSheetFilter(src.Filter)
		dstWS.validations = cloneSheetValidations(src.Validations)
		dstWS.conditionalFormats = cloneSheetCondFormats(src.ConditionalFormats)
		dstWS.protectedRanges = cloneSheetProtectedRanges(src.ProtectedRanges)
		dstWS.charts = cloneSheetCharts(src.Charts)
		dstWS.pivotTables = cloneSheetPivotTables(src.PivotTables)

		for _, cell := range src.Cells {
			if cell.Raw == "" && cell.Style == (SheetCellStyle{}) {
				continue
			}
			nr, okR := rowMap[cell.RowID]
			nc, okC := colMap[cell.ColumnID]
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
		wb.sheets[dstWS.id] = dstWS
		wb.order = append(wb.order, dstWS.id)
	}
	for _, dstWS := range wb.sheets {
		dstWS.pivotTables = remapSheetPivotSourceIDs(dstWS.pivotTables, wsIDMap)
	}

	wb.revision++
	d.meta.UpdatedAt = time.Now()
	m.setDocumentModifierLocked(d, guard.UserID)
	return m.sheetSnapshotLocked(d, wb, role), nil
}

func (m *Memory) RecordSheetCellHistory(ctx context.Context, entries []SheetCellHistoryEntry) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	filtered := filterSheetCellHistoryEntries(entries, time.Now().UTC())
	if len(filtered) == 0 {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	m.ensureSheetHistoryMapsLocked()
	for _, e := range filtered {
		m.sheetHistory.nextCellID++
		e.ID = m.sheetHistory.nextCellID
		if e.ActorName == "" && e.ActorID > 0 {
			e.ActorName = m.actorNameLocked(e.ActorID)
		}
		m.sheetHistory.cellHistory[e.SheetID] = append(m.sheetHistory.cellHistory[e.SheetID], e)
	}
	return nil
}

func (m *Memory) ListSheetCellHistory(ctx context.Context, guard RestoreGuard, sheetID, worksheetID int64, row, col, limit int) ([]SheetCellHistoryEntry, error) {
	if !validSheetID(worksheetID) || row < 0 || col < 0 {
		return nil, ErrConflict
	}
	maxItems := clampSheetHistoryLimit(limit)
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, _, _, expires, err := m.authorizeSheetLocked(ctx, guard, sheetID, RoleView); err != nil {
		return nil, err
	} else if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, err
	}
	all := m.sheetHistory.cellHistory[sheetID]
	out := make([]SheetCellHistoryEntry, 0)
	for _, e := range all {
		if e.WorksheetID == worksheetID && e.Row == row && e.Col == col {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID > out[j].ID
	})
	if len(out) > maxItems {
		out = out[:maxItems]
	}
	return out, nil
}

// --- PostgreSQL implementation ---

func (p *Postgres) ListSheetVersions(ctx context.Context, guard RestoreGuard, sheetID int64) (out []SheetVersionMeta, err error) {
	out = []SheetVersionMeta{}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := lockSheetPG(ctx, tx, guard, sheetID, RoleView, false)
		if e != nil {
			return e
		}
		rows, e := tx.Query(ctx, `
			SELECT v.id, v.sheet_id, v.label, v.auto_saved,
			       COALESCE(v.created_by, 0), v.actor_name, v.created_at,
			       COALESCE(jsonb_array_length(v.snapshot->'sheets'), 0) AS ws_count,
			       COALESCE((
			           SELECT SUM((
			               SELECT COUNT(*)
			               FROM jsonb_array_elements(COALESCE(ws->'cells', '[]'::jsonb)) AS c
			               WHERE COALESCE(c->>'raw', '') <> ''
			           ))
			           FROM jsonb_array_elements(COALESCE(v.snapshot->'sheets', '[]'::jsonb)) AS ws
			       ), 0)::int AS cell_count
			FROM sheet_versions v
			WHERE v.sheet_id = $1
			ORDER BY v.created_at DESC, v.id DESC
			LIMIT $2`, sheetID, sheetHistoryMaxLimit)
		if e != nil {
			return e
		}
		list := []SheetVersionMeta{}
		for rows.Next() {
			var m SheetVersionMeta
			if e = rows.Scan(&m.ID, &m.SheetID, &m.Label, &m.AutoSaved, &m.CreatedBy, &m.ActorName, &m.CreatedAt, &m.WorksheetCount, &m.CellCount); e != nil {
				rows.Close()
				return e
			}
			list = append(list, m)
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			return e
		}
		rows.Close()
		out = list
		return drivePGEnd(ctx, guard, expires)
	})
	return out, drivePGError(err)
}

func pgActorName(ctx context.Context, tx pgx.Tx, userID int64) (string, error) {
	if userID <= 0 {
		return "", nil
	}
	var name string
	err := tx.QueryRow(ctx, `SELECT COALESCE(name, '') FROM users WHERE id=$1`, userID).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return name, err
}

func insertSheetVersionPG(ctx context.Context, tx pgx.Tx, sheetID, userID int64, actorName, label string, autoSaved bool, snap SheetWorkbookSnapshot) (SheetVersionMeta, error) {
	rawSnap, err := json.Marshal(snap)
	if err != nil {
		return SheetVersionMeta{}, err
	}
	var createdBy *int64
	if userID > 0 {
		uid := userID
		createdBy = &uid
	}
	wsCount, cellCount := countSheetSnapshotStats(snap)
	meta := SheetVersionMeta{
		SheetID:        sheetID,
		Label:          label,
		AutoSaved:      autoSaved,
		CreatedBy:      userID,
		ActorName:      actorName,
		WorksheetCount: wsCount,
		CellCount:      cellCount,
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO sheet_versions (sheet_id, label, auto_saved, snapshot, created_by, actor_name)
		VALUES ($1, $2, $3, $4::jsonb, $5, $6)
		RETURNING id, created_at`,
		sheetID, label, autoSaved, string(rawSnap), createdBy, actorName,
	).Scan(&meta.ID, &meta.CreatedAt)
	if err != nil {
		return SheetVersionMeta{}, err
	}
	return meta, nil
}

func (p *Postgres) CreateSheetVersionGuarded(ctx context.Context, guard RestoreGuard, sheetID int64, label string, autoSaved bool) (out SheetVersionMeta, err error) {
	cleanLabel, ok := normalizeSheetVersionLabel(label, autoSaved)
	if !ok {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		info, expires, e := lockSheetPG(ctx, tx, guard, sheetID, RoleEdit, false)
		if e != nil {
			return e
		}
		snap, e := loadSheetSnapshotPG(ctx, tx, info)
		if e != nil {
			return e
		}
		actorName, e := pgActorName(ctx, tx, guard.UserID)
		if e != nil {
			return e
		}
		if e = drivePGEnd(ctx, guard, expires); e != nil {
			return e
		}
		out, e = insertSheetVersionPG(ctx, tx, sheetID, guard.UserID, actorName, cleanLabel, autoSaved, snap)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, drivePGError(err)
}

func (p *Postgres) RestoreSheetVersionGuarded(ctx context.Context, guard RestoreGuard, sheetID, versionID int64) (snap SheetWorkbookSnapshot, err error) {
	if !validSheetID(versionID) {
		return snap, ErrNotFound
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		info, expires, e := lockSheetPG(ctx, tx, guard, sheetID, RoleEdit, true)
		if e != nil {
			return e
		}
		if info.workbookRevision >= sheetMaxRevision {
			return ErrConflict
		}
		var rawTarget []byte
		e = tx.QueryRow(ctx, `SELECT snapshot FROM sheet_versions WHERE id=$1 AND sheet_id=$2`, versionID, sheetID).Scan(&rawTarget)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		var targetSnap SheetWorkbookSnapshot
		if e = json.Unmarshal(rawTarget, &targetSnap); e != nil || len(targetSnap.Sheets) == 0 {
			return ErrConflict
		}
		for _, ws := range targetSnap.Sheets {
			if len(ws.Rows) == 0 || len(ws.Columns) == 0 {
				return ErrConflict
			}
		}

		currentSnap, e := loadSheetSnapshotPG(ctx, tx, info)
		if e != nil {
			return e
		}
		actorName, e := pgActorName(ctx, tx, guard.UserID)
		if e != nil {
			return e
		}
		if e = drivePGEnd(ctx, guard, expires); e != nil {
			return e
		}

		// Automatic pre-restore backup inside the same transaction.
		if _, e = insertSheetVersionPG(ctx, tx, sheetID, guard.UserID, actorName, sheetPreRestoreBackupLabel, true, currentSnap); e != nil {
			return e
		}

		if _, e = tx.Exec(ctx, `DELETE FROM sheet_worksheets WHERE node_id=$1`, sheetID); e != nil {
			return e
		}

		srcSheets := slices.Clone(targetSnap.Sheets)
		sort.Slice(srcSheets, func(i, j int) bool {
			if srcSheets[i].Pos != srcSheets[j].Pos {
				return srcSheets[i].Pos < srcSheets[j].Pos
			}
			return srcSheets[i].ID < srcSheets[j].ID
		})

		wsIDMap := make(map[int64]int64, len(srcSheets))
		copiedPivots := make(map[int64][]SheetPivotTable, len(srcSheets))
		for pos, src := range srcSheets {
			title := src.Title
			if clean, ok := cleanWorksheetTitle(title); ok {
				title = clean
			} else {
				title = "Sheet1"
			}
			frozenRows := max(0, min(src.FrozenRows, min(sheetMaxFrozenRows, len(src.Rows)-1)))
			frozenCols := max(0, min(src.FrozenCols, min(sheetMaxFrozenCols, len(src.Columns)-1)))

			merges := src.Merges
			if merges == nil {
				merges = []SheetMerge{}
			}
			mergesJSON, e := json.Marshal(merges)
			if e != nil {
				return e
			}
			filterJSON, e := json.Marshal(src.Filter)
			if e != nil {
				return e
			}
			validationsJSON, e := json.Marshal(cloneSheetValidations(src.Validations))
			if e != nil {
				return e
			}
			condFormatsJSON, e := json.Marshal(cloneSheetCondFormats(src.ConditionalFormats))
			if e != nil {
				return e
			}
			protectedJSON, e := json.Marshal(cloneSheetProtectedRanges(src.ProtectedRanges))
			if e != nil {
				return e
			}
			chartsJSON, e := json.Marshal(cloneSheetCharts(src.Charts))
			if e != nil {
				return e
			}

			var wid int64
			if e = tx.QueryRow(ctx, `
				INSERT INTO sheet_worksheets (
					node_id, title, pos, frozen_rows, frozen_cols,
					merges, filter_config, validations, conditional_formats,
					protected_ranges, charts, pivot_tables, revision
				)
				VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,'[]'::jsonb,1)
				RETURNING id`,
				sheetID, title, pos, frozenRows, frozenCols,
				string(mergesJSON), string(filterJSON), string(validationsJSON),
				string(condFormatsJSON), string(protectedJSON), string(chartsJSON),
			).Scan(&wid); e != nil {
				return e
			}
			wsIDMap[src.ID] = wid
			if len(src.PivotTables) > 0 {
				copiedPivots[wid] = src.PivotTables
			}

			rPos := make([]int, len(src.Rows))
			rSize := make([]int, len(src.Rows))
			for i, r := range src.Rows {
				rPos[i] = i
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
				cPos[i] = i
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
					if _, e = tx.Exec(ctx, `
						INSERT INTO sheet_cells (worksheet_id, row_id, column_id, raw, style, revision, updated_by)
						SELECT $1, r, c, raw, st::jsonb, 1, $6
						FROM unnest($2::bigint[], $3::bigint[], $4::text[], $5::text[]) AS t(r, c, raw, st)`,
						wid, cRows, cCols, cRaws, cStyles, guard.UserID); e != nil {
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

		nextWBRev, e := touchSheetWorkbookPG(ctx, tx, sheetID, guard.UserID)
		if e != nil {
			return e
		}
		info.workbookRevision = nextWBRev
		info.updatedAt = time.Now()
		snap, e = loadSheetSnapshotPG(ctx, tx, info)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return snap, drivePGError(err)
}

func (p *Postgres) RecordSheetCellHistory(ctx context.Context, entries []SheetCellHistoryEntry) error {
	filtered := filterSheetCellHistoryEntries(entries, time.Now().UTC())
	if len(filtered) == 0 {
		return nil
	}
	return pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		sheetIDs := make([]int64, len(filtered))
		wsIDs := make([]int64, len(filtered))
		rows := make([]int, len(filtered))
		cols := make([]int, len(filtered))
		prevVals := make([]string, len(filtered))
		nextVals := make([]string, len(filtered))
		prevForms := make([]string, len(filtered))
		nextForms := make([]string, len(filtered))
		actorIDs := make([]*int64, len(filtered))
		actorNames := make([]string, len(filtered))
		createdAts := make([]time.Time, len(filtered))

		nameCache := map[int64]string{}
		for i, e := range filtered {
			sheetIDs[i] = e.SheetID
			wsIDs[i] = e.WorksheetID
			rows[i] = e.Row
			cols[i] = e.Col
			prevVals[i] = e.PrevValue
			nextVals[i] = e.NextValue
			prevForms[i] = e.PrevFormula
			nextForms[i] = e.NextFormula
			name := e.ActorName
			if e.ActorID > 0 {
				uid := e.ActorID
				actorIDs[i] = &uid
				if name == "" {
					if cached, ok := nameCache[uid]; ok {
						name = cached
					} else {
						resolved, err := pgActorName(ctx, tx, uid)
						if err != nil {
							return err
						}
						nameCache[uid] = resolved
						name = resolved
					}
				}
			}
			actorNames[i] = name
			createdAts[i] = e.CreatedAt.UTC()
		}

		_, err := tx.Exec(ctx, `
			INSERT INTO sheet_cell_history (
				sheet_id, worksheet_id, row_idx, col_idx,
				prev_value, next_value, prev_formula, next_formula,
				actor_id, actor_name, created_at
			)
			SELECT s, w, r, c, pv, nv, pf, nf, aid, aname, ts
			FROM unnest(
				$1::bigint[], $2::bigint[], $3::int[], $4::int[],
				$5::text[], $6::text[], $7::text[], $8::text[],
				$9::bigint[], $10::text[], $11::timestamptz[]
			) AS t(s, w, r, c, pv, nv, pf, nf, aid, aname, ts)`,
			sheetIDs, wsIDs, rows, cols,
			prevVals, nextVals, prevForms, nextForms,
			actorIDs, actorNames, createdAts,
		)
		return err
	})
}

func (p *Postgres) ListSheetCellHistory(ctx context.Context, guard RestoreGuard, sheetID, worksheetID int64, row, col, limit int) (out []SheetCellHistoryEntry, err error) {
	if !validSheetID(worksheetID) || row < 0 || col < 0 {
		return nil, ErrConflict
	}
	maxItems := clampSheetHistoryLimit(limit)
	out = []SheetCellHistoryEntry{}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := lockSheetPG(ctx, tx, guard, sheetID, RoleView, false)
		if e != nil {
			return e
		}
		rows, e := tx.Query(ctx, `
			SELECT id, sheet_id, worksheet_id, row_idx, col_idx,
			       prev_value, next_value, prev_formula, next_formula,
			       COALESCE(actor_id, 0), actor_name, created_at
			FROM sheet_cell_history
			WHERE sheet_id=$1 AND worksheet_id=$2 AND row_idx=$3 AND col_idx=$4
			ORDER BY created_at DESC, id DESC
			LIMIT $5`, sheetID, worksheetID, row, col, maxItems)
		if e != nil {
			return e
		}
		list := []SheetCellHistoryEntry{}
		for rows.Next() {
			var item SheetCellHistoryEntry
			if e = rows.Scan(
				&item.ID, &item.SheetID, &item.WorksheetID, &item.Row, &item.Col,
				&item.PrevValue, &item.NextValue, &item.PrevFormula, &item.NextFormula,
				&item.ActorID, &item.ActorName, &item.CreatedAt,
			); e != nil {
				rows.Close()
				return e
			}
			list = append(list, item)
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			return e
		}
		rows.Close()
		out = list
		return drivePGEnd(ctx, guard, expires)
	})
	return out, drivePGError(err)
}
