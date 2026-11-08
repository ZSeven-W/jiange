package store

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// NotifyChannel carries "docID:head" payloads after each append.
const NotifyChannel = "jiange_ops"

const docCols = `id, workspace_id, parent_id, title, icon, creator_id, created_at, updated_at, kind`

// creatorName is appended to every doc SELECT/RETURNING list.
const creatorName = `, (SELECT name FROM users WHERE users.id = creator_id)`

func scanDoc(row pgx.Row) (d DocMeta, err error) {
	err = row.Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Title, &d.Icon, &d.CreatorID, &d.CreatedAt, &d.UpdatedAt, &d.Kind, &d.CreatorName)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

func scanDocWithPermissions(row pgx.Row) (d DocMeta, err error) {
	err = row.Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Title, &d.Icon, &d.CreatorID, &d.CreatedAt, &d.UpdatedAt, &d.Kind, &d.CreatorName, &d.CopyProtected, &d.CopyMinRole, &d.DownloadMinRole, &d.CommentMinRole, &d.PermissionsRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

// scanDocDrive additionally reads the versioned-drive columns (queries that
// append `drive_revision, COALESCE(trash_batch_id,0)` after the permission
// columns); trash/delete UIs use the revision for optimistic concurrency.
func scanDocDrive(row pgx.Row) (d DocMeta, err error) {
	err = row.Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Title, &d.Icon, &d.CreatorID, &d.CreatedAt, &d.UpdatedAt, &d.Kind, &d.CreatorName, &d.CopyProtected, &d.CopyMinRole, &d.DownloadMinRole, &d.CommentMinRole, &d.PermissionsRevision, &d.DriveRevision, &d.TrashBatchID)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

func (p *Postgres) CanCreateIn(ctx context.Context, uid, ws int64) (ok bool, err error) {
	err = p.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2)`, ws, uid).Scan(&ok)
	return
}

func (p *Postgres) CreateDoc(ctx context.Context, ws, creator int64, parent *int64, title string, initial []RawOp) (d DocMeta, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var e error
		d, e = scanDoc(tx.QueryRow(ctx,
			`INSERT INTO nodes (workspace_id, parent_id, kind, sort_key, title, creator_id)
			 VALUES ($1, $2, 'doc', 'V', $3, $4) RETURNING `+docCols+creatorName, ws, parent, title, creator))
		if e != nil {
			return e
		}
		d.CopyMinRole, d.DownloadMinRole, d.CommentMinRole = RoleView, RoleView, RoleView
		if _, e = tx.Exec(ctx, `INSERT INTO doc_heads (doc_id, seq) VALUES ($1, $2)`, d.ID, len(initial)); e != nil {
			return e
		}
		for i, op := range initial {
			duplicate, e := checkOperationIdentity(ctx, tx, d.ID, op)
			if e != nil {
				return e
			}
			if duplicate {
				return ErrOpIdentityConflict
			}
			if _, e = tx.Exec(ctx, `INSERT INTO doc_ops (doc_id, seq, client_id, clock, op) VALUES ($1, $2, $3, $4, $5)`,
				d.ID, i+1, op.ClientID, op.Clock, op.Bytes); e != nil {
				return e
			}
			if e = insertOperationRange(ctx, tx, d.ID, int64(i+1), op); e != nil {
				return e
			}
		}
		return nil
	})
	return
}

func (p *Postgres) ListDocs(ctx context.Context, uid int64) ([]DocMeta, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+prefixed("n.", docCols)+`, (SELECT name FROM users u WHERE u.id = n.creator_id), n.copy_protected, n.copy_min_role, n.download_min_role, n.comment_min_role, n.permissions_revision, n.drive_revision, COALESCE(n.trash_batch_id,0) FROM nodes n
		JOIN workspace_members m ON m.workspace_id = n.workspace_id AND m.user_id = $1
		WHERE n.deleted_at IS NULL AND n.kind <> 'file' AND (NOT n.personal OR n.creator_id = $1) ORDER BY n.updated_at DESC, n.id DESC LIMIT 500`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DocMeta{}
	for rows.Next() {
		d, err := scanDocDrive(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func prefixed(p, cols string) string {
	parts := strings.Split(cols, ", ")
	for i := range parts {
		parts[i] = p + parts[i]
	}
	return strings.Join(parts, ", ")
}

func (p *Postgres) GetDoc(ctx context.Context, uid, id int64) (DocMeta, error) {
	var d DocMeta
	err := p.Pool.QueryRow(ctx, `SELECT `+prefixed("n.", docCols)+`, (SELECT name FROM users u WHERE u.id = n.creator_id), `+roleSQL+`, (SELECT name FROM workspaces w WHERE w.id = n.workspace_id), n.copy_protected, n.copy_min_role, n.download_min_role, n.comment_min_role, n.permissions_revision, n.drive_revision, COALESCE(n.trash_batch_id,0) FROM nodes n`+roleJoins+`
		WHERE n.id = $2 AND n.deleted_at IS NULL`, uid, id).
		Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Title, &d.Icon, &d.CreatorID, &d.CreatedAt, &d.UpdatedAt, &d.Kind, &d.CreatorName, &d.Role, &d.WorkspaceName, &d.CopyProtected, &d.CopyMinRole, &d.DownloadMinRole, &d.CommentMinRole, &d.PermissionsRevision, &d.DriveRevision, &d.TrashBatchID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && d.Role == "") {
		return DocMeta{}, ErrNotFound
	}
	return d, err
}

// GetDocSystem fetches node meta without user scoping.
func (p *Postgres) GetDocSystem(ctx context.Context, id int64) (DocMeta, error) {
	var d DocMeta
	err := p.Pool.QueryRow(ctx, `SELECT `+docCols+creatorName+`, copy_protected, copy_min_role, download_min_role, comment_min_role, permissions_revision, drive_revision, COALESCE(trash_batch_id,0) FROM nodes WHERE id=$1 AND deleted_at IS NULL`, id).
		Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Title, &d.Icon, &d.CreatorID, &d.CreatedAt, &d.UpdatedAt, &d.Kind, &d.CreatorName, &d.CopyProtected, &d.CopyMinRole, &d.DownloadMinRole, &d.CommentMinRole, &d.PermissionsRevision, &d.DriveRevision, &d.TrashBatchID)
	if errors.Is(err, pgx.ErrNoRows) {
		return DocMeta{}, ErrNotFound
	}
	return d, err
}

// SetCopyProtected toggles the copy-protection flag (manage only upstream).
func (p *Postgres) SetCopyProtected(ctx context.Context, id int64, on bool) error {
	_, err := p.Pool.Exec(ctx, `UPDATE nodes SET copy_protected=$2,
		copy_min_role=CASE WHEN $2 THEN 'manage' ELSE 'view' END,
		download_min_role=CASE WHEN $2 THEN 'manage' ELSE 'view' END,
		permissions_revision=permissions_revision+1 WHERE id=$1`, id, on)
	return err
}

func (p *Postgres) UpdateTitle(ctx context.Context, id int64, title string) (doc DocMeta, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var e error
		doc, e = scanDocDrive(tx.QueryRow(ctx, `UPDATE nodes SET title=$2, updated_at=now() WHERE id=$1 RETURNING `+docCols+creatorName+`, copy_protected, copy_min_role, download_min_role, comment_min_role, permissions_revision, drive_revision, COALESCE(trash_batch_id,0)`, id, title))
		if e != nil {
			return e
		}
		return recordDocumentModifier(ctx, tx, id, documentActor(ctx))
	})
	if err != nil {
		return DocMeta{}, err
	}
	return doc, nil
}

func (p *Postgres) AllocClient(ctx context.Context, uid, doc int64) (id int64, err error) {
	err = p.Pool.QueryRow(ctx, `INSERT INTO doc_clients (doc_id, user_id) VALUES ($1, $2) RETURNING id`, doc, uid).Scan(&id)
	return
}

func (p *Postgres) ClientOwner(ctx context.Context, id int64) (uid, doc int64, err error) {
	err = p.Pool.QueryRow(ctx, `SELECT user_id, doc_id FROM doc_clients WHERE id=$1`, id).Scan(&uid, &doc)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

func (p *Postgres) SetAck(ctx context.Context, id, seq int64, now time.Time) error {
	_, err := p.Pool.Exec(ctx, `UPDATE doc_clients SET acked_seq=GREATEST(acked_seq,$2), last_seen=$3 WHERE id=$1`, id, seq, now)
	return err
}

func (p *Postgres) Horizon(ctx context.Context, doc int64, since time.Time) (h int64, err error) {
	err = p.Pool.QueryRow(ctx, `SELECT LEAST(h.seq, COALESCE((SELECT min(acked_seq) FROM doc_clients
		WHERE doc_id=$1 AND last_seen >= $2), h.seq)) FROM doc_heads h WHERE h.doc_id=$1`, doc, since).Scan(&h)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

func (p *Postgres) ExistingOpIDs(ctx context.Context, doc int64, ops []RawOp) ([]bool, error) {
	out := make([]bool, len(ops))
	for i, op := range ops {
		if err := p.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM doc_ops WHERE doc_id=$1 AND client_id=$2 AND clock=$3)`, doc, op.ClientID, op.Clock).Scan(&out[i]); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (p *Postgres) AppendOps(ctx context.Context, doc int64, ops []RawOp) ([]int64, error) {
	return p.appendOps(ctx, doc, nil, ops)
}

