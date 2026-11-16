package store

import (
	"bytes"
	"context"
	"errors"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/collab"
)

var (
	ErrTitleSnapshotUnverified = errors.New("title replay: snapshot differs from complete replay")
	ErrTitleProofLimit         = errors.New("title replay: snapshot verification limit")
)

// This conservative offline verifier intentionally rejects compacted or
// non-canonical snapshots. An exact match is a sufficient check for this
// snapshot, not proof that an unmatched snapshot is corrupt. In particular it
// must never be used to discard an unmatched snapshot or user's data.
const titleProofMaxRecords = 2000
const titleProofMaxBytes = 2 << 20
const titleProofMaxCharacters = 32768

// VerifyTitleSnapshotReplay replays the original log from sequence 1, checks
// all identities and causal dependencies through the fixed head, and compares
// the saved snapshot with the complete replica at SnapshotSeq. The snapshot
// is supplied by an internal caller; page reads enforce the original account
// and edit grant. Nothing is published or mutated. Exact bytes deliberately
// include topology, tombstones, marks and state clock, not just visible text.
// The candidate may become stale immediately; this does not prove immutable
// pages across database rollback, snapshot provenance across a later write,
// compatibility with GC, or permission to publish a directory title.
func VerifyTitleSnapshotReplay(ctx context.Context, reader TitleReplayPageReader, guard RestoreGuard, doc, epoch int64, snapshot TitleSnapshot, maxRows, maxBytes int) (collab.TitleProjectionCandidate, error) {
	if snapshot.Head < 1 || snapshot.SnapshotSeq < 0 || snapshot.SnapshotSeq > snapshot.Head || len(snapshot.Snapshot) == 0 {
		return collab.TitleProjectionCandidate{}, ErrTitleSnapshotUnverified
	}
	if snapshot.Head > titleProofMaxRecords || len(snapshot.Snapshot) > titleProofMaxBytes {
		return collab.TitleProjectionCandidate{}, ErrTitleProofLimit
	}
	full := collab.NewDoc()
	checked := false
	checkSnapshot := func() error {
		if full.Pending() != 0 || !bytes.Equal(full.EncodeState(), snapshot.Snapshot) {
			return ErrTitleSnapshotUnverified
		}
		checked = true
		return nil
	}
	if snapshot.SnapshotSeq == 0 {
		if err := checkSnapshot(); err != nil {
			return collab.TitleProjectionCandidate{}, err
		}
	}
	var used, characters int
	replay, err := replayTitlePrefix(ctx, reader, guard, doc, epoch, snapshot.Head, maxRows, maxBytes, func(row collab.TitleProjectionRecord) error {
		if len(row.Bytes) > titleProofMaxBytes-used {
			return ErrTitleProofLimit
		}
		used += len(row.Bytes)
		if int64(row.Seq) > snapshot.SnapshotSeq {
			return nil
		}
		// DecodeOps allocates by the encoded count. Only accept the fixed
		// one-op header used by the replay reader before decoding untrusted rows.
		if len(row.Bytes) < 3 || row.Bytes[0] != collab.Magic || row.Bytes[1] != collab.Version || row.Bytes[2] != 1 {
			return ErrTitleSnapshotUnverified
		}
		ops, err := collab.DecodeOps(row.Bytes)
		if err != nil || len(ops) != 1 {
			return ErrTitleSnapshotUnverified
		}
		if ops[0].T == collab.TTextInsert {
			characters += utf8.RuneCountInString(ops[0].Text)
			if characters > titleProofMaxCharacters {
				return ErrTitleProofLimit
			}
		}
		if !full.Apply(ops[0]) {
			return ErrTitleSnapshotUnverified
		}
		if int64(row.Seq) == snapshot.SnapshotSeq {
			return checkSnapshot()
		}
		return nil
	})
	if err != nil {
		return collab.TitleProjectionCandidate{}, err
	}
	if !checked {
		return collab.TitleProjectionCandidate{}, ErrTitleSnapshotUnverified
	}
	candidate, err := replay.CausallyCheckedCandidate(ctx, uint64(snapshot.Head))
	if err != nil {
		return collab.TitleProjectionCandidate{}, err
	}
	// A final page rechecks the same session, permission, and epoch after the
	// potentially expensive causal pass, as in the existing candidate builder.
	page, err := reader.ReadTitleReplayPage(ctx, guard, doc, epoch, snapshot.Head, snapshot.Head, maxRows, maxBytes)
	if err != nil {
		return collab.TitleProjectionCandidate{}, err
	}
	if len(page) != 0 {
		return collab.TitleProjectionCandidate{}, ErrConflict
	}
	return candidate, nil
}
