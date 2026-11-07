package syncsrv

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// v2 welcome carries the history epoch; a stale client epoch resets the
// replay position so the client resyncs from a snapshot (restore/PITR).
func TestWelcomeEpochNegotiation(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	u, ws, err := st.CreateUser(ctx, "epoch@test.dev", "epoch", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, u.ID, nil, "test", InitialOps(""))
	if err != nil {
		t.Fatal(err)
	}
	op := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 7, Clock: 1}, Block: paragraph, Parent: collab.Root, Side: 1, Text: "史"}
	b, err := collab.EncodeOps([]collab.Op{op})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendOps(ctx, doc.ID, []store.RawOp{{ClientID: 7, Clock: 1, Bytes: b}}); err != nil {
		t.Fatal(err)
	}
	if err := st.BumpHistoryEpoch(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	r := &room{hub: &Hub{Store: st, SnapshotEvery: 1000, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}, id: doc.ID, conns: map[*conn]struct{}{}}

	// 决策：同代际保留 lastSeq；跨代际归零（只比较 seq 不够——同 seq 不同内容）
	if got := helloLastSeq(true, 2, 2, 300); got != 300 {
		t.Fatalf("same epoch: %d", got)
	}
	if got := helloLastSeq(true, 1, 2, 300); got != 0 {
		t.Fatalf("stale epoch: %d", got)
	}
	if got := helloLastSeq(false, 0, 2, 300); got != 300 {
		t.Fatalf("v1 client: %d", got)
	}

	// v2 客户端收到带 epoch 的 welcome；v1 帧不带尾字节
	c := &conn{clientID: 7, out: make(chan []byte, 10), cancel: func() {}}
	if err := r.join(ctx, c, 0, true, 2); err != nil {
		t.Fatal(err)
	}
	msg, err := collab.DecodeServerMsg(<-c.out)
	if err != nil || !msg.HasEpoch || msg.HistoryEpoch != 2 {
		t.Fatalf("v2 welcome: %+v %v", msg, err)
	}
	legacy := &conn{clientID: 8, out: make(chan []byte, 10), cancel: func() {}}
	if err := r.join(ctx, legacy, 0, false, 2); err != nil {
		t.Fatal(err)
	}
	msg, err = collab.DecodeServerMsg(<-legacy.out)
	if err != nil || msg.HasEpoch {
		t.Fatalf("v1 welcome must not carry epoch: %+v %v", msg, err)
	}
}
