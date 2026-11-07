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
	fields      []Field
	records     []Record
	recordIndex map[int64]int // lazily populated; validated after slice deletion
	views       []View
	events      map[int64][]BtEvent // per-base event log; never broadcast another base's rows
	nextID      int64
	eventSeq    int64
	formLinks   map[[2]int64]formLink // Base and view -> hash-only publication
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

// CreateInitializedBase does not expose a node before all default content is
// ready. The same lock protects permission checks and all published state.
func (m *Memory) CreateInitializedBase(ctx context.Context, ws, creator int64, parent *int64, title string) (DocMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return DocMeta{}, err
	}
	if creator < 1 || creator > int64(len(m.users)) || !m.member(creator, ws) {
		return DocMeta{}, ErrForbidden
	}
	var parentID *int64
	if parent != nil {
		p := m.doc(*parent)
		if p == nil || p.deleted || p.meta.WorkspaceID != ws || RoleRank(m.roleLocked(creator, p)) < RoleRank(RoleView) {
			return DocMeta{}, ErrNotFound
		}
		id := *parent
		parentID = &id
	}
	now := time.Now()
	baseID := int64(len(m.d.docs) + 1)
	d := &memDoc{
		meta: DocMeta{ID: baseID, Kind: "base", WorkspaceID: ws, ParentID: parentID, Title: title, CreatorID: creator, CreatorName: m.users[creator-1].Name, CreatedAt: now, UpdatedAt: now},
		ids:  map[[2]int64]bool{}, snaps: map[int64][]byte{}, versions: map[int64]memVersion{},
	}
	field := Field{BaseID: baseID, Name: "文本", Type: "text", Position: 1, IsPrimary: true}
	view := View{BaseID: baseID, Name: "表格", Type: "grid", Config: json.RawMessage(`{}`), Pos: 1}
	records := make([]Record, 5)
	for i := range records {
		uid := creator
		records[i] = Record{BaseID: baseID, Cells: map[string]json.RawMessage{}, Position: float64(i + 1), CreatorID: &uid, CreatedAt: &now, UpdatedAt: &now}
	}
	if err := ctx.Err(); err != nil {
		return DocMeta{}, err
	}
	field.ID = m.id()
	view.ID = m.id()
	for i := range records {
		records[i].ID = m.id()
		records[i].Position = float64(records[i].ID)
	}
	m.d.docs = append(m.d.docs, d)
	m.b.fields = append(m.b.fields, field)
	m.b.views = append(m.b.views, view)
	m.b.records = append(m.b.records, records...)
	return d.meta, nil
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
	f.IsPrimary = true
	for _, existing := range m.b.fields {
		if existing.BaseID == f.BaseID {
			f.IsPrimary = false
			if existing.IsPrimary && f.Position != 0 && f.Position <= existing.Position {
				return Field{}, ErrPrimaryField
			}
		}
	}
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
			if x.IsPrimary && f.Position != x.Position {
				return Field{}, ErrPrimaryField
			}
			f.IsPrimary = x.IsPrimary
			if !f.IsPrimary && f.Position != x.Position {
				for _, primary := range m.b.fields {
					if primary.BaseID == f.BaseID && primary.IsPrimary && fieldBefore(x, primary) != fieldBefore(f, primary) {
						return Field{}, ErrPrimaryField
					}
				}
			}
			m.b.fields[i] = f
			return f, nil
		}
	}
	return Field{}, ErrNotFound
}

func (m *Memory) DeleteField(_ context.Context, base, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, field := range m.b.fields {
		if field.BaseID == base && field.ID == id && field.IsPrimary {
			return ErrPrimaryField
		}
	}
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

func (m *Memory) MoveRecord(_ context.Context, base, id int64, position float64) (Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, r := range m.b.records {
		if r.ID == id && r.BaseID == base {
			m.b.records[i].Position = position
			return m.b.records[i], nil
		}
	}
	return Record{}, ErrNotFound
}

func (m *Memory) AddRecordsBulk(_ context.Context, base int64, records []Record) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range records {
		r.ID = m.id()
		if r.Position == 0 {
			r.Position = float64(r.ID)
		}
		if r.Cells == nil {
			r.Cells = map[string]json.RawMessage{}
		}
		now := time.Now()
		r.CreatedAt, r.UpdatedAt = &now, &now
		r.BaseID = base
		m.b.records = append(m.b.records, r)
	}
	return nil
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
	return m.appendBtEventLocked(base, body), nil
}

// appendBtEventLocked appends to one base while the caller holds m.mu.
func (m *Memory) appendBtEventLocked(base int64, body json.RawMessage) int64 {
	if m.b.events == nil {
		m.b.events = make(map[int64][]BtEvent)
	}
	m.b.eventSeq++
	m.b.events[base] = append(m.b.events[base], BtEvent{Seq: m.b.eventSeq, Body: slices.Clone(body)})
	return m.b.eventSeq
}

func (m *Memory) BtEventsAfter(_ context.Context, base, after int64, limit int) ([]BtEvent, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []BtEvent
	if limit <= 0 {
		return out, nil
	}
	for _, e := range m.b.events[base] {
		if e.Seq > after {
			e.Body = slices.Clone(e.Body)
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
	events := m.b.events[base]
	if len(events) == 0 {
		return 0, nil
	}
	return events[len(events)-1].Seq, nil
}
