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

func validBaseTableName(name string) (string, bool) {
	n := strings.TrimSpace(name)
	if n == "" || !utf8.ValidString(n) || utf8.RuneCountInString(n) > 100 {
		return "", false
	}
	return n, true
}

func (m *Memory) ensureDefaultTableLocked(baseID int64) BaseTable {
	for _, tbl := range m.b.tables {
		if tbl.BaseID == baseID && tbl.IsDefault {
			return tbl
		}
	}
	tbl := BaseTable{ID: m.id(), BaseID: baseID, Name: "数据表", Position: 1, IsDefault: true}
	m.b.tables = append(m.b.tables, tbl)
	return tbl
}

func (m *Memory) defaultTableIDLocked(baseID int64) int64 {
	return m.ensureDefaultTableLocked(baseID).ID
}

func (m *Memory) tableBelongsToBaseLocked(baseID, tableID int64) bool {
	if tableID <= 0 {
		return false
	}
	for _, tbl := range m.b.tables {
		if tbl.ID == tableID && tbl.BaseID == baseID {
			return true
		}
	}
	return false
}

func (m *Memory) resolveTableIDLocked(baseID, tableID int64) (int64, error) {
	if tableID <= 0 {
		return m.defaultTableIDLocked(baseID), nil
	}
	if !m.tableBelongsToBaseLocked(baseID, tableID) {
		return 0, ErrNotFound
	}
	return tableID, nil
}

func (m *Memory) baseTablesLocked(baseID int64) []BaseTable {
	d := m.doc(baseID)
	if d != nil && d.meta.Kind == "base" {
		m.ensureDefaultTableLocked(baseID)
	}
	out := make([]BaseTable, 0)
	for _, tbl := range m.b.tables {
		if tbl.BaseID == baseID {
			out = append(out, tbl)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Position == out[j].Position {
			return out[i].ID < out[j].ID
		}
		return out[i].Position < out[j].Position
	})
	return out
}

func (m *Memory) BaseTables(_ context.Context, baseID int64) ([]BaseTable, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.baseTablesLocked(baseID), nil
}

