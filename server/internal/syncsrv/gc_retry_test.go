package syncsrv

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type racedLookupStore struct {
	store.Store
	run func()
}

func TestCompactedPartialOverlapRejectsMixedBatch(t *testing.T) {
	stores := map[string]func(*testing.T) store.Store{"memory": func(t *testing.T) store.Store { return store.NewMemory() }}
	if url := os.Getenv("JIANGE_TEST_DATABASE_URL"); url != "" {
		stores["postgres"] = func(t *testing.T) store.Store {
			pg, err := store.NewPostgres(context.Background(), url)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pg.Close)
			if _, err := migrate.Up(context.Background(), pg.Pool); err != nil {
				t.Fatal(err)
			}
			return pg
		}
	}
	for name, makeStore := range stores {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			st := makeStore(t)
			u, ws, err := st.CreateUser(ctx, fmt.Sprintf("gc-overlap-%d@test.dev", time.Now().UnixNano()), "test", "hash")
			if err != nil {
				t.Fatal(err)
			}
			doc, err := st.CreateDoc(ctx, ws.ID, u.ID, nil, "test", InitialOps(""))
			if err != nil {
				t.Fatal(err)
			}
			ins := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 7, Clock: 10}, Block: paragraph, Parent: collab.Root, Side: 1, Text: "甲乙"}
			del := collab.Op{T: collab.TTextDelete, ID: collab.OpID{Client: 7, Clock: 12}, Block: paragraph, Target: ins.ID, Len: 2}
			for _, op := range []collab.Op{ins, del} {
				b, err := collab.EncodeOps([]collab.Op{op})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := st.AppendOps(ctx, doc.ID, []store.RawOp{{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b}}); err != nil {
					t.Fatal(err)
				}
			}
			rows, err := st.OpsAfter(ctx, doc.ID, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			state := collab.NewDoc()
			for _, row := range rows {
				decoded, err := collab.DecodeOps(row.Bytes)
				if err != nil {
					t.Fatal(err)
				}
				for _, op := range decoded {
					state.Apply(op)
				}
			}
			if state.Compact() != 2 {
				t.Fatal("expected both original characters to be compacted")
			}
			head, err := st.Head(ctx, doc.ID)
			if err != nil {
				t.Fatal(err)
			}
			if err := st.SaveSnapshot(ctx, doc.ID, head, state.EncodeState()); err != nil {
				t.Fatal(err)
			}
			r := &room{hub: &Hub{Store: st, SnapshotEvery: 1000, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}, id: doc.ID, conns: map[*conn]struct{}{}}
			if err := r.load(ctx); err != nil {
				t.Fatal(err)
			}
			otherCancelled := false
			other := &conn{clientID: 8, out: make(chan []byte, 10), cancel: func() { otherCancelled = true }}
			r.conns[other] = struct{}{}
			c := &conn{clientID: 7, out: make(chan []byte, 10), cancel: func() {}}
			fresh := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 7, Clock: 20}, Block: paragraph, Parent: collab.Root, Side: 1, Text: "新"}
			overlap := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 7, Clock: 11}, Block: paragraph, Parent: collab.Root, Side: 1, Text: "冲"}
			if err := r.handleOps(ctx, c, []collab.Op{fresh, overlap}); err != errBatchRejected {
				t.Fatalf("expected partial identity rejection: %v", err)
			}
			if r.doc == nil || r.head != head || r.doc.Text(paragraph) != "" || otherCancelled || len(other.out) != 0 {
				t.Fatal("partial overlap changed room state or other connection")
			}
			msg, err := collab.DecodeServerMsg(<-c.out)
			if err != nil || msg.Type != collab.MsgError || msg.Code != "bad_ops" || len(c.out) != 0 {
				t.Fatalf("expected bad_ops without ACK: %+v %v", msg, err)
			}
			if got, err := st.Head(ctx, doc.ID); err != nil || got != head {
				t.Fatalf("partial batch persisted: %d %v", got, err)
			}
		})
	}
}

type alwaysBusyStore struct{ store.Store }

func (s *alwaysBusyStore) AppendOpsAtHead(context.Context, int64, int64, []store.RawOp) ([]int64, error) {
	return nil, store.ErrConflict
}

