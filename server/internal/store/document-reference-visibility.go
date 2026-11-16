package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// ReferenceVisibility controls only the display of the references section.
// It does not restrict reading document content or the references API.
type ReferenceVisibility struct {
	Visible  bool  `json:"visible"`
	Revision int64 `json:"revision"`
}
type ReferenceVisibilityStore interface {
	ReferenceVisibilityGuarded(context.Context, RestoreGuard, int64) (ReferenceVisibility, error)
	SetReferenceVisibilityGuarded(context.Context, RestoreGuard, int64, bool, int64) (ReferenceVisibility, error)
}

func (m *Memory) ReferenceVisibilityGuarded(ctx context.Context, g RestoreGuard, id int64) (ReferenceVisibility, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, expiry, err := m.checkIconAccessLocked(ctx, g, id, RoleView)
	if err != nil {
		return ReferenceVisibility{}, err
	}
	if err = driveMemoryEnd(ctx, g, expiry); err != nil {
		return ReferenceVisibility{}, err
	}
	return ReferenceVisibility{Visible: !d.referencesHidden, Revision: d.referencesRevision}, nil
}
func (m *Memory) SetReferenceVisibilityGuarded(ctx context.Context, g RestoreGuard, id int64, visible bool, expected int64) (ReferenceVisibility, error) {
	if expected < 0 || expected >= maxConditionalInteger {
		return ReferenceVisibility{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d, expiry, err := m.checkIconAccessLocked(ctx, g, id, RoleEdit)
	if err != nil {
		return ReferenceVisibility{}, err
	}
	if d.referencesRevision != expected {
		return ReferenceVisibility{}, ErrConflict
	}
	if err = driveMemoryEnd(ctx, g, expiry); err != nil {
		return ReferenceVisibility{}, err
	}
	if visible == !d.referencesHidden {
		return ReferenceVisibility{Visible: visible, Revision: expected}, nil
	}
	d.referencesHidden = !visible
	d.referencesRevision++
	return ReferenceVisibility{Visible: visible, Revision: d.referencesRevision}, nil
}

func referenceVisibilityTx(ctx context.Context, tx pgx.Tx, id int64) (ReferenceVisibility, error) {
	out := ReferenceVisibility{Visible: true}
	err := tx.QueryRow(ctx, `SELECT visible,revision FROM document_reference_visibility WHERE doc_id=$1`, id).Scan(&out.Visible, &out.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, nil
	}
	return out, err
}
func (p *Postgres) ReferenceVisibilityGuarded(ctx context.Context, g RestoreGuard, id int64) (out ReferenceVisibility, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expiry, e := lockIconAccess(ctx, tx, g, id, RoleView, false)
		if e != nil {
			return e
		}
		out, e = referenceVisibilityTx(ctx, tx, id)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, g, expiry)
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	if err != nil {
		return ReferenceVisibility{}, err
	}
	return out, nil
}
func (p *Postgres) SetReferenceVisibilityGuarded(ctx context.Context, g RestoreGuard, id int64, visible bool, expected int64) (out ReferenceVisibility, err error) {
	if expected < 0 || expected >= maxConditionalInteger {
		return ReferenceVisibility{}, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expiry, e := lockIconAccess(ctx, tx, g, id, RoleEdit, true)
		if e != nil {
			return e
		}
		current, e := referenceVisibilityTx(ctx, tx, id)
		if e != nil {
			return e
		}
		if current.Revision != expected {
			return ErrConflict
		}
		if current.Visible == visible {
			out = current
			return drivePGEnd(ctx, g, expiry)
		}
		_, e = tx.Exec(ctx, `INSERT INTO document_reference_visibility(doc_id,visible,revision) VALUES($1,$2,1) ON CONFLICT(doc_id) DO UPDATE SET visible=EXCLUDED.visible,revision=document_reference_visibility.revision+1`, id, visible)
		if e != nil {
			return e
		}
		out = ReferenceVisibility{Visible: visible, Revision: expected + 1}
		return drivePGEnd(ctx, g, expiry)
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	if err != nil {
		return ReferenceVisibility{}, err
	}
	return out, nil
}
