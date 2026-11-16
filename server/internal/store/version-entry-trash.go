package store

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const versionTrashRetention = 30 * 24 * time.Hour

type DeletedVersionEntry struct {
	VersionEntry
	DeletedAt time.Time `json:"deletedAt"`
}

func (m *Memory) DeletedVersionEntries(ctx context.Context, guard RestoreGuard, docID int64) ([]DeletedVersionEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return nil, err
	}
	d := m.doc(docID)
	if d == nil || d.deleted || d.purged || d.meta.Kind != "doc" {
		return nil, ErrNotFound
	}
	if !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) || RoleRank(m.roleLocked(guard.UserID, d)) < RoleRank(RoleEdit) {
		return nil, ErrForbidden
	}
	now := guard.currentTime()
	out := []DeletedVersionEntry{}
	for _, entry := range d.namedVersions {
		if entry.deletedAt == nil || entry.CreatedBy == 0 || !entry.deletedAt.After(now.Add(-versionTrashRetention)) {
			continue
		}
		v := entry.VersionEntry
		v.CreatedByName = ""
		if user := m.userByID(v.CreatedBy); user != nil {
			v.CreatedByName = user.Name
		}
		out = append(out, DeletedVersionEntry{VersionEntry: v, DeletedAt: *entry.deletedAt})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].DeletedAt.Equal(out[j].DeletedAt) {
			return out[i].ID > out[j].ID
		}
		return out[i].DeletedAt.After(out[j].DeletedAt)
	})
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if !guard.currentTime().Before(expires) {
		return nil, ErrUnauthenticated
	}
	return out, nil
}

func (m *Memory) RestoreVersionEntry(ctx context.Context, guard RestoreGuard, docID int64, id string, revision int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return err
	}
	d := m.doc(docID)
	if d == nil || d.deleted || d.purged || d.meta.Kind != "doc" {
		return ErrNotFound
	}
	if !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) || RoleRank(m.roleLocked(guard.UserID, d)) < RoleRank(RoleEdit) {
		return ErrForbidden
	}
	for i := range d.namedVersions {
		v := &d.namedVersions[i]
		if v.ID != id {
			continue
		}
		if v.deletedAt == nil || v.CreatedBy == 0 || !v.deletedAt.After(guard.currentTime().Add(-versionTrashRetention)) {
			return ErrNotFound
		}
		if v.Revision != revision {
			return ErrConflict
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		v.deletedAt = nil
		v.Revision++
		return nil
	}
	return ErrNotFound
}

func (p *Postgres) DeletedVersionEntries(ctx context.Context, guard RestoreGuard, docID int64) (out []DeletedVersionEntry, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		role, _, kind, e := lockCopySource(ctx, tx, docID, guard.UserID)
		if e != nil {
			return e
		}
		if kind != "doc" || RoleRank(role) < RoleRank(RoleEdit) {
			return ErrForbidden
		}
		ws, e := drivePGNodeWorkspace(ctx, tx, docID)
		if e != nil {
			return e
		}
		if e = drivePGValidChain(ctx, tx, docID, ws); e != nil {
			return ErrForbidden
		}
		rows, e := tx.Query(ctx, `SELECT CASE WHEN v.legacy_seq THEN 's:'||v.seq::text ELSE 'n:'||v.id::text END,v.seq,v.label,COALESCE(v.created_by,0),COALESCE(u.name,''),v.created_at,v.revision,v.deleted_at FROM doc_version_entries v LEFT JOIN users u ON u.id=v.created_by WHERE v.doc_id=$1 AND v.created_by IS NOT NULL AND v.deleted_at>$2 ORDER BY v.deleted_at DESC,v.id DESC`, docID, guard.currentTime().Add(-versionTrashRetention))
		if e != nil {
			return e
		}
		defer rows.Close()
		out = []DeletedVersionEntry{}
		for rows.Next() {
			var v DeletedVersionEntry
			if e = rows.Scan(&v.ID, &v.Seq, &v.Label, &v.CreatedBy, &v.CreatedByName, &v.CreatedAt, &v.Revision, &v.DeletedAt); e != nil {
				return e
			}
			out = append(out, v)
		}
		if e = rows.Err(); e != nil {
			return e
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		return nil
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	return
}

func (p *Postgres) RestoreVersionEntry(ctx context.Context, guard RestoreGuard, docID int64, id string, revision int64) (err error) {
	prefix, raw, ok := strings.Cut(id, ":")
	n, e := strconv.ParseInt(raw, 10, 64)
	if !ok || e != nil || n <= 0 || (prefix != "n" && prefix != "s") {
		return ErrNotFound
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var head int64
		e := tx.QueryRow(ctx, `SELECT seq FROM doc_heads WHERE doc_id=$1 FOR UPDATE`, docID).Scan(&head)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		role, _, kind, e := lockCopySource(ctx, tx, docID, guard.UserID)
		if e != nil {
			return e
		}
		if kind != "doc" || RoleRank(role) < RoleRank(RoleEdit) {
			return ErrForbidden
		}
		ws, e := drivePGNodeWorkspace(ctx, tx, docID)
		if e != nil {
			return e
		}
		if e = drivePGValidChain(ctx, tx, docID, ws); e != nil {
			return ErrForbidden
		}
		query := `SELECT id,revision,deleted_at FROM doc_version_entries WHERE doc_id=$1 AND id=$2 AND NOT legacy_seq AND created_by IS NOT NULL FOR UPDATE`
		if prefix == "s" {
			query = `SELECT id,revision,deleted_at FROM doc_version_entries WHERE doc_id=$1 AND seq=$2 AND legacy_seq AND created_by IS NOT NULL FOR UPDATE`
		}
		var row, current int64
		var deleted *time.Time
		e = tx.QueryRow(ctx, query, docID, n).Scan(&row, &current, &deleted)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if deleted == nil || !deleted.After(guard.currentTime().Add(-versionTrashRetention)) {
			return ErrNotFound
		}
		if current != revision {
			return ErrConflict
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		_, e = tx.Exec(ctx, `UPDATE doc_version_entries SET deleted_at=NULL,revision=revision+1 WHERE id=$1`, row)
		return e
	})
	if retryableRestoreConflict(err) {
		return ErrConflict
	}
	return err
}
