package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const (
	// MaxWorkspaceNameRunes is the maximum allowed rune length for a workspace name.
	MaxWorkspaceNameRunes = 80
	// MaxOwnedWorkspaces caps the total number of workspaces a single user may own.
	MaxOwnedWorkspaces = 20
)

var (
	// ErrInvalidInput indicates a caller-supplied argument failed domain validation.
	ErrInvalidInput = errors.New("store: invalid input")
	// ErrWorkspaceLimitReached indicates the owner has reached MaxOwnedWorkspaces.
	ErrWorkspaceLimitReached = fmt.Errorf("store: owned workspace limit reached: %w", ErrConflict)
)

// WorkspaceManagerStore manages creating additional workspaces owned by an
// existing authenticated user.
type WorkspaceManagerStore interface {
	CreateWorkspace(ctx context.Context, ownerID int64, name string) (Workspace, error)
}

var (
	_ WorkspaceManagerStore = (*Memory)(nil)
	_ WorkspaceManagerStore = (*Postgres)(nil)
)

func validateWorkspaceName(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	n := utf8.RuneCountInString(trimmed)
	if n < 1 || n > MaxWorkspaceNameRunes {
		return "", fmt.Errorf("%w: workspace name must be 1-%d characters", ErrInvalidInput, MaxWorkspaceNameRunes)
	}
	for _, r := range trimmed {
		if unicode.IsControl(r) {
			return "", fmt.Errorf("%w: workspace name contains invalid control characters", ErrInvalidInput)
		}
	}
	return trimmed, nil
}

// CreateWorkspace atomically creates a workspace and adds ownerID to
// workspace_members with role = 'owner' on the in-memory store.
func (m *Memory) CreateWorkspace(ctx context.Context, ownerID int64, name string) (Workspace, error) {
	if err := ctx.Err(); err != nil {
		return Workspace{}, err
	}
	if ownerID <= 0 {
		return Workspace{}, fmt.Errorf("%w: invalid owner id", ErrInvalidInput)
	}
	trimmed, err := validateWorkspaceName(name)
	if err != nil {
		return Workspace{}, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if int(ownerID) > len(m.users) || m.users[ownerID-1].ID != ownerID {
		return Workspace{}, ErrNotFound
	}

	owned := 0
	for _, existing := range m.workspaces {
		if existing.OwnerID == ownerID {
			owned++
		}
	}
	if owned >= MaxOwnedWorkspaces {
		return Workspace{}, ErrWorkspaceLimitReached
	}

	w := Workspace{
		ID:      int64(len(m.workspaces) + 1),
		Name:    trimmed,
		OwnerID: ownerID,
	}
	m.workspaces = append(m.workspaces, w)
	if m.members == nil {
		m.members = map[int64][]int64{}
	}
	m.members[ownerID] = append(m.members[ownerID], w.ID)
	if m.workspaceRoles == nil {
		m.workspaceRoles = map[[2]int64]string{}
	}
	m.workspaceRoles[[2]int64{w.ID, ownerID}] = WorkspaceRoleOwner
	return w, nil
}

// CreateWorkspace atomically inserts into workspaces and workspace_members
// (with role = 'owner') in a single Postgres transaction while enforcing
// MaxOwnedWorkspaces under a row lock on the owner user.
func (p *Postgres) CreateWorkspace(ctx context.Context, ownerID int64, name string) (w Workspace, err error) {
	if err := ctx.Err(); err != nil {
		return Workspace{}, err
	}
	if ownerID <= 0 {
		return Workspace{}, fmt.Errorf("%w: invalid owner id", ErrInvalidInput)
	}
	trimmed, err := validateWorkspaceName(name)
	if err != nil {
		return Workspace{}, err
	}

	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var uid int64
		if err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, ownerID).Scan(&uid); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}

		var owned int
		if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM workspaces WHERE owner_id = $1`, ownerID).Scan(&owned); err != nil {
			return err
		}
		if owned >= MaxOwnedWorkspaces {
			return ErrWorkspaceLimitReached
		}

		if err := tx.QueryRow(ctx,
			`INSERT INTO workspaces (name, owner_id) VALUES ($1, $2) RETURNING id, name, owner_id`,
			trimmed, ownerID,
		).Scan(&w.ID, &w.Name, &w.OwnerID); err != nil {
			return err
		}

		_, err := tx.Exec(ctx,
			`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
			w.ID, ownerID,
		)
		return err
	})
	if err != nil {
		return Workspace{}, err
	}
	return w, nil
}
