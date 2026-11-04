package store

import (
	"bytes"
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
	var opts, colors []byte
	err = r.Scan(&f.ID, &f.BaseID, &f.Name, &f.Type, &opts, &colors, &f.Description, &f.Formula, &f.Position)
	if err == nil {
		err = json.Unmarshal(opts, &f.Options)
	}
	if err == nil {
		err = json.Unmarshal(colors, &f.OptionColors)
	}
	return f, notFound(err)
}

const fieldCols = `id, base_id, name, type, options, option_colors, description, formula, position`
const recordCols = `id, base_id, cells, position, creator_id, created_at, updated_at`

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

func colors(f Field) []byte {
	if f.OptionColors == nil {
		f.OptionColors = []int{}
	}
	b, _ := json.Marshal(f.OptionColors)
	return b
}

func (p *Postgres) AddField(ctx context.Context, f Field) (Field, error) {
	return scanField(p.Pool.QueryRow(ctx, `INSERT INTO base_fields (base_id, name, type, options, option_colors, description, formula, position)
		VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8::float8 = 0 THEN COALESCE((SELECT max(position) FROM base_fields WHERE base_id=$1), 0) + 1 ELSE $8 END)
		RETURNING `+fieldCols, f.BaseID, f.Name, f.Type, opts(f), colors(f), f.Description, f.Formula, f.Position))
}

func (p *Postgres) UpdateField(ctx context.Context, f Field) (Field, error) {
	return scanField(p.Pool.QueryRow(ctx, `UPDATE base_fields SET name=$3, type=$4, options=$5, option_colors=$6, description=$7, formula=$8, position=$9 WHERE id=$1 AND base_id=$2 RETURNING `+fieldCols,
		f.ID, f.BaseID, f.Name, f.Type, opts(f), colors(f), f.Description, f.Formula, f.Position))
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
	err = r.Scan(&rec.ID, &rec.BaseID, &rec.Cells, &rec.Position, &rec.CreatorID, &rec.CreatedAt, &rec.UpdatedAt)
	return rec, notFound(err)
}

// recordColsWithPrefix spells out recordCols for queries that join or alias.
func recordColsWithPrefix() string { return recordCols }

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
	var creator any
	if r.CreatorID != nil {
		creator = *r.CreatorID
	}
	return scanRecord(p.Pool.QueryRow(ctx, `INSERT INTO base_records (base_id, cells, position, creator_id)
		VALUES ($1,$2, CASE WHEN $3::float8 = 0 THEN COALESCE((SELECT max(position) FROM base_records WHERE base_id=$1), 0) + 1 ELSE $3 END, $4)
		RETURNING `+recordCols, r.BaseID, r.Cells, r.Position, creator))
}

// SetCells merges cells; jsonb_strip_nulls drops cells set to null.
func (p *Postgres) SetCells(ctx context.Context, base, id int64, cells map[string]json.RawMessage) (Record, error) {
	return scanRecord(p.Pool.QueryRow(ctx, `UPDATE base_records SET cells = jsonb_strip_nulls(cells || $3::jsonb), updated_at = now()
		WHERE id=$1 AND base_id=$2 RETURNING `+recordCols, id, base, cells))
}

func (p *Postgres) MoveRecord(ctx context.Context, base, id int64, position float64) (Record, error) {
	return scanRecord(p.Pool.QueryRow(ctx, `UPDATE base_records SET position=$3 WHERE id=$1 AND base_id=$2 RETURNING `+recordCols, id, base, position))
}

func (p *Postgres) DeleteRecord(ctx context.Context, base, id int64) error {
	t, err := p.Pool.Exec(ctx, `DELETE FROM base_records WHERE id=$1 AND base_id=$2`, id, base)
	if err == nil && t.RowsAffected() == 0 {
		err = ErrNotFound
	}
	return err
}

// MapFieldCells rewrites every stored cell of the field through fn (nil deletes).
func (p *Postgres) MapFieldCells(ctx context.Context, base, field int64, fn func(json.RawMessage) json.RawMessage) error {
	key := jsonKey(field)
	rows, err := p.Pool.Query(ctx, `SELECT id, cells->$2 FROM base_records WHERE base_id=$1 AND cells ? $2`, base, key)
	if err != nil {
		return err
	}
	type change struct {
		id  int64
		val json.RawMessage
	}
	var changes []change
	for rows.Next() {
		var id int64
		var v json.RawMessage
		if err := rows.Scan(&id, &v); err != nil {
			rows.Close()
			return err
		}
		if nv := fn(v); !bytes.Equal(nv, v) {
			changes = append(changes, change{id, nv})
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, ch := range changes {
		if ch.val == nil {
			_, err = tx.Exec(ctx, `UPDATE base_records SET cells = cells - $3 WHERE id=$1 AND base_id=$2`, ch.id, base, key)
		} else {
			_, err = tx.Exec(ctx, `UPDATE base_records SET cells = cells || jsonb_build_object($3::text, $4::jsonb) WHERE id=$1 AND base_id=$2`, ch.id, base, key, ch.val)
		}
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (p *Postgres) AppendBtEvent(ctx context.Context, base int64, body json.RawMessage) (int64, error) {
	var seq int64
	err := p.Pool.QueryRow(ctx, `INSERT INTO bt_events (base_id, body) VALUES ($1, $2) RETURNING id`, base, body).Scan(&seq)
	return seq, err
}

func (p *Postgres) BtEventsAfter(ctx context.Context, base, after int64, limit int) ([]BtEvent, error) {
	rows, err := p.Pool.Query(ctx, `SELECT id, body FROM bt_events WHERE base_id=$1 AND id > $2 ORDER BY id LIMIT $3`, base, after, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (BtEvent, error) {
		var e BtEvent
		return e, r.Scan(&e.Seq, &e.Body)
	})
}

func (p *Postgres) BtHead(ctx context.Context, base int64) (int64, error) {
	var seq int64
	err := p.Pool.QueryRow(ctx, `SELECT COALESCE(max(id), 0) FROM bt_events WHERE base_id=$1`, base).Scan(&seq)
	return seq, err
}

// AddRecordsBulk inserts many records in one batched round trip.
func (p *Postgres) AddRecordsBulk(ctx context.Context, base int64, records []Record) error {
	if len(records) == 0 {
		return nil
	}
	b := &pgx.Batch{}
	var pos float64
	if err := p.Pool.QueryRow(ctx, `SELECT COALESCE(max(position), 0) FROM base_records WHERE base_id=$1`, base).Scan(&pos); err != nil {
		return err
	}
	for _, r := range records {
		pos++
		if r.Cells == nil {
			r.Cells = map[string]json.RawMessage{}
		}
		var creator any
		if r.CreatorID != nil {
			creator = *r.CreatorID
		}
		b.Queue(`INSERT INTO base_records (base_id, cells, position, creator_id) VALUES ($1, $2, $3, $4)`, base, r.Cells, pos, creator)
	}
	return p.Pool.SendBatch(ctx, b).Close()
}
