package store

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// DriveShortcut is a pointer stored in a Drive folder referencing any node.
// The API enriches target metadata live via GetDoc so access revocation or
// deletion takes effect immediately without leaking stale metadata.
type DriveShortcut struct {
	ID                int64     `json:"id"`
	WorkspaceID       int64     `json:"workspaceId"`
	ParentID          *int64    `json:"parentId"`
	Personal          bool      `json:"personal"`
	TargetNodeID      int64     `json:"targetNodeId"`
	Title             string    `json:"title"`
	CreatorID         int64     `json:"creatorId"`
	CreatorName       string    `json:"creatorName"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
	TargetAccessible  bool      `json:"targetAccessible"`
	TargetKind        string    `json:"targetKind,omitempty"`
	TargetDocType     string    `json:"targetDocType,omitempty"`
	TargetTitle       string    `json:"targetTitle,omitempty"`
	TargetIcon        string    `json:"targetIcon,omitempty"`
	TargetWikiSpaceID *int64    `json:"targetWikiSpaceId,omitempty"`
}

// DriveShortcutStore persists Drive shortcuts with PostgreSQL/Memory parity.
type DriveShortcutStore interface {
	ListDriveShortcuts(ctx context.Context, g RestoreGuard, ws int64, parent *int64, personal bool) ([]DriveShortcut, error)
	CreateDriveShortcut(ctx context.Context, g RestoreGuard, ws int64, parent *int64, personal bool, targetNodeID int64, title string) (DriveShortcut, error)
	DeleteDriveShortcut(ctx context.Context, g RestoreGuard, id int64) error
}

func cleanShortcutTitle(title string) (string, bool) {
	t := strings.TrimSpace(title)
	if utf8.RuneCountInString(t) > 100 {
		return "", false
	}
	return t, true
}

func (m *Memory) ListDriveShortcuts(ctx context.Context, g RestoreGuard, ws int64, parent *int64, personal bool) ([]DriveShortcut, error) {
	if ws <= 0 {
		return nil, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, g)
	if err != nil {
		return nil, err
	}
	if err := m.driveDestinationLocked(g.UserID, ws, parent, RoleView); err != nil {
		return nil, err
	}
	folderPersonal := personal
	if parent != nil {
		p := m.doc(*parent)
		if p == nil {
			return nil, ErrNotFound
		}
		folderPersonal = p.personal
	}
	out := make([]DriveShortcut, 0)
	for _, sc := range m.driveShortcuts {
		if sc.WorkspaceID != ws || !sameDriveParent(sc.ParentID, parent) {
			continue
		}
		if parent == nil {
			if folderPersonal {
				if !sc.Personal || sc.CreatorID != g.UserID {
					continue
				}
			} else if sc.Personal {
				continue
			}
		}
		cp := sc
		cp.ParentID = cloneDriveParent(sc.ParentID)
		out = append(out, cp)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].ID > out[j].ID
		}
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	if err := drivePGEnd(ctx, g, expires); err != nil {
		return nil, err
	}
	return out, nil
}

func (m *Memory) CreateDriveShortcut(ctx context.Context, g RestoreGuard, ws int64, parent *int64, personal bool, targetNodeID int64, title string) (DriveShortcut, error) {
	clean, ok := cleanShortcutTitle(title)
	if ws <= 0 || targetNodeID <= 0 || !ok {
		return DriveShortcut{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, g)
	if err != nil {
		return DriveShortcut{}, err
	}
	if !m.member(g.UserID, ws) {
		return DriveShortcut{}, ErrForbidden
	}
	if err := m.driveDestinationLocked(g.UserID, ws, parent, RoleEdit); err != nil {
		return DriveShortcut{}, err
	}
	target := m.doc(targetNodeID)
	if target == nil || target.deleted || RoleRank(m.roleLocked(g.UserID, target)) < RoleRank(RoleView) {
		return DriveShortcut{}, ErrNotFound
	}
	if parent != nil && *parent == targetNodeID {
		return DriveShortcut{}, ErrConflict
	}
	effectivePersonal := personal
	if parent != nil {
		p := m.doc(*parent)
		if p == nil {
			return DriveShortcut{}, ErrNotFound
		}
		effectivePersonal = p.personal
	}
	if clean == "" {
		clean = target.meta.Title
	}
	if err := drivePGEnd(ctx, g, expires); err != nil {
		return DriveShortcut{}, err
	}
	m.driveShortcutSeq++
	now := time.Now()
	creatorName := ""
	if g.UserID >= 1 && g.UserID <= int64(len(m.users)) {
		creatorName = m.users[g.UserID-1].Name
	}
	sc := DriveShortcut{
		ID:           m.driveShortcutSeq,
		WorkspaceID:  ws,
		ParentID:     cloneDriveParent(parent),
		Personal:     effectivePersonal,
		TargetNodeID: targetNodeID,
		Title:        clean,
		CreatorID:    g.UserID,
		CreatorName:  creatorName,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	m.driveShortcuts = append(m.driveShortcuts, sc)
	return sc, nil
}

func (m *Memory) DeleteDriveShortcut(ctx context.Context, g RestoreGuard, id int64) error {
	if id <= 0 {
		return ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, g)
	if err != nil {
		return err
	}
	idx := -1
	for i, sc := range m.driveShortcuts {
		if sc.ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return ErrNotFound
	}
	sc := m.driveShortcuts[idx]
	allowed := sc.CreatorID == g.UserID
	if !allowed && sc.ParentID != nil {
		if p := m.doc(*sc.ParentID); p != nil && !p.deleted && RoleRank(m.roleLocked(g.UserID, p)) >= RoleRank(RoleEdit) {
			allowed = true
		}
	}
	if !allowed && sc.ParentID == nil && !sc.Personal && m.member(g.UserID, sc.WorkspaceID) {
		allowed = true
	}
	if !allowed {
		return ErrForbidden
	}
	if err := drivePGEnd(ctx, g, expires); err != nil {
		return err
	}
	m.driveShortcuts = append(m.driveShortcuts[:idx], m.driveShortcuts[idx+1:]...)
	return nil
}

func (p *Postgres) ListDriveShortcuts(ctx context.Context, g RestoreGuard, ws int64, parent *int64, personal bool) (out []DriveShortcut, err error) {
	if ws <= 0 {
		return nil, ErrConflict
	}
	out = []DriveShortcut{}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		if e := drivePGLockWorkspaceRead(ctx, tx, ws); e != nil {
			return e
		}
		exp, e := drivePGSession(ctx, tx, g)
		if e != nil {
			return e
		}
		if _, e = drivePGDestination(ctx, tx, g, ws, parent, RoleView); e != nil {
			return e
		}
		var rows pgx.Rows
		if parent != nil {
			rows, e = tx.Query(ctx, `
				SELECT s.id, s.workspace_id, s.parent_id, s.personal, s.target_node_id, s.title, s.creator_id,
				       COALESCE((SELECT u.name FROM users u WHERE u.id = s.creator_id), ''),
				       s.created_at, s.updated_at
				FROM drive_shortcuts s
				WHERE s.workspace_id = $1 AND s.parent_id = $2
				ORDER BY s.created_at DESC, s.id DESC
			`, ws, *parent)
		} else if personal {
			rows, e = tx.Query(ctx, `
				SELECT s.id, s.workspace_id, s.parent_id, s.personal, s.target_node_id, s.title, s.creator_id,
				       COALESCE((SELECT u.name FROM users u WHERE u.id = s.creator_id), ''),
				       s.created_at, s.updated_at
				FROM drive_shortcuts s
				WHERE s.workspace_id = $1 AND s.parent_id IS NULL AND s.personal = true AND s.creator_id = $2
				ORDER BY s.created_at DESC, s.id DESC
			`, ws, g.UserID)
		} else {
			rows, e = tx.Query(ctx, `
				SELECT s.id, s.workspace_id, s.parent_id, s.personal, s.target_node_id, s.title, s.creator_id,
				       COALESCE((SELECT u.name FROM users u WHERE u.id = s.creator_id), ''),
				       s.created_at, s.updated_at
				FROM drive_shortcuts s
				WHERE s.workspace_id = $1 AND s.parent_id IS NULL AND s.personal = false
				ORDER BY s.created_at DESC, s.id DESC
			`, ws)
		}
		if e != nil {
			return e
		}
		for rows.Next() {
			var sc DriveShortcut
			if e = rows.Scan(&sc.ID, &sc.WorkspaceID, &sc.ParentID, &sc.Personal, &sc.TargetNodeID, &sc.Title, &sc.CreatorID, &sc.CreatorName, &sc.CreatedAt, &sc.UpdatedAt); e != nil {
				rows.Close()
				return e
			}
			out = append(out, sc)
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			return e
		}
		rows.Close()
		return drivePGEnd(ctx, g, exp)
	})
	return out, drivePGError(err)
}

func (p *Postgres) CreateDriveShortcut(ctx context.Context, g RestoreGuard, ws int64, parent *int64, personal bool, targetNodeID int64, title string) (out DriveShortcut, err error) {
	clean, ok := cleanShortcutTitle(title)
	if ws <= 0 || targetNodeID <= 0 || !ok {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		targetWS, e := drivePGNodeWorkspace(ctx, tx, targetNodeID)
		if e != nil {
			return e
		}
		if targetWS <= ws {
			if e = drivePGLockWorkspace(ctx, tx, targetWS); e != nil {
				return e
			}
			if ws != targetWS {
				if e = drivePGLockWorkspace(ctx, tx, ws); e != nil {
					return e
				}
			}
		} else {
			if e = drivePGLockWorkspace(ctx, tx, ws); e != nil {
				return e
			}
			if e = drivePGLockWorkspace(ctx, tx, targetWS); e != nil {
				return e
			}
		}
		exp, e := drivePGSession(ctx, tx, g)
		if e != nil {
			return e
		}
		var member int
		e = tx.QueryRow(ctx, `SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, ws, g.UserID).Scan(&member)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if e != nil {
			return e
		}
		parentPersonal, e := drivePGDestination(ctx, tx, g, ws, parent, RoleEdit)
		if e != nil {
			return e
		}
		if parent != nil && *parent == targetNodeID {
			return ErrConflict
		}
		targetRole, _, _, e := lockCopySource(ctx, tx, targetNodeID, g.UserID)
		if e != nil {
			return e
		}
		if RoleRank(targetRole) < RoleRank(RoleView) {
			return ErrNotFound
		}
		if clean == "" {
			if e = tx.QueryRow(ctx, `SELECT title FROM nodes WHERE id=$1`, targetNodeID).Scan(&clean); e != nil {
				return notFound(e)
			}
		}
		effectivePersonal := parent == nil && personal || parent != nil && parentPersonal
		e = tx.QueryRow(ctx, `
			INSERT INTO drive_shortcuts (workspace_id, parent_id, personal, target_node_id, title, creator_id)
			VALUES ($1, $2, $3, $4, $5, $6)
			RETURNING id, workspace_id, parent_id, personal, target_node_id, title, creator_id,
			          COALESCE((SELECT u.name FROM users u WHERE u.id = drive_shortcuts.creator_id), ''),
			          created_at, updated_at
		`, ws, parent, effectivePersonal, targetNodeID, clean, g.UserID).Scan(
			&out.ID, &out.WorkspaceID, &out.ParentID, &out.Personal, &out.TargetNodeID, &out.Title, &out.CreatorID, &out.CreatorName, &out.CreatedAt, &out.UpdatedAt,
		)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, g, exp)
	})
	return out, drivePGError(err)
}

