package store

import (
	"context"
	"errors"
	"slices"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/jackc/pgx/v5"
)

var ErrTitleReplayPageLimit = errors.New("title replay: page resource limit")

const titleReplayPageMaxRows = 256
const titleReplayPageMaxBytes = 8 << 20

// TitleReplayPageReader is an internal, read-only page of the existing log.
// It checks authorization, epoch, a fixed target head and contiguous rows on
// every call. It does not prove full causality, operation identity uniqueness,
// immutable history across database rollback, or checkpoint provenance; a
// caller must perform those checks before publishing any projection. This is
// not exposed as an HTTP endpoint or connected to document writes. Records
// contain raw document content and must not be sent to a client without the
// applicable content-copy policy and a fresh authorization check.
type TitleReplayPageReader interface {
	ReadTitleReplayPage(context.Context, RestoreGuard, int64, int64, int64, int64, int, int) ([]collab.TitleProjectionRecord, error)
}

// BuildTitleReplayCandidate reads a fixed prefix from sequence 1 and checks
// every operation identity before yielding a candidate. The final empty-page
// read rechecks the account and epoch. A concurrent append can make the
// candidate stale; full causality and publication still need separate checks.
func BuildTitleReplayCandidate(ctx context.Context, reader TitleReplayPageReader, guard RestoreGuard, doc, epoch, head int64, maxRows, maxBytes int) (collab.TitleProjectionCandidate, error) {
	if reader == nil || !validTitleReplayPage(doc, epoch, head, 0, maxRows, maxBytes) {
		return collab.TitleProjectionCandidate{}, ErrConflict
	}
	replay, err := collab.NewTitleIdentityReplay(uint64(doc), uint64(epoch))
	if err != nil {
		return collab.TitleProjectionCandidate{}, err
	}
	var cursor int64
	for cursor < head {
		if err := ctx.Err(); err != nil {
			return collab.TitleProjectionCandidate{}, err
		}
		page, err := reader.ReadTitleReplayPage(ctx, guard, doc, epoch, head, cursor, maxRows, maxBytes)
		if err != nil {
			return collab.TitleProjectionCandidate{}, err
		}
		if len(page) == 0 || len(page) > maxRows {
			return collab.TitleProjectionCandidate{}, ErrConflict
		}
		used := 0
		for _, record := range page {
			if err := ctx.Err(); err != nil {
				return collab.TitleProjectionCandidate{}, err
			}
			if record.Seq != uint64(cursor+1) || record.Seq > uint64(head) || len(record.Bytes) > maxBytes-used {
				return collab.TitleProjectionCandidate{}, ErrConflict
			}
			if err := replay.ApplyRecord(record); err != nil {
				return collab.TitleProjectionCandidate{}, err
			}
			used += len(record.Bytes)
			cursor++
		}
	}
	page, err := reader.ReadTitleReplayPage(ctx, guard, doc, epoch, head, cursor, maxRows, maxBytes)
	if err != nil {
		return collab.TitleProjectionCandidate{}, err
	}
	if len(page) != 0 {
		return collab.TitleProjectionCandidate{}, ErrConflict
	}
	return replay.CandidateAt(uint64(head))
}

func validTitleReplayPage(doc, epoch, head, after int64, maxRows, maxBytes int) bool {
	return doc > 0 && doc <= maxConditionalInteger && epoch > 0 && epoch <= maxConditionalInteger && head >= 0 && head <= maxConditionalInteger && after >= 0 && after <= head && maxRows > 0 && maxRows <= titleReplayPageMaxRows && maxBytes > 0 && maxBytes <= titleReplayPageMaxBytes
}

// Decode one row only after checking the one-op header, avoiding a malicious
// count causing DecodeOps to allocate for an entire batch. Canonical encoding,
// ranges and identity uniqueness remain the replay verifier's responsibility.
func titleReplayRow(doc, epoch, seq, client, storedClock int64, raw []byte) (collab.TitleProjectionRecord, error) {
	if client < 0 || storedClock < -1 || len(raw) < 3 || raw[0] != collab.Magic || raw[1] != collab.Version || raw[2] != 1 {
		return collab.TitleProjectionRecord{}, ErrConflict
	}
	ops, err := collab.DecodeOps(raw)
	if err != nil || len(ops) != 1 || ops[0].ID.Client != uint64(client) || ops[0].ID.Clock == 0 || storedClock >= 0 && ops[0].ID.Clock != uint64(storedClock) {
		return collab.TitleProjectionRecord{}, ErrConflict
	}
	return collab.TitleProjectionRecord{DocumentID: uint64(doc), Epoch: uint64(epoch), Seq: uint64(seq), ClientID: uint64(client), Clock: ops[0].ID.Clock, Bytes: slices.Clone(raw)}, nil
}

