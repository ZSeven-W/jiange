package store

import (
	"bytes"
	"context"
	"errors"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	WebAuthnPurposeRegister = "register"
	WebAuthnPurposeLogin    = "login"
	MaxPasskeysPerUser      = 32
	MaxPasskeyNameRunes     = 80
	MaxPasskeyAAGUIDRunes   = 64
)

// UserPasskey stores a registered FIDO2 / WebAuthn credential belonging to a user.
type UserPasskey struct {
	ID            int64      `json:"id"`
	UserID        int64      `json:"userId"`
	CredentialID  []byte     `json:"-"`
	PublicKeyCOSE []byte     `json:"-"`
	SignCount     int64      `json:"signCount"`
	AAGUID        string     `json:"aaguid"`
	Transports    []string   `json:"transports"`
	Name          string     `json:"name"`
	CreatedAt     time.Time  `json:"createdAt"`
	LastUsedAt    *time.Time `json:"lastUsedAt"`
}

// WebAuthnChallenge stores a single-use short-lived WebAuthn registration or login challenge.
type WebAuthnChallenge struct {
	Challenge string    `json:"challenge"`
	UserID    *int64    `json:"userId,omitempty"`
	Purpose   string    `json:"purpose"`
	RPID      string    `json:"rpId"`
	Origin    string    `json:"origin"`
	ExpiresAt time.Time `json:"expiresAt"`
	CreatedAt time.Time `json:"createdAt"`
}

// PasskeyStore persists WebAuthn passkeys and single-use challenges.
type PasskeyStore interface {
	CreateWebAuthnChallenge(ctx context.Context, ch WebAuthnChallenge) error
	ConsumeWebAuthnChallenge(ctx context.Context, challenge, purpose string, now time.Time) (WebAuthnChallenge, error)
	CreateUserPasskey(ctx context.Context, pk UserPasskey) (UserPasskey, error)
	ListUserPasskeys(ctx context.Context, userID int64) ([]UserPasskey, error)
	GetUserPasskeyByCredentialID(ctx context.Context, credentialID []byte) (UserPasskey, error)
	UpdateUserPasskeySignCount(ctx context.Context, id int64, signCount int64, lastUsedAt time.Time) error
	DeleteUserPasskey(ctx context.Context, userID, id int64) error
}

var (
	_ PasskeyStore = (*Memory)(nil)
	_ PasskeyStore = (*Postgres)(nil)
)

// memPasskeys holds in-memory WebAuthn credentials and challenges for Memory store.
type memPasskeys struct {
	nextID     int64
	items      []UserPasskey
	challenges map[string]WebAuthnChallenge
}

func normalizePasskeyName(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "Passkey"
	}
	if utf8.RuneCountInString(trimmed) <= MaxPasskeyNameRunes {
		return trimmed
	}
	var b strings.Builder
	b.Grow(len(trimmed))
	n := 0
	for _, r := range trimmed {
		if n >= MaxPasskeyNameRunes {
			break
		}
		b.WriteRune(r)
		n++
	}
	return b.String()
}

func normalizePasskeyTransports(raw []string) []string {
	out := make([]string, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))
	for _, entry := range raw {
		clean := strings.ToLower(strings.TrimSpace(entry))
		if clean == "" || len(clean) > 32 {
			continue
		}
		if _, dup := seen[clean]; dup {
			continue
		}
		seen[clean] = struct{}{}
		out = append(out, clean)
		if len(out) >= 16 {
			break
		}
	}
	return out
}

func validWebAuthnPurpose(purpose string) bool {
	return purpose == WebAuthnPurposeRegister || purpose == WebAuthnPurposeLogin
}

func cloneUserPasskey(in UserPasskey) UserPasskey {
	out := in
	if in.CredentialID != nil {
		out.CredentialID = append([]byte(nil), in.CredentialID...)
	}
	if in.PublicKeyCOSE != nil {
		out.PublicKeyCOSE = append([]byte(nil), in.PublicKeyCOSE...)
	}
	if len(in.Transports) == 0 {
		out.Transports = []string{}
	} else {
		out.Transports = append([]string(nil), in.Transports...)
	}
	if in.LastUsedAt != nil {
		ts := in.LastUsedAt.UTC()
		out.LastUsedAt = &ts
	}
	out.CreatedAt = in.CreatedAt.UTC()
	return out
}

