package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Comment mutations check the current session, document access and policy
// together with the write. Anonymous access never constitutes a session.
func commentRoleAllowed(role, minimum string) bool {
	if minimum == "" {
		minimum = RoleEdit
	} // conservative for pre-migration memory data
	return (minimum == RoleView || minimum == RoleEdit) && RoleRank(role) >= RoleRank(minimum)
}

func (m *Memory) checkCommentLocked(ctx context.Context, guard RestoreGuard, docID int64) (time.Time, error) {
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
	for cur := d; cur != nil; {
		if seen[cur.meta.ID] || cur.deleted || cur.meta.WorkspaceID != d.meta.WorkspaceID {
			return time.Time{}, ErrForbidden
		}
		seen[cur.meta.ID] = true
		if cur.meta.ParentID == nil {
			break
		}
		cur = m.doc(*cur.meta.ParentID)
		if cur == nil {
			return time.Time{}, ErrForbidden
		}
	}
	role := m.roleLocked(guard.UserID, d)
	if RoleRank(role) < RoleRank(RoleView) {
		return time.Time{}, ErrForbidden
	}
	minimum := d.meta.CommentMinRole
	if d.meta.Kind != "doc" {
		minimum = RoleEdit
	}
	if !commentRoleAllowed(role, minimum) {
		return time.Time{}, ErrCommentPermissionDenied
	}
	return session.expires, nil
}