func (p *Postgres) AppendOpsAtHead(ctx context.Context, doc, expectedHead int64, ops []RawOp) ([]int64, error) {
	return p.appendOps(ctx, doc, &expectedHead, ops)
}

func (p *Postgres) AppendOpsAtHeadGuarded(ctx context.Context, guard RestoreGuard, doc, expectedHead int64, ops []RawOp) ([]int64, error) {
	return p.appendOps(withDocumentWriteGuard(ctx, guard), doc, &expectedHead, ops)
}

func (p *Postgres) appendOps(ctx context.Context, doc int64, expectedHead *int64, ops []RawOp) (seqs []int64, err error) {
	seqs = make([]int64, len(ops))
	guard, guarded := documentWriteGuard(ctx)
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var head int64
		if err := tx.QueryRow(ctx, `SELECT seq FROM doc_heads WHERE doc_id=$1 FOR UPDATE`, doc).Scan(&head); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		nodeLocked := false
		var expires time.Time
		if guarded {
			var e error
			expires, e = drivePGSession(ctx, tx, guard)
			if e != nil {
				return e
			}
			var ws int64
			var kind string
			var deleted bool
			e = tx.QueryRow(ctx, `SELECT workspace_id,kind,deleted_at IS NOT NULL FROM nodes WHERE id=$1 FOR UPDATE`, doc).Scan(&ws, &kind, &deleted)
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrForbidden
			}
			if e != nil {
				return e
			}
			if kind != "doc" || deleted {
				return ErrForbidden
			}
			nodeLocked = true
			role, _, _, e := lockCopySource(ctx, tx, doc, guard.UserID)
			if errors.Is(e, ErrNotFound) {
				return ErrForbidden
			}
			if e != nil {
				return e
			}
			if RoleRank(role) < RoleRank(RoleEdit) {
				return ErrForbidden
			}
			if e = drivePGValidChain(ctx, tx, doc, ws); errors.Is(e, ErrConflict) {
				return ErrForbidden
			} else if e != nil {
				return e
			}
		}
		if expectedHead != nil && head != *expectedHead {
			return ErrConflict
		}
		start := head
		for i, op := range ops {
			duplicate, err := checkOperationIdentity(ctx, tx, doc, op)
			if err != nil {
				return err
			}
			if duplicate {
				continue
			}
			if !nodeLocked {
				// Metadata writes lock the node before last-modifier attribution.
				// The op insert trigger also touches attribution, so acquire the
				// node first to avoid a node/attribution lock inversion.
				var id int64
				if err := tx.QueryRow(ctx, `SELECT id FROM nodes WHERE id=$1 FOR UPDATE`, doc).Scan(&id); err != nil {
					return err
				}
				nodeLocked = true
			}
			tag, err := tx.Exec(ctx, `INSERT INTO doc_ops (doc_id, seq, client_id, clock, op) VALUES ($1,$2,$3,$4,$5)
				ON CONFLICT (doc_id, client_id, clock) DO NOTHING`, doc, head+1, op.ClientID, op.Clock, op.Bytes)
			if err != nil {
				return err
			}
			if tag.RowsAffected() != 1 {
				// The identity was checked under the head lock; an unexpected
				// uniqueness collision must never be treated as an exact retry.
				return ErrOpIdentityConflict
			}
			head++
			if err := insertOperationRange(ctx, tx, doc, head, op); err != nil {
				return err
			}
			seqs[i] = head
		}
		if head == start {
			if guarded {
				return drivePGEnd(ctx, guard, expires)
			}
			return nil
		}
		if _, err := tx.Exec(ctx, `UPDATE doc_heads SET seq=$2 WHERE doc_id=$1`, doc, head); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE nodes SET updated_at=now() WHERE id=$1`, doc); err != nil {
			return err
		}
		actor := documentActor(ctx)
		if guarded {
			actor = guard.UserID
		}
		if err := recordDocumentModifier(ctx, tx, doc, actor); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT pg_notify($1, $2)`, NotifyChannel, strconv.FormatInt(doc, 10)+":"+strconv.FormatInt(head, 10)); err != nil {
			return err
		}
		if guarded {
			return drivePGEnd(ctx, guard, expires)
		}
		return nil
	})
	if guarded && retryableRestoreConflict(err) {
		err = ErrConflict
	}
	return
}