func cloneWebAuthnChallenge(in WebAuthnChallenge) WebAuthnChallenge {
	out := in
	if in.UserID != nil {
		uid := *in.UserID
		out.UserID = &uid
	}
	out.ExpiresAt = in.ExpiresAt.UTC()
	out.CreatedAt = in.CreatedAt.UTC()
	return out
}

// --- Memory implementation ---

func (m *Memory) CreateWebAuthnChallenge(ctx context.Context, ch WebAuthnChallenge) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	ch.Challenge = strings.TrimSpace(ch.Challenge)
	if ch.Challenge == "" || !validWebAuthnPurpose(ch.Purpose) || ch.ExpiresAt.IsZero() {
		return ErrConflict
	}
	if ch.UserID != nil && *ch.UserID <= 0 {
		return ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if ch.UserID != nil {
		if _, ok := m.findUserByIDLocked(*ch.UserID); !ok {
			return ErrNotFound
		}
	}
	if m.enterprise.passkeys.challenges == nil {
		m.enterprise.passkeys.challenges = map[string]WebAuthnChallenge{}
	}
	if ch.CreatedAt.IsZero() {
		ch.CreatedAt = time.Now().UTC()
	}
	m.enterprise.passkeys.challenges[ch.Challenge] = cloneWebAuthnChallenge(ch)
	return nil
}

