package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

type VersionEntry struct {
	ID            string    `json:"id"`
	Seq           int64     `json:"seq"`
	Label         string    `json:"label"`
	CreatedBy     int64     `json:"createdBy"`
	CreatedByName string    `json:"createdByName"`
	CreatedAt     time.Time `json:"createdAt"`
	Revision      int64     `json:"revision"`
}
type memoryVersionEntry struct {
	VersionEntry
	request   string
	epoch     int64
	deletedAt *time.Time
}

var versionRequestPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

func (m *Memory) CreateVersionEntry(ctx context.Context, guard RestoreGuard, docID, epoch, head int64, state []byte, label, request string) (VersionEntry, error) {
	if !versionRequestPattern.MatchString(request) {
		return VersionEntry{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return VersionEntry{}, err
	}
	d := m.doc(docID)
	if d == nil || d.deleted || d.purged || d.meta.Kind != "doc" {
		return VersionEntry{}, ErrNotFound
	}
	if !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) || RoleRank(m.roleLocked(guard.UserID, d)) < RoleRank(RoleEdit) {
		return VersionEntry{}, ErrForbidden
	}
	currentEpoch := d.historyEpoch
	if currentEpoch < 1 {
		currentEpoch = 1
	}
	if epoch != currentEpoch || head <= 0 || int64(len(d.ops)) != head {
		return VersionEntry{}, ErrConflict
	}
	if old, ok := d.snaps[head]; ok && !bytes.Equal(old, state) {
		return VersionEntry{}, ErrConflict
	}
	for _, entry := range d.namedVersions {
		if entry.CreatedBy == guard.UserID && entry.request == request {
			if entry.deletedAt != nil {
				return VersionEntry{}, ErrConflict
			}
			if entry.Seq != head || entry.epoch != epoch || entry.Label != label {
				return VersionEntry{}, ErrConflict
			}
			if err = ctx.Err(); err != nil {
				return VersionEntry{}, err
			}
			if !guard.currentTime().Before(expires) {
				return VersionEntry{}, ErrUnauthenticated
			}
			return entry.VersionEntry, nil
		}
	}
	if err = ctx.Err(); err != nil {
		return VersionEntry{}, err
	}
	if !guard.currentTime().Before(expires) {
		return VersionEntry{}, ErrUnauthenticated
	}
	// Promote a legacy version before adding a second name for that snapshot.
	if old, ok := d.versions[head]; ok {
		hasEntry := false
		for _, entry := range d.namedVersions {
			if entry.Seq == head {
				hasEntry = true
				break
			}
		}
		if !hasEntry {
			name := ""
			if u := m.userByID(old.UserID); u != nil {
				name = u.Name
			}
			d.namedVersions = append(d.namedVersions, memoryVersionEntry{VersionEntry: VersionEntry{ID: fmt.Sprintf("s:%d", head), Seq: head, Label: old.Label, CreatedBy: old.UserID, CreatedByName: name, CreatedAt: old.At, Revision: 1}})
		}
	} else {
		d.snaps[head] = slices.Clone(state)
		d.versions[head] = memVersion{Label: label, UserID: guard.UserID, At: time.Now()}
	}
	m.d.versionEntrySequence++
	out := VersionEntry{ID: fmt.Sprintf("n:%d", m.d.versionEntrySequence), Seq: head, Label: label, CreatedBy: guard.UserID, CreatedByName: m.users[guard.UserID-1].Name, CreatedAt: time.Now(), Revision: 1}
	d.namedVersions = append(d.namedVersions, memoryVersionEntry{VersionEntry: out, request: request, epoch: epoch})
	return out, nil
}

func (m *Memory) ListVersionEntries(ctx context.Context, guard RestoreGuard, docID int64) ([]VersionEntry, error) {
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
	if !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) || RoleRank(m.roleLocked(guard.UserID, d)) < RoleRank(RoleView) {
		return nil, ErrForbidden
	}
	out := make([]VersionEntry, 0, len(d.namedVersions)+len(d.versions))
	represented := map[int64]bool{}
	for _, entry := range d.namedVersions {
		represented[entry.Seq] = true
		if entry.deletedAt != nil {
			continue
		}
		value := entry.VersionEntry
		if value.Revision == 0 {
			value.Revision = 1
		}
		value.CreatedByName = ""
		if user := m.userByID(value.CreatedBy); user != nil {
			value.CreatedByName = user.Name
		}
		out = append(out, value)
	}
	for seq, v := range d.versions {
		if represented[seq] {
			continue
		}
		name := ""
		if u := m.userByID(v.UserID); u != nil {
			name = u.Name
		}
		out = append(out, VersionEntry{ID: fmt.Sprintf("s:%d", seq), Seq: seq, Label: v.Label, CreatedBy: v.UserID, CreatedByName: name, CreatedAt: v.At, Revision: 1})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].ID > out[j].ID
		}
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if !guard.currentTime().Before(expires) {
		return nil, ErrUnauthenticated
	}
	return out, nil
}

