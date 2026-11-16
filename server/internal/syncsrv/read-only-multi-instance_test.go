package syncsrv

import (
	"bytes"
	"context"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestReadOnlyProjectionQueueCoalesces(t *testing.T) {
	c := &conn{projection: make(chan []byte, 1), cancel: func() { t.Error("queue unexpectedly canceled") }}
	for _, value := range []string{"old", "middle", "new"} {
		c.sendProjection([]byte(value))
	}
	if got := <-c.projection; !bytes.Equal(got, []byte("new")) {
		t.Fatalf("queued stale projection %q", got)
	}
	select {
	case extra := <-c.projection:
		t.Fatalf("additional projection retained: %q", extra)
	default:
	}
}

func TestReadOnlyCatchupWaitsForDependenciesAcrossPages(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	e := newEnv(t, st, 1000)
	doc := e.newDoc()
	if err := st.SetShare(ctx, doc, e.users[2].ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	viewer := e.viewClient(2, doc)
	parent := collab.OpID{Client: 999998, Clock: 3000}
	child := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 999998, Clock: 1000}, Block: paragraph, Parent: parent, Side: 1, Text: "乙"}
	ops := []collab.Op{child}
	for i := 0; i < 999; i++ {
		value := "x"
		ops = append(ops, collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 999998, Clock: uint64(1001 + i)}, Block: paragraph, Key: "test", Value: &value})
	}
	ops = append(ops, collab.Op{T: collab.TTextInsert, ID: parent, Block: paragraph, Parent: collab.Root, Side: 1, Text: "甲"})
	rows := make([]store.RawOp, 0, len(ops))
	for _, op := range ops {
		data, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		rows = append(rows, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: data})
	}
	seqs, err := st.AppendOps(ctx, doc, rows)
	if err != nil {
		t.Fatal(err)
	}
	e.hub.mu.Lock()
	room := e.hub.rooms[doc]
	e.hub.mu.Unlock()
	if room == nil {
		t.Fatal("viewer room missing")
	}
	room.remoteHead(seqs[len(seqs)-1])
	waitFor(t, "complete projected history", func() bool {
		viewer.mu.Lock()
		defer viewer.mu.Unlock()
		return viewer.projections > 0 && viewer.doc.Text(paragraph) == "甲乙"
	})
	if isClosed(viewer.done) {
		t.Fatal("viewer disconnected on a temporary dependency")
	}
}

type readyListener struct {
	store.DocStore
	once  sync.Once
	ready chan struct{}
}

func (s *readyListener) Listen(ctx context.Context, fn func(int64, int64)) error {
	return s.DocStore.Listen(ctx, func(doc, head int64) { s.once.Do(func() { close(s.ready) }); fn(doc, head) })
}

func checkReadOnlyAcrossInstances(t *testing.T, st store.Store) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e := newEnv(t, st, 1000)
	first := &readyListener{DocStore: st, ready: make(chan struct{})}
	second := &readyListener{DocStore: st, ready: make(chan struct{})}
	e.hub.Store = first
	hub2 := &Hub{Store: second, SnapshotEvery: 1000, PingInterval: time.Hour}
	server2 := httptest.NewServer(e.handler(hub2))
	defer server2.Close()
	go e.hub.Run(ctx)
	go hub2.Run(ctx)
	doc := e.newDoc()
	// A notification observed by each listener proves subscription is active;
	// repeat until both receive one rather than assuming a fixed startup delay.
	ticker := time.NewTicker(30 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	var clock uint64 = 1000
	ready := func(ch <-chan struct{}) bool {
		select {
		case <-ch:
			return true
		default:
			return false
		}
	}
	for !ready(first.ready) || !ready(second.ready) {
		select {
		case <-deadline.C:
			t.Fatal("listeners did not become ready")
		case <-ticker.C:
			value := "ready"
			op := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 999999, Clock: clock}, Block: paragraph, Key: "test-ready", Value: &value}
			clock++
			encoded, err := collab.EncodeOps([]collab.Op{op})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = st.AppendOps(ctx, doc, []store.RawOp{{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: encoded}}); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := st.SetShare(ctx, doc, e.users[2].ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	editor := e.client(0, doc)
	viewer := &client{t: t, user: 2, docID: doc, peers: map[uint64]string{}, protocol3: true}
	viewer.connect(server2.URL)
	defer viewer.disconnect()
	editor.edit(typeAt("跨实例更新", func(n int) int { return n }))
	waitFor(t, "viewer projected remote update", func() bool {
		viewer.mu.Lock()
		defer viewer.mu.Unlock()
		return viewer.projections > 0 && strings.Contains(viewer.doc.Text(paragraph), "跨实例更新")
	})
	viewer.mu.Lock()
	defer viewer.mu.Unlock()
	if viewer.rawFrames != 0 {
		t.Fatalf("viewer received %d raw operation frames", viewer.rawFrames)
	}
}

func TestReadOnlyAcrossMemoryInstances(t *testing.T) {
	checkReadOnlyAcrossInstances(t, store.NewMemory())
}

func TestReadOnlyAcrossPostgresInstances(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pg, err := store.NewPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err = migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	checkReadOnlyAcrossInstances(t, pg)
}