// AppendRestoreOps serializes with ordinary AppendOps on doc_heads and holds
// the effective grant rows until the transaction commits.
func (p *Postgres) AppendRestoreOps(ctx context.Context, guard RestoreGuard, doc, expectedHead int64, ops []RawOp) (seqs []int64, err error) {
	seqs = make([]int64, len(ops))
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var head int64
		if err := tx.QueryRow(ctx, `SELECT seq FROM doc_heads WHERE doc_id=$1 FOR UPDATE`, doc).Scan(&head); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		var sessionUser int64
		var expires time.Time
		if err := tx.QueryRow(ctx, `SELECT user_id, expires_at FROM sessions WHERE token_hash=$1 FOR SHARE`, guard.SessionHash).Scan(&sessionUser, &expires); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrUnauthenticated
			}
			return err
		}
		if sessionUser != guard.UserID || !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		role, _, kind, err := lockCopySource(ctx, tx, doc, guard.UserID)
		if errors.Is(err, ErrNotFound) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		if kind != "doc" || RoleRank(role) < RoleRank(RoleEdit) {
			return ErrForbidden
		}
		if head != expectedHead {
			return ErrConflict
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		for i, op := range ops {
			duplicate, err := checkOperationIdentity(ctx, tx, doc, op)
			if errors.Is(err, ErrOpIdentityConflict) || duplicate {
				return ErrConflict
			}
			if err != nil {
				return err
			}
			tag, err := tx.Exec(ctx, `INSERT INTO doc_ops (doc_id, seq, client_id, clock, op) VALUES ($1,$2,$3,$4,$5)
				ON CONFLICT (doc_id, client_id, clock) DO NOTHING`, doc, head+1, op.ClientID, op.Clock, op.Bytes)
			if err != nil {
				return err
			}
			if tag.RowsAffected() != 1 {
				return ErrConflict
			}
			head++
			if err := insertOperationRange(ctx, tx, doc, head, op); err != nil {
				return err
			}
			seqs[i] = head
		}
		if len(ops) == 0 {
			if !guard.currentTime().Before(expires) {
				return ErrUnauthenticated
			}
			return nil
		}
		if _, err := tx.Exec(ctx, `UPDATE doc_heads SET seq=$2 WHERE doc_id=$1`, doc, head); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE nodes SET updated_at=now() WHERE id=$1`, doc); err != nil {
			return err
		}
		if err := recordDocumentModifier(ctx, tx, doc, guard.UserID); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `SELECT pg_notify($1, $2)`, NotifyChannel, strconv.FormatInt(doc, 10)+":"+strconv.FormatInt(head, 10))
		if err != nil {
			return err
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		if retryableRestoreConflict(err) {
			return nil, ErrConflict
		}
		return nil, err
	}
	return seqs, nil
}

func retryableRestoreConflict(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "40P01" || pgErr.Code == "40001")
}

func (p *Postgres) OpsAfter(ctx context.Context, doc, after int64, limit int) ([]SeqOp, error) {
	if limit <= 0 {
		limit = 1 << 30
	}
	rows, err := p.Pool.Query(ctx, `SELECT seq, client_id, op FROM doc_ops WHERE doc_id=$1 AND seq>$2 ORDER BY seq LIMIT $3`, doc, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SeqOp
	for rows.Next() {
		var o SeqOp
		if err := rows.Scan(&o.Seq, &o.ClientID, &o.Bytes); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (p *Postgres) Head(ctx context.Context, doc int64) (h int64, err error) {
	_, h, err = p.HeadVersion(ctx, doc)
	return
}

// HeadVersion returns the log's history epoch and head. The epoch is an
// independent generation marker: after a restore it changes even when the
// head lands on the same seq with different content.
func (p *Postgres) HeadVersion(ctx context.Context, doc int64) (epoch, head int64, err error) {
	err = p.Pool.QueryRow(ctx, `SELECT history_epoch, seq FROM doc_heads WHERE doc_id=$1`, doc).Scan(&epoch, &head)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

// BumpHistoryEpoch marks the log as a new generation (rollback/restore
// tooling, migration 0036). Clients caching the old epoch must resync from a
// snapshot; their unacknowledged drafts retry through operation identity.
func (p *Postgres) BumpHistoryEpoch(ctx context.Context, doc int64) error {
	tag, err := p.Pool.Exec(ctx, `UPDATE doc_heads SET history_epoch = history_epoch + 1 WHERE doc_id=$1`, doc)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) LatestSnapshot(ctx context.Context, doc int64) (seq int64, state []byte, err error) {
	// Naming a snapshot does not stop it being a valid synchronization baseline.
	// SaveVersion marks the existing row, so filtering it out here could make
	// the only baseline disappear when an older replica reconnects.
	err = p.Pool.QueryRow(ctx, `SELECT seq, state FROM doc_snapshots WHERE doc_id=$1 ORDER BY seq DESC LIMIT 1`, doc).Scan(&seq, &state)
	if err == nil {
		state = decompressState(state)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

func (p *Postgres) SaveSnapshot(ctx context.Context, doc, seq int64, state []byte) error {
	_, err := p.Pool.Exec(ctx, `INSERT INTO doc_snapshots (doc_id, seq, state) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, doc, seq, compressState(state))
	return err
}

