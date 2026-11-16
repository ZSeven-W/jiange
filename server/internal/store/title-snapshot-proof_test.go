package store_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func proofRecords(t *testing.T, ops ...collab.Op) []collab.TitleProjectionRecord {
	t.Helper()
	var records []collab.TitleProjectionRecord
	for i, op := range ops {
		raw, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		records = append(records, collab.TitleProjectionRecord{DocumentID: 42, Epoch: 3, Seq: uint64(i + 1), ClientID: op.ID.Client, Clock: op.ID.Clock, Bytes: raw})
	}
	return records
}

func proofReader(records []collab.TitleProjectionRecord) fakeTitleReplayReader {
	return func(_ context.Context, _ store.RestoreGuard, _, _, _, after int64, _, _ int) ([]collab.TitleProjectionRecord, error) {
		if int(after) >= len(records) {
			return nil, nil
		}
		return records[after : after+1], nil
	}
}

func TestTitleSnapshotProofRejectsDifferentHistoryAndUnresolvedTail(t *testing.T) {
	title := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: 0, Clock: 1}, Parent: collab.Root, Pos: "U", Type: "title"}
	body := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: 2, Clock: 1}, Parent: collab.Root, Pos: "V", Type: "paragraph"}
	text := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 3, Clock: 1}, Block: body.ID, Parent: collab.Root, Side: 1, Text: "正文"}
	tail := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 4, Clock: 1}, Block: title.ID, Parent: collab.Root, Side: 1, Text: "标题"}
	records := proofRecords(t, title, body, text, tail)
	full := collab.NewDoc()
	for _, op := range []collab.Op{title, body, text} {
		if !full.Apply(op) {
			t.Fatal("apply failed")
		}
	}
	snapshot := store.TitleSnapshot{Head: 4, SnapshotSeq: 3, Snapshot: full.EncodeState()}
	guard := store.RestoreGuard{UserID: 1}
	verify := func(rows []collab.TitleProjectionRecord, snap store.TitleSnapshot) (collab.TitleProjectionCandidate, error) {
		return store.VerifyTitleSnapshotReplay(context.Background(), proofReader(rows), guard, 42, 3, snap, 1, 4096)
	}
	candidate, err := verify(records, snapshot)
	if err != nil || candidate.Text != "标题" || !candidate.Visible {
		t.Fatalf("verified: %+v %v", candidate, err)
	}
	other := collab.NewDoc()
	for _, op := range []collab.Op{title, body} {
		other.Apply(op)
	}
	otherText := text
	otherText.Text = "别的"
	other.Apply(otherText)
	bad := snapshot
	bad.Snapshot = other.EncodeState()
	if got, err := verify(records, bad); !errors.Is(err, store.ErrTitleSnapshotUnverified) || got.Visible {
		t.Fatalf("wrong snapshot: %+v %v", got, err)
	}
	orphan := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 5, Clock: 1}, Block: collab.OpID{Client: 99, Clock: 1}, Parent: collab.Root, Side: 1, Text: "未闭合"}
	badTail := proofRecords(t, title, body, text, orphan)
	if got, err := verify(badTail, snapshot); !errors.Is(err, collab.ErrTitleReplayCausality) || got.Visible {
		t.Fatalf("orphan tail: %+v %v", got, err)
	}
	if _, err := verify(records, store.TitleSnapshot{Head: 2001, Snapshot: snapshot.Snapshot}); !errors.Is(err, store.ErrTitleProofLimit) {
		t.Fatalf("limit: %v", err)
	}
}

