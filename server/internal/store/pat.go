package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const (
	PATScopeRead  = "read"
	PATScopeWrite = "write"
	PATScopeAdmin = "admin"

	MaxActivePATsPerUser = 50
	MaxPATNameRunes      = 80
	maxPATPrefixRunes    = 32
)

// PersonalAccessToken holds public metadata for a user's Personal Access Token (PAT).
// Token hashes and raw secrets are never serialized into this struct.
type PersonalAccessToken struct {
	ID          int64      `json:"id"`
	UserID      int64      `json:"userId"`
	Name        string     `json:"name"`
	TokenPrefix string     `json:"tokenPrefix"`
	Scopes      []string   `json:"scopes"`
	ExpiresAt   *time.Time `json:"expiresAt,omitempty"`
	LastUsedAt  *time.Time `json:"lastUsedAt,omitempty"`
	RevokedAt   *time.Time `json:"revokedAt,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
}

// PATAuthResult pairs an authenticated user with the matched Personal Access Token metadata.
type PATAuthResult struct {
	User  User
	Token PersonalAccessToken
}

// PATStore persists Personal Access Tokens for Bearer API authentication.
type PATStore interface {
	ListPersonalAccessTokens(ctx context.Context, userID int64) ([]PersonalAccessToken, error)
	CreatePersonalAccessToken(ctx context.Context, userID int64, name, tokenPrefix string, tokenHash []byte, scopes []string, expiresAt *time.Time) (PersonalAccessToken, error)
	RevokePersonalAccessToken(ctx context.Context, userID, tokenID int64, now time.Time) error
	AuthenticatePersonalAccessToken(ctx context.Context, tokenHash []byte, now time.Time) (PATAuthResult, error)
}

var (
	_ PATStore = (*Memory)(nil)
	_ PATStore = (*Postgres)(nil)
)

type memPATRecord struct {
	token PersonalAccessToken
	hash  []byte
}

// memPAT holds in-memory personal access tokens for Memory store.
type memPAT struct {
	nextID int64
	items  []memPATRecord
}

// NormalizePATScopes validates and canonicalizes a non-empty list of PAT scopes.
// Supported scopes are "read", "write", and "admin".
func NormalizePATScopes(scopes []string) ([]string, bool) {
	if len(scopes) == 0 {
		return nil, false
	}
	has := map[string]bool{}
	for _, raw := range scopes {
		s := strings.ToLower(strings.TrimSpace(raw))
		switch s {
		case PATScopeRead, PATScopeWrite, PATScopeAdmin:
			has[s] = true
		default:
			return nil, false
		}
	}
	order := []string{PATScopeRead, PATScopeWrite, PATScopeAdmin}
	out := make([]string, 0, len(has))
	for _, sc := range order {
		if has[sc] {
			out = append(out, sc)
		}
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}

func validatePATCreateArgs(name, tokenPrefix string, tokenHash []byte, scopes []string, expiresAt *time.Time) (string, string, []string, *time.Time, error) {
	trimmedName := strings.TrimSpace(name)
	if !utf8.ValidString(trimmedName) {
		return "", "", nil, nil, fmt.Errorf("%w: invalid token name", ErrConflict)
	}
	if n := utf8.RuneCountInString(trimmedName); n < 1 || n > MaxPATNameRunes {
		return "", "", nil, nil, fmt.Errorf("%w: token name must be 1-%d characters", ErrConflict, MaxPATNameRunes)
	}
	trimmedPrefix := strings.TrimSpace(tokenPrefix)
	if !utf8.ValidString(trimmedPrefix) {
		return "", "", nil, nil, fmt.Errorf("%w: invalid token prefix", ErrConflict)
	}
	if n := utf8.RuneCountInString(trimmedPrefix); n < 1 || n > maxPATPrefixRunes {
		return "", "", nil, nil, fmt.Errorf("%w: token prefix must be 1-%d characters", ErrConflict, maxPATPrefixRunes)
	}
	if len(tokenHash) == 0 {
		return "", "", nil, nil, fmt.Errorf("%w: token hash is required", ErrConflict)
	}
	normScopes, ok := NormalizePATScopes(scopes)
	if !ok {
		return "", "", nil, nil, fmt.Errorf("%w: scopes must be non-empty subset of read, write, admin", ErrConflict)
	}
	var exp *time.Time
	if expiresAt != nil {
		u := expiresAt.UTC()
		exp = &u
	}
	return trimmedName, trimmedPrefix, normScopes, exp, nil
}

func clonePATTimePtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	cp := t.UTC()
	return &cp
}

func clonePAT(t PersonalAccessToken) PersonalAccessToken {
	cp := t
	cp.CreatedAt = t.CreatedAt.UTC()
	cp.ExpiresAt = clonePATTimePtr(t.ExpiresAt)
	cp.LastUsedAt = clonePATTimePtr(t.LastUsedAt)
	cp.RevokedAt = clonePATTimePtr(t.RevokedAt)
	if t.Scopes != nil {
		cp.Scopes = append([]string(nil), t.Scopes...)
	} else {
		cp.Scopes = []string{}
	}
	return cp
}

func isPATActiveAt(t PersonalAccessToken, now time.Time) bool {
	if t.RevokedAt != nil {
		return false
	}
	if t.ExpiresAt != nil && !t.ExpiresAt.After(now) {
		return false
	}
	return true
}

func decodePATScopesJSON(raw []byte) []string {
	var scopes []string
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &scopes)
	}
	if scopes == nil {
		return []string{}
	}
	return scopes
}

// --- Memory implementation ---

func (m *Memory) findPATUserLocked(userID int64) (User, bool) {
	for _, u := range m.users {
		if u.ID == userID {
			return u, true
		}
	}
	return User{}, false
}

func (m *Memory) ListPersonalAccessTokens(_ context.Context, userID int64) ([]PersonalAccessToken, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	out := []PersonalAccessToken{}
	if userID <= 0 {
		return out, nil
	}
	for _, rec := range m.pat.items {
		if rec.token.UserID == userID {
			out = append(out, clonePAT(rec.token))
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

func (m *Memory) CreatePersonalAccessToken(
	_ context.Context,
	userID int64,
	name, tokenPrefix string,
	tokenHash []byte,
	scopes []string,
	expiresAt *time.Time,
) (PersonalAccessToken, error) {
	if userID <= 0 {
		return PersonalAccessToken{}, ErrNotFound
	}
	trimmedName, trimmedPrefix, normScopes, exp, err := validatePATCreateArgs(name, tokenPrefix, tokenHash, scopes, expiresAt)
	if err != nil {
		return PersonalAccessToken{}, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.findPATUserLocked(userID); !ok {
		return PersonalAccessToken{}, ErrNotFound
	}

	now := time.Now().UTC()
	activeCount := 0
	for _, rec := range m.pat.items {
		if bytes.Equal(rec.hash, tokenHash) {
			return PersonalAccessToken{}, fmt.Errorf("%w: duplicate token hash", ErrConflict)
		}
		if rec.token.UserID == userID && isPATActiveAt(rec.token, now) {
			activeCount++
		}
	}
	if activeCount >= MaxActivePATsPerUser {
		return PersonalAccessToken{}, fmt.Errorf("%w: maximum %d active personal access tokens reached", ErrConflict, MaxActivePATsPerUser)
	}

	m.pat.nextID++
	hashCopy := make([]byte, len(tokenHash))
	copy(hashCopy, tokenHash)

	tok := PersonalAccessToken{
		ID:          m.pat.nextID,
		UserID:      userID,
		Name:        trimmedName,
		TokenPrefix: trimmedPrefix,
		Scopes:      normScopes,
		ExpiresAt:   exp,
		CreatedAt:   now,
	}
	m.pat.items = append(m.pat.items, memPATRecord{
		token: tok,
		hash:  hashCopy,
	})
	return clonePAT(tok), nil
}

func (m *Memory) RevokePersonalAccessToken(_ context.Context, userID, tokenID int64, now time.Time) error {
	if userID <= 0 || tokenID <= 0 {
		return ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	for i := range m.pat.items {
		if m.pat.items[i].token.ID == tokenID && m.pat.items[i].token.UserID == userID {
			if m.pat.items[i].token.RevokedAt == nil {
				ts := now
				m.pat.items[i].token.RevokedAt = &ts
			}
			return nil
		}
	}
	return ErrNotFound
}

func (m *Memory) AuthenticatePersonalAccessToken(_ context.Context, tokenHash []byte, now time.Time) (PATAuthResult, error) {
	if len(tokenHash) == 0 {
		return PATAuthResult{}, ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	for i := range m.pat.items {
		if !bytes.Equal(m.pat.items[i].hash, tokenHash) {
			continue
		}
		if !isPATActiveAt(m.pat.items[i].token, now) {
			return PATAuthResult{}, ErrNotFound
		}
		u, ok := m.findPATUserLocked(m.pat.items[i].token.UserID)
		if !ok {
			return PATAuthResult{}, ErrNotFound
		}
		ts := now
		m.pat.items[i].token.LastUsedAt = &ts
		return PATAuthResult{
			User:  u,
			Token: clonePAT(m.pat.items[i].token),
		}, nil
	}
	return PATAuthResult{}, ErrNotFound
}

// --- Postgres implementation ---

func (p *Postgres) ListPersonalAccessTokens(ctx context.Context, userID int64) ([]PersonalAccessToken, error) {
	if userID <= 0 {
		return []PersonalAccessToken{}, nil
	}
	rows, err := p.Pool.Query(ctx,
		`SELECT id, user_id, name, token_prefix, scopes, expires_at, last_used_at, revoked_at, created_at
		   FROM personal_access_tokens
		  WHERE user_id = $1
		  ORDER BY created_at DESC, id DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []PersonalAccessToken{}
	for rows.Next() {
		var tok PersonalAccessToken
		var scopesRaw []byte
		if err := rows.Scan(
			&tok.ID,
			&tok.UserID,
			&tok.Name,
			&tok.TokenPrefix,
			&scopesRaw,
			&tok.ExpiresAt,
			&tok.LastUsedAt,
			&tok.RevokedAt,
			&tok.CreatedAt,
		); err != nil {
			return nil, err
		}
		tok.Scopes = decodePATScopesJSON(scopesRaw)
		out = append(out, clonePAT(tok))
	}
	return out, rows.Err()
}