// Listen holds a dedicated connection on LISTEN jiange_ops, reconnecting on failure.
func (p *Postgres) Listen(ctx context.Context, fn func(int64, int64)) error {
	for ctx.Err() == nil {
		err := p.listenOnce(ctx, fn)
		if ctx.Err() != nil {
			return nil
		}
		_ = err
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
		}
	}
	return nil
}

func (p *Postgres) listenOnce(ctx context.Context, fn func(int64, int64)) error {
	c, err := p.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer c.Release()
	if _, err := c.Exec(ctx, "LISTEN "+NotifyChannel); err != nil {
		return err
	}
	for {
		n, err := c.Conn().WaitForNotification(ctx)
		if err != nil {
			c.Conn().Close(context.Background()) // don't return a LISTENing conn to the pool
			return err
		}
		a, b, ok := strings.Cut(n.Payload, ":")
		doc, e1 := strconv.ParseInt(a, 10, 64)
		head, e2 := strconv.ParseInt(b, 10, 64)
		if ok && e1 == nil && e2 == nil {
			fn(doc, head)
		}
	}
}

const subtreeCTE = `WITH RECURSIVE t(id) AS (SELECT $1::bigint UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id = t.id) `

func (p *Postgres) Trash(ctx context.Context, id int64) error {
	return p.setSubtreeDeleted(ctx, id, true)
}