func TestContentionLimitRollsBackWithoutResettingOtherClients(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	u, ws, err := st.CreateUser(ctx, "busy@test.dev", "busy", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, u.ID, nil, "test", InitialOps(""))
	if err != nil {
		t.Fatal(err)
	}
	r := &room{hub: &Hub{Store: &alwaysBusyStore{st}, SnapshotEvery: 1000, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}, id: doc.ID, conns: map[*conn]struct{}{}}
	if err := r.load(ctx); err != nil {
		t.Fatal(err)
	}
	head := r.head
	otherCancelled := false
	other := &conn{clientID: 8, out: make(chan []byte, 10), cancel: func() { otherCancelled = true }}
	r.conns[other] = struct{}{}
	c := &conn{clientID: 7, out: make(chan []byte, 10), cancel: func() {}}
	op := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 7, Clock: 10}, Block: paragraph, Parent: collab.Root, Side: 1, Text: "新"}
	if err := r.handleOps(ctx, c, []collab.Op{op}); err != errBatchRejected {
		t.Fatalf("expected bounded retry rejection, got %v", err)
	}
	if r.doc == nil || r.head != head || r.doc.Text(paragraph) != "" || otherCancelled || len(other.out) != 0 {
		t.Fatal("contention corrupted state or reset other clients")
	}
	msg, err := collab.DecodeServerMsg(<-c.out)
	if err != nil || msg.Type != collab.MsgError || msg.Code != "retry" {
		t.Fatalf("expected retry error without ACK, got %+v %v", msg, err)
	}
	if len(c.out) != 0 {
		t.Fatal("retry error was followed by an ACK")
	}
	if err := r.doc.TryApply(op); err != nil {
		t.Fatalf("rolled-back operation remains in seen IDs: %v", err)
	}
}

func TestIdentityConflictRejectsOnlyOffendingConnection(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	u, ws, err := st.CreateUser(ctx, "identity@test.dev", "identity", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, u.ID, nil, "test", InitialOps(""))
	if err != nil {
		t.Fatal(err)
	}
	original := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 7, Clock: 10}, Block: paragraph, Parent: collab.Root, Side: 1, Text: "旧"}
	b, err := collab.EncodeOps([]collab.Op{original})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendOps(ctx, doc.ID, []store.RawOp{{ClientID: 7, Clock: 10, Bytes: b}}); err != nil {
		t.Fatal(err)
	}
	r := &room{hub: &Hub{Store: st, SnapshotEvery: 1000, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}, id: doc.ID, conns: map[*conn]struct{}{}}
	if err := r.load(ctx); err != nil {
		t.Fatal(err)
	}
	head := r.head
	otherCancelled := false
	other := &conn{clientID: 8, out: make(chan []byte, 10), cancel: func() { otherCancelled = true }}
	r.conns[other] = struct{}{}
	c := &conn{clientID: 7, out: make(chan []byte, 10), cancel: func() {}}
	newOp := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 7, Clock: 20}, Block: paragraph, Parent: collab.Root, Side: 1, Text: "新"}
	conflict := original
	conflict.Text = "篡"
	if err := r.handleOps(ctx, c, []collab.Op{newOp, conflict}); err != errBatchRejected {
		t.Fatalf("expected identity rejection, got %v", err)
	}
	if r.doc == nil || r.head != head || r.doc.Text(paragraph) != "旧" || otherCancelled || len(other.out) != 0 {
		t.Fatal("identity conflict corrupted room or reset other clients")
	}
	msg, err := collab.DecodeServerMsg(<-c.out)
	if err != nil || msg.Type != collab.MsgError || msg.Code != "bad_ops" || len(c.out) != 0 {
		t.Fatalf("expected bad_ops without ACK, got %+v %v", msg, err)
	}
	if err := r.doc.TryApply(newOp); err != nil {
		t.Fatalf("accepted prefix was not rolled back: %v", err)
	}
	if persisted, err := st.Head(ctx, doc.ID); err != nil || persisted != head {
		t.Fatalf("conflicting batch was persisted: %d %v", persisted, err)
	}
}

func (s *racedLookupStore) ExistingOpIDs(ctx context.Context, doc int64, ops []store.RawOp) ([]bool, error) {
	result, err := s.Store.ExistingOpIDs(ctx, doc, ops)
	if err == nil && s.run != nil {
		s.run()
		s.run = nil
	}
	return result, err
}

