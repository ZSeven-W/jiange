package store

import (
	"context"
	"time"
)

func (m *Memory) Automations(_ context.Context, base int64) ([]Automation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Automation{}
	for _, a := range m.automations {
		if a.BaseID == base {
			a.Config = append([]byte(nil), a.Config...)
			out = append(out, a)
		}
	}
	return out, nil
}

func (m *Memory) AllAutomations(_ context.Context) ([]Automation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := append([]Automation{}, m.automations...)
	for i := range out {
		out[i].Config = append([]byte(nil), out[i].Config...)
	}
	return out, nil
}

func (m *Memory) MarkFired(_ context.Context, id int64, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.automations {
		if m.automations[i].ID == id {
			m.automations[i].LastFiredAt = at
			return nil
		}
	}
	return ErrNotFound
}

func (m *Memory) AddAutomation(_ context.Context, a Automation) (Automation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextAutomationID++
	a.ID = m.nextAutomationID
	if a.Config == nil {
		a.Config = []byte("{}")
	}
	a.Config = append([]byte(nil), a.Config...)
	m.automations = append(m.automations, a)
	a.Config = append([]byte(nil), a.Config...)
	return a, nil
}

func (m *Memory) UpdateAutomation(_ context.Context, a Automation) (Automation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, x := range m.automations {
		if x.ID == a.ID && x.BaseID == a.BaseID {
			if a.Config == nil {
				a.Config = x.Config
			}
			a.Config = append([]byte(nil), a.Config...)
			m.automations[i] = a
			a.Config = append([]byte(nil), a.Config...)
			return a, nil
		}
	}
	return Automation{}, ErrNotFound
}

func (m *Memory) DeleteAutomation(_ context.Context, base, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := len(m.automations)
	out := m.automations[:0]
	for _, a := range m.automations {
		if a.ID != id || a.BaseID != base {
			out = append(out, a)
		}
	}
	m.automations = out
	if n == len(out) {
		return ErrNotFound
	}
	return nil
}