func (p *Postgres) Restore(ctx context.Context, id int64) error {
	return p.setSubtreeDeleted(ctx, id, false)
}

// Acquire the root lock in its own statement before taking the recursive
// query's READ COMMITTED snapshot. A child creator that holds a share lock on
// any ancestor then commits or aborts before the subtree is enumerated.
func (p *Postgres) setSubtreeDeleted(ctx context.Context, id int64, deleted bool) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var locked int64
		if err := tx.QueryRow(ctx, `SELECT id FROM nodes WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
			return notFound(err)
		}
		if deleted {
			_, err := tx.Exec(ctx, subtreeCTE+`UPDATE nodes SET deleted_at = now() WHERE id IN (SELECT id FROM t) AND deleted_at IS NULL`, id)
			return err
		}
		_, err := tx.Exec(ctx, subtreeCTE+`UPDATE nodes SET deleted_at = NULL WHERE id IN (SELECT id FROM t)`, id)
		return err
	})
	if retryableRestoreConflict(err) {
		return ErrConflict
	}
	return err
}

func (p *Postgres) ListTrash(ctx context.Context, uid int64) ([]DocMeta, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+prefixed("n.", docCols)+`, (SELECT name FROM users u WHERE u.id = n.creator_id), n.copy_protected, n.copy_min_role, n.download_min_role, n.comment_min_role, n.permissions_revision, n.drive_revision, COALESCE(n.trash_batch_id,0) FROM nodes n
		JOIN workspace_members m ON m.workspace_id = n.workspace_id AND m.user_id = $1
		WHERE n.deleted_at IS NOT NULL AND (NOT n.personal OR n.creator_id = $1) ORDER BY n.deleted_at DESC LIMIT 200`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DocMeta{}
	for rows.Next() {
		d, err := scanDocDrive(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (p *Postgres) Move(ctx context.Context, id int64, parent *int64) error {
	if parent != nil {
		var cyc bool
		if err := p.Pool.QueryRow(ctx, subtreeCTE+`SELECT EXISTS (SELECT 1 FROM t WHERE id = $2)`, id, *parent).Scan(&cyc); err != nil {
			return err
		}
		if cyc {
			return ErrConflict
		}
	}
	return pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE nodes SET parent_id = $2, updated_at = now() WHERE id = $1`, id, parent); err != nil {
			return err
		}
		return recordDocumentModifier(ctx, tx, id, documentActor(ctx))
	})
}