func lockCommentAccess(ctx context.Context, tx pgx.Tx, guard RestoreGuard, docID int64) (time.Time, error) {
	var minimum, kind string
	err := tx.QueryRow(ctx, `SELECT comment_min_role,kind FROM nodes WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, docID).Scan(&minimum, &kind)
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
	if errors.Is(err, ErrNotFound) || err == nil && RoleRank(role) < RoleRank(RoleView) {
		return time.Time{}, ErrForbidden
	}
	if err != nil {
		return time.Time{}, err
	}
	if kind != "doc" {
		minimum = RoleEdit
	}
	if !commentRoleAllowed(role, minimum) {
		return time.Time{}, ErrCommentPermissionDenied
	}
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

// nextCommentIDLocked never reuses a deleted comment's ID in this store.
// m.mu must be held by the caller.
func (m *Memory) nextCommentIDLocked() int64 {
	if m.commentSequence == 0 {
		for _, c := range m.comments {
			if c.ID > m.commentSequence {
				m.commentSequence = c.ID
			}
		}
	}
	m.commentSequence++
	return m.commentSequence
}

func (m *Memory) AddCommentGuarded(ctx context.Context, guard RestoreGuard, c Comment) (Comment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expiry, err := m.checkCommentLocked(ctx, guard, c.DocID)
	if err != nil {
		return Comment{}, err
	}
	if c.UserID != guard.UserID {
		return Comment{}, ErrForbidden
	}
	var parentAuthor int64
	if c.ParentID != nil {
		found := false
		for _, parent := range m.comments {
			if parent.ID == *c.ParentID && parent.DocID == c.DocID {
				found = true
				parentAuthor = parent.UserID
				break
			}
		}
		if !found {
			return Comment{}, ErrNotFound
		}
	}
	if err = ctx.Err(); err != nil {
		return Comment{}, err
	}
	if !guard.currentTime().Before(expiry) {
		return Comment{}, ErrUnauthenticated
	}
	c.ID = m.nextCommentIDLocked()
	if u := m.userByID(c.UserID); u != nil {
		c.UserName = u.Name
	}
	now := time.Now()
	c.CreatedAt, c.UpdatedAt = now, now
	c.Mentions = append([]int64(nil), c.Mentions...)
	items := m.commentNotificationsLocked(c, guard.UserID, parentAuthor, false)
	if err = ctx.Err(); err != nil {
		return Comment{}, err
	}
	if !guard.currentTime().Before(expiry) {
		return Comment{}, ErrUnauthenticated
	}
	m.comments = append(m.comments, c)
	m.publishCommentNotificationsLocked(items, now)
	return c, nil
}

func (m *Memory) PatchCommentGuarded(ctx context.Context, guard RestoreGuard, docID, commentID int64, body *string, resolved *bool) (Comment, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expiry, err := m.checkCommentLocked(ctx, guard, docID)
	if err != nil {
		return Comment{}, false, err
	}
	for i, c := range m.comments {
		if c.ID != commentID || c.DocID != docID {
			continue
		}
		if body != nil && c.UserID != guard.UserID {
			return Comment{}, false, ErrForbidden
		}
		changed := resolved != nil && *resolved && !c.Resolved
		if body != nil {
			c.Body = *body
		}
		if resolved != nil {
			c.Resolved = *resolved
		}
		var items []Notification
		if changed {
			items = m.commentNotificationsLocked(c, guard.UserID, 0, true)
		}
		if err = ctx.Err(); err != nil {
			return Comment{}, false, err
		}
		if !guard.currentTime().Before(expiry) {
			return Comment{}, false, ErrUnauthenticated
		}
		c.UpdatedAt = time.Now()
		m.comments[i] = c
		m.publishCommentNotificationsLocked(items, c.UpdatedAt)
		return c, changed, nil
	}
	return Comment{}, false, ErrNotFound
}

func (m *Memory) DeleteCommentGuarded(ctx context.Context, guard RestoreGuard, docID, commentID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expiry, err := m.checkCommentLocked(ctx, guard, docID)
	if err != nil {
		return err
	}
	found := false
	for _, c := range m.comments {
		if c.ID == commentID && c.DocID == docID {
			if c.UserID != guard.UserID && m.roleLocked(guard.UserID, m.doc(docID)) != RoleManage {
				return ErrForbidden
			}
			found = true
			break
		}
	}
	if !found {
		return ErrNotFound
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if !guard.currentTime().Before(expiry) {
		return ErrUnauthenticated
	}
	return m.removeCommentTreeLocked(docID, commentID)
}

// removeCommentTreeLocked preserves malformed cross-document legacy threads
// rather than allowing their deletion to cross the authorization boundary.
// m.mu must be held by the caller, and the caller must check authorization.
func (m *Memory) removeCommentTreeLocked(docID, commentID int64) error {
	found := false
	for _, c := range m.comments {
		if c.ID == commentID && c.DocID == docID {
			found = true
			break
		}
	}
	if !found {
		return ErrNotFound
	}
	removed := map[int64]bool{commentID: true}
	for changed := true; changed; {
		changed = false
		for _, c := range m.comments {
			if c.ParentID != nil && removed[*c.ParentID] && !removed[c.ID] {
				if c.DocID != docID {
					return ErrConflict
				}
				removed[c.ID] = true
				changed = true
			}
		}
	}
	out := m.comments[:0]
	for _, c := range m.comments {
		if c.DocID != docID || !removed[c.ID] {
			out = append(out, c)
		}
	}
	m.comments = out
	for i := range m.notifications {
		n := &m.notifications[i]
		if n.CommentID != nil && removed[*n.CommentID] {
			// Retain notification identity but permanently detach it from any
			// future comment; normal IDs are positive.
			invalid := -*n.CommentID
			n.CommentID = &invalid
		}
	}
	return nil
}

func (p *Postgres) AddCommentGuarded(ctx context.Context, guard RestoreGuard, c Comment) (out Comment, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expiry, err := lockCommentAccess(ctx, tx, guard, c.DocID)
		if err != nil {
			return err
		}
		if c.UserID != guard.UserID {
			return ErrForbidden
		}
		var parentAuthor int64
		if c.ParentID != nil {
			err = tx.QueryRow(ctx, `SELECT user_id FROM comments WHERE id=$1 AND doc_id=$2 FOR SHARE`, *c.ParentID, c.DocID).Scan(&parentAuthor)
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			if err != nil {
				return err
			}
		}
		if c.Mentions == nil {
			c.Mentions = []int64{}
		}
		err = tx.QueryRow(ctx, `INSERT INTO comments (doc_id,user_id,parent_id,block,start_char,end_char,quote,body,mentions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,created_at,updated_at`, c.DocID, c.UserID, c.ParentID, c.Block, c.StartChar, c.EndChar, c.Quote, c.Body, c.Mentions).Scan(&c.ID, &c.CreatedAt, &c.UpdatedAt)
		if err != nil {
			return err
		}
		if err = tx.QueryRow(ctx, `SELECT name FROM users WHERE id=$1`, c.UserID).Scan(&c.UserName); err != nil {
			return err
		}
		if err = insertCommentNotificationsTx(ctx, tx, c, guard.UserID, parentAuthor, false); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		out = c
		return nil
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	if err != nil {
		out = Comment{}
	}
	return
}

func (p *Postgres) PatchCommentGuarded(ctx context.Context, guard RestoreGuard, docID, commentID int64, body *string, resolved *bool) (out Comment, changed bool, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expiry, err := lockCommentAccess(ctx, tx, guard, docID)
		if err != nil {
			return err
		}
		c, err := scanComment(tx.QueryRow(ctx, `SELECT `+commentCols+` FROM comments c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=$1 AND c.doc_id=$2 FOR UPDATE OF c`, commentID, docID))
		if err != nil {
			return err
		}
		if body != nil && c.UserID != guard.UserID {
			return ErrForbidden
		}
		changed = resolved != nil && *resolved && !c.Resolved
		if body != nil {
			c.Body = *body
		}
		if resolved != nil {
			c.Resolved = *resolved
		}
		err = tx.QueryRow(ctx, `UPDATE comments SET body=$3,resolved=$4,updated_at=now() WHERE id=$1 AND doc_id=$2 RETURNING updated_at`, commentID, docID, c.Body, c.Resolved).Scan(&c.UpdatedAt)
		if err != nil {
			return err
		}
		if changed {
			if err = insertCommentNotificationsTx(ctx, tx, c, guard.UserID, 0, true); err != nil {
				return err
			}
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		out = c
		return nil
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	if err != nil {
		out = Comment{}
		changed = false
	}
	return
}

func (p *Postgres) DeleteCommentGuarded(ctx context.Context, guard RestoreGuard, docID, commentID int64) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expiry, err := lockCommentAccess(ctx, tx, guard, docID)
		if err != nil {
			return err
		}
		var owner int64
		err = tx.QueryRow(ctx, `SELECT user_id FROM comments WHERE id=$1 AND doc_id=$2 FOR UPDATE`, commentID, docID).Scan(&owner)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if owner != guard.UserID {
			role, _, _, err := lockCopySource(ctx, tx, docID, guard.UserID)
			if err != nil {
				return err
			}
			if role != RoleManage {
				return ErrForbidden
			}
		}
		// Old releases allowed a reply to reference a comment in a different
		// document. The parent FK cascades recursively, so refusing malformed
		// descendants is necessary before deleting the authorized thread.
		// Block concurrent legacy inserts while checking; a mere recursive read
		// would otherwise race a newly inserted cross-document child.
		if _, err = tx.Exec(ctx, `LOCK TABLE comments IN SHARE ROW EXCLUSIVE MODE`); err != nil {
			return err
		}
		var crossesDocument bool
		err = tx.QueryRow(ctx, `WITH RECURSIVE descendants(id, doc_id) AS (
			SELECT id,doc_id FROM comments WHERE id=$1 AND doc_id=$2
			UNION
			SELECT c.id,c.doc_id FROM comments c JOIN descendants p ON c.parent_id=p.id
		) SELECT EXISTS(SELECT 1 FROM descendants WHERE doc_id<>$2)`, commentID, docID).Scan(&crossesDocument)
		if err != nil {
			return err
		}
		if crossesDocument {
			return ErrConflict
		}
		if _, err = tx.Exec(ctx, `DELETE FROM comments WHERE id=$1 AND doc_id=$2`, commentID, docID); err != nil {
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