func (p *Postgres) DeleteDriveShortcut(ctx context.Context, g RestoreGuard, id int64) error {
	if id <= 0 {
		return ErrNotFound
	}
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var ws, creatorID int64
		var parentID *int64
		var personal bool
		e := tx.QueryRow(ctx, `SELECT workspace_id, parent_id, personal, creator_id FROM drive_shortcuts WHERE id=$1`, id).Scan(&ws, &parentID, &personal, &creatorID)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if e = drivePGLockWorkspace(ctx, tx, ws); e != nil {
			return e
		}
		exp, e := drivePGSession(ctx, tx, g)
		if e != nil {
			return e
		}
		// Re-fetch under lock in case it was concurrently removed.
		e = tx.QueryRow(ctx, `SELECT workspace_id, parent_id, personal, creator_id FROM drive_shortcuts WHERE id=$1 FOR UPDATE`, id).Scan(&ws, &parentID, &personal, &creatorID)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		allowed := creatorID == g.UserID
		if !allowed && parentID != nil {
			if _, destErr := drivePGDestination(ctx, tx, g, ws, parentID, RoleEdit); destErr == nil {
				allowed = true
			}
		}
		if !allowed && parentID == nil && !personal {
			var member int
			if mErr := tx.QueryRow(ctx, `SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, ws, g.UserID).Scan(&member); mErr == nil {
				allowed = true
			}
		}
		if !allowed {
			return ErrForbidden
		}
		if _, e = tx.Exec(ctx, `DELETE FROM drive_shortcuts WHERE id=$1`, id); e != nil {
			return e
		}
		return drivePGEnd(ctx, g, exp)
	})
	return drivePGError(err)
}
