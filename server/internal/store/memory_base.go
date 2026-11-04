package store

import (
	"context"
	"encoding/json"
	"maps"
	"slices"
	"sort"
	"strconv"
	"time"
)

type memBase struct {
	fields   []Field
	records  []Record
	events   []BtEvent
	nextID   int64
	eventSeq int64
}

func (m *Memory) CreateBase(ctx context.Context, ws, creator int64, parent *int64, title string) (DocMeta, error) {
	d, err := m.CreateDoc(ctx, ws, creator, parent, title, nil)
	if err != nil {
		return d, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.doc(d.ID).meta.Kind = "base"
	d.Kind = "base"
	return d, nil
}

func (m *Memory) id() int64 { m.b.nextID++; return m.b.nextID }

func (m *Memory) Fields(_ context.Context, base int64) ([]Field, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Field{}
	for _, f := range m.b.fields {
		if f.BaseID == base {
			out = append(out, f)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Position < out[j].Position })
	return out, nil
}

func (m *Memory) AddField(_ context.Context, f Field) (Field, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	f.ID = m.id()
	if f.Position == 0 {
		f.Position = float64(f.ID)
	}
	m.b.fields = append(m.b.fields, f)
	return f, nil
}

func (m *Memory) UpdateField(_ context.Context, f Field) (Field, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, x := range m.b.fields {
		if x.ID == f.ID && x.BaseID == f.BaseID {
			m.b.fields[i] = f
			return f, nil
		}
	}
	return Field{}, ErrNotFound
}

func (m *Memory) DeleteField(_ context.Context, base, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := len(m.b.fields)
	m.b.fields = slices.DeleteFunc(m.b.fields, func(f Field) bool { return f.ID == id && f.BaseID == base })
	if n == len(m.b.fields) {
		return ErrNotFound
	}
	key := strconv.FormatInt(id, 10)
	for i := range m.b.records {
		if m.b.records[i].BaseID == base {
			nc := maps.Clone(m.b.records[i].Cells)
			delete(nc, key)
			m.b.records[i].Cells = nc
		}
	}
	return nil
}

func (m *Memory) Records(_ context.Context, base int64) ([]Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Record{}
	for _, r := range m.b.records {
		if r.BaseID == base {
			out = append(out, r)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Position < out[j].Position })
	return out, nil
}

func (m *Memory) AddRecord(_ context.Context, r Record) (Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r.ID = m.id()
	if r.Position == 0 {
		r.Position = float64(r.ID)
	}
	if r.Cells == nil {
		r.Cells = map[string]json.RawMessage{}
	}
	now := time.Now()
	r.CreatedAt, r.UpdatedAt = &now, &now
	m.b.records = append(m.b.records, r)
	return r, nil
}

func (m *Memory) SetCells(_ context.Context, base, id int64, cells map[string]json.RawMessage) (Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, r := range m.b.records {
		if r.ID == id && r.BaseID == base {
			nc := map[string]json.RawMessage{}
			for k, v := range r.Cells {
				nc[k] = v
			}
			for k, v := range cells {
				if len(v) == 0 || string(v) == "null" {
					delete(nc, k)
				} else {
					nc[k] = v
				}
			}
			m.b.records[i].Cells = nc
			now := time.Now()
			m.b.records[i].UpdatedAt = &now
			return m.b.records[i], nil
		}
	}
	return Record{}, ErrNotFound
}

func (m *Memory) DeleteRecord(_ context.Context, base, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := len(m.b.records)
	m.b.records = slices.DeleteFunc(m.b.records, func(r Record) bool { return r.ID == id && r.BaseID == base })
	if n == len(m.b.records) {
		return ErrNotFound
	}
	return nil
}

func (m *Memory) MapFieldCells(_ context.Context, base, field int64, fn func(json.RawMessage) json.RawMessage) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := strconv.FormatInt(field, 10)
	for i := range m.b.records {
		if m.b.records[i].BaseID != base {
			continue
		}
		v, ok := m.b.records[i].Cells[key]
		if !ok {
			continue
		}
		nc := maps.Clone(m.b.records[i].Cells)
		if nv := fn(v); nv == nil {
			delete(nc, key)
		} else {
			nc[key] = nv
		}
		m.b.records[i].Cells = nc
	}
	return nil
}

func (m *Memory) AppendBtEvent(_ context.Context, base int64, body json.RawMessage) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.b.eventSeq++
	m.b.events = append(m.b.events, BtEvent{Seq: m.b.eventSeq, Body: body})
	return m.b.eventSeq, nil
}

func (m *Memory) BtEventsAfter(_ context.Context, base, after int64, limit int) ([]BtEvent, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []BtEvent
	for _, e := range m.b.events {
		if e.Seq > after {
			out = append(out, e)
			if len(out) == limit {
				break
			}
		}
	}
	return out, nil
}

func (m *Memory) BtHead(_ context.Context, base int64) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.b.eventSeq, nil
}
