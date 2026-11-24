package store

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"slices"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

const baseMaxBatchRecords = 200

// BatchRestoreRecordInput describes one deleted record to re-create atomically.
type BatchRestoreRecordInput struct {
	TableID  int64                      `json:"tableId,omitempty"`
	Position float64                    `json:"position,omitempty"`
	Cells    map[string]json.RawMessage `json:"cells"`
}

// BatchCellUpdateInput describes one record cell update inside an atomic batch.
type BatchCellUpdateInput struct {
	RecordID int64                      `json:"id"`
	Cells    map[string]json.RawMessage `json:"cells"`
	Expected map[string]json.RawMessage `json:"expected,omitempty"`
}

// BaseBatchStore provides atomic transactional batch record delete, restore,
// and update with PG/Memory parity.
type BaseBatchStore interface {
	BatchDeleteRecordsGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, ids []int64) ([]Record, []int64, error)
	BatchRestoreRecordsGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, items []BatchRestoreRecordInput, validate func([]Field, map[string]json.RawMessage) error) ([]Record, []int64, error)
	BatchUpdateCellsGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, updates []BatchCellUpdateInput, validate func([]Field, map[string]json.RawMessage) error) ([]Record, []int64, error)
	RestoreFieldGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, input RestoreFieldInput, validateCell func(Field, json.RawMessage) error) (Field, int, error)
}

func dedupePositiveIDs(ids []int64, limit int) ([]int64, bool) {
	if len(ids) == 0 || len(ids) > limit {
		return nil, false
	}
	seen := make(map[int64]bool, len(ids))
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id <= 0 {
			return nil, false
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, len(out) > 0
}

func cloneRecordCells(cells map[string]json.RawMessage) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(cells))
	for k, v := range cells {
		if !nullCell(v) {
			out[k] = slices.Clone(v)
		}
	}
	return out
}

func (m *Memory) BatchDeleteRecordsGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, rawIDs []int64) ([]Record, []int64, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	ids, ok := dedupePositiveIDs(rawIDs, baseMaxBatchRecords)
	if !ok {
		return nil, nil, ErrInvalidBaseRecord
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expires, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return nil, nil, err
	}
	// Verify every requested record exists in baseID and check linked neighbors.
	targets := make([]Record, 0, len(ids))
	affectedSet := map[int64]bool{baseID: true}
	for _, rid := range ids {
		idx := m.recordIndexLocked(rid)
		if idx < 0 || m.b.records[idx].BaseID != baseID {
			return nil, nil, ErrNotFound
		}
		rec := m.b.records[idx]
		rec.Cells = cloneRecordCells(rec.Cells)
		targets = append(targets, rec)
		for _, neighbor := range m.recordNeighborsLocked(rid) {
			affectedSet[neighbor] = true
		}
	}
	affected := make([]int64, 0, len(affectedSet))
	for bid := range affectedSet {
		if bid != baseID {
			if _, exp2, err := m.checkBaseWriteLocked(guard, bid); err != nil {
				return nil, nil, err
			} else if exp2.Before(expires) {
				expires = exp2
			}
		}
		affected = append(affected, bid)
	}
	slices.Sort(affected)

	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, nil, err
	}

	idSet := make(map[int64]bool, len(ids))
	for _, id := range ids {
		idSet[id] = true
	}
	// Remove records in one pass and rebuild index cleanly.
	kept := make([]Record, 0, len(m.b.records)-len(ids))
	for _, rec := range m.b.records {
		if rec.BaseID == baseID && idSet[rec.ID] {
			continue
		}
		kept = append(kept, rec)
	}
	m.b.records = kept
	m.b.recordIndex = make(map[int64]int, len(kept))
	for i, rec := range kept {
		m.b.recordIndex[rec.ID] = i
	}
	// Clean up bt_links touching any deleted record.
	for k, list := range m.links {
		if idSet[k[1]] {
			delete(m.links, k)
			continue
		}
		filtered := slices.DeleteFunc(slices.Clone(list), func(v int64) bool { return idSet[v] })
		if len(filtered) != len(list) {
			if len(filtered) == 0 {
				delete(m.links, k)
			} else {
				m.links[k] = filtered
			}
		}
	}
	for _, bid := range affected {
		m.appendBtEventActorLocked(ctx, bid, []byte(`{"kind":"reload"}`))
	}
	return targets, affected, nil
}

func (m *Memory) BatchRestoreRecordsGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, items []BatchRestoreRecordInput, validate func([]Field, map[string]json.RawMessage) error) ([]Record, []int64, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if len(items) == 0 || len(items) > baseMaxBatchRecords || validate == nil {
		return nil, nil, ErrInvalidBaseRecord
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expires, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return nil, nil, err
	}
	fields := m.recordFieldsLocked(baseID)
	fieldsByTable := map[int64][]Field{}
	fieldIDSetByTable := map[int64]map[string]bool{}
	for _, f := range fields {
		fieldsByTable[f.TableID] = append(fieldsByTable[f.TableID], f)
		if fieldIDSetByTable[f.TableID] == nil {
			fieldIDSetByTable[f.TableID] = map[string]bool{}
		}
		fieldIDSetByTable[f.TableID][strconv.FormatInt(f.ID, 10)] = true
	}
	defaultTID := m.defaultTableIDLocked(baseID)
	validTables := map[int64]bool{}
	for _, tbl := range m.b.tables {
		if tbl.BaseID == baseID {
			validTables[tbl.ID] = true
		}
	}

	prepared := make([]struct {
		tableID  int64
		position float64
		cells    map[string]json.RawMessage
	}, 0, len(items))
	for _, it := range items {
		if math.IsNaN(it.Position) || math.IsInf(it.Position, 0) {
			return nil, nil, ErrInvalidBaseRecord
		}
		tid := it.TableID
		if tid == 0 {
			tid = defaultTID
		}
		if !validTables[tid] {
			return nil, nil, ErrNotFound
		}
		// Keep only cells for fields that still exist in this table (skip link/lookup/formula/created/updated).
		liveFields := fieldsByTable[tid]
		fieldByKey := map[string]Field{}
		for _, f := range liveFields {
			fieldByKey[strconv.FormatInt(f.ID, 10)] = f
		}
		clean := map[string]json.RawMessage{}
		for k, v := range it.Cells {
			f, ok := fieldByKey[k]
			if !ok || nullCell(v) || FieldReadOnly(f.Type) || f.Type == "link" || f.Type == "lookup" || f.Type == "formula" || f.Type == "created_time" || f.Type == "updated_time" {
				continue
			}
			clean[k] = slices.Clone(v)
		}
		if err := validate(liveFields, clean); err != nil {
			return nil, nil, err
		}
		prepared = append(prepared, struct {
			tableID  int64
			position float64
			cells    map[string]json.RawMessage
		}{tableID: tid, position: it.Position, cells: clean})
	}

	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, nil, err
	}

	now := time.Now()
	uid := guard.UserID
	out := make([]Record, 0, len(prepared))
	seedsByTable := map[int64]map[string]int64{}
	for _, p := range prepared {
		seeds, loaded := seedsByTable[p.tableID]
		if !loaded {
			seeds = m.autonumberSeedsLocked(baseID, p.tableID)
			seedsByTable[p.tableID] = seeds
		}
		applyAutonumbers(p.cells, seeds)
		pos := p.position
		if pos == 0 {
			maxPos := 0.0
			for _, rec := range m.b.records {
				if rec.TableID == p.tableID && rec.Position > maxPos {
					maxPos = rec.Position
				}
			}
			pos = maxPos + 1
		}
		rec := Record{
			ID:        m.id(),
			BaseID:    baseID,
			TableID:   p.tableID,
			Cells:     p.cells,
			Position:  pos,
			CreatorID: &uid,
			CreatedAt: &now,
			UpdatedAt: &now,
		}
		m.b.records = append(m.b.records, rec)
		if m.b.recordIndex == nil {
			m.b.recordIndex = map[int64]int{}
		}
		m.b.recordIndex[rec.ID] = len(m.b.records) - 1
		out = append(out, rec)
	}
	m.appendBtEventActorLocked(ctx, baseID, []byte(`{"kind":"reload"}`))
	return out, []int64{baseID}, nil
}

