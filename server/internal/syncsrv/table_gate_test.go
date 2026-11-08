package syncsrv

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// ttable 载荷门控：v1 连接提交被拒；v2 连接在房间内有 v1 成员时同样被拒。
func TestTableOpsGate(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	u, ws, err := st.CreateUser(ctx, "tgate@test.dev", "gate", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, u.ID, nil, "test", InitialOps(""))
	if err != nil {
		t.Fatal(err)
	}
	r := &room{hub: &Hub{Store: st, SnapshotEvery: 1000, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}, id: doc.ID, conns: map[*conn]struct{}{}}
	if err := r.load(ctx); err != nil {
		t.Fatal(err)
	}
	head := r.head
	op := collab.Op{T: collab.TTable, ID: collab.OpID{Client: 7, Clock: 1}, Block: collab.OpID{Client: 7, Clock: 1}, Payload: []byte("{}")}

	// v1 连接：直接拒绝
	v1 := &conn{clientID: 7, out: make(chan []byte, 10), cancel: func() {}}
	if err := r.handleOps(ctx, v1, []collab.Op{op}); err != errBatchRejected {
		t.Fatalf("v1 submit: %v", err)
	}
	if msg, err := collab.DecodeServerMsg(<-v1.out); err != nil || msg.Type != collab.MsgError || msg.Code != "bad_ops" {
		t.Fatalf("v1 error frame: %+v %v", msg, err)
	}
	if r.head != head {
		t.Fatalf("rejected batch advanced head: %d", r.head)
	}

	// v2 连接，但房间里有 v1 成员：同样拒绝
	v1member := &conn{clientID: 8, out: make(chan []byte, 10), cancel: func() {}}
	r.conns[v1member] = struct{}{}
	defer delete(r.conns, v1member)
	v2 := &conn{clientID: 9, v2: true, out: make(chan []byte, 10), cancel: func() {}}
	if err := r.handleOps(ctx, v2, []collab.Op{op}); err != errBatchRejected {
		t.Fatalf("v2 submit with v1 member: %v", err)
	}
	if msg, err := collab.DecodeServerMsg(<-v2.out); err != nil || msg.Type != collab.MsgError || msg.Code != "bad_ops" {
		t.Fatalf("v2 error frame: %+v %v", msg, err)
	}

	// 全员 v2 且块存在：应用并推进（TryApply 已集成 ttable，载荷按块持久化）
	delete(r.conns, v1member)
	block := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: 9, Clock: 2}, Parent: collab.Root, Pos: "V", Type: "table"}
	if err := r.handleOps(ctx, v2, []collab.Op{block}); err != nil {
		t.Fatalf("create table block: %v", err)
	}
	valid := collab.Op{T: collab.TTable, ID: collab.OpID{Client: 9, Clock: 3}, Block: block.ID, Payload: []byte(`{"kind":"axis-insert"}`)}
	if err := r.handleOps(ctx, v2, []collab.Op{valid}); err != nil {
		t.Fatalf("v2 apply: %v", err)
	}
	if r.head != head+2 {
		t.Fatalf("ttable not persisted: %d", r.head)
	}
	// v1 连接此时加入该文档：拒绝而不是让它失步
	if err := r.join(ctx, v1member, 0, false, 1); err == nil {
		t.Fatal("v1 join of table-bearing doc accepted")
	}
	if msg, err := collab.DecodeServerMsg(<-v1member.out); err != nil || msg.Type != collab.MsgError || msg.Code != "v2_required" {
		t.Fatalf("v1 join error frame: %+v %v", msg, err)
	}
}
