package syncsrv

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/coder/websocket"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func tableGateFixture(t *testing.T) (*store.Memory, int64, *room) {
	t.Helper()
	ctx := context.Background()
	st := store.NewMemory()
	u, ws, err := st.CreateUser(ctx, "table-gate@example.test", "gate", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, u.ID, nil, "test", InitialOps(""))
	if err != nil {
		t.Fatal(err)
	}
	r := &room{hub: &Hub{Store: st, SnapshotEvery: 1000, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}, id: doc.ID, conns: map[*conn]struct{}{}}
	return st, doc.ID, r
}

func tableGateAppend(t *testing.T, st store.Store, doc int64, ops ...collab.Op) int64 {
	t.Helper()
	ctx := context.Background()
	head, err := st.Head(ctx, doc)
	if err != nil {
		t.Fatal(err)
	}
	raws := make([]store.RawOp, 0, len(ops))
	for _, op := range ops {
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		raws = append(raws, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
	}
	if _, err := st.AppendOpsAtHead(ctx, doc, head, raws); err != nil {
		t.Fatal(err)
	}
	head, err = st.Head(ctx, doc)
	if err != nil {
		t.Fatal(err)
	}
	return head
}

func TestPostgresTableGateAcrossInstances(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pg, err := store.NewPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	defer cancel()
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	e := newEnv(t, pg, 1000)
	go e.hub.Run(ctx)
	time.Sleep(100 * time.Millisecond) // allow LISTEN to subscribe
	id := e.newDoc()
	readCtx, stop := context.WithTimeout(ctx, 5*time.Second)
	defer stop()
	ws, _, err := websocket.Dial(readCtx, strings.Replace(e.srv.URL, "http", "ws", 1)+"?protocol=2", &websocket.DialOptions{HTTPHeader: http.Header{"X-User": {"0"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	if err := ws.Write(readCtx, websocket.MessageBinary, collab.EncodeHello(uint64(id), 0, 0)); err != nil {
		t.Fatal(err)
	}
	_, raw, err := ws.Read(readCtx)
	if err != nil {
		t.Fatal(err)
	}
	welcome, err := collab.DecodeServerMsg(raw)
	if err != nil || welcome.Type != collab.MsgWelcome || !welcome.HasEpoch {
		t.Fatalf("welcome: %+v %v", welcome, err)
	}
	var seen uint64
	for seen < welcome.HeadSeq {
		_, raw, err = ws.Read(readCtx)
		if err != nil {
			t.Fatal(err)
		}
		msg, err := collab.DecodeServerMsg(raw)
		if err != nil || msg.Type != collab.MsgSOps {
			t.Fatalf("catch-up: %+v %v", msg, err)
		}
		ops, err := collab.DecodeOps(msg.Batch)
		if err != nil {
			t.Fatal(err)
		}
		seen = msg.FirstSeq + uint64(len(ops)) - 1
	}
	block := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: 7, Clock: 1}, Parent: collab.Root, Pos: "V", Type: "table"}
	table := collab.Op{T: collab.TTable, ID: collab.OpID{Client: 7, Clock: 2}, Block: block.ID, Payload: []byte(`{"kind":"axis-insert"}`)}
	head := tableGateAppend(t, pg, id, block, table) // emulate an older instance
	_, raw, err = ws.Read(readCtx)
	if err != nil {
		t.Fatalf("missing terminal frame: %v", err)
	}
	msg, err := collab.DecodeServerMsg(raw)
	if err != nil || msg.Type != collab.MsgError || msg.Code != "table_unsupported" {
		t.Fatalf("got %+v %v", msg, err)
	}
	if actual, err := pg.Head(ctx, id); err != nil || actual != head {
		t.Fatalf("history changed: %d %v", actual, err)
	}
}

func expectTableUnsupported(t *testing.T, c *conn) {
	t.Helper()
	select {
	case b := <-c.out:
		msg, err := collab.DecodeServerMsg(b)
		if err != nil || msg.Type != collab.MsgError || msg.Code != "table_unsupported" {
			t.Fatalf("unexpected frame: %+v %v", msg, err)
		}
	default:
		t.Fatal("missing unsupported-table error")
	}
	select {
	case b := <-c.out:
		t.Fatalf("unexpected subsequent frame: %x", b)
	default:
	}
}

func TestTableOpsGate(t *testing.T) {
	st, id, r := tableGateFixture(t)
	ctx := context.Background()
	if err := r.load(ctx); err != nil {
		t.Fatal(err)
	}
	head, err := st.Head(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	block := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: 9, Clock: 1}, Parent: collab.Root, Pos: "V", Type: "table"}
	for _, payload := range []string{`{"kind":"axis-insert"}`, `{"kind":"text-mark","key":"bold","value":"1"}`} {
		table := collab.Op{T: collab.TTable, ID: collab.OpID{Client: 9, Clock: 2}, Block: block.ID, Payload: []byte(payload)}
		for _, v2 := range []bool{false, true} {
			c := &conn{clientID: 9, v2: v2, out: make(chan []byte, 10), cancel: func() {}}
			if err := r.handleOps(ctx, c, []collab.Op{block, table}); err != errBatchRejected {
				t.Fatalf("payload=%s v2=%v: %v", payload, v2, err)
			}
			expectTableUnsupported(t, c)
			if got, _ := st.Head(ctx, id); got != head || r.head != head {
				t.Fatalf("payload=%s v2=%v partial commit: %d/%d", payload, v2, got, r.head)
			}
		}
	}
}

func TestTableGateStopsCrossInstanceReplay(t *testing.T) {
	st, id, r := tableGateFixture(t)
	ctx := context.Background()
	if err := r.load(ctx); err != nil {
		t.Fatal(err)
	}
	cancelled := false
	c := &conn{clientID: 9, v2: true, out: make(chan []byte, 10), cancel: func() { cancelled = true }}
	r.conns[c] = struct{}{}
	block := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: 7, Clock: 1}, Parent: collab.Root, Pos: "V", Type: "table"}
	table := collab.Op{T: collab.TTable, ID: collab.OpID{Client: 7, Clock: 2}, Block: block.ID, Payload: []byte(`{"kind":"axis-insert"}`)}
	head := tableGateAppend(t, st, id, block, table) // emulates a legacy instance
	r.remoteHead(head)
	if !cancelled || r.doc != nil {
		t.Fatal("existing connection was not fenced")
	}
	expectTableUnsupported(t, c)
	if got, _ := st.Head(ctx, id); got != head {
		t.Fatal("the durable history was modified")
	}
	delete(r.conns, c)
	for _, v2 := range []bool{false, true} {
		next := &conn{clientID: 11, v2: v2, out: make(chan []byte, 10), cancel: func() {}}
		if err := r.join(ctx, next, 0, v2, 1); err == nil {
			t.Fatalf("v2=%v joined an unsupported document", v2)
		}
		expectTableUnsupported(t, next)
	}
}