func (m *Memory) BatchUpdateCellsGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, updates []BatchCellUpdateInput, validate func([]Field, map[string]json.RawMessage) error) ([]Record, []int64, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if len(updates) == 0 || len(updates) > baseMaxBatchRecords || validate == nil {
		return nil, nil, ErrInvalidBaseRecord
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expires, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return nil, nil, err
	}
	fields := m.recordFieldsLocked(baseID)
	fieldsByTable := map[int64][]Field{}
	for _, f := range fields {
		fieldsByTable[f.TableID] = append(fieldsByTable[f.TableID], f)
	}

	// Phase 1: Validate every update and check every Expected condition BEFORE mutating any row.
	seenRec := make(map[int64]bool, len(updates))
	indices := make([]int, len(updates))
	nextCellsList := make([]map[string]json.RawMessage, len(updates))
	for i, upd := range updates {
		if upd.RecordID <= 0 || seenRec[upd.RecordID] || len(upd.Cells) == 0 {
			return nil, nil, ErrInvalidBaseRecord
		}
		seenRec[upd.RecordID] = true
		idx := m.recordIndexLocked(upd.RecordID)
		if idx < 0 || m.b.records[idx].BaseID != baseID {
			return nil, nil, ErrNotFound
		}
		cur := m.b.records[idx]
		mut := BaseRecordMutation{Operation: "update", RecordID: upd.RecordID, Cells: upd.Cells, Expected: upd.Expected}
		if err := validExpectation(mut); err != nil {
			return nil, nil, err
		}
		if err := validate(fieldsByTable[cur.TableID], upd.Cells); err != nil {
			return nil, nil, err
		}
		// Disallow link fields inside plain batch-update (those require multi-base link locking).
		for _, f := range fieldsByTable[cur.TableID] {
			if f.Type == "link" {
				if _, touched := upd.Cells[strconv.FormatInt(f.ID, 10)]; touched {
					return nil, nil, ErrInvalidBaseRecord
				}
			}
		}
		if upd.Expected != nil {
			if err := checkExpectedCells(cur.Cells, mut); err != nil {
				return nil, nil, err
			}
		}
		merged := cloneRecordCells(cur.Cells)
		for k, v := range upd.Cells {
			if nullCell(v) {
				delete(merged, k)
			} else {
				merged[k] = slices.Clone(v)
			}
		}
		indices[i] = idx
		nextCellsList[i] = merged
	}

	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, nil, err
	}

	// Phase 2: Commit all updates atomically in memory.
	now := time.Now()
	out := make([]Record, len(updates))
	for i, idx := range indices {
		m.b.records[idx].Cells = nextCellsList[i]
		tCopy := now
		m.b.records[idx].UpdatedAt = &tCopy
		rec := m.b.records[idx]
		rec.Cells = cloneRecordCells(rec.Cells)
		out[i] = rec
	}
	m.appendBtEventActorLocked(ctx, baseID, []byte(`{"kind":"reload"}`))
	return out, []int64{baseID}, nil
}

func (p *Postgres) BatchDeleteRecordsGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, rawIDs []int64) (deleted []Record, affected []int64, err error) {
	ids, ok := dedupePositiveIDs(rawIDs, baseMaxBatchRecords)
	if !ok {
		return nil, nil, ErrInvalidBaseRecord
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		// Discover any linked neighbor bases before locking in sorted order.
		baseSet := map[int64]bool{baseID: true}
		nRows, e := tx.Query(ctx, `
			SELECT DISTINCT r.base_id FROM bt_links l
			JOIN base_records r ON (r.id = l.to_record AND l.from_record = ANY($1)) OR (r.id = l.from_record AND l.to_record = ANY($1))
		`, ids)
		if e != nil {
			return e
		}
		for nRows.Next() {
			var bid int64
			if e = nRows.Scan(&bid); e != nil {
				nRows.Close()
				return e
			}
			if bid > 0 {
				baseSet[bid] = true
			}
		}
		if e = nRows.Err(); e != nil {
			nRows.Close()
			return e
		}
		nRows.Close()

		affected = make([]int64, 0, len(baseSet))
		for bid := range baseSet {
			affected = append(affected, bid)
		}
		slices.Sort(affected)

		expires, e := lockBaseWrites(ctx, tx, guard, affected)
		if e != nil {
			return e
		}

		// Lock and verify all requested rows exist in this Base.
		rows, e := tx.Query(ctx, `SELECT `+recordCols+` FROM base_records WHERE base_id=$1 AND id=ANY($2) FOR UPDATE`, baseID, ids)
		if e != nil {
			return e
		}
		byID := make(map[int64]Record, len(ids))
		for rows.Next() {
			rec, scanErr := scanRecord(rows)
			if scanErr != nil {
				rows.Close()
				return scanErr
			}
			byID[rec.ID] = rec
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			return e
		}
		rows.Close()
		if len(byID) != len(ids) {
			return ErrNotFound
		}

		if _, e = tx.Exec(ctx, `DELETE FROM base_records WHERE base_id=$1 AND id=ANY($2)`, baseID, ids); e != nil {
			return e
		}

		deleted = make([]Record, 0, len(ids))
		for _, id := range ids {
			deleted = append(deleted, byID[id])
		}
		for _, bid := range affected {
			if _, e = tx.Exec(ctx, `INSERT INTO bt_events(base_id, body, actor_id, actor_kind) VALUES ($1, '{"kind":"reload"}'::jsonb, $2, 'user')`, bid, guard.UserID); e != nil {
				return e
			}
		}
		return drivePGEnd(ctx, guard, expires)
	})
	if err != nil {
		if retryableRestoreConflict(err) {
			return nil, nil, ErrConflict
		}
		return nil, nil, drivePGError(err)
	}
	return deleted, affected, nil
}

func (p *Postgres) BatchRestoreRecordsGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, items []BatchRestoreRecordInput, validate func([]Field, map[string]json.RawMessage) error) (restored []Record, affected []int64, err error) {
	if len(items) == 0 || len(items) > baseMaxBatchRecords || validate == nil {
		return nil, nil, ErrInvalidBaseRecord
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := lockBaseWrite(ctx, tx, guard, baseID)
		if e != nil {
			return e
		}
		var defaultTID int64
		validTables := map[int64]bool{}
		tRows, e := tx.Query(ctx, `SELECT id, is_default FROM bt_tables WHERE base_id=$1`, baseID)
		if e != nil {
			return e
		}
		for tRows.Next() {
			var tid int64
			var isDef bool
			if e = tRows.Scan(&tid, &isDef); e != nil {
				tRows.Close()
				return e
			}
			validTables[tid] = true
			if isDef {
				defaultTID = tid
			}
		}
		if e = tRows.Err(); e != nil {
			tRows.Close()
			return e
		}
		tRows.Close()

		fieldsByTable := map[int64][]Field{}
		fRows, e := tx.Query(ctx, `SELECT `+fieldCols+` FROM base_fields WHERE base_id=$1 ORDER BY position, id`, baseID)
		if e != nil {
			return e
		}
		for fRows.Next() {
			f, scanErr := scanField(fRows)
			if scanErr != nil {
				fRows.Close()
				return scanErr
			}
			fieldsByTable[f.TableID] = append(fieldsByTable[f.TableID], f)
		}
		if e = fRows.Err(); e != nil {
			fRows.Close()
			return e
		}
		fRows.Close()

		restored = make([]Record, 0, len(items))
		seedsByTable := map[int64]map[string]int64{}
		for _, it := range items {
			if math.IsNaN(it.Position) || math.IsInf(it.Position, 0) {
				return ErrInvalidBaseRecord
			}
			tid := it.TableID
			if tid == 0 {
				tid = defaultTID
			}
			if !validTables[tid] {
				return ErrNotFound
			}
			liveFields := fieldsByTable[tid]
			fieldByKey := map[string]Field{}
			for _, f := range liveFields {
				fieldByKey[strconv.FormatInt(f.ID, 10)] = f
			}
			clean := map[string]json.RawMessage{}
			for k, v := range it.Cells {
				f, ok := fieldByKey[k]
				if !ok || nullCell(v) || FieldReadOnly(f.Type) || f.Type == "link" || f.Type == "lookup" || f.Type == "formula" || f.Type == "created_time" || f.Type == "updated_time" {
					continue
				}
				if len(bytes.TrimSpace(v)) == 0 || !json.Valid(v) {
					return ErrInvalidBaseRecord
				}
				clean[k] = slices.Clone(v)
			}
			if e = validate(liveFields, clean); e != nil {
				return e
			}
			seeds, loaded := seedsByTable[tid]
			if !loaded {
				seeds, e = pgAutonumberSeeds(ctx, tx, baseID, tid)
				if e != nil {
					return e
				}
				seedsByTable[tid] = seeds
			}
			applyAutonumbers(clean, seeds)
			rec, e := scanRecord(tx.QueryRow(ctx, `
				INSERT INTO base_records (base_id, table_id, cells, position, creator_id)
				VALUES ($1, $2, $3, CASE WHEN $4::float8=0 THEN COALESCE((SELECT max(position) FROM base_records WHERE table_id=$2),0)+1 ELSE $4 END, $5)
				RETURNING `+recordCols, baseID, tid, clean, it.Position, guard.UserID))
			if e != nil {
				return e
			}
			restored = append(restored, rec)
		}

		if _, e = tx.Exec(ctx, `INSERT INTO bt_events(base_id, body, actor_id, actor_kind) VALUES ($1, '{"kind":"reload"}'::jsonb, $2, 'user')`, baseID, guard.UserID); e != nil {
			return e
		}
		affected = []int64{baseID}
		return drivePGEnd(ctx, guard, expires)
	})
	if err != nil {
		if retryableRestoreConflict(err) {
			return nil, nil, ErrConflict
		}
		return nil, nil, drivePGError(err)
	}
	return restored, affected, nil
}