func TestCompactedRetryDoesNotResurrectOrAuthorizeDependencies(t *testing.T) {
	for _, mode := range []string{"duplicate", "mixed", "dependent"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			st := store.NewMemory()
			u, ws, err := st.CreateUser(ctx, mode+"@test.dev", mode, "hash")
			if err != nil {
				t.Fatal(err)
			}
			doc, err := st.CreateDoc(ctx, ws.ID, u.ID, nil, "test", InitialOps(""))
			if err != nil {
				t.Fatal(err)
			}
			ins := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 7, Clock: 10}, Block: paragraph, Parent: collab.Root, Side: 1, Text: "旧"}
			del := collab.Op{T: collab.TTextDelete, ID: collab.OpID{Client: 7, Clock: 11}, Block: paragraph, Target: ins.ID, Len: 1}
			raw := func(op collab.Op) store.RawOp {
				b, e := collab.EncodeOps([]collab.Op{op})
				if e != nil {
					t.Fatal(e)
				}
				return store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b}
			}
			if _, err := st.AppendOps(ctx, doc.ID, []store.RawOp{raw(ins), raw(del)}); err != nil {
				t.Fatal(err)
			}
			rows, err := st.OpsAfter(ctx, doc.ID, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			state := collab.NewDoc()
			for _, row := range rows {
				ops, e := collab.DecodeOps(row.Bytes)
				if e != nil {
					t.Fatal(e)
				}
				for _, op := range ops {
					state.Apply(op)
				}
			}
			if n := state.Compact(); n == 0 {
				t.Fatal("fixture did not compact deleted character")
			}
			head, _ := st.Head(ctx, doc.ID)
			if err := st.SaveSnapshot(ctx, doc.ID, head, state.EncodeState()); err != nil {
				t.Fatal(err)
			}
			hub := &Hub{Store: st, SnapshotEvery: 1000, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
			r := &room{hub: hub, id: doc.ID, conns: map[*conn]struct{}{}}
			if err := r.load(ctx); err != nil {
				t.Fatal(err)
			}
			c := &conn{clientID: 7, out: make(chan []byte, 10), cancel: func() {}}
			batch := []collab.Op{ins}
			want := ""
			if mode != "duplicate" {
				next := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 7, Clock: 12}, Block: paragraph, Parent: collab.Root, Side: 1, Text: "新"}
				if mode == "dependent" {
					next.Parent = ins.ID
				} else {
					want = "新"
				}
				batch = append(batch, next)
			}
			err = r.handleOps(ctx, c, batch)
			if mode == "dependent" && err != errBatchRejected {
				t.Fatalf("dependent op accepted: %v", err)
			}
			if mode != "dependent" && err != nil {
				t.Fatal(err)
			}
			if got := r.doc.Text(paragraph); got != want {
				t.Fatalf("room text=%q, want %q", got, want)
			}
			if mode == "dependent" {
				if got, _ := st.Head(ctx, doc.ID); got != head {
					t.Fatalf("dependent op persisted at head %d", got)
				}
			}
			if err := r.snapshot(ctx); err != nil {
				t.Fatal(err)
			}
			restarted := &room{hub: hub, id: doc.ID, conns: map[*conn]struct{}{}}
			if err := restarted.load(ctx); err != nil {
				t.Fatal(err)
			}
			if got := restarted.doc.Text(paragraph); got != want {
				t.Fatalf("restarted text=%q, want %q", got, want)
			}
		})
	}
}

func TestOperationLookupCannotRaceAnotherWriter(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	u, ws, err := st.CreateUser(ctx, "race@test.dev", "race", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, u.ID, nil, "test", InitialOps(""))
	if err != nil {
		t.Fatal(err)
	}
	op := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 7, Clock: 10}, Block: paragraph, Parent: collab.Root, Side: 1, Text: "新"}
	b, err := collab.EncodeOps([]collab.Op{op})
	if err != nil {
		t.Fatal(err)
	}
	raw := store.RawOp{ClientID: 7, Clock: 10, Bytes: b}
	raced := &racedLookupStore{Store: st}
	raced.run = func() {
		if _, err := st.AppendOps(ctx, doc.ID, []store.RawOp{raw}); err != nil {
			t.Fatal(err)
		}
	}
	hub := &Hub{Store: raced, SnapshotEvery: 1000, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	r := &room{hub: hub, id: doc.ID, conns: map[*conn]struct{}{}}
	if err := r.load(ctx); err != nil {
		t.Fatal(err)
	}
	oldHead := r.head
	cancelled := false
	c := &conn{clientID: 7, out: make(chan []byte, 10), cancel: func() { cancelled = true }}
	r.conns[c] = struct{}{}
	if err := r.handleOps(ctx, c, []collab.Op{op}); err != nil {
		t.Fatalf("stale head should be retried on the same connection: %v", err)
	}
	if cancelled || r.doc == nil || r.doc.Text(paragraph) != "新" {
		t.Fatal("retry cancelled the connection or polluted room state")
	}
	first, err := collab.DecodeServerMsg(<-c.out)
	if err != nil || first.Type != collab.MsgSOps || first.FirstSeq != uint64(oldHead+1) {
		t.Fatalf("concurrent operation was not delivered before ACK: %+v %v", first, err)
	}
	ack, err := collab.DecodeServerMsg(<-c.out)
	if err != nil || ack.Type != collab.MsgSAck || ack.Count != 0 {
		t.Fatalf("retry did not receive duplicate ACK: %+v %v", ack, err)
	}
	if head, _ := st.Head(ctx, doc.ID); head != oldHead+1 {
		t.Fatalf("unexpected persisted head %d", head)
	}
	restarted := &room{hub: hub, id: doc.ID, conns: map[*conn]struct{}{}}
	if err := restarted.load(ctx); err != nil {
		t.Fatal(err)
	}
	if got := restarted.doc.Text(paragraph); got != "新" {
		t.Fatalf("restarted text=%q", got)
	}
}
