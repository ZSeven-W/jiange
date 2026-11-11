package store

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
)

// AISettings is a user's own AI provider configuration. APIKeyCipher is
// encrypted by the API layer; the store never sees the plaintext key.
type AISettings struct {
	UserID       int64
	BaseURL      string
	Model        string
	APIKeyCipher []byte
	KeyHint      string
	UpdatedAt    time.Time
}

type AIStore interface {
	// AISettings returns ErrNotFound when the user has not configured AI.
	AISettings(ctx context.Context, userID int64) (AISettings, error)
	SetAISettings(ctx context.Context, s AISettings) error
	DeleteAISettings(ctx context.Context, userID int64) error
}

func (m *Memory) AISettings(ctx context.Context, userID int64) (AISettings, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.aiSettings[userID]
	if !ok {
		return AISettings{}, ErrNotFound
	}
	s.APIKeyCipher = slices.Clone(s.APIKeyCipher)
	return s, nil
}

func (m *Memory) SetAISettings(ctx context.Context, s AISettings) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.aiSettings == nil {
		m.aiSettings = map[int64]AISettings{}
	}
	s.APIKeyCipher = slices.Clone(s.APIKeyCipher)
	s.UpdatedAt = time.Now()
	m.aiSettings[s.UserID] = s
	return nil
}

func (m *Memory) DeleteAISettings(ctx context.Context, userID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.aiSettings, userID)
	return nil
}

func (p *Postgres) AISettings(ctx context.Context, userID int64) (AISettings, error) {
	s := AISettings{UserID: userID}
	err := p.Pool.QueryRow(ctx, `SELECT base_url,model,api_key_cipher,key_hint,updated_at FROM user_ai_settings WHERE user_id=$1`, userID).
		Scan(&s.BaseURL, &s.Model, &s.APIKeyCipher, &s.KeyHint, &s.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return AISettings{}, ErrNotFound
	}
	return s, err
}

func (p *Postgres) SetAISettings(ctx context.Context, s AISettings) error {
	_, err := p.Pool.Exec(ctx, `INSERT INTO user_ai_settings (user_id,base_url,model,api_key_cipher,key_hint) VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (user_id) DO UPDATE SET base_url=EXCLUDED.base_url,model=EXCLUDED.model,api_key_cipher=EXCLUDED.api_key_cipher,key_hint=EXCLUDED.key_hint,updated_at=now()`,
		s.UserID, s.BaseURL, s.Model, s.APIKeyCipher, s.KeyHint)
	return err
}

func (p *Postgres) DeleteAISettings(ctx context.Context, userID int64) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM user_ai_settings WHERE user_id=$1`, userID)
	return err
}