func (p *Postgres) CreatePersonalAccessToken(
	ctx context.Context,
	userID int64,
	name, tokenPrefix string,
	tokenHash []byte,
	scopes []string,
	expiresAt *time.Time,
) (PersonalAccessToken, error) {
	if userID <= 0 {
		return PersonalAccessToken{}, ErrNotFound
	}
	trimmedName, trimmedPrefix, normScopes, exp, err := validatePATCreateArgs(name, tokenPrefix, tokenHash, scopes, expiresAt)
	if err != nil {
		return PersonalAccessToken{}, err
	}
	scopesJSON, err := json.Marshal(normScopes)
	if err != nil {
		return PersonalAccessToken{}, err
	}

	var created PersonalAccessToken
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var exists int
		if err := tx.QueryRow(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, userID).Scan(&exists); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		var activeCount int
		if err := tx.QueryRow(ctx,
			`SELECT COUNT(*)
			   FROM personal_access_tokens
			  WHERE user_id = $1
			    AND revoked_at IS NULL
			    AND (expires_at IS NULL OR expires_at > now())`,
			userID,
		).Scan(&activeCount); err != nil {
			return err
		}
		if activeCount >= MaxActivePATsPerUser {
			return fmt.Errorf("%w: maximum %d active personal access tokens reached", ErrConflict, MaxActivePATsPerUser)
		}
		var scopesRaw []byte
		if err := tx.QueryRow(ctx,
			`INSERT INTO personal_access_tokens (user_id, name, token_prefix, token_hash, scopes, expires_at)
			 VALUES ($1, $2, $3, $4, $5::jsonb, $6)
			 RETURNING id, user_id, name, token_prefix, scopes, expires_at, last_used_at, revoked_at, created_at`,
			userID, trimmedName, trimmedPrefix, tokenHash, scopesJSON, exp,
		).Scan(
			&created.ID,
			&created.UserID,
			&created.Name,
			&created.TokenPrefix,
			&scopesRaw,
			&created.ExpiresAt,
			&created.LastUsedAt,
			&created.RevokedAt,
			&created.CreatedAt,
		); err != nil {
			return err
		}
		created.Scopes = decodePATScopesJSON(scopesRaw)
		return nil
	})
	if isUnique(err) {
		return PersonalAccessToken{}, fmt.Errorf("%w: duplicate token hash", ErrConflict)
	}
	if err != nil {
		return PersonalAccessToken{}, err
	}
	return clonePAT(created), nil
}

