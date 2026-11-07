package store

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
)

func (m *Memory) RecordConstrained(ctx context.Context, baseID, recordID int64, fields []Field, mandatory []btquery.Config) (Record, error) {
	specs := Specs(fields)
	for _, cfg := range mandatory {
		if err := btquery.ValidateLocked(specs, cfg); err != nil {
			return Record{}, err
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}
	i := m.recordIndexLocked(recordID)
	if i < 0 || m.b.records[i].BaseID != baseID {
		return Record{}, ErrNotFound
	}
	record := m.b.records[i]
	for _, cfg := range mandatory {
		if !btquery.Match(specs, cfg, record.Cells) {
			return Record{}, ErrNotFound
		}
	}
	cells := make(map[string]json.RawMessage, len(record.Cells))
	for key, value := range record.Cells {
		cells[key] = slices.Clone(value)
	}
	record.Cells = cells
	return record, nil
}

func (p *Postgres) RecordConstrained(ctx context.Context, baseID, recordID int64, fields []Field, mandatory []btquery.Config) (Record, error) {
	specs := Specs(fields)
	args := []any{baseID, recordID}
	var clauses []string
	for _, cfg := range mandatory {
		if err := btquery.ValidateLocked(specs, cfg); err != nil {
			return Record{}, err
		}
		where, next, _, err := btquery.Compile(specs, cfg, args...)
		if err != nil {
			return Record{}, err
		}
		args = next
		if where != "" {
			clauses = append(clauses, "("+where+")")
		}
	}
	query := fmt.Sprintf(`SELECT %s FROM base_records WHERE base_id=$1 AND id=$2`, recordColsWithPrefix())
	if len(clauses) > 0 {
		query += " AND " + strings.Join(clauses, " AND ")
	}
	return scanRecord(p.Pool.QueryRow(ctx, query, args...))
}

func (m *Memory) VisibleRecordIDs(ctx context.Context, baseID int64, ids []int64, fields []Field, mandatory []btquery.Config) ([]int64, error) {
	specs := Specs(fields)
	for _, cfg := range mandatory {
		if err := btquery.ValidateLocked(specs, cfg); err != nil {
			return nil, err
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	seen := make(map[int64]bool, len(ids))
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if id <= 0 || seen[id] {
			continue
		}
		seen[id] = true
		i := m.recordIndexLocked(id)
		if i < 0 || m.b.records[i].BaseID != baseID {
			continue
		}
		allowed := true
		for _, cfg := range mandatory {
			if !btquery.Match(specs, cfg, m.b.records[i].Cells) {
				allowed = false
				break
			}
		}
		if allowed {
			out = append(out, id)
		}
	}
	return out, nil
}

func (p *Postgres) VisibleRecordIDs(ctx context.Context, baseID int64, ids []int64, fields []Field, mandatory []btquery.Config) ([]int64, error) {
	if len(ids) == 0 {
		return []int64{}, nil
	}
	specs := Specs(fields)
	args := []any{baseID, ids}
	var clauses []string
	for _, cfg := range mandatory {
		if err := btquery.ValidateLocked(specs, cfg); err != nil {
			return nil, err
		}
		where, next, _, err := btquery.Compile(specs, cfg, args...)
		if err != nil {
			return nil, err
		}
		args = next
		if where != "" {
			clauses = append(clauses, "("+where+")")
		}
	}
	query := `SELECT id FROM base_records WHERE base_id=$1 AND id=ANY($2)`
	if len(clauses) > 0 {
		query += " AND " + strings.Join(clauses, " AND ")
	}
	rows, err := p.Pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	allowed := make(map[int64]bool, len(ids))
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		allowed[id] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	seen := map[int64]bool{}
	out := make([]int64, 0, len(allowed))
	for _, id := range ids {
		if allowed[id] && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}
