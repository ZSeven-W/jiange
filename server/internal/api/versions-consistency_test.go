package api

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

// A store that can return rows appended after Head was read. Deliberately
// ignores limit so StateAtHead's upper-bound check is tested independently.
type fixedHeadStore struct {
	store.DocStore
	head        int64
	rows        []store.SeqOp
	snapshotSeq int64
	snapshot    []byte
}

func (s *fixedHeadStore) Head(context.Context, int64) (int64, error) { return s.head, nil }
func (s *fixedHeadStore) LatestSnapshot(context.Context, int64) (int64, []byte, error) {
	if s.snapshot == nil {
		return 0, nil, store.ErrNotFound
	}
	return s.snapshotSeq, s.snapshot, nil
}
func (s *fixedHeadStore) OpsAfter(_ context.Context, _ int64, after int64, _ int) ([]store.SeqOp, error) {
	var out []store.SeqOp
	for _, row := range s.rows {
		if row.Seq > after {
			out = append(out, row)
		}
	}
	return out, nil
}

func stateAtHeadFixture(t *testing.T) ([]store.SeqOp, []byte) {
	t.Helper()
	doc := collab.NewDoc()
	initial := syncsrv.InitialOps("")
	rows := make([]store.SeqOp, 0, 4)
	for i, raw := range initial {
		ops, err := collab.DecodeOps(raw.Bytes)
		if err != nil {
			t.Fatal(err)
		}
		for _, op := range ops {
			doc.Apply(op)
		}
		rows = append(rows, store.SeqOp{Seq: int64(i + 1), ClientID: raw.ClientID, Bytes: raw.Bytes})
	}
	snapshot := doc.EncodeState()
	para := collab.OpID{Client: 0, Clock: 2}
	for i, text := range []string{"早", "晚"} {
		op := doc.InsertText(7, para, i, text)
		data, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		rows = append(rows, store.SeqOp{Seq: int64(len(rows) + 1), ClientID: 7, Bytes: data})
	}
	return rows, snapshot
}

func TestStateAtHeadExcludesRowsAppendedAfterCapturedHead(t *testing.T) {
	rows, _ := stateAtHeadFixture(t)
	st := &fixedHeadStore{head: 3, rows: rows}
	doc, seq, err := StateAtHead(context.Background(), st, 1)
	if err != nil {
		t.Fatal(err)
	}
	if seq != 3 || viewText(doc.View()) != "早" {
		t.Fatalf("sequence %d contains %q", seq, viewText(doc.View()))
	}

	// A persisted snapshot at seq 3 must still be able to replay the newer op.
	restored, err := collab.DecodeState(doc.EncodeState())
	if err != nil {
		t.Fatal(err)
	}
	ops, err := collab.DecodeOps(rows[3].Bytes)
	if err != nil {
		t.Fatal(err)
	}
	for _, op := range ops {
		restored.Apply(op)
	}
	if got := viewText(restored.View()); got != "早晚" {
		t.Fatalf("later replay lost or duplicated content: %q", got)
	}
}

func TestStateAtHeadRejectsMissingSequence(t *testing.T) {
	rows, _ := stateAtHeadFixture(t)
	for _, test := range []struct {
		name string
		rows []store.SeqOp
	}{
		{"gap in a page", []store.SeqOp{rows[0], rows[2]}},
		{"early end", []store.SeqOp{rows[0]}},
		{"first row past head", []store.SeqOp{rows[3]}},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, _, err := StateAtHead(context.Background(), &fixedHeadStore{head: 3, rows: test.rows}, 1)
			if err == nil || !strings.Contains(err.Error(), "sequence") {
				t.Fatalf("expected sequence error, got %v", err)
			}
		})
	}
}

func TestStateAtHeadUsesSnapshotAndRejectsSnapshotBeyondHead(t *testing.T) {
	rows, snapshot := stateAtHeadFixture(t)
	st := &fixedHeadStore{head: 3, rows: rows, snapshotSeq: 2, snapshot: snapshot}
	doc, seq, err := StateAtHead(context.Background(), st, 1)
	if err != nil || seq != 3 || viewText(doc.View()) != "早" {
		t.Fatalf("snapshot replay: seq=%d err=%v", seq, err)
	}
	st.snapshotSeq = 4
	_, _, err = StateAtHead(context.Background(), st, 1)
	if err == nil || errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expected inconsistent snapshot error, got %v", err)
	}
}

func TestStateAtHeadRejectsUnresolvedDependencies(t *testing.T) {
	rows, _ := stateAtHeadFixture(t)
	missingBlock := collab.OpID{Client: 99, Clock: 1}
	orphan := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 7, Clock: 100}, Block: missingBlock, Parent: collab.Root, Side: 1, Text: "待恢复"}
	data, err := collab.EncodeOps([]collab.Op{orphan})
	if err != nil {
		t.Fatal(err)
	}
	rows = append(rows[:2], store.SeqOp{Seq: 3, ClientID: 7, Bytes: data})
	doc, seq, err := StateAtHead(context.Background(), &fixedHeadStore{head: 3, rows: rows}, 1)
	if err == nil || !strings.Contains(err.Error(), "missing dependencies") || doc != nil || seq != 0 {
		t.Fatalf("unresolved operation must not produce a snapshot: doc=%v seq=%d err=%v", doc, seq, err)
	}
}

func TestStateAtHeadAcceptsDependenciesSatisfiedLaterInSequence(t *testing.T) {
	rows, _ := stateAtHeadFixture(t)
	block := collab.OpID{Client: 99, Clock: 1}
	insert := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 7, Clock: 100}, Block: block, Parent: collab.Root, Side: 1, Text: "已恢复"}
	create := collab.Op{T: collab.TBlockCreate, ID: block, Parent: collab.Root, Pos: "W", Type: "paragraph"}
	rows = rows[:2]
	for i, op := range []collab.Op{insert, create} {
		data, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		rows = append(rows, store.SeqOp{Seq: int64(i + 3), ClientID: int64(op.ID.Client), Bytes: data})
	}
	doc, seq, err := StateAtHead(context.Background(), &fixedHeadStore{head: 4, rows: rows}, 1)
	if err != nil || seq != 4 || doc.Pending() != 0 || viewText(doc.View()) != "已恢复" {
		t.Fatalf("resolved sequence must materialize: seq=%d err=%v", seq, err)
	}
	restored, err := collab.DecodeState(doc.EncodeState())
	if err != nil || viewText(restored.View()) != "已恢复" {
		t.Fatalf("resolved text must survive snapshot round trip: err=%v", err)
	}
}