func TestTitleSnapshotProofRechecksAuthorizationAfterCausality(t *testing.T) {
	title := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: 0, Clock: 1}, Parent: collab.Root, Pos: "U", Type: "title"}
	record := proofRecords(t, title)[0]
	full := collab.NewDoc()
	full.Apply(title)
	checks := 0
	reader := fakeTitleReplayReader(func(_ context.Context, _ store.RestoreGuard, _, _, _, after int64, _, _ int) ([]collab.TitleProjectionRecord, error) {
		if after == 0 {
			return []collab.TitleProjectionRecord{record}, nil
		}
		checks++
		if checks == 2 {
			return nil, store.ErrForbidden
		}
		return nil, nil
	})
	got, err := store.VerifyTitleSnapshotReplay(context.Background(), reader, store.RestoreGuard{UserID: 1}, 42, 3, store.TitleSnapshot{Head: 1, SnapshotSeq: 1, Snapshot: full.EncodeState()}, 1, 4096)
	if !errors.Is(err, store.ErrForbidden) || got.Visible {
		t.Fatalf("revoked: %+v %v", got, err)
	}
}

func TestTitleSnapshotProofBoundsAndMalformedInput(t *testing.T) {
	title := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: 0, Clock: 1}, Parent: collab.Root, Pos: "U", Type: "title"}
	text := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 2, Clock: 1}, Block: title.ID, Parent: collab.Root, Side: 1, Text: strings.Repeat("字", 32769)}
	full := collab.NewDoc()
	full.Apply(title)
	records := proofRecords(t, title, text)
	guard := store.RestoreGuard{UserID: 1}
	base := store.TitleSnapshot{Head: 2, SnapshotSeq: 1, Snapshot: full.EncodeState()}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.VerifyTitleSnapshotReplay(ctx, proofReader(records), guard, 42, 3, base, 1, 1<<20); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	// Counting text before snapshot materialization prevents a very long
	// character ancestry from overflowing the recursive state encoder.
	base.SnapshotSeq = 2
	if _, err := store.VerifyTitleSnapshotReplay(context.Background(), proofReader(records), guard, 42, 3, base, 1, 1<<20); !errors.Is(err, store.ErrTitleProofLimit) {
		t.Fatalf("character limit: %v", err)
	}
	bad := proofRecords(t, title)
	bad[0].Bytes = []byte{collab.Magic, collab.Version, 255, 255, 255, 255, 255}
	base.Head, base.SnapshotSeq = 1, 1
	if _, err := store.VerifyTitleSnapshotReplay(context.Background(), proofReader(bad), guard, 42, 3, base, 1, 1<<20); !errors.Is(err, store.ErrTitleSnapshotUnverified) {
		t.Fatalf("bad count: %v", err)
	}
}

func TestTitleSnapshotProofRejectsCompactedSnapshotWithoutDeclaringCorruption(t *testing.T) {
	doc := collab.NewDoc()
	title := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: 0, Clock: 1}, Parent: collab.Root, Pos: "U", Type: "title"}
	doc.Apply(title)
	insert := doc.InsertText(3, title.ID, 0, "标题")
	deletes := doc.DeleteText(3, title.ID, 1, 1)
	if len(deletes) != 1 {
		t.Fatalf("delete: %d", len(deletes))
	}
	records := proofRecords(t, title, insert, deletes[0])
	before := doc.EncodeState()
	if doc.CompactLegacyTombstones() == 0 {
		t.Fatal("test must compact a deleted leaf")
	}
	guard := store.RestoreGuard{UserID: 1}
	snapshot := store.TitleSnapshot{Head: 3, SnapshotSeq: 3, Snapshot: before}
	if _, err := store.VerifyTitleSnapshotReplay(context.Background(), proofReader(records), guard, 42, 3, snapshot, 1, 4096); err != nil {
		t.Fatalf("uncompacted: %v", err)
	}
	snapshot.Snapshot = doc.EncodeState()
	if _, err := store.VerifyTitleSnapshotReplay(context.Background(), proofReader(records), guard, 42, 3, snapshot, 1, 4096); !errors.Is(err, store.ErrTitleSnapshotUnverified) {
		t.Fatalf("compacted must remain unverified: %v", err)
	}
}
