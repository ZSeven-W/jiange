package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
)

// pgBaseSnapshotReader is used only during its owning transaction callback.
// All calls are sequential: pgx transactions do not allow concurrent queries.
type pgBaseSnapshotReader struct {
	tx  pgx.Tx
	uid int64
}

// WithBaseReadSnapshot provides one consistent database snapshot for the base
// and every authorized related table visited by fn. The transaction ends
// before the caller sends its HTTP response; callers must recheck current
// authorization after it returns.
func (p *Postgres) WithBaseReadSnapshot(ctx context.Context, uid, baseID int64, fn func(BaseSnapshotReader) error) (err error) {
	tx, err := p.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	reader := &pgBaseSnapshotReader{tx: tx, uid: uid}
	meta, err := reader.GetDoc(ctx, uid, baseID)
	if err != nil {
		return err
	}
	if meta.Kind != "base" || RoleRank(meta.Role) < RoleRank(RoleView) {
		return ErrNotFound
	}
	if err := fn(reader); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *pgBaseSnapshotReader) GetDoc(ctx context.Context, uid, id int64) (DocMeta, error) {
	var d DocMeta
	err := r.tx.QueryRow(ctx, `SELECT `+prefixed("n.", docCols)+`, (SELECT name FROM users u WHERE u.id = n.creator_id), `+roleSQL+`, (SELECT name FROM workspaces w WHERE w.id = n.workspace_id), n.copy_protected FROM nodes n`+roleJoins+`
        WHERE n.id = $2 AND n.deleted_at IS NULL`, uid, id).
		Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Title, &d.Icon, &d.CreatorID, &d.CreatedAt, &d.UpdatedAt, &d.Kind, &d.CreatorName, &d.Role, &d.WorkspaceName, &d.CopyProtected)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && d.Role == "") {
		return DocMeta{}, ErrNotFound
	}
	return d, err
}

func (r *pgBaseSnapshotReader) Fields(ctx context.Context, base int64) ([]Field, error) {
	return pgFields(ctx, r.tx, base)
}
func (r *pgBaseSnapshotReader) Views(ctx context.Context, base int64) ([]View, error) {
	return pgViews(ctx, r.tx, base)
}

func (r *pgBaseSnapshotReader) QueryRecordsConstrained(ctx context.Context, base int64, fields []Field, mandatory []btquery.Config, cfg btquery.Config, limit int) ([]Record, error) {
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}
	specs := Specs(fields)
	args := []any{base}
	var clauses []string
	for _, c := range mandatory {
		if err := btquery.ValidateLocked(specs, c); err != nil {
			return nil, err
		}
		where, next, _, err := btquery.Compile(specs, c, args...)
		if err != nil {
			return nil, err
		}
		args = next
		if where != "" {
			clauses = append(clauses, "("+where+")")
		}
	}
	where, args, order, err := btquery.Compile(specs, cfg, args...)
	if err != nil {
		return nil, err
	}
	if where != "" {
		clauses = append(clauses, "("+where+")")
	}
	q := fmt.Sprintf(`SELECT %s FROM base_records WHERE base_id=$1`, recordColsWithPrefix())
	if len(clauses) > 0 {
		q += " AND " + strings.Join(clauses, " AND ")
	}
	q += " ORDER BY " + firstNonEmpty(order, "position, id") + " LIMIT " + fmt.Sprint(limit)
	rows, err := r.tx.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Record, error) { return scanRecord(row) })
}

type pgBaseSnapshotQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func (r *pgBaseSnapshotReader) RecordsConstrainedByIDs(ctx context.Context, base int64, ids []int64, fields []Field, mandatory []btquery.Config) ([]Record, error) {
	return pgRecordsConstrainedByIDs(ctx, r.tx, base, ids, fields, mandatory)
}

func (p *Postgres) RecordsConstrainedByIDs(ctx context.Context, base int64, ids []int64, fields []Field, mandatory []btquery.Config) ([]Record, error) {
	return pgRecordsConstrainedByIDs(ctx, p.Pool, base, ids, fields, mandatory)
}