func (p *Postgres) BatchUpdateCellsGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, updates []BatchCellUpdateInput, validate func([]Field, map[string]json.RawMessage) error) (updated []Record, affected []int64, err error) {
	if len(updates) == 0 || len(updates) > baseMaxBatchRecords || validate == nil {
		return nil, nil, ErrInvalidBaseRecord
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := lockBaseWrite(ctx, tx, guard, baseID)
		if e != nil {
			return e
		}
		fieldsByTable := map[int64][]Field{}
		fRows, e := tx.Query(ctx, `SELECT `+fieldCols+` FROM base_fields WHERE base_id=$1 ORDER BY position, id`, baseID)
		if e != nil {
			return e
		}
		for fRows.Next() {
			f, scanErr := scanField(fRows)
			if scanErr != nil {
				fRows.Close()
				return scanErr
			}
			fieldsByTable[f.TableID] = append(fieldsByTable[f.TableID], f)
		}
		if e = fRows.Err(); e != nil {
			fRows.Close()
			return e
		}
		fRows.Close()

		ids := make([]int64, 0, len(updates))
		seen := map[int64]bool{}
		for _, upd := range updates {
			if upd.RecordID <= 0 || seen[upd.RecordID] || len(upd.Cells) == 0 {
				return ErrInvalidBaseRecord
			}
			seen[upd.RecordID] = true
			ids = append(ids, upd.RecordID)
		}
		rRows, e := tx.Query(ctx, `SELECT `+recordCols+` FROM base_records WHERE base_id=$1 AND id=ANY($2) FOR UPDATE`, baseID, ids)
		if e != nil {
			return e
		}
		byID := make(map[int64]Record, len(ids))
		for rRows.Next() {
			rec, scanErr := scanRecord(rRows)
			if scanErr != nil {
				rRows.Close()
				return scanErr
			}
			byID[rec.ID] = rec
		}
		if e = rRows.Err(); e != nil {
			rRows.Close()
			return e
		}
		rRows.Close()
		if len(byID) != len(ids) {
			return ErrNotFound
		}

		updated = make([]Record, 0, len(updates))
		for _, upd := range updates {
			cur := byID[upd.RecordID]
			mut := BaseRecordMutation{Operation: "update", RecordID: upd.RecordID, Cells: upd.Cells, Expected: upd.Expected}
			if e = validExpectation(mut); e != nil {
				return e
			}
			if e = validate(fieldsByTable[cur.TableID], upd.Cells); e != nil {
				return e
			}
			for _, f := range fieldsByTable[cur.TableID] {
				if f.Type == "link" {
					if _, touched := upd.Cells[strconv.FormatInt(f.ID, 10)]; touched {
						return ErrInvalidBaseRecord
					}
				}
			}
			if upd.Expected != nil {
				if e = checkExpectedCells(cur.Cells, mut); e != nil {
					return e
				}
			}
			merged := cloneRecordCells(cur.Cells)
			for k, v := range upd.Cells {
				if nullCell(v) {
					delete(merged, k)
				} else {
					merged[k] = slices.Clone(v)
				}
			}
			rec, e := scanRecord(tx.QueryRow(ctx, `UPDATE base_records SET cells=$3, updated_at=now() WHERE base_id=$1 AND id=$2 RETURNING `+recordCols, baseID, upd.RecordID, merged))
			if e != nil {
				return e
			}
			updated = append(updated, rec)
		}
		if _, e = tx.Exec(ctx, `INSERT INTO bt_events(base_id, body, actor_id, actor_kind) VALUES ($1, '{"kind":"reload"}'::jsonb, $2, 'user')`, baseID, guard.UserID); e != nil {
			return e
		}
		affected = []int64{baseID}
		return drivePGEnd(ctx, guard, expires)
	})
	if err != nil {
		if retryableRestoreConflict(err) {
			return nil, nil, ErrConflict
		}
		return nil, nil, drivePGError(err)
	}
	return updated, affected, nil
}
