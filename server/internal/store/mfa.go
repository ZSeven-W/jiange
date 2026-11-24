package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// UserMFAState stores a user's encrypted TOTP secret, enrollment status,
// and hashed one-time recovery codes.
type UserMFAState struct {
	UserID            int64      `json:"userId"`
	SecretEnc         []byte     `json:"-"`
	Enabled           bool       `json:"enabled"`
	RecoveryCodesHash []string   `json:"-"`
	EnabledAt         *time.Time `json:"enabledAt,omitempty"`
	UpdatedAt         time.Time  `json:"updatedAt"`
}

// MFAStore persists per-user TOTP MFA state and short-lived login challenges.
type MFAStore interface {
	GetUserMFA(ctx context.Context, userID int64) (UserMFAState, error)
	UpsertUserMFA(ctx context.Context, state UserMFAState) error
	DeleteUserMFA(ctx context.Context, userID int64) error
	CreateMFAChallenge(ctx context.Context, tokenHash []byte, userID int64, expiresAt time.Time) error
	PeekMFAChallenge(ctx context.Context, tokenHash []byte, now time.Time) (int64, error)
	ConsumeMFAChallenge(ctx context.Context, tokenHash []byte, now time.Time) (int64, error)
	GetUserByIDForMFA(ctx context.Context, userID int64) (User, error)
}

var (
	_ MFAStore = (*Memory)(nil)
	_ MFAStore = (*Postgres)(nil)
)

type memMFAChallenge struct {
	userID    int64
	expiresAt time.Time
}

// memMFA holds in-memory TOTP MFA settings and challenges for Memory store.
type memMFA struct {
	users      map[int64]UserMFAState
	challenges map[string]memMFAChallenge
}

func cloneUserMFAState(in UserMFAState) UserMFAState {
	out := in
	if in.SecretEnc != nil {
		out.SecretEnc = append([]byte(nil), in.SecretEnc...)
	}
	if in.RecoveryCodesHash != nil {
		out.RecoveryCodesHash = append([]string(nil), in.RecoveryCodesHash...)
	} else {
		out.RecoveryCodesHash = []string{}
	}
	if in.EnabledAt != nil {
		ts := *in.EnabledAt
		out.EnabledAt = &ts
	}
	return out
}

func (m *Memory) ensureMFAInitLocked() {
	if m.mfa.users == nil {
		m.mfa.users = map[int64]UserMFAState{}
	}
	if m.mfa.challenges == nil {
		m.mfa.challenges = map[string]memMFAChallenge{}
	}
}

func (m *Memory) findUserByIDLocked(userID int64) (User, bool) {
	for _, u := range m.users {
		if u.ID == userID {
			return u, true
		}
	}
	return User{}, false
}

func (m *Memory) GetUserMFA(_ context.Context, userID int64) (UserMFAState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.mfa.users == nil {
		return UserMFAState{}, ErrNotFound
	}
	st, ok := m.mfa.users[userID]
	if !ok {
		return UserMFAState{}, ErrNotFound
	}
	return cloneUserMFAState(st), nil
}

