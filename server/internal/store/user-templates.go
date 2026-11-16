package store

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// UserTemplate is a personal document template (Markdown body).
type UserTemplate struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"createdAt"`
}

// MaxUserTemplates bounds templates per user.
const MaxUserTemplates = 100

var ErrTooManyTemplates = errors.New("store: too many templates")

type TemplateStore interface {
	UserTemplates(ctx context.Context, userID int64) ([]UserTemplate, error)
	AddUserTemplate(ctx context.Context, userID int64, name, body string) (UserTemplate, error)
	DeleteUserTemplate(ctx context.Context, userID, id int64) error
}

type memTemplate struct {
	user int64
	t    UserTemplate
}

func (m *Memory) UserTemplates(ctx context.Context, userID int64) ([]UserTemplate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []UserTemplate{}
	for _, t := range m.templates {
		if t.user == userID {
			out = append(out, t.t)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	return out, nil
}

func (m *Memory) AddUserTemplate(ctx context.Context, userID int64, name, body string) (UserTemplate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, t := range m.templates {
		if t.user == userID {
			n++
		}
	}
	if n >= MaxUserTemplates {
		return UserTemplate{}, ErrTooManyTemplates
	}
	m.templateSeq++
	t := UserTemplate{ID: m.templateSeq, Name: name, Body: body, CreatedAt: time.Now()}
	m.templates = append(m.templates, memTemplate{userID, t})
	return t, nil
}

func (m *Memory) DeleteUserTemplate(ctx context.Context, userID, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, t := range m.templates {
		if t.user == userID && t.t.ID == id {
			m.templates = append(m.templates[:i], m.templates[i+1:]...)
			return nil
		}
	}
	return ErrNotFound
}

func (p *Postgres) UserTemplates(ctx context.Context, userID int64) ([]UserTemplate, error) {
	rows, err := p.Pool.Query(ctx, `SELECT id,name,body,created_at FROM user_templates WHERE user_id=$1 ORDER BY id DESC`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (UserTemplate, error) {
		var t UserTemplate
		err := r.Scan(&t.ID, &t.Name, &t.Body, &t.CreatedAt)
		return t, err
	})
}

func (p *Postgres) AddUserTemplate(ctx context.Context, userID int64, name, body string) (out UserTemplate, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		// Serialize per user so the count limit holds under concurrent saves.
		if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id=$1 FOR UPDATE`, userID); err != nil {
			return err
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM user_templates WHERE user_id=$1`, userID).Scan(&n); err != nil {
			return err
		}
		if n >= MaxUserTemplates {
			return ErrTooManyTemplates
		}
		return tx.QueryRow(ctx, `INSERT INTO user_templates (user_id,name,body) VALUES ($1,$2,$3) RETURNING id,name,body,created_at`, userID, name, body).
			Scan(&out.ID, &out.Name, &out.Body, &out.CreatedAt)
	})
	return out, err
}

func (p *Postgres) DeleteUserTemplate(ctx context.Context, userID, id int64) error {
	tag, err := p.Pool.Exec(ctx, `DELETE FROM user_templates WHERE user_id=$1 AND id=$2`, userID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
