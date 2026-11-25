package store

import (
	"context"
	"crypto/subtle"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	maxSessionUserAgentRunes = 256
	maxSessionIPAddressRunes = 128
)

// UserSession describes an active authenticated session for account self-service
// management without exposing the underlying session token or token hash.
type UserSession struct {
	ID         int64     `json:"id"`
	UserID     int64     `json:"userId"`
	UserAgent  string    `json:"userAgent"`
	IPAddress  string    `json:"ipAddress"`
	CreatedAt  time.Time `json:"createdAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
	Current    bool      `json:"current"`
}

// AccountSecurityStore persists session metadata/revocation, password updates,
// and single-use password reset tokens.
type AccountSecurityStore interface {
	UpdateSessionMetadata(ctx context.Context, tokenHash []byte, userAgent, ipAddress string, now time.Time) error
	TouchSession(ctx context.Context, tokenHash []byte, now time.Time) error
	ListUserSessions(ctx context.Context, userID int64, currentTokenHash []byte, now time.Time) ([]UserSession, error)
	RevokeUserSession(ctx context.Context, userID, sessionID int64) error
	RevokeOtherUserSessions(ctx context.Context, userID int64, keepTokenHash []byte) (int64, error)
	UpdateUserPasswordHash(ctx context.Context, userID int64, passwordHash string) error
	CreatePasswordResetToken(ctx context.Context, tokenHash []byte, userID int64, expiresAt time.Time) error
	ConsumePasswordResetToken(ctx context.Context, tokenHash []byte, now time.Time) (int64, error)
}

var (
	_ AccountSecurityStore = (*Memory)(nil)
	_ AccountSecurityStore = (*Postgres)(nil)
)

func clampSessionField(raw string, maxRunes int) string {
	clean := strings.TrimSpace(strings.ToValidUTF8(raw, ""))
	if maxRunes <= 0 || utf8.RuneCountInString(clean) <= maxRunes {
		return clean
	}
	var b strings.Builder
	b.Grow(len(clean))
	n := 0
	for _, r := range clean {
		if n >= maxRunes {
			break
		}
		b.WriteRune(r)
		n++
	}
	return b.String()
}

func normalizeStoreTime(now time.Time) time.Time {
	if now.IsZero() {
		return time.Now().UTC()
	}
	return now.UTC()
}

// --- Memory implementation ---

type memPasswordResetToken struct {
	userID    int64
	expiresAt time.Time
	usedAt    *time.Time
	createdAt time.Time
}

type memPasswordResetStore struct {
	mu     sync.Mutex
	tokens map[string]memPasswordResetToken
}

// memResetTokens binds per-Memory password reset token storage without adding fields to Memory.
var memResetTokens sync.Map // map[*Memory]*memPasswordResetStore

func (m *Memory) passwordResetStore() *memPasswordResetStore {
	if v, ok := memResetTokens.Load(m); ok {
		return v.(*memPasswordResetStore)
	}
	st := &memPasswordResetStore{
		tokens: make(map[string]memPasswordResetToken),
	}
	actual, _ := memResetTokens.LoadOrStore(m, st)
	return actual.(*memPasswordResetStore)
}

func (m *Memory) UpdateSessionMetadata(ctx context.Context, tokenHash []byte, userAgent, ipAddress string, now time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(tokenHash) == 0 {
		return ErrNotFound
	}
	ts := normalizeStoreTime(now)
	ua := clampSessionField(userAgent, maxSessionUserAgentRunes)
	ip := clampSessionField(ipAddress, maxSessionIPAddressRunes)

	m.mu.Lock()
	defer m.mu.Unlock()
	key := string(tokenHash)
	sess, ok := m.sessions[key]
	if !ok {
		return ErrNotFound
	}
	sess.userAgent = ua
	sess.ipAddress = ip
	sess.lastSeenAt = ts
	m.sessions[key] = sess
	return nil
}

func (m *Memory) TouchSession(ctx context.Context, tokenHash []byte, now time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(tokenHash) == 0 {
		return ErrNotFound
	}
	ts := normalizeStoreTime(now)

	m.mu.Lock()
	defer m.mu.Unlock()
	key := string(tokenHash)
	sess, ok := m.sessions[key]
	if !ok || !ts.Before(sess.expires) {
		return ErrNotFound
	}
	sess.lastSeenAt = ts
	m.sessions[key] = sess
	return nil
}

func (m *Memory) ListUserSessions(ctx context.Context, userID int64, currentTokenHash []byte, now time.Time) ([]UserSession, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	ts := normalizeStoreTime(now)

	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]UserSession, 0)
	for key, sess := range m.sessions {
		if sess.userID != userID || !ts.Before(sess.expires) {
			continue
		}
		isCurrent := len(currentTokenHash) > 0 && subtle.ConstantTimeCompare([]byte(key), currentTokenHash) == 1
		out = append(out, UserSession{
			ID:         sess.id,
			UserID:     sess.userID,
			UserAgent:  sess.userAgent,
			IPAddress:  sess.ipAddress,
			CreatedAt:  sess.createdAt.UTC(),
			LastSeenAt: sess.lastSeenAt.UTC(),
			ExpiresAt:  sess.expires.UTC(),
			Current:    isCurrent,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].LastSeenAt.Equal(out[j].LastSeenAt) {
			return out[i].LastSeenAt.After(out[j].LastSeenAt)
		}
		return out[i].ID > out[j].ID
	})
	return out, nil
}

func (m *Memory) RevokeUserSession(ctx context.Context, userID, sessionID int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if userID <= 0 || sessionID <= 0 {
		return ErrNotFound
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	for key, sess := range m.sessions {
		if sess.id == sessionID && sess.userID == userID {
			delete(m.sessions, key)
			return nil
		}
	}
	return ErrNotFound
}

func (m *Memory) RevokeOtherUserSessions(ctx context.Context, userID int64, keepTokenHash []byte) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if userID <= 0 {
		return 0, nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	var revoked int64
	for key, sess := range m.sessions {
		if sess.userID != userID {
			continue
		}
		if len(keepTokenHash) > 0 && subtle.ConstantTimeCompare([]byte(key), keepTokenHash) == 1 {
			continue
		}
		delete(m.sessions, key)
		revoked++
	}
	return revoked, nil
}

func (m *Memory) UpdateUserPasswordHash(ctx context.Context, userID int64, passwordHash string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if userID <= 0 || strings.TrimSpace(passwordHash) == "" {
		return ErrConflict
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.users {
		if m.users[i].ID == userID {
			m.users[i].PasswordHash = passwordHash
			return nil
		}
	}
	return ErrNotFound
}

func (m *Memory) CreatePasswordResetToken(ctx context.Context, tokenHash []byte, userID int64, expiresAt time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(tokenHash) == 0 || userID <= 0 || expiresAt.IsZero() {
		return ErrConflict
	}

	m.mu.Lock()
	_, exists := m.findUserByIDLocked(userID)
	m.mu.Unlock()
	if !exists {
		return ErrNotFound
	}

	rs := m.passwordResetStore()
	rs.mu.Lock()
	defer rs.mu.Unlock()
	key := string(tokenHash)
	if _, dup := rs.tokens[key]; dup {
		return ErrConflict
	}
	rs.tokens[key] = memPasswordResetToken{
		userID:    userID,
		expiresAt: expiresAt.UTC(),
		createdAt: time.Now().UTC(),
	}
	return nil
}

func (m *Memory) ConsumePasswordResetToken(ctx context.Context, tokenHash []byte, now time.Time) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if len(tokenHash) == 0 {
		return 0, ErrNotFound
	}
	ts := normalizeStoreTime(now)

	rs := m.passwordResetStore()
	rs.mu.Lock()
	defer rs.mu.Unlock()
	key := string(tokenHash)
	tok, ok := rs.tokens[key]
	if !ok || tok.usedAt != nil || !ts.Before(tok.expiresAt) {
		return 0, ErrNotFound
	}
	used := ts
	tok.usedAt = &used
	rs.tokens[key] = tok
	return tok.userID, nil
}

// --- Postgres implementation ---

func (p *Postgres) UpdateSessionMetadata(ctx context.Context, tokenHash []byte, userAgent, ipAddress string, now time.Time) error {
	if len(tokenHash) == 0 {
		return ErrNotFound
	}
	ts := normalizeStoreTime(now)
	ua := clampSessionField(userAgent, maxSessionUserAgentRunes)
	ip := clampSessionField(ipAddress, maxSessionIPAddressRunes)

	tag, err := p.Pool.Exec(ctx,
		`UPDATE sessions
		    SET user_agent = $2, ip_address = $3, last_seen_at = $4
		  WHERE token_hash = $1`,
		tokenHash, ua, ip, ts,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) TouchSession(ctx context.Context, tokenHash []byte, now time.Time) error {
	if len(tokenHash) == 0 {
		return ErrNotFound
	}
	ts := normalizeStoreTime(now)

	tag, err := p.Pool.Exec(ctx,
		`UPDATE sessions
		    SET last_seen_at = $2
		  WHERE token_hash = $1 AND expires_at > $2`,
		tokenHash, ts,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) ListUserSessions(ctx context.Context, userID int64, currentTokenHash []byte, now time.Time) ([]UserSession, error) {
	ts := normalizeStoreTime(now)
	var curHash []byte
	if len(currentTokenHash) > 0 {
		curHash = currentTokenHash
	}

	rows, err := p.Pool.Query(ctx,
		`SELECT id, user_id, user_agent, ip_address, created_at, last_seen_at, expires_at,
		        ($3::bytea IS NOT NULL AND octet_length($3::bytea) > 0 AND token_hash = $3::bytea) AS is_current
		   FROM sessions
		  WHERE user_id = $1 AND expires_at > $2
		  ORDER BY last_seen_at DESC, id DESC`,
		userID, ts, curHash,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]UserSession, 0)
	for rows.Next() {
		var item UserSession
		if err := rows.Scan(
			&item.ID,
			&item.UserID,
			&item.UserAgent,
			&item.IPAddress,
			&item.CreatedAt,
			&item.LastSeenAt,
			&item.ExpiresAt,
			&item.Current,
		); err != nil {
			return nil, err
		}
		item.CreatedAt = item.CreatedAt.UTC()
		item.LastSeenAt = item.LastSeenAt.UTC()
		item.ExpiresAt = item.ExpiresAt.UTC()
		out = append(out, item)
	}
	return out, rows.Err()
}

func (p *Postgres) RevokeUserSession(ctx context.Context, userID, sessionID int64) error {
	if userID <= 0 || sessionID <= 0 {
		return ErrNotFound
	}
	tag, err := p.Pool.Exec(ctx,
		`DELETE FROM sessions WHERE id = $1 AND user_id = $2`,
		sessionID, userID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) RevokeOtherUserSessions(ctx context.Context, userID int64, keepTokenHash []byte) (int64, error) {
	if userID <= 0 {
		return 0, nil
	}
	if len(keepTokenHash) == 0 {
		tag, err := p.Pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID)
		if err != nil {
			return 0, err
		}
		return tag.RowsAffected(), nil
	}
	tag, err := p.Pool.Exec(ctx,
		`DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2`,
		userID, keepTokenHash,
	)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (p *Postgres) UpdateUserPasswordHash(ctx context.Context, userID int64, passwordHash string) error {
	if userID <= 0 || strings.TrimSpace(passwordHash) == "" {
		return ErrConflict
	}
	tag, err := p.Pool.Exec(ctx,
		`UPDATE users SET password_hash = $2 WHERE id = $1`,
		userID, passwordHash,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) CreatePasswordResetToken(ctx context.Context, tokenHash []byte, userID int64, expiresAt time.Time) error {
	if len(tokenHash) == 0 || userID <= 0 || expiresAt.IsZero() {
		return ErrConflict
	}
	_, err := p.Pool.Exec(ctx,
		`INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
		tokenHash, userID, expiresAt.UTC(),
	)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			switch pgErr.Code {
			case "23503":
				return ErrNotFound
			case "23505":
				return ErrConflict
			}
		}
		return err
	}
	return nil
}

func (p *Postgres) ConsumePasswordResetToken(ctx context.Context, tokenHash []byte, now time.Time) (int64, error) {
	if len(tokenHash) == 0 {
		return 0, ErrNotFound
	}
	ts := normalizeStoreTime(now)

	var userID int64
	err := p.Pool.QueryRow(ctx,
		`UPDATE password_reset_tokens
		    SET used_at = $2
		  WHERE token_hash = $1
		    AND used_at IS NULL
		    AND expires_at > $2
		  RETURNING user_id`,
		tokenHash, ts,
	).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return userID, err
}