func (p *Postgres) CreateVersionEntry(ctx context.Context, guard RestoreGuard, docID, epoch, head int64, state []byte, label, request string) (out VersionEntry, err error) {
	if !versionRequestPattern.MatchString(request) {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var actualEpoch, actualHead int64
		e := tx.QueryRow(ctx, `SELECT history_epoch,seq FROM doc_heads WHERE doc_id=$1 FOR UPDATE`, docID).Scan(&actualEpoch, &actualHead)
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
		if epoch != actualEpoch || head <= 0 || head != actualHead {
			return ErrConflict
		}
		_, e = tx.Exec(ctx, `INSERT INTO doc_snapshots(doc_id,seq,state) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, docID, head, compressState(state))
		if e != nil {
			return e
		}
		var packed []byte
		var versioned bool
		var legacyLabel string
		var legacyCreator *int64
		var legacyTime time.Time
		e = tx.QueryRow(ctx, `SELECT state,is_version,label,created_by,created_at FROM doc_snapshots WHERE doc_id=$1 AND seq=$2 FOR UPDATE`, docID, head).Scan(&packed, &versioned, &legacyLabel, &legacyCreator, &legacyTime)
		if e != nil {
			return e
		}
		if !bytes.Equal(decompressState(packed), state) {
			return ErrConflict
		}
		// Preserve old-client versions created after the migration as separate entries.
		if versioned {
			_, e = tx.Exec(ctx, `INSERT INTO doc_version_entries(doc_id,seq,label,created_by,created_at,legacy_seq) SELECT $1,$2,$3,$4,$5,true WHERE NOT EXISTS (SELECT 1 FROM doc_version_entries WHERE doc_id=$1 AND seq=$2)`, docID, head, legacyLabel, legacyCreator, legacyTime)
			if e != nil {
				return e
			}
		} else {
			_, e = tx.Exec(ctx, `UPDATE doc_snapshots SET is_version=true,label=$3,created_by=$4,created_at=now() WHERE doc_id=$1 AND seq=$2`, docID, head, label, guard.UserID)
			if e != nil {
				return e
			}
		}
		var id, seq, oldEpoch, revision int64
		var oldLabel, name string
		var at time.Time
		e = tx.QueryRow(ctx, `INSERT INTO doc_version_entries(doc_id,seq,history_epoch,label,created_by,request_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(doc_id,created_by,request_id) DO NOTHING RETURNING id,seq,history_epoch,label,created_at,revision`, docID, head, epoch, label, guard.UserID, request).Scan(&id, &seq, &oldEpoch, &oldLabel, &at, &revision)
		if errors.Is(e, pgx.ErrNoRows) {
			e = tx.QueryRow(ctx, `SELECT id,seq,history_epoch,label,created_at,revision FROM doc_version_entries WHERE doc_id=$1 AND created_by=$2 AND request_id=$3 AND deleted_at IS NULL FOR SHARE`, docID, guard.UserID, request).Scan(&id, &seq, &oldEpoch, &oldLabel, &at, &revision)
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrConflict
			}
			if e != nil {
				return e
			}
			if seq != head || oldEpoch != epoch || oldLabel != label {
				return ErrConflict
			}
		} else if e != nil {
			return e
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		if e = tx.QueryRow(ctx, `SELECT name FROM users WHERE id=$1`, guard.UserID).Scan(&name); e != nil {
			return e
		}
		out = VersionEntry{ID: fmt.Sprintf("n:%d", id), Seq: seq, Label: oldLabel, CreatedBy: guard.UserID, CreatedByName: name, CreatedAt: at, Revision: revision}
		return nil
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	return
}

func (p *Postgres) ListVersionEntries(ctx context.Context, guard RestoreGuard, docID int64) (out []VersionEntry, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		role, _, kind, e := lockCopySource(ctx, tx, docID, guard.UserID)
		if e != nil {
			return e
		}
		if kind != "doc" || RoleRank(role) < RoleRank(RoleView) {
			return ErrForbidden
		}
		ws, e := drivePGNodeWorkspace(ctx, tx, docID)
		if e != nil {
			return e
		}
		if e = drivePGValidChain(ctx, tx, docID, ws); e != nil {
			return ErrForbidden
		}
		rows, e := tx.Query(ctx, `SELECT id,seq,label,created_by,name,created_at,revision FROM (
    SELECT CASE WHEN v.legacy_seq THEN 's:'||v.seq::text ELSE 'n:'||v.id::text END AS id,v.seq,v.label,COALESCE(v.created_by,0) AS created_by,COALESCE(u.name,'') AS name,v.created_at,v.revision
    FROM doc_version_entries v LEFT JOIN users u ON u.id=v.created_by WHERE v.doc_id=$1 AND v.deleted_at IS NULL
    UNION ALL
    SELECT 's:'||s.seq::text,s.seq,s.label,COALESCE(s.created_by,0),COALESCE(u.name,''),s.created_at,1::bigint
    FROM doc_snapshots s LEFT JOIN users u ON u.id=s.created_by WHERE s.doc_id=$1 AND s.is_version AND NOT EXISTS(SELECT 1 FROM doc_version_entries v WHERE v.doc_id=s.doc_id AND v.seq=s.seq)
   ) entries ORDER BY created_at DESC,id DESC`, docID)
		if e != nil {
			return e
		}
		defer rows.Close()
		out = []VersionEntry{}
		for rows.Next() {
			var v VersionEntry
			if e = rows.Scan(&v.ID, &v.Seq, &v.Label, &v.CreatedBy, &v.CreatedByName, &v.CreatedAt, &v.Revision); e != nil {
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
