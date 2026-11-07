package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// lockShareManager holds the target and all positive authorization rows until
// the sharing mutation commits. The exclusive target lock also serializes
// sharing changes and link joins on this document.
func lockShareManager(ctx context.Context, tx pgx.Tx, guard RestoreGuard, docID int64) (time.Time, error) {
	var id int64
	err := tx.QueryRow(ctx, `SELECT id FROM nodes WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, docID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, ErrForbidden
	}
	if err != nil {
		return time.Time{}, err
	}
	var uid int64
	var expiry time.Time
	err = tx.QueryRow(ctx, `SELECT user_id,expires_at FROM sessions WHERE token_hash=$1 FOR SHARE`, guard.SessionHash).Scan(&uid, &expiry)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (uid != guard.UserID || !guard.currentTime().Before(expiry)) {
		return time.Time{}, ErrUnauthenticated
	}
	if err != nil {
		return time.Time{}, err
	}
	role, _, _, err := lockCopySource(ctx, tx, docID, guard.UserID)
	if errors.Is(err, ErrNotFound) || err == nil && RoleRank(role) < RoleRank(RoleManage) {
		return time.Time{}, ErrForbidden
	}
	if err != nil {
		return time.Time{}, err
	}
	// Refuse corrupt parent chains rather than authorizing through them.
	var invalid bool
	err = tx.QueryRow(ctx, `WITH RECURSIVE a AS (
        SELECT id,parent_id,workspace_id,deleted_at,ARRAY[id] AS seen FROM nodes WHERE id=$1
        UNION ALL SELECT n.id,n.parent_id,n.workspace_id,n.deleted_at,a.seen||n.id
        FROM nodes n JOIN a ON n.id=a.parent_id WHERE NOT n.id=ANY(a.seen)
    ) SELECT EXISTS(SELECT 1 FROM a WHERE deleted_at IS NOT NULL OR workspace_id<>(SELECT workspace_id FROM nodes WHERE id=$1))
        OR EXISTS(SELECT 1 FROM a WHERE parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM nodes p WHERE p.id=a.parent_id))`, docID).Scan(&invalid)
	if err != nil {
		return time.Time{}, err
	}
	if invalid {
		return time.Time{}, ErrForbidden
	}
	return expiry, nil
}

func (m *Memory) checkShareManagerLocked(ctx context.Context, guard RestoreGuard, docID int64) (time.Time, error) {
	if err := ctx.Err(); err != nil {
		return time.Time{}, err
	}
	session, ok := m.sessions[string(guard.SessionHash)]
	if !ok || session.userID != guard.UserID || !guard.currentTime().Before(session.expires) {
		return time.Time{}, ErrUnauthenticated
	}
	d := m.doc(docID)
	if d == nil || d.deleted {
		return time.Time{}, ErrForbidden
	}
	seen := map[int64]bool{}
	for current := d; current != nil; {
		if seen[current.meta.ID] || current.deleted || current.meta.WorkspaceID != d.meta.WorkspaceID {
			return time.Time{}, ErrForbidden
		}
		seen[current.meta.ID] = true
		if current.meta.ParentID == nil {
			break
		}
		current = m.doc(*current.meta.ParentID)
		if current == nil {
			return time.Time{}, ErrForbidden
		}
	}
	if RoleRank(m.roleLocked(guard.UserID, d)) < RoleRank(RoleManage) {
		return time.Time{}, ErrForbidden
	}
	return session.expires, nil
}

func (m *Memory) SetShareGuarded(ctx context.Context, guard RestoreGuard, docID, userID int64, role string, createOnly bool) error {
	if userID <= 0 || (role != "" && RoleRank(role) == 0) || (createOnly && role == "") {
		return ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expiry, err := m.checkShareManagerLocked(ctx, guard, docID)
	if err != nil {
		return err
	}
	if userID > int64(len(m.users)) {
		return ErrNotFound
	}
	if createOnly && (m.doc(docID).meta.CreatorID == userID || m.sh.shares[docID][userID] != "") {
		return ErrShareExists
	}
	if !guard.currentTime().Before(expiry) {
		return ErrUnauthenticated
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if m.sh.shares == nil {
		m.sh.shares = map[int64]map[int64]string{}
	}
	if m.sh.shares[docID] == nil {
		m.sh.shares[docID] = map[int64]string{}
	}
	if role == "" {
		delete(m.sh.shares[docID], userID)
	} else {
		m.sh.shares[docID][userID] = role
	}
	return nil
}

func (p *Postgres) SetShareGuarded(ctx context.Context, guard RestoreGuard, docID, userID int64, role string, createOnly bool) error {
	if userID <= 0 || (role != "" && RoleRank(role) == 0) || (createOnly && role == "") {
		return ErrConflict
	}
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expiry, err := lockShareManager(ctx, tx, guard, docID)
		if err != nil {
			return err
		}
		if createOnly {
			result, err := tx.Exec(ctx, `INSERT INTO doc_shares (doc_id,user_id,role)
                SELECT n.id,$2,$3 FROM nodes n WHERE n.id=$1 AND n.creator_id<>$2 AND n.deleted_at IS NULL
                ON CONFLICT (doc_id,user_id) DO NOTHING`, docID, userID, role)
			if err != nil {
				return err
			}
			if result.RowsAffected() == 0 {
				return ErrShareExists
			}
		} else if role == "" {
			if _, err := tx.Exec(ctx, `DELETE FROM doc_shares WHERE doc_id=$1 AND user_id=$2`, docID, userID); err != nil {
				return err
			}
		} else {
			if _, err := tx.Exec(ctx, `INSERT INTO doc_shares (doc_id,user_id,role) VALUES ($1,$2,$3)
                ON CONFLICT (doc_id,user_id) DO UPDATE SET role=EXCLUDED.role`, docID, userID, role); err != nil {
				return err
			}
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if retryableRestoreConflict(err) {
		return ErrConflict
	}
	return err
}

func validLinkRole(role, candidate string) bool {
	return role == "none" || (role == "anon" || role == RoleView || role == RoleEdit) && candidate != ""
}

func (m *Memory) ChangeLinkRoleGuarded(ctx context.Context, guard RestoreGuard, docID int64, role, candidate string) (Link, error) {
	if !validLinkRole(role, candidate) {
		return Link{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expiry, err := m.checkShareManagerLocked(ctx, guard, docID)
	if err != nil {
		return Link{}, err
	}
	old := m.sh.links[docID]
	next := Link{Role: role, Token: old.Token}
	if role == "none" {
		next.Token = ""
	} else if old.Role == "" || old.Role == "none" || old.Token == "" {
		next.Token = candidate
	}
	if !guard.currentTime().Before(expiry) {
		return Link{}, ErrUnauthenticated
	}
	if err := ctx.Err(); err != nil {
		return Link{}, err
	}
	if m.sh.links == nil {
		m.sh.links = map[int64]Link{}
	}
	if role == "none" || old.Token != "" && old.Token != next.Token {
		delete(m.sh.joins, docID)
	}
	m.sh.links[docID] = next
	return next, nil
}

func (p *Postgres) ChangeLinkRoleGuarded(ctx context.Context, guard RestoreGuard, docID int64, role, candidate string) (next Link, err error) {
	if !validLinkRole(role, candidate) {
		return Link{}, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expiry, err := lockShareManager(ctx, tx, guard, docID)
		if err != nil {
			return err
		}
		var oldRole string
		var oldToken *string
		if err := tx.QueryRow(ctx, `SELECT link_role,link_token FROM nodes WHERE id=$1`, docID).Scan(&oldRole, &oldToken); err != nil {
			return err
		}
		next = Link{Role: role}
		if oldToken != nil {
			next.Token = *oldToken
		}
		if role == "none" {
			next.Token = ""
		} else if oldRole == "none" || next.Token == "" {
			next.Token = candidate
		}
		if role == "none" || oldToken != nil && *oldToken != next.Token {
			if _, err := tx.Exec(ctx, `DELETE FROM doc_link_joins WHERE doc_id=$1`, docID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE nodes SET link_role=$2,link_token=NULLIF($3,'') WHERE id=$1`, docID, next.Role, next.Token); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		next = Link{}
	}
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	return
}

