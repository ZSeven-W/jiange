package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
)

func (p *Postgres) Views(ctx context.Context, base int64) ([]View, error) {
	rows, err := p.Pool.Query(ctx, `SELECT id, base_id, type, name, config, pos FROM bt_views WHERE base_id=$1 ORDER BY pos, id`, base)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (v View, err error) {
		err = r.Scan(&v.ID, &v.BaseID, &v.Type, &v.Name, &v.Config, &v.Pos)
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
	err := p.Pool.QueryRow(ctx, `INSERT INTO bt_views (base_id, type, name, config, pos)
		VALUES ($1,$2,$3,$4, CASE WHEN $5::float8 = 0 THEN COALESCE((SELECT max(pos) FROM bt_views WHERE base_id=$1), 0) + 1 ELSE $5 END)
		RETURNING id, pos`, v.BaseID, v.Type, v.Name, v.Config, v.Pos).Scan(&v.ID, &v.Pos)
	return v, err
}

func (p *Postgres) UpdateView(ctx context.Context, v View) (View, error) {
	err := p.Pool.QueryRow(ctx, `UPDATE bt_views SET type = CASE WHEN $3 = '' THEN type ELSE $3 END,
		name = CASE WHEN $4 = '' THEN name ELSE $4 END,
		config = CASE WHEN $5::jsonb IS NULL THEN config ELSE $5::jsonb END,
		pos = CASE WHEN $6::float8 = 0 THEN pos ELSE $6 END
		WHERE id=$1 AND base_id=$2 RETURNING type, name, config, pos`,
		v.ID, v.BaseID, v.Type, v.Name, rawJSON(v.Config), v.Pos).
		Scan(&v.Type, &v.Name, &v.Config, &v.Pos)
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
	t, err := p.Pool.Exec(ctx, `DELETE FROM bt_views WHERE id=$1 AND base_id=$2`, id, base)
	if err == nil && t.RowsAffected() == 0 {
		err = ErrNotFound
	}
	return err
}

// QueryRecords compiles the view config into jsonb SQL and runs it in one
// statement; values ride as bind parameters.
func (p *Postgres) QueryRecords(ctx context.Context, base int64, fields []Field, cfg btquery.Config, limit int) ([]Record, error) {
	if limit <= 0 {
		limit = 10000
	}
	// $1 is the base id; the compiled fragments bind their values from $2 on
	where, args, order, err := btquery.Compile(Specs(fields), cfg, base)
	if err != nil {
		return nil, err
	}
	q := fmt.Sprintf(`SELECT %s FROM base_records WHERE base_id=$1`, recordColsWithPrefix())
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
