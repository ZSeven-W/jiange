package store

import (
	"context"
	"time"
)

// Automation is one bitable automation: when trigger fires and (for
// record_matches) the record matches config rules, notify config users with
// the message template ({{字段名}} interpolated from the record).
type Automation struct {
	ID          int64      `json:"id"`
	BaseID      int64      `json:"baseId"`
	Name        string     `json:"name"`
	Enabled     bool       `json:"enabled"`
	TriggerKind string     `json:"triggerKind"` // form_submit | record_matches | schedule
	Config      jsonConfig `json:"config"`
	// LastFiredAt persists the previous schedule firing (zero = never).
	LastFiredAt time.Time `json:"-"`
}

// jsonConfig keeps the automation config opaque at the store layer (the API
// layer owns its shape).
type jsonConfig = []byte

type AutomationStore interface {
	Automations(ctx context.Context, baseID int64) ([]Automation, error)
	// AllAutomations powers the schedule sweeper (every enabled schedule
	// automation across bases).
	AllAutomations(ctx context.Context) ([]Automation, error)
	AddAutomation(ctx context.Context, a Automation) (Automation, error)
	UpdateAutomation(ctx context.Context, a Automation) (Automation, error)
	DeleteAutomation(ctx context.Context, baseID, id int64) error
	MarkFired(ctx context.Context, id int64, at time.Time) error
	// MutateAutomationGuarded revalidates the caller and commits the automation
	// mutation with a Base reload event. Before protects against stale edits.
	MutateAutomationGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, before, after *Automation) (Automation, error)
}
