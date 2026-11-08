package syncsrv

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type unavailableEpochStore struct{ store.Store }

func (s unavailableEpochStore) HeadVersion(context.Context, int64) (int64, int64, error) {
	return 0, 0, errors.New("epoch store unavailable")
}

func TestHelloFailsClosedWhenEpochUnavailable(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	u, ws, err := st.CreateUser(ctx, "missing-epoch@example.test", "Test", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, u.ID, nil, "doc", InitialOps(""))
	if err != nil {
		t.Fatal(err)
	}
	h := &Hub{Store: unavailableEpochStore{st}}
	c := &conn{hub: h, user: u, out: make(chan []byte, 2), owned: map[uint64]bool{}, cancel: func() {}, wantsV2: true}
	if err := c.hello(ctx, collab.ClientMsg{DocID: uint64(doc.ID)}); err == nil {
		t.Fatal("hello accepted without a trustworthy epoch")
	}
	msg, err := collab.DecodeServerMsg(<-c.out)
	if err != nil || msg.Type != collab.MsgError || msg.Code != "internal" {
		t.Fatalf("unexpected failure frame: %+v, %v", msg, err)
	}
	if c.room == nil {
		t.Fatal("expected room to be released")
	}
	h.release(c.room)
}

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

// Exercise the actual upgrade URL and wire frames, including a v1 replica
// whose cached sequence must not be trusted on its first epoch-aware join.
func TestWebSocketFirstContactNegotiatesEpoch(t *testing.T) {
	st := store.NewMemory()
	e := newEnv(t, st, 1000)
	doc := e.newDoc()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	base := strings.Replace(e.srv.URL, "http", "ws", 1)
	connect := func(query string, lastSeq uint64) (collab.ServerMsg, collab.ServerMsg) {
		t.Helper()
		ws, _, err := websocket.Dial(ctx, base+query, &websocket.DialOptions{HTTPHeader: http.Header{"X-User": {"0"}}})
		if err != nil {
			t.Fatal(err)
		}
		defer ws.Close(websocket.StatusNormalClosure, "")
		if err := ws.Write(ctx, websocket.MessageBinary, collab.EncodeHello(uint64(doc), 0, lastSeq)); err != nil {
			t.Fatal(err)
		}
		_, b, err := ws.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		welcome, err := collab.DecodeServerMsg(b)
		if err != nil {
			t.Fatal(err)
		}
		_, b, err = ws.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		ops, err := collab.DecodeServerMsg(b)
		if err != nil {
			t.Fatal(err)
		}
		return welcome, ops
	}
	legacy, legacyOps := connect("", 0)
	if legacy.Type != collab.MsgWelcome || legacy.HasEpoch || legacyOps.Type != collab.MsgSOps {
		t.Fatalf("legacy negotiation: %+v %+v", legacy, legacyOps)
	}
	if err := st.BumpHistoryEpoch(ctx, doc); err != nil {
		t.Fatal(err)
	}
	epoch, _, err := st.HeadVersion(ctx, doc)
	if err != nil || epoch != 2 {
		t.Fatalf("memory epoch after bump: %d, %v", epoch, err)
	}
	upgraded, replay := connect("?protocol=2", 2)
	if upgraded.Type != collab.MsgWelcome || !upgraded.HasEpoch || upgraded.HistoryEpoch != 2 {
		t.Fatalf("upgraded welcome: %+v", upgraded)
	}
	if replay.Type != collab.MsgSOps || replay.FirstSeq != 1 {
		t.Fatalf("expected replay from sequence 1: %+v", replay)
	}
}

func TestWebSocketTableDocumentFirstContact(t *testing.T) {
	st := store.NewMemory()
	e := newEnv(t, st, 1000)
	doc := e.newDoc()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	block := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: 99, Clock: 1}, Parent: collab.Root, Pos: "W", Type: "table"}
	table := collab.Op{T: collab.TTable, ID: collab.OpID{Client: 99, Clock: 2}, Block: block.ID, Payload: []byte(`{"kind":"axis-insert"}`)}
	for _, op := range []collab.Op{block, table} {
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := st.AppendOps(ctx, doc, []store.RawOp{{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b}}); err != nil {
			t.Fatal(err)
		}
	}
	base := strings.Replace(e.srv.URL, "http", "ws", 1)
	for _, tc := range []struct {
		query string
		want  byte
	}{{"", collab.MsgError}, {"?protocol=2", collab.MsgWelcome}} {
		t.Run(tc.query, func(t *testing.T) {
			ws, _, err := websocket.Dial(ctx, base+tc.query, &websocket.DialOptions{HTTPHeader: http.Header{"X-User": {"0"}}})
			if err != nil {
				t.Fatal(err)
			}
			defer ws.Close(websocket.StatusNormalClosure, "")
			if err := ws.Write(ctx, websocket.MessageBinary, collab.EncodeHello(uint64(doc), 0, 0)); err != nil {
				t.Fatal(err)
			}
			_, b, err := ws.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			msg, err := collab.DecodeServerMsg(b)
			if err != nil || msg.Type != tc.want {
				t.Fatalf("first frame: %+v, %v", msg, err)
			}
			if tc.want == collab.MsgWelcome && !msg.HasEpoch {
				t.Fatal("v2 welcome omitted epoch")
			}
			if tc.want == collab.MsgError && msg.Code != "v2_required" {
				t.Fatalf("unexpected error: %+v", msg)
			}
		})
	}
}