func (m *Memory) ReadTitleReplayPage(ctx context.Context, guard RestoreGuard, doc, epoch, head, after int64, maxRows, maxBytes int) ([]collab.TitleProjectionRecord, error) {
	if !validTitleReplayPage(doc, epoch, head, after, maxRows, maxBytes) {
		return nil, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, guard)
	if err != nil {
		return nil, err
	}
	d := m.doc(doc)
	if d == nil || d.deleted || d.purged || d.meta.Kind != "doc" {
		return nil, ErrNotFound
	}
	if !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) || RoleRank(m.roleLocked(guard.UserID, d)) < RoleRank(RoleEdit) {
		return nil, ErrForbidden
	}
	actualEpoch := d.historyEpoch
	if actualEpoch < 1 {
		actualEpoch = 1
	}
	if actualEpoch != epoch || int64(len(d.ops)) < head {
		return nil, ErrConflict
	}
	var out []collab.TitleProjectionRecord
	used := 0
	for seq := after + 1; seq <= head && len(out) < maxRows; seq++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		row := d.ops[seq-1]
		if row.Seq != seq {
			return nil, ErrConflict
		}
		if len(row.Bytes) > maxBytes-used {
			if len(out) == 0 {
				return nil, ErrTitleReplayPageLimit
			}
			break
		}
		record, err := titleReplayRow(doc, epoch, seq, row.ClientID, -1, row.Bytes)
		if err != nil {
			return nil, err
		}
		out = append(out, record)
		used += len(row.Bytes)
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, err
	}
	return out, nil
}

func (p *Postgres) ReadTitleReplayPage(ctx context.Context, guard RestoreGuard, doc, epoch, head, after int64, maxRows, maxBytes int) (out []collab.TitleProjectionRecord, err error) {
	if !validTitleReplayPage(doc, epoch, head, after, maxRows, maxBytes) {
		return nil, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var actualEpoch, actualHead int64
		if e := tx.QueryRow(ctx, `SELECT history_epoch,seq FROM doc_heads WHERE doc_id=$1 FOR SHARE`, doc).Scan(&actualEpoch, &actualHead); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return e
		}
		expires, e := drivePGSession(ctx, tx, guard)
		if e != nil {
			return e
		}
		role, _, kind, e := lockCopySource(ctx, tx, doc, guard.UserID)
		if errors.Is(e, ErrNotFound) {
			return ErrForbidden
		}
		if e != nil {
			return e
		}
		if kind != "doc" || RoleRank(role) < RoleRank(RoleEdit) {
			return ErrForbidden
		}
		ws, e := drivePGNodeWorkspace(ctx, tx, doc)
		if e != nil {
			return e
		}
		if e = drivePGValidChain(ctx, tx, doc, ws); errors.Is(e, ErrConflict) {
			return ErrForbidden
		} else if e != nil {
			return e
		}
		if actualEpoch != epoch || actualHead < head || actualHead > maxConditionalInteger {
			return ErrConflict
		}
		rows, e := tx.Query(ctx, `SELECT seq,client_id,clock,octet_length(op),CASE WHEN octet_length(op)<=$5 THEN op END FROM doc_ops WHERE doc_id=$1 AND seq>$2 AND seq<=$3 ORDER BY seq LIMIT $4`, doc, after, head, maxRows, maxBytes)
		if e != nil {
			return e
		}
		defer rows.Close()
		used := 0
		for rows.Next() {
			var seq, client, clock, size int64
			var raw []byte
			if e = rows.Scan(&seq, &client, &clock, &size, &raw); e != nil {
				return e
			}
			if seq != after+int64(len(out))+1 || client < 0 || clock < 0 || size < 0 {
				return ErrConflict
			}
			if size > int64(maxBytes-used) {
				if len(out) == 0 {
					return ErrTitleReplayPageLimit
				}
				break
			}
			if int64(len(raw)) != size {
				return ErrConflict
			}
			record, e := titleReplayRow(doc, epoch, seq, client, clock, raw)
			if e != nil {
				return e
			}
			out = append(out, record)
			used += len(raw)
		}
		if e = rows.Err(); e != nil {
			return e
		}
		if after < head && len(out) == 0 {
			return ErrConflict
		}
		return drivePGEnd(ctx, guard, expires)
	})
	if err != nil {
		return nil, drivePGError(err)
	}
	return out, nil
}
