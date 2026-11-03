package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

func (p *Postgres) CreateBase(ctx context.Context, ws, creator int64, parent *int64, title string) (DocMeta, error) {
	return scanDoc(p.Pool.QueryRow(ctx, `INSERT INTO nodes (workspace_id, parent_id, kind, sort_key, title, creator_id)
		VALUES ($1, $2, 'base', 'V', $3, $4) RETURNING `+docCols+creatorName, ws, parent, title, creator))
}

func notFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func scanField(r pgx.Row) (f Field, err error) {
	var opts []byte
	err = r.Scan(&f.ID, &f.BaseID, &f.Name, &f.Type, &opts, &f.Position)
	if err == nil {
		err = json.Unmarshal(opts, &f.Options)
	}
	return f, notFound(err)
}

const fieldCols = `id, base_id, name, type, options, position`
const recordCols = `id, base_id, cells, position`

func (p *Postgres) Fields(ctx context.Context, base int64) ([]Field, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+fieldCols+` FROM base_fields WHERE base_id=$1 ORDER BY position, id`, base)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Field, error) { return scanField(r) })
}

func opts(f Field) []byte {
	if f.Options == nil {
		f.Options = []string{}
	}
	b, _ := json.Marshal(f.Options)
	return b
}

func (p *Postgres) AddField(ctx context.Context, f Field) (Field, error) {
	return scanField(p.Pool.QueryRow(ctx, `INSERT INTO base_fields (base_id, name, type, options, position)
		VALUES ($1,$2,$3,$4, CASE WHEN $5::float8 = 0 THEN COALESCE((SELECT max(position) FROM base_fields WHERE base_id=$1), 0) + 1 ELSE $5 END)
		RETURNING `+fieldCols, f.BaseID, f.Name, f.Type, opts(f), f.Position))
}

func (p *Postgres) UpdateField(ctx context.Context, f Field) (Field, error) {
	return scanField(p.Pool.QueryRow(ctx, `UPDATE base_fields SET name=$3, type=$4, options=$5, position=$6 WHERE id=$1 AND base_id=$2 RETURNING `+fieldCols,
		f.ID, f.BaseID, f.Name, f.Type, opts(f), f.Position))
}

func (p *Postgres) DeleteField(ctx context.Context, base, id int64) error {
	t, err := p.Pool.Exec(ctx, `DELETE FROM base_fields WHERE id=$1 AND base_id=$2`, id, base)
	if err == nil && t.RowsAffected() == 0 {
		err = ErrNotFound
	}
	if err == nil {
		_, err = p.Pool.Exec(ctx, `UPDATE base_records SET cells = cells - $2 WHERE base_id=$1 AND cells ? $2`, base, jsonKey(id))
	}
	return err
}

func jsonKey(id int64) string { b, _ := json.Marshal(id); return string(b) }

func scanRecord(r pgx.Row) (rec Record, err error) {
	err = r.Scan(&rec.ID, &rec.BaseID, &rec.Cells, &rec.Position)
	return rec, notFound(err)
}

func (p *Postgres) Records(ctx context.Context, base int64) ([]Record, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+recordCols+` FROM base_records WHERE base_id=$1 ORDER BY position, id LIMIT 10000`, base)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Record, error) { return scanRecord(r) })
}

func (p *Postgres) AddRecord(ctx context.Context, r Record) (Record, error) {
	if r.Cells == nil {
		r.Cells = map[string]json.RawMessage{}
	}
	return scanRecord(p.Pool.QueryRow(ctx, `INSERT INTO base_records (base_id, cells, position)
		VALUES ($1,$2, CASE WHEN $3::float8 = 0 THEN COALESCE((SELECT max(position) FROM base_records WHERE base_id=$1), 0) + 1 ELSE $3 END)
		RETURNING `+recordCols, r.BaseID, r.Cells, r.Position))
}

// SetCells merges cells; jsonb_strip_nulls drops cells set to null.
func (p *Postgres) SetCells(ctx context.Context, base, id int64, cells map[string]json.RawMessage) (Record, error) {
	return scanRecord(p.Pool.QueryRow(ctx, `UPDATE base_records SET cells = jsonb_strip_nulls(cells || $3::jsonb), updated_at = now()
		WHERE id=$1 AND base_id=$2 RETURNING `+recordCols, id, base, cells))
}

func (p *Postgres) DeleteRecord(ctx context.Context, base, id int64) error {
	t, err := p.Pool.Exec(ctx, `DELETE FROM base_records WHERE id=$1 AND base_id=$2`, id, base)
	if err == nil && t.RowsAffected() == 0 {
		err = ErrNotFound
	}
	return err
}
