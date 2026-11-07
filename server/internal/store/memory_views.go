package store

import (
	"context"
	"encoding/json"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
)

func (m *Memory) Views(_ context.Context, base int64) ([]View, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []View{}
	for _, v := range m.b.views {
		if v.BaseID == base {
			out = append(out, v)
		}
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Pos < out[j-1].Pos; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, nil
}

func (m *Memory) AddView(_ context.Context, v View) (View, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v.ID = m.id()
	if v.Pos == 0 {
		v.Pos = float64(v.ID)
	}
	if v.Type == "" {
		v.Type = "grid"
	}
	if v.Config == nil {
		v.Config = []byte("{}")
	}
	m.b.views = append(m.b.views, v)
	return v, nil
}

func (m *Memory) UpdateView(_ context.Context, v View) (View, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, x := range m.b.views {
		if x.ID == v.ID && x.BaseID == v.BaseID {
			if v.Name == "" {
				v.Name = x.Name
			}
			if v.Type == "" {
				v.Type = x.Type
			}
			if v.Config == nil {
				v.Config = x.Config
			}
			m.b.views[i] = v
			return v, nil
		}
	}
	return View{}, ErrNotFound
}

func (m *Memory) DeleteView(_ context.Context, base, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := len(m.b.views)
	out := m.b.views[:0]
	for _, v := range m.b.views {
		if v.ID != id || v.BaseID != base {
			out = append(out, v)
		}
	}
	m.b.views = out
	if n == len(out) {
		return ErrNotFound
	}
	return nil
}

// QueryRecords filters and sorts in memory using btquery's evaluator (the
// memory twin of the Postgres SQL compilation).
func (m *Memory) QueryRecords(_ context.Context, base int64, fields []Field, cfg btquery.Config, limit int) ([]Record, error) {
	specs := Specs(fields)
	recs, err := m.Records(context.Background(), base)
	if err != nil {
		return nil, err
	}
	out := []Record{}
	for _, i := range btquery.SortIndexes(specs, cfg, len(recs), func(i int) map[string]json.RawMessage { return recs[i].Cells }) {
		if btquery.Match(specs, cfg, recs[i].Cells) {
			out = append(out, recs[i])
			if limit > 0 && len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}

func (m *Memory) QueryRecordsConstrained(ctx context.Context, base int64, fields []Field, mandatory []btquery.Config, cfg btquery.Config, limit int) ([]Record, error) {
	specs := Specs(fields)
	for _, c := range mandatory {
		if err := btquery.ValidateLocked(specs, c); err != nil {
			return nil, err
		}
	}
	if err := btquery.Validate(specs, cfg); err != nil {
		return nil, err
	}
	recs, err := m.Records(ctx, base)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}
	out := []Record{}
	for _, i := range btquery.SortIndexes(specs, cfg, len(recs), func(i int) map[string]json.RawMessage { return recs[i].Cells }) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if !btquery.Match(specs, cfg, recs[i].Cells) {
			continue
		}
		allowed := true
		for _, c := range mandatory {
			if !btquery.Match(specs, c, recs[i].Cells) {
				allowed = false
				break
			}
		}
		if allowed {
			out = append(out, recs[i])
			if len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}

// BtQueryAll is an empty (unfiltered) query config.
func BtQueryAll() btquery.Config { return btquery.Config{} }

// Specs converts store fields into the compiler's field specs.
func Specs(fields []Field) []btquery.FieldSpec {
	out := make([]btquery.FieldSpec, len(fields))
	for i, f := range fields {
		out[i] = btquery.FieldSpec{ID: f.ID, Type: f.Type, Options: f.Options}
	}
	return out
}
