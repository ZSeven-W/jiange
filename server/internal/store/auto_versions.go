package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
)

const AutoVersionLabel = "自动保存"
const autoVersionPageLimit = 100

type AutoVersionCandidate struct{ DocID, Epoch, Head int64 }

func autoVersionLimit(limit int) int {
	if limit < 1 || limit > autoVersionPageLimit {
		return autoVersionPageLimit
	}
	return limit
}

// AutoVersionCandidates uses the current head rather than a wall-clock window,
// so a failed sweep or a service outage does not permanently miss a document.
func (m *Memory) AutoVersionCandidates(ctx context.Context, after int64, limit int) ([]AutoVersionCandidate, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	out := make([]AutoVersionCandidate, 0)
	for _, d := range m.d.docs {
		if d == nil || d.meta.ID <= after || d.deleted || d.purged || d.meta.Kind != "doc" || !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) {
			continue
		}
		head := int64(len(d.ops))
		if head <= 0 {
			continue
		}
		if _, exists := d.versions[head]; exists {
			continue
		}
		epoch := d.historyEpoch
		if epoch < 1 {
			epoch = 1
		}
		out = append(out, AutoVersionCandidate{DocID: d.meta.ID, Epoch: epoch, Head: head})
		if len(out) >= autoVersionLimit(limit) {
			break
		}
	}
	return out, nil
}

// SaveAutomaticVersion never renames a manual version at the same head.
func (m *Memory) SaveAutomaticVersion(ctx context.Context, candidate AutoVersionCandidate, state []byte) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return false, err
	}
	d := m.doc(candidate.DocID)
	if d == nil || d.deleted || d.purged || d.meta.Kind != "doc" || !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) {
		return false, ErrNotFound
	}
	epoch := d.historyEpoch
	if epoch < 1 {
		epoch = 1
	}
	if candidate.Epoch != epoch || candidate.Head <= 0 || candidate.Head != int64(len(d.ops)) {
		return false, ErrConflict
	}
	if existing, ok := d.snaps[candidate.Head]; ok && !bytes.Equal(existing, state) {
		return false, ErrConflict
	}
	if _, exists := d.versions[candidate.Head]; exists {
		return false, nil
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	now := time.Now()
	d.snaps[candidate.Head] = slices.Clone(state)
	d.versions[candidate.Head] = memVersion{Label: AutoVersionLabel, At: now}
	m.d.versionEntrySequence++
	d.namedVersions = append(d.namedVersions, memoryVersionEntry{VersionEntry: VersionEntry{ID: fmt.Sprintf("n:%d", m.d.versionEntrySequence), Seq: candidate.Head, Label: AutoVersionLabel, CreatedAt: now}, epoch: candidate.Epoch})
	return true, nil
}

func (p *Postgres) AutoVersionCandidates(ctx context.Context, after int64, limit int) ([]AutoVersionCandidate, error) {
	rows, err := p.Pool.Query(ctx, `SELECT h.doc_id,h.history_epoch,h.seq FROM doc_heads h JOIN nodes n ON n.id=h.doc_id WHERE h.doc_id>$1 AND h.seq>0 AND n.kind='doc' AND n.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM doc_snapshots s WHERE s.doc_id=h.doc_id AND s.seq=h.seq AND s.is_version) ORDER BY h.doc_id LIMIT $2`, after, autoVersionLimit(limit))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AutoVersionCandidate{}
	for rows.Next() {
		var c AutoVersionCandidate
		if err = rows.Scan(&c.DocID, &c.Epoch, &c.Head); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (p *Postgres) SaveAutomaticVersion(ctx context.Context, candidate AutoVersionCandidate, state []byte) (created bool, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var epoch, head int64
		e := tx.QueryRow(ctx, `SELECT history_epoch,seq FROM doc_heads WHERE doc_id=$1 FOR UPDATE`, candidate.DocID).Scan(&epoch, &head)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		var creator, ws int64
		e = tx.QueryRow(ctx, `SELECT creator_id,workspace_id FROM nodes WHERE id=$1`, candidate.DocID).Scan(&creator, &ws)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		_, _, kind, e := lockCopySource(ctx, tx, candidate.DocID, creator)
		if e != nil {
			return e
		}
		if kind != "doc" {
			return ErrNotFound
		}
		if e = drivePGValidChain(ctx, tx, candidate.DocID, ws); e != nil {
			return ErrNotFound
		}
		if epoch != candidate.Epoch || head <= 0 || head != candidate.Head {
			return ErrConflict
		}
		_, e = tx.Exec(ctx, `INSERT INTO doc_snapshots(doc_id,seq,state) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, candidate.DocID, head, compressState(state))
		if e != nil {
			return e
		}
		var packed []byte
		var versioned bool
		e = tx.QueryRow(ctx, `SELECT state,is_version FROM doc_snapshots WHERE doc_id=$1 AND seq=$2 FOR UPDATE`, candidate.DocID, head).Scan(&packed, &versioned)
		if e != nil {
			return e
		}
		if !bytes.Equal(decompressState(packed), state) {
			return ErrConflict
		}
		if versioned {
			return nil
		}
		var at time.Time
		e = tx.QueryRow(ctx, `UPDATE doc_snapshots SET is_version=true,label=$3,created_by=NULL,created_at=now() WHERE doc_id=$1 AND seq=$2 RETURNING created_at`, candidate.DocID, head, AutoVersionLabel).Scan(&at)
		if e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `INSERT INTO doc_version_entries(doc_id,seq,history_epoch,label,created_by,created_at) VALUES($1,$2,$3,$4,NULL,$5)`, candidate.DocID, head, epoch, AutoVersionLabel, at)
		if e != nil {
			return e
		}
		created = true
		return nil
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	if err != nil {
		created = false
	}
	return
}
