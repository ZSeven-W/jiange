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
	// ErrLastWorkspace indicates deleting or leaving would leave the user with zero workspaces.
	ErrLastWorkspace = fmt.Errorf("store: cannot remove last workspace: %w", ErrConflict)
	// ErrOwnerCannotLeave indicates a workspace owner must transfer ownership or delete the workspace before leaving.
	ErrOwnerCannotLeave = fmt.Errorf("store: owner cannot leave workspace: %w", ErrConflict)
)

// WorkspaceSummary is an alias for Workspace returned by workspace lifecycle mutations.
type WorkspaceSummary = Workspace

// WorkspaceManagerStore manages creating and mutating workspaces for
// authenticated users.
type WorkspaceManagerStore interface {
	CreateWorkspace(ctx context.Context, ownerID int64, name string) (Workspace, error)
	RenameWorkspace(ctx context.Context, actorID, wsID int64, name string) (WorkspaceSummary, error)
	DeleteWorkspace(ctx context.Context, actorID, wsID int64) error
	TransferWorkspaceOwner(ctx context.Context, actorID, wsID, targetUserID int64) error
	LeaveWorkspace(ctx context.Context, actorID, wsID int64) error
}

// WorkspaceStore is an alias for WorkspaceManagerStore.
type WorkspaceStore = WorkspaceManagerStore

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

func (m *Memory) workspaceExistsLocked(wsID int64) bool {
	return wsID > 0 && int(wsID) <= len(m.workspaces) && m.workspaces[wsID-1].ID == wsID
}

func removeWorkspaceFromSlice(ids []int64, wsID int64) []int64 {
	if len(ids) == 0 {
		return ids
	}
	out := ids[:0]
	for _, id := range ids {
		if id != wsID {
			out = append(out, id)
		}
	}
	return out
}

// RenameWorkspace updates the workspace's name on the in-memory store.
// Caller must hold the owner or admin role in the workspace.
func (m *Memory) RenameWorkspace(ctx context.Context, actorID, wsID int64, name string) (WorkspaceSummary, error) {
	if err := ctx.Err(); err != nil {
		return WorkspaceSummary{}, err
	}
	if actorID <= 0 || wsID <= 0 {
		return WorkspaceSummary{}, fmt.Errorf("%w: invalid actor or workspace id", ErrInvalidInput)
	}
	trimmed, err := validateWorkspaceName(name)
	if err != nil {
		return WorkspaceSummary{}, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.workspaceExistsLocked(wsID) {
		return WorkspaceSummary{}, ErrNotFound
	}
	if !isWorkspaceAdminRole(m.workspaceRoleLocked(wsID, actorID)) {
		return WorkspaceSummary{}, ErrForbidden
	}
	m.workspaces[wsID-1].Name = trimmed
	return m.workspaces[wsID-1], nil
}

// RenameWorkspace updates the workspace's name in Postgres after verifying the
// caller holds the owner or admin role in the workspace.
func (p *Postgres) RenameWorkspace(ctx context.Context, actorID, wsID int64, name string) (w WorkspaceSummary, err error) {
	if err := ctx.Err(); err != nil {
		return WorkspaceSummary{}, err
	}
	if actorID <= 0 || wsID <= 0 {
		return WorkspaceSummary{}, fmt.Errorf("%w: invalid actor or workspace id", ErrInvalidInput)
	}
	trimmed, err := validateWorkspaceName(name)
	if err != nil {
		return WorkspaceSummary{}, err
	}

	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var ownerID int64
		if err := tx.QueryRow(ctx, `SELECT owner_id FROM workspaces WHERE id = $1 FOR UPDATE`, wsID).Scan(&ownerID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		var role string
		if err := tx.QueryRow(ctx,
			`SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR SHARE`,
			wsID, actorID,
		).Scan(&role); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrForbidden
			}
			return err
		}
		if ownerID != actorID && !isWorkspaceAdminRole(role) {
			return ErrForbidden
		}
		return tx.QueryRow(ctx,
			`UPDATE workspaces SET name = $1 WHERE id = $2 RETURNING id, name, owner_id`,
			trimmed, wsID,
		).Scan(&w.ID, &w.Name, &w.OwnerID)
	})
	if err != nil {
		return WorkspaceSummary{}, err
	}
	return w, nil
}