func (p *Postgres) RevokePersonalAccessToken(ctx context.Context, userID, tokenID int64, now time.Time) error {
	if userID <= 0 || tokenID <= 0 {
		return ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}
	tag, err := p.Pool.Exec(ctx,
		`UPDATE personal_access_tokens
		    SET revoked_at = COALESCE(revoked_at, $3)
		  WHERE id = $1 AND user_id = $2`,
		tokenID, userID, now,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) AuthenticatePersonalAccessToken(ctx context.Context, tokenHash []byte, now time.Time) (PATAuthResult, error) {
	if len(tokenHash) == 0 {
		return PATAuthResult{}, ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}
	var res PATAuthResult
	var scopesRaw []byte
	err := p.Pool.QueryRow(ctx,
		`UPDATE personal_access_tokens t
		    SET last_used_at = $2
		   FROM users u
		  WHERE t.user_id = u.id
		    AND t.token_hash = $1
		    AND t.revoked_at IS NULL
		    AND (t.expires_at IS NULL OR t.expires_at > $2)
		 RETURNING u.id, u.email, u.name, u.password_hash, u.created_at,
		           t.id, t.user_id, t.name, t.token_prefix, t.scopes,
		           t.expires_at, t.last_used_at, t.revoked_at, t.created_at`,
		tokenHash, now,
	).Scan(
		&res.User.ID,
		&res.User.Email,
		&res.User.Name,
		&res.User.PasswordHash,
		&res.User.CreatedAt,
		&res.Token.ID,
		&res.Token.UserID,
		&res.Token.Name,
		&res.Token.TokenPrefix,
		&scopesRaw,
		&res.Token.ExpiresAt,
		&res.Token.LastUsedAt,
		&res.Token.RevokedAt,
		&res.Token.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return PATAuthResult{}, ErrNotFound
	}
	if err != nil {
		return PATAuthResult{}, err
	}
	res.Token.Scopes = decodePATScopesJSON(scopesRaw)
	res.Token = clonePAT(res.Token)
	return res, nil
}