func (m *Memory) CreateBaseTableGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, name string) (BaseTable, error) {
	clean, ok := validBaseTableName(name)
	if !ok {
		return BaseTable{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expiry, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return BaseTable{}, err
	}
	if err = ctx.Err(); err != nil {
		return BaseTable{}, err
	}
	if !guard.currentTime().Before(expiry) {
		return BaseTable{}, ErrUnauthenticated
	}
	tables := m.baseTablesLocked(baseID)
	pos := 1.0
	if len(tables) > 0 {
		pos = tables[len(tables)-1].Position + 1
	}
	now := time.Now()
	tbl := BaseTable{ID: m.id(), BaseID: baseID, Name: clean, Position: pos, IsDefault: false}
	field := Field{ID: m.id(), BaseID: baseID, TableID: tbl.ID, Name: "文本", Type: "text", Position: 1, IsPrimary: true}
	view := View{ID: m.id(), BaseID: baseID, TableID: tbl.ID, Type: "grid", Name: "表格", Config: json.RawMessage(`{}`), Pos: 1}
	records := make([]Record, 5)
	for i := range records {
		uid := guard.UserID
		rid := m.id()
		records[i] = Record{ID: rid, BaseID: baseID, TableID: tbl.ID, Cells: map[string]json.RawMessage{}, Position: float64(i + 1), CreatorID: &uid, CreatedAt: &now, UpdatedAt: &now}
	}
	m.b.tables = append(m.b.tables, tbl)
	m.b.fields = append(m.b.fields, field)
	m.b.views = append(m.b.views, view)
	m.b.records = append(m.b.records, records...)
	m.recordViewReloadLocked(baseID)
	return tbl, nil
}

func (m *Memory) RenameBaseTableGuarded(ctx context.Context, guard BaseWriteGuard, baseID, tableID int64, name string) (BaseTable, error) {
	clean, ok := validBaseTableName(name)
	if !ok {
		return BaseTable{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expiry, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return BaseTable{}, err
	}
	m.ensureDefaultTableLocked(baseID)
	if err = ctx.Err(); err != nil {
		return BaseTable{}, err
	}
	if !guard.currentTime().Before(expiry) {
		return BaseTable{}, ErrUnauthenticated
	}
	for i := range m.b.tables {
		if m.b.tables[i].ID == tableID && m.b.tables[i].BaseID == baseID {
			m.b.tables[i].Name = clean
			m.recordViewReloadLocked(baseID)
			return m.b.tables[i], nil
		}
	}
	return BaseTable{}, ErrNotFound
}

func (m *Memory) DeleteBaseTableGuarded(ctx context.Context, guard BaseWriteGuard, baseID, tableID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expiry, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return err
	}
	m.ensureDefaultTableLocked(baseID)
	idx := -1
	for i, tbl := range m.b.tables {
		if tbl.ID == tableID && tbl.BaseID == baseID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return ErrNotFound
	}
	if m.b.tables[idx].IsDefault {
		return ErrConflict
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if !guard.currentTime().Before(expiry) {
		return ErrUnauthenticated
	}
	m.b.tables = slices.Delete(m.b.tables, idx, idx+1)
	deletedFields := map[int64]bool{}
	m.b.fields = slices.DeleteFunc(m.b.fields, func(f Field) bool {
		if f.BaseID == baseID && f.TableID == tableID {
			deletedFields[f.ID] = true
			return true
		}
		return false
	})
	deletedRecords := map[int64]bool{}
	m.b.records = slices.DeleteFunc(m.b.records, func(r Record) bool {
		if r.BaseID == baseID && r.TableID == tableID {
			deletedRecords[r.ID] = true
			return true
		}
		return false
	})
	m.b.views = slices.DeleteFunc(m.b.views, func(v View) bool {
		if v.BaseID == baseID && v.TableID == tableID {
			delete(m.b.formLinks, [2]int64{baseID, v.ID})
			return true
		}
		return false
	})
	for key, tos := range m.links {
		if deletedFields[key[0]] || deletedRecords[key[1]] {
			delete(m.links, key)
			continue
		}
		kept := tos[:0]
		for _, to := range tos {
			if !deletedRecords[to] {
				kept = append(kept, to)
			}
		}
		m.links[key] = kept
	}
	// Clear target_table_id references pointing at the deleted table.
	for i := range m.b.fields {
		if m.b.fields[i].TargetTableID != nil && *m.b.fields[i].TargetTableID == tableID {
			m.b.fields[i].TargetTableID = nil
		}
	}
	m.recordViewReloadLocked(baseID)
	return nil
}

func (m *Memory) ReorderBaseTablesGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, ids []int64) ([]BaseTable, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expiry, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return nil, err
	}
	tables := m.baseTablesLocked(baseID)
	if len(ids) != len(tables) || len(ids) == 0 {
		return nil, ErrConflict
	}
	byID := make(map[int64]BaseTable, len(tables))
	for _, tbl := range tables {
		byID[tbl.ID] = tbl
	}
	ordered := make([]BaseTable, 0, len(ids))
	for i, id := range ids {
		tbl, ok := byID[id]
		if !ok {
			return nil, ErrConflict
		}
		delete(byID, id)
		tbl.Position = float64(i + 1)
		ordered = append(ordered, tbl)
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if !guard.currentTime().Before(expiry) {
		return nil, ErrUnauthenticated
	}
	positions := make(map[int64]float64, len(ordered))
	for _, tbl := range ordered {
		positions[tbl.ID] = tbl.Position
	}
	for i := range m.b.tables {
		if m.b.tables[i].BaseID == baseID {
			m.b.tables[i].Position = positions[m.b.tables[i].ID]
		}
	}
	m.recordViewReloadLocked(baseID)
	return ordered, nil
}

func scanBaseTable(r pgx.Row) (tbl BaseTable, err error) {
	err = r.Scan(&tbl.ID, &tbl.BaseID, &tbl.Name, &tbl.Position, &tbl.IsDefault)
	return tbl, notFound(err)
}

func appendBtReloadTx(ctx context.Context, tx pgx.Tx, baseID int64) error {
	_, err := tx.Exec(ctx, `INSERT INTO bt_events (base_id, body) VALUES ($1, '{"kind":"reload"}'::jsonb)`, baseID)
	return err
}

func nullableID(id int64) any {
	if id <= 0 {
		return nil
	}
	return id
}

func fieldsSingleTableID(fields []Field) int64 {
	var tid int64
	for _, f := range fields {
		if f.TableID <= 0 {
			return 0
		}
		if tid == 0 {
			tid = f.TableID
		} else if tid != f.TableID {
			return 0
		}
	}
	return tid
}

func pgBaseTables(ctx context.Context, db pgBaseSnapshotQueryer, baseID int64) ([]BaseTable, error) {
	rows, err := db.Query(ctx, `SELECT id, base_id, name, position, is_default FROM bt_tables WHERE base_id=$1 ORDER BY position, id`, baseID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (BaseTable, error) { return scanBaseTable(r) })
}

func (p *Postgres) BaseTables(ctx context.Context, baseID int64) ([]BaseTable, error) {
	return pgBaseTables(ctx, p.Pool, baseID)
}

func (r *pgBaseSnapshotReader) BaseTables(ctx context.Context, baseID int64) ([]BaseTable, error) {
	return pgBaseTables(ctx, r.tx, baseID)
}

func (p *Postgres) CreateBaseTableGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, name string) (result BaseTable, err error) {
	clean, ok := validBaseTableName(name)
	if !ok {
		return BaseTable{}, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expiry, err := lockBaseWrite(ctx, tx, guard, baseID)
		if err != nil {
			return err
		}
		result, err = scanBaseTable(tx.QueryRow(ctx, `INSERT INTO bt_tables (base_id, name, position, is_default)
			VALUES ($1, $2, COALESCE((SELECT max(position) FROM bt_tables WHERE base_id=$1), 0) + 1, false)
			RETURNING id, base_id, name, position, is_default`, baseID, clean))
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO base_fields (base_id, table_id, name, type, position, is_primary) VALUES ($1,$2,'文本','text',1,true)`, baseID, result.ID); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO bt_views (base_id, table_id, type, name, config, pos) VALUES ($1,$2,'grid','表格','{}'::jsonb,1)`, baseID, result.ID); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO base_records (base_id, table_id, cells, position, creator_id)
			SELECT $1,$2,'{}'::jsonb,n,$3 FROM generate_series(1,5) AS n`, baseID, result.ID, guard.UserID); err != nil {
			return err
		}
		if err = appendBtReloadTx(ctx, tx, baseID); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		if retryableRestoreConflict(err) {
			return BaseTable{}, ErrConflict
		}
		return BaseTable{}, err
	}
	return result, nil
}

func (p *Postgres) RenameBaseTableGuarded(ctx context.Context, guard BaseWriteGuard, baseID, tableID int64, name string) (result BaseTable, err error) {
	clean, ok := validBaseTableName(name)
	if !ok {
		return BaseTable{}, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expiry, err := lockBaseWrite(ctx, tx, guard, baseID)
		if err != nil {
			return err
		}
		result, err = scanBaseTable(tx.QueryRow(ctx, `UPDATE bt_tables SET name=$3 WHERE id=$1 AND base_id=$2 RETURNING id, base_id, name, position, is_default`, tableID, baseID, clean))
		if err != nil {
			return err
		}
		if err = appendBtReloadTx(ctx, tx, baseID); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		if retryableRestoreConflict(err) {
			return BaseTable{}, ErrConflict
		}
		return BaseTable{}, err
	}
	return result, nil
}

func (p *Postgres) DeleteBaseTableGuarded(ctx context.Context, guard BaseWriteGuard, baseID, tableID int64) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expiry, err := lockBaseWrite(ctx, tx, guard, baseID)
		if err != nil {
			return err
		}
		var isDefault bool
		err = tx.QueryRow(ctx, `SELECT is_default FROM bt_tables WHERE id=$1 AND base_id=$2 FOR UPDATE`, tableID, baseID).Scan(&isDefault)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if isDefault {
			return ErrConflict
		}
		if _, err = tx.Exec(ctx, `DELETE FROM bt_tables WHERE id=$1 AND base_id=$2 AND NOT is_default`, tableID, baseID); err != nil {
			return err
		}
		if err = appendBtReloadTx(ctx, tx, baseID); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil && retryableRestoreConflict(err) {
		return ErrConflict
	}
	return err
}

func (p *Postgres) ReorderBaseTablesGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, ids []int64) (result []BaseTable, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expiry, err := lockBaseWrite(ctx, tx, guard, baseID)
		if err != nil {
			return err
		}
		tables, err := pgBaseTables(ctx, tx, baseID)
		if err != nil {
			return err
		}
		if len(ids) != len(tables) || len(ids) == 0 {
			return ErrConflict
		}
		byID := make(map[int64]BaseTable, len(tables))
		for _, tbl := range tables {
			byID[tbl.ID] = tbl
		}
		result = make([]BaseTable, 0, len(ids))
		for i, id := range ids {
			tbl, ok := byID[id]
			if !ok {
				return ErrConflict
			}
			delete(byID, id)
			tbl.Position = float64(i + 1)
			if _, err = tx.Exec(ctx, `UPDATE bt_tables SET position=$3 WHERE id=$1 AND base_id=$2`, id, baseID, tbl.Position); err != nil {
				return err
			}
			result = append(result, tbl)
		}
		if err = appendBtReloadTx(ctx, tx, baseID); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		if retryableRestoreConflict(err) {
			return nil, ErrConflict
		}
		return nil, err
	}
	return result, nil
}
