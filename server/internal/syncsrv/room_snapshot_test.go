package syncsrv

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// The embedded interface is unused by these snapshot-only tests. Overrides
// provide deterministic gaps and simulated writes from another server.
type snapshotStore struct {
	store.DocStore
	horizon     int64
	rows        []store.SeqOp
	latestSeq   int64
	latestState []byte
	saves       int
	savedSeq    int64
	savedState  []byte
	ignoreLimit bool
}

func (s *snapshotStore) Horizon(context.Context, int64, time.Time) (int64, error) {
	return s.horizon, nil
}
func (s *snapshotStore) LatestSnapshot(context.Context, int64) (int64, []byte, error) {
	if s.latestState == nil {
		return 0, nil, store.ErrNotFound
	}
	return s.latestSeq, s.latestState, nil
}
func (s *snapshotStore) OpsAfter(_ context.Context, _ int64, after int64, limit int) ([]store.SeqOp, error) {
	var out []store.SeqOp
	for _, row := range s.rows {
		if row.Seq > after {
			out = append(out, row)
		}
	}
	if !s.ignoreLimit && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
func (s *snapshotStore) SaveSnapshot(_ context.Context, _, seq int64, state []byte) error {
	s.saves++
	s.savedSeq = seq
	s.savedState = append([]byte(nil), state...)
	return nil
}

func snapshotRows(t *testing.T) []store.SeqOp {
	t.Helper()
	raws := InitialOps("")
	rows := make([]store.SeqOp, len(raws))
	for i, raw := range raws {
		rows[i] = store.SeqOp{Seq: int64(i + 1), ClientID: raw.ClientID, Bytes: raw.Bytes}
	}
	return rows
}

func newSnapshotRoom(s *snapshotStore, head, snapSeq int64) *room {
	return &room{id: 1, head: head, snapSeq: snapSeq, conns: map[*conn]struct{}{}, hub: &Hub{Store: s, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}}
}

func TestSnapshotRejectsMissingOrNoncontiguousOperations(t *testing.T) {
	rows := snapshotRows(t)
	for _, tc := range []struct {
		name string
		rows []store.SeqOp
	}{
		{"empty", nil},
		{"premature end", rows[:1]},
		{"missing first", rows[1:]},
		{"duplicate", []store.SeqOp{rows[0], rows[0]}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &snapshotStore{horizon: 2, rows: tc.rows}
			r := newSnapshotRoom(s, 2, 0)
			if err := r.snapshot(context.Background()); err == nil {
				t.Fatal("expected missing sequence error")
			}
			if s.saves != 0 || r.snapSeq != 0 {
				t.Fatalf("incomplete snapshot persisted or room advanced: saves=%d seq=%d", s.saves, r.snapSeq)
			}
		})
	}
}

func TestSnapshotBoundsConcurrentWritesToRoomHead(t *testing.T) {
	rows := snapshotRows(t)
	// A later row is visible after the horizon is read; it must not be included.
	extra := rows[1]
	extra.Seq = 3
	s := &snapshotStore{horizon: 3, rows: append(rows, extra)}
	r := newSnapshotRoom(s, 2, 0)
	if err := r.snapshot(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.saves != 1 || s.savedSeq != 2 || r.snapSeq != 2 {
		t.Fatalf("unexpected snapshot: saves=%d seq=%d room=%d", s.saves, s.savedSeq, r.snapSeq)
	}
	got, err := collab.DecodeState(s.savedState)
	if err != nil {
		t.Fatal(err)
	}
	want := collab.NewDoc()
	for _, row := range rows {
		ops, err := collab.DecodeOps(row.Bytes)
		if err != nil {
			t.Fatal(err)
		}
		for _, op := range ops {
			want.Apply(op)
		}
	}
	g, _ := json.Marshal(got.View())
	w, _ := json.Marshal(want.View())
	if string(g) != string(w) {
		t.Fatalf("snapshot differs: %s vs %s", g, w)
	}
}

func TestSnapshotDoesNotUseNewerBaseAtOlderHorizon(t *testing.T) {
	s := &snapshotStore{horizon: 2, rows: snapshotRows(t), latestSeq: 3, latestState: collab.NewDoc().EncodeState()}
	r := newSnapshotRoom(s, 2, 0)
	if err := r.snapshot(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.saves != 0 || r.snapSeq != 0 {
		t.Fatalf("saved or changed room sequence: %+v", s)
	}
}

func TestSnapshotReplaysFromAvailableSnapshot(t *testing.T) {
	rows := snapshotRows(t)
	base := collab.NewDoc()
	ops, err := collab.DecodeOps(rows[0].Bytes)
	if err != nil {
		t.Fatal(err)
	}
	for _, op := range ops {
		base.Apply(op)
	}
	s := &snapshotStore{horizon: 2, rows: rows, latestSeq: 1, latestState: base.EncodeState()}
	r := newSnapshotRoom(s, 2, 1)
	if err := r.snapshot(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.saves != 1 || s.savedSeq != 2 {
		t.Fatalf("unexpected save: %d at %d", s.saves, s.savedSeq)
	}
	got, err := collab.DecodeState(s.savedState)
	if err != nil {
		t.Fatal(err)
	}
	want := collab.NewDoc()
	for _, row := range rows {
		ops, err := collab.DecodeOps(row.Bytes)
		if err != nil {
			t.Fatal(err)
		}
		for _, op := range ops {
			want.Apply(op)
		}
	}
	g, _ := json.Marshal(got.View())
	w, _ := json.Marshal(want.View())
	if string(g) != string(w) {
		t.Fatalf("snapshot from existing base differs: %s vs %s", g, w)
	}
}

func TestSnapshotRejectsRowsBeyondHorizon(t *testing.T) {
	rows := snapshotRows(t)
	extra := rows[1]
	extra.Seq = 3
	s := &snapshotStore{horizon: 2, rows: append(rows, extra), ignoreLimit: true}
	r := newSnapshotRoom(s, 2, 0)
	if err := r.snapshot(context.Background()); err == nil {
		t.Fatal("expected error for row beyond horizon")
	}
	if s.saves != 0 || r.snapSeq != 0 {
		t.Fatal("out-of-bound snapshot persisted")
	}
}

func TestSnapshotDecodeFailureDoesNotAdvance(t *testing.T) {
	s := &snapshotStore{horizon: 2, rows: snapshotRows(t), latestSeq: 1, latestState: []byte("bad")}
	r := newSnapshotRoom(s, 2, 0)
	if err := r.snapshot(context.Background()); err == nil || errors.Is(err, store.ErrNotFound) {
		t.Fatal("expected decode error")
	}
	if s.saves != 0 || r.snapSeq != 0 {
		t.Fatal("failed snapshot advanced room")
	}
}
