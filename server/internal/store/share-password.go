package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// memLinkPasswords holds in-memory share link password hashes for Memory store.
type memLinkPasswords struct {
	hashes map[int64]string
}

// SharePasswordStore persists per-document share link access password hashes.
type SharePasswordStore interface {
	// GetLinkPasswordHash returns the stored password hash for docID, or "" and nil when unset.
	GetLinkPasswordHash(ctx context.Context, docID int64) (string, error)
	// SetLinkPasswordGuarded verifies the caller's session and manage role on docID,
	// deleting the password row when passwordHash == "" or upserting it otherwise.
	SetLinkPasswordGuarded(ctx context.Context, guard RestoreGuard, docID int64, passwordHash string) error
}

var (
	_ SharePasswordStore = (*Memory)(nil)
	_ SharePasswordStore = (*Postgres)(nil)
)

func (m *Memory) GetLinkPasswordHash(ctx context.Context, docID int64) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.linkPasswords.hashes == nil {
		return "", nil
	}
	return m.linkPasswords.hashes[docID], nil
}

func (m *Memory) SetLinkPasswordGuarded(ctx context.Context, guard RestoreGuard, docID int64, passwordHash string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expiry, err := m.checkShareManagerLocked(ctx, guard, docID)
	if err != nil {
		return err
	}
	if !guard.currentTime().Before(expiry) {
		return ErrUnauthenticated
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if passwordHash == "" {
		if m.linkPasswords.hashes != nil {
			delete(m.linkPasswords.hashes, docID)
		}
		return nil
	}
	if m.linkPasswords.hashes == nil {
		m.linkPasswords.hashes = map[int64]string{}
	}
	m.linkPasswords.hashes[docID] = passwordHash
	return nil
}

func (p *Postgres) GetLinkPasswordHash(ctx context.Context, docID int64) (string, error) {
	var hash string
	err := p.Pool.QueryRow(ctx, `SELECT password_hash FROM doc_link_passwords WHERE doc_id=$1`, docID).Scan(&hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return hash, err
}

func (p *Postgres) SetLinkPasswordGuarded(ctx context.Context, guard RestoreGuard, docID int64, passwordHash string) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expiry, err := lockShareManager(ctx, tx, guard, docID)
		if err != nil {
			return err
		}
		if passwordHash == "" {
			if _, err := tx.Exec(ctx, `DELETE FROM doc_link_passwords WHERE doc_id=$1`, docID); err != nil {
				return err
			}
		} else {
			if _, err := tx.Exec(ctx, `INSERT INTO doc_link_passwords (doc_id, password_hash, updated_at) VALUES ($1, $2, now())
				ON CONFLICT (doc_id) DO UPDATE SET password_hash=EXCLUDED.password_hash, updated_at=now()`, docID, passwordHash); err != nil {
				return err
			}
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if retryableRestoreConflict(err) {
		return ErrConflict
	}
	return err
}
