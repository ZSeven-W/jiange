package store

import (
	"bytes"
	"context"
	"encoding/json"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// sameAutomation excludes LastFiredAt: the scheduler may advance it while a
// user is editing a rule, and editing must not reset the schedule watermark.
func sameAutomation(a, b Automation) bool {
	return a.ID == b.ID && a.BaseID == b.BaseID && a.Name == b.Name &&
		a.Enabled == b.Enabled && a.TriggerKind == b.TriggerKind && bytes.Equal(a.Config, b.Config)
}

func validAutomationMutation(baseID int64, before, after *Automation) bool {
	if baseID <= 0 || (before == nil && after == nil) {
		return false
	}
	if before != nil && (before.BaseID != baseID || before.ID <= 0) {
		return false
	}
	if after == nil {
		return true
	}
	if after.BaseID != baseID || (before != nil && before.ID != after.ID) ||
		(before == nil && after.ID != 0) || !utf8.ValidString(after.Name) ||
		utf8.RuneCountInString(after.Name) < 1 || utf8.RuneCountInString(after.Name) > 100 {
		return false
	}
	if after.TriggerKind != "record_matches" && after.TriggerKind != "form_submit" && after.TriggerKind != "schedule" {
		return false
	}
	return len(after.Config) == 0 || json.Valid(after.Config)
}

// MutateAutomationGuarded changes exactly one rule and its reload event under
// the same authorization lock. It does not execute actions or send webhooks.
func (m *Memory) MutateAutomationGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, before, after *Automation) (Automation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !validAutomationMutation(baseID, before, after) {
		return Automation{}, ErrConflict
	}
	_, expires, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return Automation{}, err
	}
	index := -1
	if before != nil {
		for i, a := range m.automations {
			if a.BaseID == baseID && a.ID == before.ID {
				index = i
				break
			}
		}
		if index < 0 {
			return Automation{}, ErrNotFound
		}
		if !sameAutomation(m.automations[index], *before) {
			return Automation{}, ErrConflict
		}
	}
	if err := ctx.Err(); err != nil {
		return Automation{}, err
	}
	if !guard.currentTime().Before(expires) {
		return Automation{}, ErrUnauthenticated
	}
	if after == nil {
		m.automations = append(m.automations[:index], m.automations[index+1:]...)
		m.appendBtEventLocked(baseID, json.RawMessage(`{"kind":"reload"}`))
		return Automation{}, nil
	}
	a := *after
	if len(a.Config) == 0 {
		a.Config = []byte("{}")
	}
	a.Config = append([]byte(nil), a.Config...)
	if before == nil {
		m.nextAutomationID++
		a.ID = m.nextAutomationID
		a.LastFiredAt = a.LastFiredAt.UTC()
		m.automations = append(m.automations, a)
	} else {
		a.LastFiredAt = m.automations[index].LastFiredAt
		m.automations[index] = a
	}
	m.appendBtEventLocked(baseID, json.RawMessage(`{"kind":"reload"}`))
	a.Config = append([]byte(nil), a.Config...)
	return a, nil
}

func (p *Postgres) MutateAutomationGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, before, after *Automation) (result Automation, err error) {
	if !validAutomationMutation(baseID, before, after) {
		return Automation{}, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, err := lockBaseWrite(ctx, tx, guard, baseID)
		if err != nil {
			return err
		}
		var current Automation
		if before != nil {
			err = tx.QueryRow(ctx, `SELECT `+automationCols+` FROM bt_automations WHERE base_id=$1 AND id=$2 FOR UPDATE`, baseID, before.ID).
				Scan(&current.ID, &current.BaseID, &current.Name, &current.Enabled, &current.TriggerKind, &current.Config, &current.LastFiredAt)
			if err != nil {
				return notFound(err)
			}
			if !sameAutomation(current, *before) {
				return ErrConflict
			}
		}
		if after == nil {
			_, err = tx.Exec(ctx, `DELETE FROM bt_automations WHERE base_id=$1 AND id=$2`, baseID, before.ID)
		} else {
			result = *after
			if len(result.Config) == 0 {
				result.Config = []byte("{}")
			}
			if before == nil {
				err = tx.QueryRow(ctx, `INSERT INTO bt_automations (base_id,name,enabled,trigger_kind,config) VALUES ($1,$2,$3,$4,$5) RETURNING id,config`, baseID, result.Name, result.Enabled, result.TriggerKind, result.Config).Scan(&result.ID, &result.Config)
			} else {
				result.LastFiredAt = current.LastFiredAt
				err = tx.QueryRow(ctx, `UPDATE bt_automations SET name=$3,enabled=$4,trigger_kind=$5,config=$6 WHERE base_id=$1 AND id=$2 RETURNING config`, baseID, result.ID, result.Name, result.Enabled, result.TriggerKind, result.Config).Scan(&result.Config)
			}
		}
		if err != nil {
			return err
		}
		if err = pgViewReload(ctx, tx, baseID); err != nil {
			return err
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		return ctx.Err()
	})
	if err != nil {
		return Automation{}, err
	}
	return result, nil
}