func (p *Postgres) SaveVersion(ctx context.Context, doc, seq int64, label string, userID int64) error {
	t, err := p.Pool.Exec(ctx, `UPDATE doc_snapshots SET is_version = true, label = $3, created_by = $4 WHERE doc_id = $1 AND seq = $2`, doc, seq, label, userID)
	if err != nil {
		return err
	}
	if t.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) Versions(ctx context.Context, doc int64) ([]Version, error) {
	rows, err := p.Pool.Query(ctx, `SELECT s.seq, s.label, s.created_by, COALESCE(u.name, ''), s.created_at
		FROM doc_snapshots s LEFT JOIN users u ON u.id = s.created_by
		WHERE s.doc_id = $1 AND s.is_version ORDER BY s.seq DESC`, doc)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (v Version, err error) {
		err = r.Scan(&v.Seq, &v.Label, &v.CreatedBy, &v.CreatedByName, &v.CreatedAt)
		return
	})
}

func (p *Postgres) VersionState(ctx context.Context, doc, seq int64) ([]byte, error) {
	var state []byte
	err := p.Pool.QueryRow(ctx, `SELECT state FROM doc_snapshots WHERE doc_id = $1 AND seq = $2 AND is_version`, doc, seq).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return decompressState(state), err
}

func (p *Postgres) RecentDocIDs(ctx context.Context, since time.Time) ([]int64, error) {
	rows, err := p.Pool.Query(ctx, `SELECT DISTINCT doc_id FROM doc_ops WHERE created_at > $1`, since)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (int64, error) {
		var id int64
		return id, r.Scan(&id)
	})
}