func (m *Memory) UpsertUserMFA(_ context.Context, state UserMFAState) error {
	if state.UserID <= 0 || len(state.SecretEnc) == 0 {
		return ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.findUserByIDLocked(state.UserID); !ok {
		return ErrNotFound
	}
	m.ensureMFAInitLocked()
	cloned := cloneUserMFAState(state)
	if cloned.UpdatedAt.IsZero() {
		cloned.UpdatedAt = time.Now().UTC()
	}
	m.mfa.users[state.UserID] = cloned
	return nil
}

func (m *Memory) DeleteUserMFA(_ context.Context, userID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.mfa.users != nil {
		delete(m.mfa.users, userID)
	}
	for k, ch := range m.mfa.challenges {
		if ch.userID == userID {
			delete(m.mfa.challenges, k)
		}
	}
	return nil
}

func (m *Memory) CreateMFAChallenge(_ context.Context, tokenHash []byte, userID int64, expiresAt time.Time) error {
	if len(tokenHash) == 0 || userID <= 0 {
		return ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.findUserByIDLocked(userID); !ok {
		return ErrNotFound
	}
	m.ensureMFAInitLocked()
	m.mfa.challenges[string(tokenHash)] = memMFAChallenge{
		userID:    userID,
		expiresAt: expiresAt,
	}
	return nil
}

func (m *Memory) PeekMFAChallenge(_ context.Context, tokenHash []byte, now time.Time) (int64, error) {
	if len(tokenHash) == 0 {
		return 0, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.mfa.challenges == nil {
		return 0, ErrNotFound
	}
	key := string(tokenHash)
	ch, ok := m.mfa.challenges[key]
	if !ok {
		return 0, ErrNotFound
	}
	if !now.Before(ch.expiresAt) {
		delete(m.mfa.challenges, key)
		return 0, ErrNotFound
	}
	return ch.userID, nil
}

func (m *Memory) ConsumeMFAChallenge(_ context.Context, tokenHash []byte, now time.Time) (int64, error) {
	if len(tokenHash) == 0 {
		return 0, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.mfa.challenges == nil {
		return 0, ErrNotFound
	}
	key := string(tokenHash)
	ch, ok := m.mfa.challenges[key]
	if !ok {
		return 0, ErrNotFound
	}
	delete(m.mfa.challenges, key)
	if !now.Before(ch.expiresAt) {
		return 0, ErrNotFound
	}
	return ch.userID, nil
}

func (m *Memory) GetUserByIDForMFA(_ context.Context, userID int64) (User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.findUserByIDLocked(userID)
	if !ok {
		return User{}, ErrNotFound
	}
	return u, nil
}

// --- Postgres implementation ---

func mfaPGError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" {
		return ErrNotFound
	}
	return err
}

func (p *Postgres) GetUserMFA(ctx context.Context, userID int64) (UserMFAState, error) {
	var st UserMFAState
	var codesRaw []byte
	err := p.Pool.QueryRow(ctx,
		`SELECT user_id, secret_enc, enabled, recovery_codes_hash, enabled_at, updated_at
		   FROM user_mfa
		  WHERE user_id = $1`, userID,
	).Scan(&st.UserID, &st.SecretEnc, &st.Enabled, &codesRaw, &st.EnabledAt, &st.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return UserMFAState{}, ErrNotFound
	}
	if err != nil {
		return UserMFAState{}, err
	}
	st.RecoveryCodesHash = []string{}
	if len(codesRaw) > 0 {
		if err := json.Unmarshal(codesRaw, &st.RecoveryCodesHash); err != nil {
			return UserMFAState{}, err
		}
		if st.RecoveryCodesHash == nil {
			st.RecoveryCodesHash = []string{}
		}
	}
	return st, nil
}

func (p *Postgres) UpsertUserMFA(ctx context.Context, state UserMFAState) error {
	if state.UserID <= 0 || len(state.SecretEnc) == 0 {
		return ErrConflict
	}
	codes := state.RecoveryCodesHash
	if codes == nil {
		codes = []string{}
	}
	codesJSON, err := json.Marshal(codes)
	if err != nil {
		return err
	}
	updatedAt := state.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = time.Now().UTC()
	}
	_, err = p.Pool.Exec(ctx,
		`INSERT INTO user_mfa (user_id, secret_enc, enabled, recovery_codes_hash, enabled_at, updated_at)
		 VALUES ($1, $2, $3, $4::jsonb, $5, $6)
		 ON CONFLICT (user_id) DO UPDATE SET
		     secret_enc          = EXCLUDED.secret_enc,
		     enabled             = EXCLUDED.enabled,
		     recovery_codes_hash = EXCLUDED.recovery_codes_hash,
		     enabled_at          = EXCLUDED.enabled_at,
		     updated_at          = EXCLUDED.updated_at`,
		state.UserID, state.SecretEnc, state.Enabled, codesJSON, state.EnabledAt, updatedAt,
	)
	return mfaPGError(err)
}

func (p *Postgres) DeleteUserMFA(ctx context.Context, userID int64) error {
	return pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM mfa_challenges WHERE user_id = $1`, userID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM user_mfa WHERE user_id = $1`, userID)
		return err
	})
}

func (p *Postgres) CreateMFAChallenge(ctx context.Context, tokenHash []byte, userID int64, expiresAt time.Time) error {
	if len(tokenHash) == 0 || userID <= 0 {
		return ErrConflict
	}
	_, err := p.Pool.Exec(ctx,
		`INSERT INTO mfa_challenges (token_hash, user_id, expires_at)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (token_hash) DO UPDATE SET
		     user_id    = EXCLUDED.user_id,
		     expires_at = EXCLUDED.expires_at`,
		tokenHash, userID, expiresAt,
	)
	return mfaPGError(err)
}

func (p *Postgres) PeekMFAChallenge(ctx context.Context, tokenHash []byte, now time.Time) (int64, error) {
	if len(tokenHash) == 0 {
		return 0, ErrNotFound
	}
	var userID int64
	err := p.Pool.QueryRow(ctx,
		`SELECT user_id FROM mfa_challenges WHERE token_hash = $1 AND expires_at > $2`,
		tokenHash, now,
	).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return userID, err
}

func (p *Postgres) ConsumeMFAChallenge(ctx context.Context, tokenHash []byte, now time.Time) (int64, error) {
	if len(tokenHash) == 0 {
		return 0, ErrNotFound
	}
	var userID int64
	var expiresAt time.Time
	err := p.Pool.QueryRow(ctx,
		`DELETE FROM mfa_challenges WHERE token_hash = $1 RETURNING user_id, expires_at`,
		tokenHash,
	).Scan(&userID, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	if !now.Before(expiresAt) {
		return 0, ErrNotFound
	}
	return userID, nil
}

func (p *Postgres) GetUserByIDForMFA(ctx context.Context, userID int64) (u User, err error) {
	err = p.Pool.QueryRow(ctx,
		`SELECT id, email, name, password_hash, created_at FROM users WHERE id = $1`, userID,
	).Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return u, err
}