func managedPermissions(meta DocMeta, patch ManagedDocPatch) (string, string, bool, error) {
	if patch.ExpectedCopyProtected != nil && meta.CopyProtected != *patch.ExpectedCopyProtected {
		return "", "", false, ErrConflict
	}
	// JSON clients must be able to compare revisions exactly.
	if meta.PermissionsRevision >= 9007199254740991 {
		return "", "", false, ErrConflict
	}
	if patch.CopyMinRole == nil && patch.DownloadMinRole == nil && patch.CommentMinRole == nil {
		if patch.ExpectedPermissionsRevision != nil {
			return "", "", false, ErrConflict
		}
		if patch.CopyProtected {
			return RoleManage, RoleManage, true, nil
		}
		return RoleView, RoleView, false, nil
	}
	if meta.Kind != "doc" || patch.ExpectedPermissionsRevision == nil || patch.ExpectedCopyProtected != nil || *patch.ExpectedPermissionsRevision != meta.PermissionsRevision {
		return "", "", false, ErrConflict
	}
	copyRole, downloadRole := meta.CopyMinRole, meta.DownloadMinRole
	if copyRole == "" || downloadRole == "" {
		copyRole, downloadRole = RoleView, RoleView
		if meta.CopyProtected {
			copyRole, downloadRole = RoleManage, RoleManage
		}
	}
	if patch.CopyMinRole != nil {
		copyRole = *patch.CopyMinRole
	}
	if patch.DownloadMinRole != nil {
		downloadRole = *patch.DownloadMinRole
	}
	if RoleRank(copyRole) == 0 || RoleRank(downloadRole) == 0 {
		return "", "", false, ErrConflict
	}
	return copyRole, downloadRole, copyRole != RoleView || downloadRole != RoleView, nil
}

