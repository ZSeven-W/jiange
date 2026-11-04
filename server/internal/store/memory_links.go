package store

import (
	"context"
	"strconv"
)

func (m *Memory) SetLinks(_ context.Context, _, fieldID, fromRecord int64, toRecords []int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := [2]int64{fieldID, fromRecord}
	m.links[key] = append(m.links[key][:0], toRecords...)
	return nil
}

func (m *Memory) LinksForRecords(_ context.Context, fieldID int64, fromRecords []int64) (map[int64][]int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[int64][]int64{}
	for _, from := range fromRecords {
		if v, ok := m.links[[2]int64{fieldID, from}]; ok {
			out[from] = append(out[from], v...)
		}
	}
	return out, nil
}

func (m *Memory) LinkFieldsTargeting(_ context.Context, targetBase int64) ([]LinkFieldRef, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []LinkFieldRef{}
	for _, f := range m.b.fields {
		if f.Type == "link" && len(f.Options) > 0 && f.Options[0] == strconv.FormatInt(targetBase, 10) {
			out = append(out, LinkFieldRef{FieldID: f.ID, BaseID: f.BaseID})
		}
	}
	return out, nil
}
