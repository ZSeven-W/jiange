package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Postgres implements Store with pgx.
type Postgres struct{ Pool *pgxpool.Pool }

func NewPostgres(ctx context.Context, url string) (*Postgres, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, err
	}
	return &Postgres{Pool: pool}, nil
}

func (p *Postgres) Close() { p.Pool.Close() }

func (p *Postgres) Ping(ctx context.Context) error { return p.Pool.Ping(ctx) }

func isUnique(err error) bool {
	var pe *pgconn.PgError
	return errors.As(err, &pe) && pe.Code == "23505"
}

func (p *Postgres) CreateUser(ctx context.Context, email, name, hash string) (u User, w Workspace, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx,
			`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
			 RETURNING id, email, name, password_hash, created_at`, email, name, hash,
		).Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.CreatedAt); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO workspaces (name, owner_id) VALUES ($1, $2) RETURNING id, name, owner_id`,
			name+" 的空间", u.ID).Scan(&w.ID, &w.Name, &w.OwnerID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, w.ID, u.ID)
		return err
	})
	if isUnique(err) {
		err = ErrConflict
	}
	return u, w, err
}

func (p *Postgres) UserByEmail(ctx context.Context, email string) (u User, err error) {
	err = p.Pool.QueryRow(ctx,
		`SELECT id, email, name, password_hash, created_at FROM users WHERE lower(email) = lower($1)`, email,
	).Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return u, err
}

func (p *Postgres) CreateSession(ctx context.Context, h []byte, uid int64, exp time.Time) error {
	_, err := p.Pool.Exec(ctx, `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`, h, uid, exp)
	return err
}

func (p *Postgres) SessionUser(ctx context.Context, h []byte, now time.Time) (u User, err error) {
	err = p.Pool.QueryRow(ctx,
		`SELECT u.id, u.email, u.name, u.password_hash, u.created_at
		   FROM sessions s JOIN users u ON u.id = s.user_id
		  WHERE s.token_hash = $1 AND s.expires_at > $2`, h, now,
	).Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return u, err
}

func (p *Postgres) DeleteSession(ctx context.Context, h []byte) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, h)
	return err
}

func (p *Postgres) Workspaces(ctx context.Context, uid int64) ([]Workspace, error) {
	rows, err := p.Pool.Query(ctx,
		`SELECT w.id, w.name, w.owner_id FROM workspaces w
		   JOIN workspace_members m ON m.workspace_id = w.id
		  WHERE m.user_id = $1 ORDER BY w.id`, uid)
	if err != nil {
		return nil, err
	}
	out := []Workspace{}
	for rows.Next() {
		var w Workspace
		if err := rows.Scan(&w.ID, &w.Name, &w.OwnerID); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}