func TestTableGateRejectsOpaqueSnapshot(t *testing.T) {
	st, id, r := tableGateFixture(t)
	ctx := context.Background()
	if err := r.load(ctx); err != nil {
		t.Fatal(err)
	}
	block := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: 7, Clock: 1}, Parent: collab.Root, Pos: "V", Type: "table"}
	table := collab.Op{T: collab.TTable, ID: collab.OpID{Client: 7, Clock: 2}, Block: block.ID, Payload: []byte(`{"kind":"axis-insert"}`)}
	head := tableGateAppend(t, st, id, block, table)
	r.doc.Apply(block)
	r.doc.Apply(table)
	if err := st.SaveSnapshot(ctx, id, head, r.doc.EncodeState()); err != nil {
		t.Fatal(err)
	}
	r.doc = nil
	c := &conn{clientID: 11, v2: true, out: make(chan []byte, 10), cancel: func() {}}
	if err := r.join(ctx, c, 0, true, 1); err == nil {
		t.Fatal("v2 peer joined an opaque snapshot")
	}
	expectTableUnsupported(t, c)
}

func TestTableGateDeliversErrorAcrossLiveWebSocket(t *testing.T) {
	st := store.NewMemory()
	e := newEnv(t, st, 1000)
	id := e.newDoc()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, strings.Replace(e.srv.URL, "http", "ws", 1)+"?protocol=2", &websocket.DialOptions{HTTPHeader: http.Header{"X-User": {"0"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	if err := ws.Write(ctx, websocket.MessageBinary, collab.EncodeHello(uint64(id), 0, 0)); err != nil {
		t.Fatal(err)
	}
	_, raw, err := ws.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	welcome, err := collab.DecodeServerMsg(raw)
	if err != nil || welcome.Type != collab.MsgWelcome || !welcome.HasEpoch {
		t.Fatalf("welcome: %+v %v", welcome, err)
	}
	var seen uint64
	for seen < welcome.HeadSeq {
		_, raw, err = ws.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		msg, err := collab.DecodeServerMsg(raw)
		if err != nil || msg.Type != collab.MsgSOps {
			t.Fatalf("catch-up: %+v %v", msg, err)
		}
		ops, err := collab.DecodeOps(msg.Batch)
		if err != nil {
			t.Fatal(err)
		}
		seen = msg.FirstSeq + uint64(len(ops)) - 1
	}
	block := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: 7, Clock: 1}, Parent: collab.Root, Pos: "V", Type: "table"}
	table := collab.Op{T: collab.TTable, ID: collab.OpID{Client: 7, Clock: 2}, Block: block.ID, Payload: []byte(`{"kind":"axis-insert"}`)}
	head := tableGateAppend(t, st, id, block, table)
	e.hub.mu.Lock()
	r := e.hub.rooms[id]
	e.hub.mu.Unlock()
	if r == nil {
		t.Fatal("room missing")
	}
	r.remoteHead(head)
	_, raw, err = ws.Read(ctx)
	if err != nil {
		t.Fatalf("missing error frame: %v", err)
	}
	msg, err := collab.DecodeServerMsg(raw)
	if err != nil || msg.Type != collab.MsgError || msg.Code != "table_unsupported" {
		t.Fatalf("got %+v %v", msg, err)
	}
}

func TestTableGateRejectsLiveBatchAtomically(t *testing.T) {
	st := store.NewMemory()
	e := newEnv(t, st, 1000)
	id := e.newDoc()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, strings.Replace(e.srv.URL, "http", "ws", 1)+"?protocol=2", &websocket.DialOptions{HTTPHeader: http.Header{"X-User": {"0"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	if err := ws.Write(ctx, websocket.MessageBinary, collab.EncodeHello(uint64(id), 0, 0)); err != nil {
		t.Fatal(err)
	}
	_, raw, err := ws.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	welcome, err := collab.DecodeServerMsg(raw)
	if err != nil || welcome.Type != collab.MsgWelcome || !welcome.HasEpoch {
		t.Fatalf("welcome: %+v %v", welcome, err)
	}
	var seen uint64
	for seen < welcome.HeadSeq {
		_, raw, err = ws.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		msg, err := collab.DecodeServerMsg(raw)
		if err != nil || msg.Type != collab.MsgSOps {
			t.Fatalf("catch-up: %+v %v", msg, err)
		}
		ops, err := collab.DecodeOps(msg.Batch)
		if err != nil {
			t.Fatal(err)
		}
		seen = msg.FirstSeq + uint64(len(ops)) - 1
	}
	head, err := st.Head(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	block := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: welcome.ClientID, Clock: 1}, Parent: collab.Root, Pos: "V", Type: "table"}
	table := collab.Op{T: collab.TTable, ID: collab.OpID{Client: welcome.ClientID, Clock: 2}, Block: block.ID, Payload: []byte(`{"kind":"axis-insert"}`)}
	batch, err := collab.EncodeOps([]collab.Op{block, table})
	if err != nil {
		t.Fatal(err)
	}
	if err := ws.Write(ctx, websocket.MessageBinary, collab.EncodeClientOps(batch)); err != nil {
		t.Fatal(err)
	}
	_, raw, err = ws.Read(ctx)
	if err != nil {
		t.Fatalf("missing error frame: %v", err)
	}
	msg, err := collab.DecodeServerMsg(raw)
	if err != nil || msg.Type != collab.MsgError || msg.Code != "table_unsupported" {
		t.Fatalf("batch was not rejected: %+v %v", msg, err)
	}
	if got, _ := st.Head(ctx, id); got != head {
		t.Fatalf("rejected batch advanced head %d -> %d", head, got)
	}
}

func TestTableGateStopsFullLogRepairBeforeAcknowledging(t *testing.T) {
	st, id, r := tableGateFixture(t)
	ctx := context.Background()
	if err := r.load(ctx); err != nil {
		t.Fatal(err)
	}
	block := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: 7, Clock: 1}, Parent: collab.Root, Pos: "V", Type: "table"}
	table := collab.Op{T: collab.TTable, ID: collab.OpID{Client: 7, Clock: 2}, Block: block.ID, Payload: []byte(`{"kind":"axis-insert"}`)}
	head := tableGateAppend(t, st, id, block, table)
	// Emulate an older incomplete snapshot which advanced past the opaque op.
	// A missing dependency forces the room's lossless full-log repair path.
	r.head, r.snapSeq, r.fullLog = head, head, false
	cancelled := false
	c := &conn{clientID: 9, v2: true, out: make(chan []byte, 10), cancel: func() { cancelled = true }}
	r.conns[c] = struct{}{}
	orphan := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 9, Clock: 1}, Block: collab.OpID{Client: 0, Clock: 2}, Parent: collab.OpID{Client: 88, Clock: 9}, Side: 1, Text: "x"}
	if err := r.handleOps(ctx, c, []collab.Op{orphan}); err != errBatchRejected {
		t.Fatalf("repair: %v", err)
	}
	if !cancelled || r.doc != nil {
		t.Fatal("unsupported full log did not fence connection")
	}
	expectTableUnsupported(t, c)
	if got, _ := st.Head(ctx, id); got != head {
		t.Fatal("rejected write advanced history")
	}
}
