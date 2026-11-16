package store

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

// A nil label deletes the named entry, without deleting its immutable snapshot.
func (m *Memory) ManageVersionEntry(ctx context.Context, guard RestoreGuard, docID int64, id string, revision int64, label *string) error {
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
	index := -1
	for i := range d.namedVersions {
		if d.namedVersions[i].ID == id {
			index = i
			break
		}
	}
	if index < 0 && strings.HasPrefix(id, "s:") {
		seq, e := strconv.ParseInt(id[2:], 10, 64)
		v, ok := d.versions[seq]
		if e != nil || !ok || v.UserID == 0 {
			return ErrNotFound
		}
		for _, entry := range d.namedVersions {
			if entry.Seq == seq {
				return ErrNotFound
			}
		}
		// Promote the fallback only as part of the successful mutation.
		if revision != 1 {
			return ErrConflict
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		d.namedVersions = append(d.namedVersions, memoryVersionEntry{VersionEntry: VersionEntry{ID: id, Seq: seq, Label: v.Label, CreatedBy: v.UserID, CreatedAt: v.At, Revision: 1}})
		index = len(d.namedVersions) - 1
	}
	if index < 0 {
		return ErrNotFound
	}
	entry := &d.namedVersions[index]
	if entry.deletedAt != nil || entry.CreatedBy == 0 {
		return ErrNotFound
	}
	if entry.Revision == 0 {
		entry.Revision = 1
	}
	if entry.Revision != revision {
		return ErrConflict
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if !guard.currentTime().Before(expires) {
		return ErrUnauthenticated
	}
	if label == nil {
		now := guard.currentTime()
		entry.deletedAt = &now
	} else {
		entry.Label = *label
	}
	entry.Revision++
	return nil
}

func (p *Postgres) ManageVersionEntry(ctx context.Context, guard RestoreGuard, docID int64, id string, revision int64, label *string) (err error) {
	prefix, value, ok := strings.Cut(id, ":")
	number, parseErr := strconv.ParseInt(value, 10, 64)
	if !ok || parseErr != nil || number <= 0 || (prefix != "n" && prefix != "s") {
		return ErrNotFound
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var head int64
		if e := tx.QueryRow(ctx, `SELECT seq FROM doc_heads WHERE doc_id=$1 FOR UPDATE`, docID).Scan(&head); errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		} else if e != nil {
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
		if prefix == "s" {
			// Promote only an unrepresented legacy snapshot. Existing tombstones
			// prevent this fallback from recreating deleted entries.
			_, e = tx.Exec(ctx, `INSERT INTO doc_version_entries(doc_id,seq,label,created_by,created_at,legacy_seq)
			 SELECT s.doc_id,s.seq,s.label,s.created_by,s.created_at,true FROM doc_snapshots s
			 WHERE s.doc_id=$1 AND s.seq=$2 AND s.is_version AND s.created_by IS NOT NULL
			 AND NOT EXISTS (SELECT 1 FROM doc_version_entries v WHERE v.doc_id=s.doc_id AND v.seq=s.seq)`, docID, number)
			if e != nil {
				return e
			}
		}
		var current, rowID int64
		query := `SELECT id,revision FROM doc_version_entries WHERE doc_id=$1 AND id=$2 AND NOT legacy_seq AND deleted_at IS NULL AND created_by IS NOT NULL FOR UPDATE`
		if prefix == "s" {
			query = `SELECT id,revision FROM doc_version_entries WHERE doc_id=$1 AND seq=$2 AND legacy_seq AND deleted_at IS NULL AND created_by IS NOT NULL FOR UPDATE`
		}
		e = tx.QueryRow(ctx, query, docID, number).Scan(&rowID, &current)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if current != revision {
			return ErrConflict
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		if label == nil {
			_, e = tx.Exec(ctx, `UPDATE doc_version_entries SET deleted_at=$2,revision=revision+1 WHERE id=$1`, rowID, guard.currentTime())
		} else {
			_, e = tx.Exec(ctx, `UPDATE doc_version_entries SET label=$2,revision=revision+1 WHERE id=$1`, rowID, *label)
		}
		return e
	})
	if retryableRestoreConflict(err) {
		return ErrConflict
	}
	return err
}