// DeleteWorkspace removes a workspace and its associated in-memory records.
// Only the workspace owner may delete it, and the owner must retain at least
// one other workspace.
func (m *Memory) DeleteWorkspace(ctx context.Context, actorID, wsID int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if actorID <= 0 || wsID <= 0 {
		return fmt.Errorf("%w: invalid actor or workspace id", ErrInvalidInput)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.workspaceExistsLocked(wsID) {
		return ErrNotFound
	}
	if m.workspaces[wsID-1].OwnerID != actorID || m.workspaceRoleLocked(wsID, actorID) != WorkspaceRoleOwner {
		return ErrForbidden
	}
	if len(m.members[actorID]) <= 1 {
		return ErrLastWorkspace
	}

	// Tombstone slot to preserve 1-based workspace ID indexing across Memory.
	m.workspaces[wsID-1] = Workspace{}
	for uid, wsIDs := range m.members {
		m.members[uid] = removeWorkspaceFromSlice(wsIDs, wsID)
	}
	for k := range m.workspaceRoles {
		if k[0] == wsID {
			delete(m.workspaceRoles, k)
		}
	}
	deletedDocs := map[int64]bool{}
	for _, d := range m.d.docs {
		if d != nil && d.meta.WorkspaceID == wsID {
			d.deleted = true
			d.purged = true
			deletedDocs[d.meta.ID] = true
		}
	}
	for docID := range deletedDocs {
		delete(m.searchIndex, docID)
		delete(m.sh.shares, docID)
		delete(m.sh.joins, docID)
		delete(m.sh.links, docID)
		delete(m.org.subjectShares, docID)
	}
	if len(deletedDocs) > 0 {
		for uid, favs := range m.favorites {
			out := favs[:0]
			for _, id := range favs {
				if !deletedDocs[id] {
					out = append(out, id)
				}
			}
			m.favorites[uid] = out
		}
		for uid, pins := range m.pins {
			out := pins[:0]
			for _, id := range pins {
				if !deletedDocs[id] {
					out = append(out, id)
				}
			}
			m.pins[uid] = out
		}
		for k := range m.recent {
			if deletedDocs[k[1]] {
				delete(m.recent, k)
			}
		}
	}
	for deptID, dept := range m.org.depts {
		if dept.WorkspaceID == wsID {
			delete(m.org.depts, deptID)
			delete(m.org.deptMembers, deptID)
		}
	}
	for groupID, grp := range m.org.groups {
		if grp.WorkspaceID == wsID {
			delete(m.org.groups, groupID)
			delete(m.org.groupMembers, groupID)
		}
	}
	for invID, inv := range m.org.invitations {
		if inv.WorkspaceID == wsID {
			delete(m.org.invitations, invID)
		}
	}
	for srcID, src := range m.org.syncSources {
		if src.WorkspaceID == wsID {
			delete(m.org.syncSources, srcID)
			delete(m.org.syncTokenHashes, srcID)
		}
	}
	if len(m.org.syncRuns) > 0 {
		kept := m.org.syncRuns[:0]
		for _, run := range m.org.syncRuns {
			if run.WorkspaceID != wsID {
				kept = append(kept, run)
			}
		}
		m.org.syncRuns = kept
	}
	for spaceID, sp := range m.wiki.spaces {
		if sp.WorkspaceID == wsID {
			delete(m.wiki.spaces, spaceID)
			delete(m.wiki.grants, spaceID)
		}
	}
	if len(m.wiki.shortcuts) > 0 {
		kept := m.wiki.shortcuts[:0]
		for _, sc := range m.wiki.shortcuts {
			if sc.WorkspaceID != wsID {
				kept = append(kept, sc)
			}
		}
		m.wiki.shortcuts = kept
	}
	delete(m.enterprise.policies, wsID)
	if len(m.enterprise.auditLogs) > 0 {
		kept := m.enterprise.auditLogs[:0]
		for _, entry := range m.enterprise.auditLogs {
			if entry.WorkspaceID != wsID {
				kept = append(kept, entry)
			}
		}
		m.enterprise.auditLogs = kept
	}
	return nil
}

// DeleteWorkspace removes a workspace and cascades its rows in Postgres.
// Only the workspace owner may delete it, and the owner must retain at least
// one other workspace.
func (p *Postgres) DeleteWorkspace(ctx context.Context, actorID, wsID int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if actorID <= 0 || wsID <= 0 {
		return fmt.Errorf("%w: invalid actor or workspace id", ErrInvalidInput)
	}

	return pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		// Lock user first (matching CreateWorkspace lock order) to serialize
		// concurrent delete/leave/create calls for the same actor.
		var uid int64
		if err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, actorID).Scan(&uid); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				var exists int64
				if e := tx.QueryRow(ctx, `SELECT id FROM workspaces WHERE id = $1`, wsID).Scan(&exists); errors.Is(e, pgx.ErrNoRows) {
					return ErrNotFound
				}
				return ErrForbidden
			}
			return err
		}
		var ownerID int64
		if err := tx.QueryRow(ctx, `SELECT owner_id FROM workspaces WHERE id = $1 FOR UPDATE`, wsID).Scan(&ownerID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		var role string
		if err := tx.QueryRow(ctx,
			`SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`,
			wsID, actorID,
		).Scan(&role); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrForbidden
			}
			return err
		}
		if ownerID != actorID || role != WorkspaceRoleOwner {
			return ErrForbidden
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_members WHERE user_id = $1`, actorID).Scan(&count); err != nil {
			return err
		}
		if count <= 1 {
			return ErrLastWorkspace
		}
		// Remove drive_files before cascading workspaces -> nodes -> attachments
		// so attachments_drive_file_delete_guard never trips on cascade order.
		if _, err := tx.Exec(ctx, `DELETE FROM drive_files WHERE node_id IN (SELECT id FROM nodes WHERE workspace_id = $1)`, wsID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM workspaces WHERE id = $1`, wsID)
		return err
	})
}

