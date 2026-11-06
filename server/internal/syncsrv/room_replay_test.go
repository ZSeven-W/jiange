package syncsrv

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type replayStore struct {
	*snapshotStore
	head int64
	// A fake store may expose rows that were appended after Head was read.
	addAfterHead []store.SeqOp
	appendSeqs   []int64
}

func (s *replayStore) Head(context.Context, int64) (int64, error) {
	if len(s.addAfterHead) > 0 {
		s.rows = append(s.rows, s.addAfterHead...)
		s.addAfterHead = nil
	}
	return s.head, nil
}

func (s *replayStore) AppendOps(context.Context, int64, []store.RawOp) ([]int64, error) {
	return s.appendSeqs, nil
}

func replayFixture(t *testing.T) ([]store.SeqOp, *collab.Doc) {
	t.Helper()
	rows := snapshotRows(t)
	doc := collab.NewDoc()
	for _, row := range rows {
		ops, err := collab.DecodeOps(row.Bytes)
		if err != nil {
			t.Fatal(err)
		}
		for _, op := range ops {
			doc.Apply(op)
		}
	}
	return rows, doc
}

func replayRoom(s *replayStore, doc *collab.Doc, head, snapSeq int64) *room {
	r := newSnapshotRoom(s.snapshotStore, head, snapSeq)
	r.hub.Store = s
	r.doc = doc
	return r
}

func TestCatchUpBoundsConcurrentAppend(t *testing.T) {
	rows, _ := replayFixture(t)
	extra := rows[1]
	extra.Seq = 3
	s := &replayStore{snapshotStore: &snapshotStore{rows: rows}, head: 2, addAfterHead: []store.SeqOp{extra}}
	r := replayRoom(s, collab.NewDoc(), 0, 0)
	if err := r.catchUp(context.Background()); err != nil {
		t.Fatal(err)
	}
	if r.head != 2 {
		t.Fatalf("catch-up crossed captured head: %d", r.head)
	}
}

func TestCatchUpRejectsGapsAndMalformedBatches(t *testing.T) {
	rows, _ := replayFixture(t)
	all, err := collab.DecodeOps(rows[0].Bytes)
	if err != nil {
		t.Fatal(err)
	}
	second, err := collab.DecodeOps(rows[1].Bytes)
	if err != nil {
		t.Fatal(err)
	}
	multi, err := collab.EncodeOps(append(all, second...))
	if err != nil {
		t.Fatal(err)
	}
	zero, err := collab.EncodeOps(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		rows []store.SeqOp
	}{
		{"gap", rows[1:]},
		{"early end", rows[:1]},
		{"multiple ops in row", []store.SeqOp{{Seq: 1, Bytes: multi}, rows[1]}},
		{"empty row", []store.SeqOp{{Seq: 1, Bytes: zero}, rows[1]}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &replayStore{snapshotStore: &snapshotStore{rows: tc.rows}, head: 2}
			r := replayRoom(s, collab.NewDoc(), 0, 0)
			if err := r.catchUp(context.Background()); err == nil {
				t.Fatal("expected invalid log error")
			}
		})
	}
}

func TestJoinNeverSendsRowsPastWelcomeHead(t *testing.T) {
	rows, doc := replayFixture(t)
	extra := rows[1]
	extra.Seq = 3
	s := &replayStore{snapshotStore: &snapshotStore{rows: append(rows, extra)}, head: 2}
	r := replayRoom(s, doc, 2, 0)
	c := &conn{clientID: 7, out: make(chan []byte, 10)}
	if err := r.join(context.Background(), c, 0); err != nil {
		t.Fatal(err)
	}
	welcome, err := collab.DecodeServerMsg(<-c.out)
	if err != nil || welcome.HeadSeq != 2 || welcome.HasSnap {
		t.Fatalf("unexpected welcome: %+v %v", welcome, err)
	}
	batch, err := collab.DecodeServerMsg(<-c.out)
	if err != nil || batch.FirstSeq != 1 {
		t.Fatalf("unexpected operations: %+v %v", batch, err)
	}
	ops, err := collab.DecodeOps(batch.Batch)
	if err != nil || len(ops) != 2 {
		t.Fatalf("expected 2 operations, got %d %v", len(ops), err)
	}
	if len(c.out) != 0 {
		t.Fatalf("unexpected future frames: %d", len(c.out))
	}
}