func pgRecordsConstrainedByIDs(ctx context.Context, db pgBaseSnapshotQueryer, base int64, ids []int64, fields []Field, mandatory []btquery.Config) ([]Record, error) {
	if len(ids) == 0 {
		return []Record{}, nil
	}
	specs := Specs(fields)
	for _, cfg := range mandatory {
		if err := btquery.ValidateLocked(specs, cfg); err != nil {
			return nil, err
		}
	}
	// Preserve request order, but avoid issuing repeated queries for duplicate
	// or invalid IDs. Querying fixed batches also avoids oversized SQL arrays.
	unique := make([]int64, 0, len(ids))
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if id > 0 && !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	byID := make(map[int64]Record, len(unique))
	for start := 0; start < len(unique); start += 1000 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		end := min(start+1000, len(unique))
		args := []any{base, unique[start:end]}
		var clauses []string
		for _, cfg := range mandatory {
			where, next, _, err := btquery.Compile(specs, cfg, args...)
			if err != nil {
				return nil, err
			}
			args = next
			if where != "" {
				clauses = append(clauses, "("+where+")")
			}
		}
		query := fmt.Sprintf(`SELECT %s FROM base_records WHERE base_id=$1 AND id=ANY($2)`, recordColsWithPrefix())
		if len(clauses) > 0 {
			query += " AND " + strings.Join(clauses, " AND ")
		}
		rows, err := db.Query(ctx, query, args...)
		if err != nil {
			return nil, err
		}
		records, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Record, error) { return scanRecord(row) })
		if err != nil {
			return nil, err
		}
		for _, record := range records {
			byID[record.ID] = record
		}
	}
	out := make([]Record, 0, len(byID))
	for _, id := range unique {
		if record, ok := byID[id]; ok {
			out = append(out, record)
		}
	}
	return out, nil
}

func (r *pgBaseSnapshotReader) BtHead(ctx context.Context, base int64) (int64, error) {
	var seq int64
	err := r.tx.QueryRow(ctx, `SELECT COALESCE(max(id), 0) FROM bt_events WHERE base_id=$1`, base).Scan(&seq)
	return seq, err
}

func (r *pgBaseSnapshotReader) WorkspaceMembers(ctx context.Context, ws int64) ([]User, error) {
	rows, err := r.tx.Query(ctx, `SELECT u.id, u.email, u.name, u.created_at FROM workspace_members m
        JOIN users u ON u.id = m.user_id WHERE m.workspace_id=$1 ORDER BY u.id`, ws)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (u User, err error) {
		err = row.Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt)
		return
	})
}

func (r *pgBaseSnapshotReader) Workspaces(ctx context.Context, uid int64) ([]Workspace, error) {
	rows, err := r.tx.Query(ctx, `SELECT w.id, w.name, w.owner_id FROM workspaces w
        JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = $1 ORDER BY w.id`, uid)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (w Workspace, err error) {
		err = row.Scan(&w.ID, &w.Name, &w.OwnerID)
		return
	})
}

func (r *pgBaseSnapshotReader) LinksForRecords(ctx context.Context, fieldID int64, fromRecords []int64) (map[int64][]int64, error) {
	rows, err := r.tx.Query(ctx, `SELECT from_record, to_record FROM bt_links WHERE field_id=$1 AND from_record = ANY($2) ORDER BY id LIMIT 100001`, fieldID, fromRecords)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64][]int64{}
	count := 0
	for rows.Next() {
		var from, to int64
		if err := rows.Scan(&from, &to); err != nil {
			return nil, err
		}
		count++
		if count > 100000 {
			return nil, ErrBaseSnapshotTooLarge
		}
		out[from] = append(out[from], to)
	}
	return out, rows.Err()
}

func (r *pgBaseSnapshotReader) LinksToRecords(ctx context.Context, fieldID int64, targetIDs []int64) (map[int64][]int64, error) {
	return pgLinksToRecords(ctx, r.tx, fieldID, targetIDs)
}

