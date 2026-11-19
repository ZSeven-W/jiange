package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
)

func (p *Postgres) Views(ctx context.Context, base int64) ([]View, error) {
	rows, err := p.Pool.Query(ctx, `SELECT id, base_id, table_id, owner_id, type, name, config, pos FROM bt_views WHERE base_id=$1 ORDER BY pos, id`, base)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (v View, err error) {
		err = r.Scan(&v.ID, &v.BaseID, &v.TableID, &v.OwnerID, &v.Type, &v.Name, &v.Config, &v.Pos)
		return v, notFound(err)
	})
}

func (p *Postgres) AddView(ctx context.Context, v View) (View, error) {
	if v.Type == "" {
		v.Type = "grid"
	}
	if v.Config == nil {
		v.Config = []byte("{}")
	}
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		if err := lockBaseNode(ctx, tx, v.BaseID); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `INSERT INTO bt_views (base_id, table_id, owner_id, type, name, config, pos)
		VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7::float8 = 0 THEN COALESCE((SELECT max(pos) FROM bt_views WHERE base_id=$1), 0) + 1 ELSE $7 END)
		RETURNING id, table_id, pos`, v.BaseID, nullableID(v.TableID), v.OwnerID, v.Type, v.Name, v.Config, v.Pos).Scan(&v.ID, &v.TableID, &v.Pos)
	})
	return v, err
}

func (p *Postgres) UpdateView(ctx context.Context, v View) (View, error) {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		if err := lockBaseNode(ctx, tx, v.BaseID); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `UPDATE bt_views SET type = CASE WHEN $3 = '' THEN type ELSE $3 END,
		name = CASE WHEN $4 = '' THEN name ELSE $4 END,
		config = CASE WHEN $5::jsonb IS NULL THEN config ELSE $5::jsonb END,
		pos = CASE WHEN $6::float8 = 0 THEN pos ELSE $6 END
		WHERE id=$1 AND base_id=$2 RETURNING table_id, owner_id, type, name, config, pos`,
			v.ID, v.BaseID, v.Type, v.Name, rawJSON(v.Config), v.Pos).
			Scan(&v.TableID, &v.OwnerID, &v.Type, &v.Name, &v.Config, &v.Pos)
	})
	return v, notFound(err)
}

// rawJSON keeps a nil config a SQL NULL (meaning "unchanged").
func rawJSON(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return b
}

func (p *Postgres) DeleteView(ctx context.Context, base, id int64) error {
	return pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		if err := lockBaseNode(ctx, tx, base); err != nil {
			return err
		}
		var tableID int64
		var ownerID *int64
		if err := tx.QueryRow(ctx, `SELECT table_id, owner_id FROM bt_views WHERE id=$1 AND base_id=$2`, id, base).Scan(&tableID, &ownerID); err != nil {
			return notFound(err)
		}
		if ownerID == nil {
			var sharedCount int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM bt_views WHERE base_id=$1 AND table_id=$2 AND owner_id IS NULL`, base, tableID).Scan(&sharedCount); err != nil {
				return err
			}
			if sharedCount <= 1 {
				return ErrConflict
			}
		}
		t, err := tx.Exec(ctx, `DELETE FROM bt_views WHERE id=$1 AND base_id=$2`, id, base)
		if err == nil && t.RowsAffected() == 0 {
			return ErrNotFound
		}
		return err
	})
}

// QueryRecords compiles the view config into jsonb SQL and runs it in one
// statement; values ride as bind parameters.
func (p *Postgres) QueryRecords(ctx context.Context, base int64, fields []Field, cfg btquery.Config, limit int) ([]Record, error) {
	if limit <= 0 {
		limit = 10000
	}
	args := []any{base}
	tableClause := ""
	if tid := fieldsSingleTableID(fields); tid > 0 {
		args = append(args, tid)
		tableClause = fmt.Sprintf(" AND table_id=$%d", len(args))
	}
	where, args, order, err := btquery.Compile(Specs(fields), cfg, args...)
	if err != nil {
		return nil, err
	}
	q := fmt.Sprintf(`SELECT %s FROM base_records WHERE base_id=$1%s`, recordColsWithPrefix(), tableClause)
	if where != "" {
		q += " AND (" + where + ")"
	}
	q += " ORDER BY " + firstNonEmpty(order, "position, id") + " LIMIT " + fmt.Sprint(limit)
	rows, err := p.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Record, error) { return scanRecord(r) })
}

func (p *Postgres) QueryRecordsConstrained(ctx context.Context, base int64, fields []Field, mandatory []btquery.Config, cfg btquery.Config, limit int) ([]Record, error) {
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}
	specs := Specs(fields)
	args := []any{base}
	var clauses []string
	if tid := fieldsSingleTableID(fields); tid > 0 {
		args = append(args, tid)
		clauses = append(clauses, fmt.Sprintf("table_id=$%d", len(args)))
	}
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
	rows, err := p.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Record, error) { return scanRecord(r) })
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}