func TestJoinRejectsMissingHistory(t *testing.T) {
	rows, doc := replayFixture(t)
	s := &replayStore{snapshotStore: &snapshotStore{rows: rows[:1]}, head: 2}
	r := replayRoom(s, doc, 2, 0)
	c := &conn{clientID: 7, out: make(chan []byte, 10)}
	if err := r.join(context.Background(), c, 0); err == nil {
		t.Fatal("expected missing log error")
	}
	if _, ok := r.conns[c]; ok {
		t.Fatal("joined after incomplete history")
	}
}

func TestJoinWithFutureSnapshotUsesCurrentRoomState(t *testing.T) {
	rows, doc := replayFixture(t)
	future := collab.NewDoc()
	for _, row := range rows {
		ops, _ := collab.DecodeOps(row.Bytes)
		for _, op := range ops {
			future.Apply(op)
		}
	}
	future.InsertText(7, collab.OpID{Client: 0, Clock: 2}, 0, "未来")
	s := &replayStore{snapshotStore: &snapshotStore{rows: rows, latestSeq: 3, latestState: future.EncodeState()}, head: 2}
	r := replayRoom(s, doc, 2, 1)
	c := &conn{clientID: 7, out: make(chan []byte, 10)}
	if err := r.join(context.Background(), c, 0); err != nil {
		t.Fatal(err)
	}
	welcome, err := collab.DecodeServerMsg(<-c.out)
	if err != nil || !welcome.HasSnap || welcome.HeadSeq != 2 || welcome.SnapSeq != 2 {
		t.Fatalf("unexpected welcome: %+v %v", welcome, err)
	}
	actual, err := collab.DecodeState(welcome.State)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(actual.View())
	want, _ := json.Marshal(doc.View())
	if string(got) != string(want) {
		t.Fatalf("future data leaked into snapshot: %s vs %s", got, want)
	}
}

func TestHandleOpsRejectsConcurrentLogGap(t *testing.T) {
	rows, doc := replayFixture(t)
	// Another instance sequences a row before ours, but the store cannot
	// provide that row when we bridge to the newly appended sequence.
	s := &replayStore{snapshotStore: &snapshotStore{rows: rows}, head: 2, appendSeqs: []int64{4}}
	r := replayRoom(s, doc, 2, 0)
	c := &conn{clientID: 7, out: make(chan []byte, 10), cancel: func() {}}
	op := doc.InsertText(7, collab.OpID{Client: 0, Clock: 2}, 0, "内容")
	// Restore a document before op so handleOps can apply it as new.
	_, r.doc = replayFixture(t)
	if err := r.handleOps(context.Background(), c, []collab.Op{op}); err == nil {
		t.Fatal("expected missing concurrent history error")
	}
	if r.doc != nil {
		t.Fatal("room not reset after incomplete replay")
	}
	if r.head != 2 {
		t.Fatalf("room advanced past missing seq: %d", r.head)
	}
}

func TestSnapshotRejectsUnresolvedDependencies(t *testing.T) {
	block := collab.OpID{Client: 55, Clock: 1}
	insert := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 55, Clock: 2}, Block: block, Parent: collab.Root, Side: 1, Text: "未决"}
	create := collab.Op{T: collab.TBlockCreate, ID: block, Parent: collab.Root, Pos: "U", Type: "paragraph"}
	encode := func(op collab.Op, seq int64) store.SeqOp {
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		return store.SeqOp{Seq: seq, ClientID: int64(op.ID.Client), Bytes: b}
	}
	rows := []store.SeqOp{encode(insert, 1), encode(create, 2)}
	t.Run("unresolved", func(t *testing.T) {
		s := &snapshotStore{horizon: 1, rows: rows[:1]}
		r := newSnapshotRoom(s, 1, 0)
		if err := r.snapshot(context.Background()); err == nil || errors.Is(err, store.ErrNotFound) {
			t.Fatal("expected unresolved dependency error")
		}
		if s.saves != 0 || r.snapSeq != 0 {
			t.Fatal("saved state without pending op")
		}
	})
	t.Run("resolved later", func(t *testing.T) {
		s := &snapshotStore{horizon: 2, rows: rows}
		r := newSnapshotRoom(s, 2, 0)
		if err := r.snapshot(context.Background()); err != nil {
			t.Fatal(err)
		}
		state, err := collab.DecodeState(s.savedState)
		if err != nil {
			t.Fatal(err)
		}
		if state.Text(block) != "未决" {
			t.Fatalf("later dependency did not resolve: %q", state.Text(block))
		}
	})
}