func (p *Postgres) LinksToRecords(ctx context.Context, fieldID int64, targetIDs []int64) (map[int64][]int64, error) {
	return pgLinksToRecords(ctx, p.Pool, fieldID, targetIDs)
}

func pgLinksToRecords(ctx context.Context, db pgBaseSnapshotQueryer, fieldID int64, targetIDs []int64) (map[int64][]int64, error) {
	out := map[int64][]int64{}
	unique := make([]int64, 0, len(targetIDs))
	seen := make(map[int64]bool, len(targetIDs))
	for _, id := range targetIDs {
		if id > 0 && !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	count := 0
	for start := 0; start < len(unique); start += 1000 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		end := min(start+1000, len(unique))
		rows, err := db.Query(ctx, `SELECT to_record, from_record FROM bt_links WHERE field_id=$1 AND to_record=ANY($2) ORDER BY id LIMIT $3`, fieldID, unique[start:end], 100001-count)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var to, from int64
			if err := rows.Scan(&to, &from); err != nil {
				rows.Close()
				return nil, err
			}
			count++
			if count > 100000 {
				rows.Close()
				return nil, ErrBaseSnapshotTooLarge
			}
			out[to] = append(out[to], from)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (r *pgBaseSnapshotReader) LinksForRecordsConstrained(ctx context.Context, fieldID int64, sourceIDs []int64, targetBaseID int64, targetFields []Field, mandatory []btquery.Config) (map[int64][]int64, error) {
	return pgConstrainedLinks(ctx, r.tx, fieldID, sourceIDs, targetBaseID, targetFields, mandatory, false)
}

func (p *Postgres) LinksForRecordsConstrained(ctx context.Context, fieldID int64, sourceIDs []int64, targetBaseID int64, targetFields []Field, mandatory []btquery.Config) (map[int64][]int64, error) {
	return pgConstrainedLinks(ctx, p.Pool, fieldID, sourceIDs, targetBaseID, targetFields, mandatory, false)
}

func (r *pgBaseSnapshotReader) LinksToRecordsConstrained(ctx context.Context, fieldID int64, targetIDs []int64, sourceBaseID int64, sourceFields []Field, mandatory []btquery.Config) (map[int64][]int64, error) {
	return pgConstrainedLinks(ctx, r.tx, fieldID, targetIDs, sourceBaseID, sourceFields, mandatory, true)
}

func (p *Postgres) LinksToRecordsConstrained(ctx context.Context, fieldID int64, targetIDs []int64, sourceBaseID int64, sourceFields []Field, mandatory []btquery.Config) (map[int64][]int64, error) {
	return pgConstrainedLinks(ctx, p.Pool, fieldID, targetIDs, sourceBaseID, sourceFields, mandatory, true)
}

// pgConstrainedLinks applies the opposite side's mandatory row policy in SQL
// before counting returned links. Invisible links therefore neither escape in
// the result nor consume the visible-edge budget.
func pgConstrainedLinks(ctx context.Context, db pgBaseSnapshotQueryer, fieldID int64, ids []int64, otherBaseID int64, fields []Field, mandatory []btquery.Config, reverse bool) (map[int64][]int64, error) {
	specs := Specs(fields)
	for _, cfg := range mandatory {
		if err := btquery.ValidateLocked(specs, cfg); err != nil {
			return nil, err
		}
	}
	unique := make([]int64, 0, len(ids))
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if id > 0 && !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	out := map[int64][]int64{}
	count := 0
	for start := 0; start < len(unique); start += 1000 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		end := min(start+1000, len(unique))
		args := []any{fieldID, unique[start:end], otherBaseID}
		var clauses []string
		for _, cfg := range mandatory {
			where, next, _, err := btquery.Compile(specs, cfg, args...)
			if err != nil {
				return nil, err
			}
			args = next
			if where != "" {
				clauses = append(clauses, "("+where+")")
			}
		}
		joinID, requestedID := "l.to_record", "l.from_record"
		if reverse {
			joinID, requestedID = "l.from_record", "l.to_record"
		}
		query := `SELECT l.from_record, l.to_record FROM bt_links l JOIN base_records r ON r.id=` + joinID + ` AND r.base_id=$3 WHERE l.field_id=$1 AND ` + requestedID + `=ANY($2)`
		if len(clauses) > 0 {
			query += " AND " + strings.Join(clauses, " AND ")
		}
		args = append(args, 100001-count)
		query += fmt.Sprintf(" ORDER BY l.id LIMIT $%d", len(args))
		rows, err := db.Query(ctx, query, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var from, to int64
			if err := rows.Scan(&from, &to); err != nil {
				rows.Close()
				return nil, err
			}
			count++
			if count > 100000 {
				rows.Close()
				return nil, ErrBaseSnapshotTooLarge
			}
			if reverse {
				out[to] = append(out[to], from)
			} else {
				out[from] = append(out[from], to)
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (r *pgBaseSnapshotReader) LinkFieldsTargeting(ctx context.Context, targetBase int64) ([]LinkFieldRef, error) {
	// Page candidates before evaluating their source-view policy. A hidden
	// reverse field must not consume the visible result budget; otherwise many
	// hidden fields can make an otherwise readable target unavailable.
	const pageSize = 256
	const maxVisible = 1000
	hiddenByBase := map[int64]map[int64]bool{}
	out := []LinkFieldRef{}
	var after int64
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		rows, err := r.tx.Query(ctx, `SELECT f.id, f.base_id FROM base_fields f JOIN nodes n ON n.id=f.base_id`+roleJoins+`
			WHERE n.deleted_at IS NULL AND n.kind='base' AND f.type='link' AND f.options->>0=$2 AND f.id>$3 AND (`+roleSQL+`) <> '' ORDER BY f.id LIMIT $4`, r.uid, strconv.FormatInt(targetBase, 10), after, pageSize)
		if err != nil {
			return nil, err
		}
		var page []LinkFieldRef
		for rows.Next() {
			var ref LinkFieldRef
			if err := rows.Scan(&ref.FieldID, &ref.BaseID); err != nil {
				rows.Close()
				return nil, err
			}
			page = append(page, ref)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		for _, ref := range page {
			after = ref.FieldID
			hidden, ok := hiddenByBase[ref.BaseID]
			if !ok {
				hidden, err = r.reverseHiddenFields(ctx, ref.BaseID)
				if err != nil {
					return nil, err
				}
				hiddenByBase[ref.BaseID] = hidden
			}
			if hidden[ref.FieldID] {
				continue
			}
			if len(out) >= maxVisible {
				return nil, ErrBaseSnapshotTooLarge
			}
			out = append(out, ref)
		}
		if len(page) < pageSize {
			return out, nil
		}
	}
}

// reverseHiddenFields mirrors the read policy before a candidate is counted.
// Invalid stored configuration fails closed rather than becoming visible.
func (r *pgBaseSnapshotReader) reverseHiddenFields(ctx context.Context, baseID int64) (map[int64]bool, error) {
	meta, err := r.GetDoc(ctx, r.uid, baseID)
	if err != nil {
		return nil, err
	}
	hidden := map[int64]bool{}
	if meta.Role == RoleManage {
		return hidden, nil
	}
	fields, err := r.Fields(ctx, baseID)
	if err != nil {
		return nil, err
	}
	views, err := r.Views(ctx, baseID)
	if err != nil {
		return nil, err
	}
	for _, view := range views {
		var cfg btquery.Config
		if len(view.Config) > 0 && string(view.Config) != "null" {
			if err := json.Unmarshal(view.Config, &cfg); err != nil {
				return nil, fmt.Errorf("invalid stored view %d: %w", view.ID, err)
			}
		}
		if !cfg.Locked {
			continue
		}
		if err := btquery.ValidateLocked(Specs(fields), cfg); err != nil {
			return nil, fmt.Errorf("invalid locked view %d: %w", view.ID, err)
		}
		for _, field := range cfg.Hidden {
			hidden[field] = true
		}
	}
	return hidden, nil
}
