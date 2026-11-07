// Package store defines persistence for the API, with a pgx (Postgres)
// implementation and an in-memory implementation used by tests.
package store

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound        = errors.New("store: not found")
	ErrConflict        = errors.New("store: conflict")
	ErrPrimaryField    = errors.New("store: primary field cannot be removed, moved or hidden")
	ErrForbidden       = errors.New("store: forbidden")
	ErrUnauthenticated = errors.New("store: session expired")
	ErrCopyProtected   = errors.New("store: copying prohibited")
)

type User struct {
	ID           int64     `json:"id"`
	Email        string    `json:"email"`
	Name         string    `json:"name"`
	PasswordHash string    `json:"-"`
	CreatedAt    time.Time `json:"createdAt"`
}

type Workspace struct {
	ID      int64  `json:"id"`
	Name    string `json:"name"`
	OwnerID int64  `json:"ownerId"`
}

type Store interface {
	VersionStore
	CommentStore
	AutomationStore
	RecentStore
	BaseSnapshotStore
	// CreateUser creates the user and a personal workspace atomically.
	CreateUser(ctx context.Context, email, name, passwordHash string) (User, Workspace, error)
	UserByEmail(ctx context.Context, email string) (User, error)
	CreateSession(ctx context.Context, tokenHash []byte, userID int64, expires time.Time) error
	SessionUser(ctx context.Context, tokenHash []byte, now time.Time) (User, error)
	DeleteSession(ctx context.Context, tokenHash []byte) error
	Workspaces(ctx context.Context, userID int64) ([]Workspace, error)
	Ping(ctx context.Context) error
	DocStore
}
