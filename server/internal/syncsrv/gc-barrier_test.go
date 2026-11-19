package syncsrv

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestSafeTombstoneGCBarrierAndLosslessFallback(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	u, ws, err := st.CreateUser(ctx, "gc@test.io", "GCUser", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, u.ID, nil, "GC 测试文档", nil)
	if err != nil {
		t.Fatal(err)
	}
	cid1, err := st.AllocClient(ctx, u.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	cid2, err := st.AllocClient(ctx, u.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}

	now := time.Now()
	hub := &Hub{
		Store:         st,
		Log:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		SnapshotEvery: 500,
		GCWindow:      time.Hour,
		rooms:         map[int64]*room{},
		Now:           func() time.Time { return now },
	}
	rm := &room{hub: hub, id: doc.ID, conns: map[*conn]struct{}{}}

	// Build a paragraph with 10 chars, then delete 6 of them to create leaf tombstones.
	paraID := collab.OpID{Client: uint64(cid1), Clock: 10}
	var ops []collab.Op
	ops = append(ops, collab.Op{T: collab.TBlockCreate, ID: paraID, Parent: collab.Root, Pos: "M", Type: "paragraph"})
	prev := collab.Root
	var charIDs []collab.OpID
	for i := 0; i < 10; i++ {
		id := collab.OpID{Client: uint64(cid1), Clock: uint64(11 + i)}
		ops = append(ops, collab.Op{T: collab.TTextInsert, ID: id, Block: paraID, Parent: prev, Side: 1, Text: string(rune('a' + i))})
		charIDs = append(charIDs, id)
		prev = id
	}
	// Delete the last 6 chars ('e'..'j') so they become leaf tombstones.
	for i := 4; i < 10; i++ {
		delID := collab.OpID{Client: uint64(cid1), Clock: uint64(30 + i)}
		ops = append(ops, collab.Op{T: collab.TTextDelete, ID: delID, Block: paraID, Target: charIDs[i], Len: 1})
	}
	var raws []store.RawOp
	for _, op := range ops {
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		raws = append(raws, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
	}
	seqs, err := st.AppendOps(ctx, doc.ID, raws)
	if err != nil {
		t.Fatal(err)
	}
	head := seqs[len(seqs)-1]

	// Register two active connections; client 2 is behind horizon -> must skip GC.
	c1 := &conn{clientID: uint64(cid1), acked: head, out: make(chan []byte, 64)}
	c2 := &conn{clientID: uint64(cid2), acked: head - 5, out: make(chan []byte, 64)}
	rm.mu.Lock()
	rm.conns[c1] = struct{}{}
	rm.conns[c2] = struct{}{}
	rm.mu.Unlock()
	_ = st.SetAck(ctx, cid1, head, now)
	_ = st.SetAck(ctx, cid2, head-5, now)

	// Client 2 catches up in store but not in-memory conn -> still skipped.
	_ = st.SetAck(ctx, cid2, head, now)
	resSkipped, err := rm.CompactSnapshotAtSafeHorizon(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if resSkipped.Skipped != "client_behind_horizon" || resSkipped.Removed != 0 {
		t.Fatalf("expected skip when live conn behind horizon, got %+v", resSkipped)
	}

	// Now client 2 ACKs head -> safe GC prunes the 6 leaf tombstones!
	rm.mu.Lock()
	c2.acked = head
	rm.mu.Unlock()

	liveBefore, tombsBefore := rm.doc.TombstoneStats()
	if liveBefore != 4 || tombsBefore != 6 {
		t.Fatalf("before GC: live=%d tombs=%d want 4,6", liveBefore, tombsBefore)
	}
	uncompactedBytes := len(rm.doc.EncodeState())

	res, err := rm.CompactSnapshotAtSafeHorizon(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if res.Skipped != "" || res.Horizon != head || res.Removed != 6 {
		t.Fatalf("expected 6 tombstones removed at horizon %d, got %+v", head, res)
	}
	liveAfter, tombsAfter := rm.doc.TombstoneStats()
	if liveAfter != 4 || tombsAfter != 0 {
		t.Fatalf("after GC: live=%d tombs=%d want 4,0", liveAfter, tombsAfter)
	}
	_, snapBytes, err := st.LatestSnapshot(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapBytes) >= uncompactedBytes {
		t.Fatalf("expected compacted snapshot (%d B) < uncompacted (%d B)", len(snapBytes), uncompactedBytes)
	}

	// Verify live text is intact.
	text, kind, visible := rm.doc.VisibleBlockText(paraID)
	if !visible || kind != "paragraph" || text != "abcd" {
		t.Fatalf("after GC text=%q kind=%q visible=%v", text, kind, visible)
	}

	// Simulate an offline replica reconnecting AFTER GCWindow with an op
	// referencing the pruned tombstone charIDs[9]: room reload + catchUp must
	// automatically recover losslessly via repairFromLog!
	lateOp := collab.Op{
		T:      collab.TTextInsert,
		ID:     collab.OpID{Client: uint64(cid2), Clock: res.BarrierClock + 1},
		Block:  paraID,
		Parent: charIDs[9], // pruned tombstone!
		Side:   1,
		Text:   "Z",
	}
	lateBytes, _ := collab.EncodeOps([]collab.Op{lateOp})
	if _, err := st.AppendOps(ctx, doc.ID, []store.RawOp{{ClientID: cid2, Clock: int64(lateOp.ID.Clock), Bytes: lateBytes}}); err != nil {
		t.Fatal(err)
	}

	// Cold-load a fresh room from the compacted snapshot + late op.
	rm2 := &room{hub: hub, id: doc.ID, conns: map[*conn]struct{}{}}
	if err := rm2.load(ctx); err != nil {
		t.Fatalf("cold load after late tombstone ref failed: %v", err)
	}
	recoveredText, _, recoveredVisible := rm2.doc.VisibleBlockText(paraID)
	if !recoveredVisible || recoveredText != "abcdZ" {
		t.Fatalf("expected lossless recovery 'abcdZ', got %q (visible=%v)", recoveredText, recoveredVisible)
	}
}