// TransferWorkspaceOwner atomically transfers ownership of wsID from actorID
// (current owner) to targetUserID (an active member of wsID) and demotes
// actorID to admin.
func (m *Memory) TransferWorkspaceOwner(ctx context.Context, actorID, wsID, targetUserID int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if actorID <= 0 || wsID <= 0 || targetUserID <= 0 || targetUserID == actorID {
		return fmt.Errorf("%w: invalid owner transfer arguments", ErrInvalidInput)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.workspaceExistsLocked(wsID) {
		return ErrNotFound
	}
	if m.workspaces[wsID-1].OwnerID != actorID || m.workspaceRoleLocked(wsID, actorID) != WorkspaceRoleOwner {
		return ErrForbidden
	}
	if !m.member(targetUserID, wsID) {
		return ErrNotFound
	}
	m.workspaces[wsID-1].OwnerID = targetUserID
	if m.workspaceRoles == nil {
		m.workspaceRoles = map[[2]int64]string{}
	}
	m.workspaceRoles[[2]int64{wsID, targetUserID}] = WorkspaceRoleOwner
	m.workspaceRoles[[2]int64{wsID, actorID}] = WorkspaceRoleAdmin
	return nil
}

// TransferWorkspaceOwner atomically updates workspaces.owner_id and swaps the
// workspace_members roles (target -> owner, actor -> admin) in one Postgres
// transaction.
func (p *Postgres) TransferWorkspaceOwner(ctx context.Context, actorID, wsID, targetUserID int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if actorID <= 0 || wsID <= 0 || targetUserID <= 0 || targetUserID == actorID {
		return fmt.Errorf("%w: invalid owner transfer arguments", ErrInvalidInput)
	}

	return pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var ownerID int64
		if err := tx.QueryRow(ctx, `SELECT owner_id FROM workspaces WHERE id = $1 FOR UPDATE`, wsID).Scan(&ownerID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		var actorRole string
		if err := tx.QueryRow(ctx,
			`SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`,
			wsID, actorID,
		).Scan(&actorRole); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrForbidden
			}
			return err
		}
		if ownerID != actorID || actorRole != WorkspaceRoleOwner {
			return ErrForbidden
		}
		var targetRole string
		if err := tx.QueryRow(ctx,
			`SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`,
			wsID, targetUserID,
		).Scan(&targetRole); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE workspaces SET owner_id = $1 WHERE id = $2`, targetUserID, wsID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2`,
			wsID, targetUserID,
		); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2`,
			wsID, actorID,
		)
		return err
	})
}

// LeaveWorkspace removes a non-owner member (admin or member) from wsID on the
// in-memory store, rejecting the workspace owner (ErrOwnerCannotLeave) and
// preventing a user from leaving their final workspace (ErrLastWorkspace).
func (m *Memory) LeaveWorkspace(ctx context.Context, actorID, wsID int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if actorID <= 0 || wsID <= 0 {
		return fmt.Errorf("%w: invalid actor or workspace id", ErrInvalidInput)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.workspaceExistsLocked(wsID) {
		return ErrNotFound
	}
	role := m.workspaceRoleLocked(wsID, actorID)
	if role == "" {
		return ErrForbidden
	}
	if role == WorkspaceRoleOwner || m.workspaces[wsID-1].OwnerID == actorID {
		return ErrOwnerCannotLeave
	}
	if len(m.members[actorID]) <= 1 {
		return ErrLastWorkspace
	}

	m.members[actorID] = removeWorkspaceFromSlice(m.members[actorID], wsID)
	if m.workspaceRoles != nil {
		delete(m.workspaceRoles, [2]int64{wsID, actorID})
	}
	for deptID, d := range m.org.depts {
		if d.WorkspaceID == wsID {
			delete(m.org.deptMembers[deptID], actorID)
		}
	}
	for groupID, g := range m.org.groups {
		if g.WorkspaceID == wsID {
			delete(m.org.groupMembers[groupID], actorID)
		}
	}
	for spaceID, sp := range m.wiki.spaces {
		if sp.WorkspaceID == wsID {
			delete(m.wiki.grants[spaceID], wikiGrantKey{SubjectTypeUser, actorID})
		}
	}
	return nil
}

// LeaveWorkspace removes a non-owner member (admin or member) from wsID in
// Postgres while enforcing ErrOwnerCannotLeave and ErrLastWorkspace atomically.
func (p *Postgres) LeaveWorkspace(ctx context.Context, actorID, wsID int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if actorID <= 0 || wsID <= 0 {
		return fmt.Errorf("%w: invalid actor or workspace id", ErrInvalidInput)
	}

	return pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var uid int64
		if err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, actorID).Scan(&uid); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				var exists int64
				if e := tx.QueryRow(ctx, `SELECT id FROM workspaces WHERE id = $1`, wsID).Scan(&exists); errors.Is(e, pgx.ErrNoRows) {
					return ErrNotFound
				}
				return ErrForbidden
			}
			return err
		}
		var ownerID int64
		if err := tx.QueryRow(ctx, `SELECT owner_id FROM workspaces WHERE id = $1 FOR SHARE`, wsID).Scan(&ownerID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		var role string
		if err := tx.QueryRow(ctx,
			`SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`,
			wsID, actorID,
		).Scan(&role); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrForbidden
			}
			return err
		}
		if ownerID == actorID || role == WorkspaceRoleOwner {
			return ErrOwnerCannotLeave
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_members WHERE user_id = $1`, actorID).Scan(&count); err != nil {
			return err
		}
		if count <= 1 {
			return ErrLastWorkspace
		}
		if _, err := tx.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, wsID, actorID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM org_department_members WHERE department_id IN (SELECT id FROM org_departments WHERE workspace_id = $1) AND user_id = $2`, wsID, actorID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM org_group_members WHERE group_id IN (SELECT id FROM org_groups WHERE workspace_id = $1) AND user_id = $2`, wsID, actorID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM wiki_space_grants WHERE space_id IN (SELECT id FROM wiki_spaces WHERE workspace_id = $1) AND subject_type = 'user' AND subject_id = $2`, wsID, actorID)
		return err
	})
}