func (m *Memory) ConsumeWebAuthnChallenge(ctx context.Context, challenge, purpose string, now time.Time) (WebAuthnChallenge, error) {
	if err := ctx.Err(); err != nil {
		return WebAuthnChallenge{}, err
	}
	challenge = strings.TrimSpace(challenge)
	if challenge == "" || !validWebAuthnPurpose(purpose) {
		return WebAuthnChallenge{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.enterprise.passkeys.challenges == nil {
		return WebAuthnChallenge{}, ErrNotFound
	}
	ch, ok := m.enterprise.passkeys.challenges[challenge]
	if !ok || ch.Purpose != purpose {
		return WebAuthnChallenge{}, ErrNotFound
	}
	delete(m.enterprise.passkeys.challenges, challenge)
	if !now.Before(ch.ExpiresAt) {
		return WebAuthnChallenge{}, ErrNotFound
	}
	return cloneWebAuthnChallenge(ch), nil
}

func (m *Memory) CreateUserPasskey(ctx context.Context, pk UserPasskey) (UserPasskey, error) {
	if err := ctx.Err(); err != nil {
		return UserPasskey{}, err
	}
	if pk.UserID <= 0 || len(pk.CredentialID) == 0 || len(pk.PublicKeyCOSE) == 0 || pk.SignCount < 0 {
		return UserPasskey{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.findUserByIDLocked(pk.UserID); !ok {
		return UserPasskey{}, ErrNotFound
	}
	userCount := 0
	for _, existing := range m.enterprise.passkeys.items {
		if bytes.Equal(existing.CredentialID, pk.CredentialID) {
			return UserPasskey{}, ErrConflict
		}
		if existing.UserID == pk.UserID {
			userCount++
		}
	}
	if userCount >= MaxPasskeysPerUser {
		return UserPasskey{}, ErrConflict
	}
	m.enterprise.passkeys.nextID++
	pk.ID = m.enterprise.passkeys.nextID
	pk.Name = normalizePasskeyName(pk.Name)
	pk.AAGUID = clampAuditRunes(pk.AAGUID, MaxPasskeyAAGUIDRunes)
	pk.Transports = normalizePasskeyTransports(pk.Transports)
	if pk.CreatedAt.IsZero() {
		pk.CreatedAt = time.Now().UTC()
	} else {
		pk.CreatedAt = pk.CreatedAt.UTC()
	}
	saved := cloneUserPasskey(pk)
	m.enterprise.passkeys.items = append(m.enterprise.passkeys.items, saved)
	return cloneUserPasskey(saved), nil
}

func (m *Memory) ListUserPasskeys(ctx context.Context, userID int64) ([]UserPasskey, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if userID <= 0 {
		return []UserPasskey{}, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]UserPasskey, 0)
	for _, pk := range m.enterprise.passkeys.items {
		if pk.UserID == userID {
			out = append(out, cloneUserPasskey(pk))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID > out[j].ID
	})
	return out, nil
}

func (m *Memory) GetUserPasskeyByCredentialID(ctx context.Context, credentialID []byte) (UserPasskey, error) {
	if err := ctx.Err(); err != nil {
		return UserPasskey{}, err
	}
	if len(credentialID) == 0 {
		return UserPasskey{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, pk := range m.enterprise.passkeys.items {
		if bytes.Equal(pk.CredentialID, credentialID) {
			return cloneUserPasskey(pk), nil
		}
	}
	return UserPasskey{}, ErrNotFound
}

func (m *Memory) UpdateUserPasskeySignCount(ctx context.Context, id int64, signCount int64, lastUsedAt time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if id <= 0 || signCount < 0 {
		return ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.enterprise.passkeys.items {
		if m.enterprise.passkeys.items[i].ID == id {
			m.enterprise.passkeys.items[i].SignCount = signCount
			ts := lastUsedAt.UTC()
			if ts.IsZero() {
				ts = time.Now().UTC()
			}
			m.enterprise.passkeys.items[i].LastUsedAt = &ts
			return nil
		}
	}
	return ErrNotFound
}

func (m *Memory) DeleteUserPasskey(ctx context.Context, userID, id int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if userID <= 0 || id <= 0 {
		return ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, pk := range m.enterprise.passkeys.items {
		if pk.ID == id && pk.UserID == userID {
			m.enterprise.passkeys.items = append(m.enterprise.passkeys.items[:i], m.enterprise.passkeys.items[i+1:]...)
			return nil
		}
	}
	return ErrNotFound
}

// --- Postgres implementation ---

func passkeyPGError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505", "23514":
			return ErrConflict
		case "23503":
			return ErrNotFound
		}
	}
	return err
}

func (p *Postgres) CreateWebAuthnChallenge(ctx context.Context, ch WebAuthnChallenge) error {
	ch.Challenge = strings.TrimSpace(ch.Challenge)
	if ch.Challenge == "" || !validWebAuthnPurpose(ch.Purpose) || ch.ExpiresAt.IsZero() {
		return ErrConflict
	}
	if ch.UserID != nil && *ch.UserID <= 0 {
		return ErrConflict
	}
	createdAt := ch.CreatedAt.UTC()
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}
	_, err := p.Pool.Exec(ctx,
		`INSERT INTO webauthn_challenges (challenge, user_id, purpose, rp_id, origin, expires_at, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT (challenge) DO UPDATE SET
		     user_id    = EXCLUDED.user_id,
		     purpose    = EXCLUDED.purpose,
		     rp_id      = EXCLUDED.rp_id,
		     origin     = EXCLUDED.origin,
		     expires_at = EXCLUDED.expires_at,
		     created_at = EXCLUDED.created_at`,
		ch.Challenge, ch.UserID, ch.Purpose, ch.RPID, ch.Origin, ch.ExpiresAt.UTC(), createdAt,
	)
	return passkeyPGError(err)
}

func (p *Postgres) ConsumeWebAuthnChallenge(ctx context.Context, challenge, purpose string, now time.Time) (WebAuthnChallenge, error) {
	challenge = strings.TrimSpace(challenge)
	if challenge == "" || !validWebAuthnPurpose(purpose) {
		return WebAuthnChallenge{}, ErrNotFound
	}
	var out WebAuthnChallenge
	err := p.Pool.QueryRow(ctx,
		`DELETE FROM webauthn_challenges
		  WHERE challenge = $1 AND purpose = $2
		 RETURNING challenge, user_id, purpose, rp_id, origin, expires_at, created_at`,
		challenge, purpose,
	).Scan(&out.Challenge, &out.UserID, &out.Purpose, &out.RPID, &out.Origin, &out.ExpiresAt, &out.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return WebAuthnChallenge{}, ErrNotFound
	}
	if err != nil {
		return WebAuthnChallenge{}, err
	}
	if !now.Before(out.ExpiresAt) {
		return WebAuthnChallenge{}, ErrNotFound
	}
	return cloneWebAuthnChallenge(out), nil
}

func (p *Postgres) CreateUserPasskey(ctx context.Context, pk UserPasskey) (out UserPasskey, err error) {
	if pk.UserID <= 0 || len(pk.CredentialID) == 0 || len(pk.PublicKeyCOSE) == 0 || pk.SignCount < 0 {
		return UserPasskey{}, ErrConflict
	}
	name := normalizePasskeyName(pk.Name)
	aaguid := clampAuditRunes(pk.AAGUID, MaxPasskeyAAGUIDRunes)
	transports := normalizePasskeyTransports(pk.Transports)
	createdAt := pk.CreatedAt.UTC()
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}

	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var uid int64
		if e := tx.QueryRow(ctx, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, pk.UserID).Scan(&uid); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return e
		}
		var count int
		if e := tx.QueryRow(ctx, `SELECT COUNT(*) FROM user_passkeys WHERE user_id = $1`, pk.UserID).Scan(&count); e != nil {
			return e
		}
		if count >= MaxPasskeysPerUser {
			return ErrConflict
		}
		e := tx.QueryRow(ctx,
			`INSERT INTO user_passkeys (
				user_id, credential_id, public_key_cose, sign_count, aaguid, transports, name, created_at, last_used_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			RETURNING id, user_id, credential_id, public_key_cose, sign_count, aaguid, transports, name, created_at, last_used_at`,
			pk.UserID, pk.CredentialID, pk.PublicKeyCOSE, pk.SignCount, aaguid, transports, name, createdAt, pk.LastUsedAt,
		).Scan(
			&out.ID, &out.UserID, &out.CredentialID, &out.PublicKeyCOSE, &out.SignCount,
			&out.AAGUID, &out.Transports, &out.Name, &out.CreatedAt, &out.LastUsedAt,
		)
		if e != nil {
			return passkeyPGError(e)
		}
		out = cloneUserPasskey(out)
		return nil
	})
	return out, err
}