func managedCommentRole(meta DocMeta, patch ManagedDocPatch) (string, error) {
	role := meta.CommentMinRole
	if role == "" {
		role = RoleEdit
	}
	if patch.CommentMinRole != nil {
		role = *patch.CommentMinRole
	}
	if role != RoleView && role != RoleEdit {
		return "", ErrConflict
	}
	return role, nil
}

func (m *Memory) PatchManagedDocGuarded(ctx context.Context, guard RestoreGuard, docID int64, patch ManagedDocPatch) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expiry, err := m.checkShareManagerLocked(ctx, guard, docID)
	if err != nil {
		return err
	}
	d := m.doc(docID)
	copyRole, downloadRole, protected, err := managedPermissions(d.meta, patch)
	if err != nil {
		return err
	}
	commentRole, err := managedCommentRole(d.meta, patch)
	if err != nil {
		return err
	}
	if patch.Move && patch.ParentID != nil {
		parent := m.doc(*patch.ParentID)
		if parent == nil || parent.deleted || parent.meta.WorkspaceID != d.meta.WorkspaceID || RoleRank(m.roleLocked(guard.UserID, parent)) < RoleRank(RoleView) {
			return ErrNotFound
		}
		seen := map[int64]bool{}
		for node := parent; node != nil; {
			if node.meta.ID == docID || seen[node.meta.ID] {
				return ErrConflict
			}
			if node.deleted || node.meta.WorkspaceID != d.meta.WorkspaceID {
				return ErrNotFound
			}
			seen[node.meta.ID] = true
			if node.meta.ParentID == nil {
				break
			}
			node = m.doc(*node.meta.ParentID)
			if node == nil {
				return ErrNotFound
			}
		}
	}
	if !guard.currentTime().Before(expiry) {
		return ErrUnauthenticated
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if patch.Move {
		d.meta.ParentID = patch.ParentID
	}
	if patch.Title != nil {
		d.meta.Title, d.meta.UpdatedAt = *patch.Title, time.Now()
	}
	d.meta.CopyProtected = protected
	d.meta.CopyMinRole, d.meta.DownloadMinRole = copyRole, downloadRole
	d.meta.CommentMinRole = commentRole
	d.meta.PermissionsRevision++
	return nil
}

func (p *Postgres) PatchManagedDocGuarded(ctx context.Context, guard RestoreGuard, docID int64, patch ManagedDocPatch) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expiry, err := lockShareManager(ctx, tx, guard, docID)
		if err != nil {
			return err
		}
		var current DocMeta
		if err := tx.QueryRow(ctx, `SELECT kind,copy_protected,copy_min_role,download_min_role,comment_min_role,permissions_revision FROM nodes WHERE id=$1`, docID).Scan(&current.Kind, &current.CopyProtected, &current.CopyMinRole, &current.DownloadMinRole, &current.CommentMinRole, &current.PermissionsRevision); err != nil {
			return err
		}
		copyRole, downloadRole, protected, err := managedPermissions(current, patch)
		if err != nil {
			return err
		}
		commentRole, err := managedCommentRole(current, patch)
		if err != nil {
			return err
		}
		if patch.Move && patch.ParentID != nil {
			var workspace int64
			if err := tx.QueryRow(ctx, `SELECT workspace_id FROM nodes WHERE id=$1`, docID).Scan(&workspace); err != nil {
				return err
			}
			role, _, _, err := lockCopySource(ctx, tx, *patch.ParentID, guard.UserID)
			if errors.Is(err, ErrNotFound) || err == nil && RoleRank(role) < RoleRank(RoleView) {
				return ErrNotFound
			}
			if err != nil {
				return err
			}
			seen := map[int64]bool{}
			current := *patch.ParentID
			for current != 0 {
				if current == docID || seen[current] {
					return ErrConflict
				}
				seen[current] = true
				var parent *int64
				var ws int64
				var deleted bool
				err := tx.QueryRow(ctx, `SELECT parent_id,workspace_id,deleted_at IS NOT NULL FROM nodes WHERE id=$1 FOR SHARE`, current).Scan(&parent, &ws, &deleted)
				if errors.Is(err, pgx.ErrNoRows) || err == nil && (ws != workspace || deleted) {
					return ErrNotFound
				}
				if err != nil {
					return err
				}
				if parent == nil {
					break
				}
				current = *parent
			}
		}
		if patch.Move {
			if _, err := tx.Exec(ctx, `UPDATE nodes SET parent_id=$2,updated_at=now() WHERE id=$1`, docID, patch.ParentID); err != nil {
				return err
			}
		}
		if patch.Title != nil {
			if _, err := tx.Exec(ctx, `UPDATE nodes SET title=$2,updated_at=now() WHERE id=$1`, docID, *patch.Title); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE nodes SET copy_protected=$2,copy_min_role=$3,download_min_role=$4,comment_min_role=$5,permissions_revision=permissions_revision+1 WHERE id=$1`, docID, protected, copyRole, downloadRole, commentRole); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if retryableRestoreConflict(err) {
		return ErrConflict
	}
	return err
}