func (p *Postgres) ListUserPasskeys(ctx context.Context, userID int64) ([]UserPasskey, error) {
	if userID <= 0 {
		return []UserPasskey{}, nil
	}
	rows, err := p.Pool.Query(ctx,
		`SELECT id, user_id, credential_id, public_key_cose, sign_count, aaguid, transports, name, created_at, last_used_at
		   FROM user_passkeys
		  WHERE user_id = $1
		  ORDER BY created_at DESC, id DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	items, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (pk UserPasskey, err error) {
		err = r.Scan(
			&pk.ID, &pk.UserID, &pk.CredentialID, &pk.PublicKeyCOSE, &pk.SignCount,
			&pk.AAGUID, &pk.Transports, &pk.Name, &pk.CreatedAt, &pk.LastUsedAt,
		)
		if err == nil {
			pk = cloneUserPasskey(pk)
		}
		return
	})
	if err != nil {
		return nil, err
	}
	if items == nil {
		items = []UserPasskey{}
	}
	return items, nil
}

func (p *Postgres) GetUserPasskeyByCredentialID(ctx context.Context, credentialID []byte) (out UserPasskey, err error) {
	if len(credentialID) == 0 {
		return UserPasskey{}, ErrNotFound
	}
	err = p.Pool.QueryRow(ctx,
		`SELECT id, user_id, credential_id, public_key_cose, sign_count, aaguid, transports, name, created_at, last_used_at
		   FROM user_passkeys
		  WHERE credential_id = $1`,
		credentialID,
	).Scan(
		&out.ID, &out.UserID, &out.CredentialID, &out.PublicKeyCOSE, &out.SignCount,
		&out.AAGUID, &out.Transports, &out.Name, &out.CreatedAt, &out.LastUsedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return UserPasskey{}, ErrNotFound
	}
	if err != nil {
		return UserPasskey{}, err
	}
	return cloneUserPasskey(out), nil
}

func (p *Postgres) UpdateUserPasskeySignCount(ctx context.Context, id int64, signCount int64, lastUsedAt time.Time) error {
	if id <= 0 || signCount < 0 {
		return ErrConflict
	}
	ts := lastUsedAt.UTC()
	if ts.IsZero() {
		ts = time.Now().UTC()
	}
	tag, err := p.Pool.Exec(ctx,
		`UPDATE user_passkeys SET sign_count = $2, last_used_at = $3 WHERE id = $1`,
		id, signCount, ts,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) DeleteUserPasskey(ctx context.Context, userID, id int64) error {
	if userID <= 0 || id <= 0 {
		return ErrNotFound
	}
	tag, err := p.Pool.Exec(ctx,
		`DELETE FROM user_passkeys WHERE id = $1 AND user_id = $2`,
		id, userID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
