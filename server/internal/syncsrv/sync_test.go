package syncsrv

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// env is a sync server on httptest; the X-User header stands in for the session cookie.
type env struct {
	t      *testing.T
	st     store.Store
	hub    *Hub
	srv    *httptest.Server
	users  []store.User
	guards []store.RestoreGuard
	ws     store.Workspace
}

func newEnv(t *testing.T, st store.Store, snapEvery int64) *env {
	ctx := context.Background()
	e := &env{t: t, st: st, hub: &Hub{Store: st, SnapshotEvery: snapEvery, PingInterval: time.Hour}}
	sfx := strconv.FormatInt(time.Now().UnixNano(), 36)
	for i, n := range []string{"kay", "alice", "mallory"} {
		u, ws, err := st.CreateUser(ctx, n+sfx+"@t.dev", n, "x")
		if err != nil {
			t.Fatal(err)
		}
		e.users = append(e.users, u)
		guard := store.RestoreGuard{UserID: u.ID, SessionHash: []byte("sync-test-" + sfx + "-" + strconv.Itoa(i))}
		if err := st.CreateSession(ctx, guard.SessionHash, u.ID, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		e.guards = append(e.guards, guard)
		if i == 0 {
			e.ws = ws
		}
	}
	// alice joins kay's workspace; mallory does not
	if m, ok := st.(*store.Memory); ok {
		m.AddMember(e.ws.ID, e.users[1].ID)
	} else {
		_, err := st.(*store.Postgres).Pool.Exec(ctx, `INSERT INTO workspace_members VALUES ($1,$2,'member')`, e.ws.ID, e.users[1].ID)
		if err != nil {
			t.Fatal(err)
		}
	}
	e.srv = httptest.NewServer(e.handler(e.hub))
	t.Cleanup(e.srv.Close)
	return e
}

func (e *env) handler(h *Hub) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		i, _ := strconv.Atoi(r.Header.Get("X-User"))
		h.Serve(w, r, e.users[i], nil, e.guards[i])
	})
}

func (e *env) newDoc() int64 {
	d, err := e.st.CreateDoc(context.Background(), e.ws.ID, e.users[0].ID, nil, "t", InitialOps(""))
	if err != nil {
		e.t.Fatal(err)
	}
	return d.ID
}

// client is a minimal Go port of the TS SyncClient used to drive the server.
type client struct {
	t           *testing.T
	url         string
	user        int
	docID       int64
	mu          sync.Mutex
	doc         *collab.Doc
	clientID    uint64
	lastSeq     uint64
	inflight    [][]collab.Op
	queued      []collab.Op
	peers       map[uint64]string
	errors      []string
	ws          *websocket.Conn
	cancel      context.CancelFunc
	welcome     chan struct{}
	gotSnap     bool
	welcomeHead uint64
	done        chan struct{}
}

func (e *env) client(user int, doc int64) *client {
	c := &client{t: e.t, url: strings.Replace(e.srv.URL, "http", "ws", 1), user: user, docID: doc, peers: map[uint64]string{}}
	c.connect(e.srv.URL)
	e.t.Cleanup(c.disconnect)
	return c
}

func (c *client) connect(base string) {
	if base != "" {
		c.url = strings.Replace(base, "http", "ws", 1)
	}
	ctx, cancel := context.WithCancel(context.Background())
	ws, _, err := websocket.Dial(ctx, c.url, &websocket.DialOptions{HTTPHeader: http.Header{"X-User": {strconv.Itoa(c.user)}}})
	if err != nil {
		c.t.Fatal(err)
	}
	ws.SetReadLimit(32 << 20)
	c.mu.Lock()
	c.ws, c.cancel, c.welcome, c.done = ws, cancel, make(chan struct{}), make(chan struct{})
	c.mu.Unlock()
	c.write(collab.EncodeHello(uint64(c.docID), c.clientID, c.lastSeq))
	go c.readLoop(ctx, ws)
	select {
	case <-c.welcome:
	case <-c.done:
	case <-time.After(5 * time.Second):
		c.t.Fatal("no welcome")
	}
	waitFor(c.t, "initial catch-up", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.lastSeq >= c.welcomeHead || isClosed(c.done)
	})
}

func isClosed(ch chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func (c *client) write(b []byte) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = c.ws.Write(ctx, websocket.MessageBinary, b)
}

func (c *client) disconnect() {
	c.mu.Lock()
	ws, cancel := c.ws, c.cancel
	c.ws = nil
	c.queued = append(flatten(c.inflight), c.queued...)
	c.inflight = nil
	c.mu.Unlock()
	if ws != nil {
		ws.Close(websocket.StatusNormalClosure, "")
		cancel()
	}
}

func flatten(b [][]collab.Op) (out []collab.Op) {
	for _, x := range b {
		out = append(out, x...)
	}
	return
}

func (c *client) readLoop(ctx context.Context, ws *websocket.Conn) {
	defer close(c.done)
	for {
		_, b, err := ws.Read(ctx)
		if err != nil {
			return
		}
		m, err := collab.DecodeServerMsg(b)
		if err != nil {
			c.t.Errorf("decode: %v", err)
			return
		}
		c.mu.Lock()
		var reply [][]byte
		switch m.Type {
		case collab.MsgWelcome:
			pending := append(flatten(c.inflight), c.queued...)
			c.inflight, c.queued = nil, nil
			if m.HasSnap {
				d, err := collab.DecodeState(m.State)
				if err != nil {
					c.t.Errorf("snapshot: %v", err)
				}
				for _, op := range pending {
					d.Apply(op)
				}
				c.doc, c.lastSeq, c.gotSnap = d, m.SnapSeq, true
			} else if c.doc == nil {
				c.doc = collab.NewDoc()
			}
			c.clientID = m.ClientID
			c.welcomeHead = m.HeadSeq
			if len(pending) > 0 {
				b, _ := collab.EncodeOps(pending)
				c.inflight = append(c.inflight, pending)
				reply = append(reply, collab.EncodeClientOps(b))
			}
			close(c.welcome)
		case collab.MsgSOps:
			if m.FirstSeq != c.lastSeq+1 {
				c.t.Errorf("gap: have %d got %d", c.lastSeq, m.FirstSeq)
			}
			ops, _ := collab.DecodeOps(m.Batch)
			for _, op := range ops {
				c.doc.Apply(op)
			}
			c.lastSeq += uint64(len(ops))
			reply = append(reply, collab.EncodeClientAck(c.lastSeq))
		case collab.MsgSAck:
			if len(c.inflight) > 0 {
				c.inflight = c.inflight[1:]
			}
			if m.Count > 0 {
				if m.FirstSeq != c.lastSeq+1 {
					c.t.Errorf("ack gap: have %d got %d", c.lastSeq, m.FirstSeq)
				}
				c.lastSeq = m.FirstSeq + m.Count - 1
				reply = append(reply, collab.EncodeClientAck(c.lastSeq))
			}
		case collab.MsgSAware:
			if m.Aware == "" {
				delete(c.peers, m.ClientID)
			} else {
				c.peers[m.ClientID] = m.Aware
			}
		case collab.MsgError:
			c.errors = append(c.errors, m.Code)
		}
		c.mu.Unlock()
		for _, r := range reply {
			_ = ws.Write(ctx, websocket.MessageBinary, r)
		}
	}
}

// edit runs fn against the local replica and sends the resulting ops.
func (c *client) edit(fn func(d *collab.Doc, id uint64) []collab.Op) {
	c.mu.Lock()
	ops := fn(c.doc, c.clientID)
	c.queued = append(c.queued, ops...)
	var msg []byte
	if c.ws != nil && len(c.queued) > 0 {
		b, _ := collab.EncodeOps(c.queued)
		c.inflight = append(c.inflight, c.queued)
		c.queued = nil
		msg = collab.EncodeClientOps(b)
	}
	c.mu.Unlock()
	if msg != nil {
		c.write(msg)
	}
}

func (c *client) view() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, _ := json.Marshal(c.doc.View())
	return string(b)
}

func (c *client) idle() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.inflight) == 0 && len(c.queued) == 0
}

var paragraph = collab.OpID{Client: 0, Clock: 2}

func typeAt(text string, at func(n int) int) func(d *collab.Doc, id uint64) []collab.Op {
	return func(d *collab.Doc, id uint64) []collab.Op {
		n := len([]rune(d.Text(paragraph)))
		return []collab.Op{d.InsertText(id, paragraph, at(n), text)}
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func converge(t *testing.T, st store.Store, doc int64, cs ...*client) string {
	t.Helper()
	head, _ := st.Head(context.Background(), doc)
	defer func() {
		if t.Failed() {
			for _, c := range cs {
				c.mu.Lock()
				t.Logf("client %d last=%d head=%d inflight=%d queued=%d errs=%v", c.clientID, c.lastSeq, head, len(c.inflight), len(c.queued), c.errors)
				c.mu.Unlock()
			}
		}
	}()
	waitFor(t, "convergence", func() bool {
		head, _ = st.Head(context.Background(), doc)
		for _, c := range cs {
			c.mu.Lock()
			ok := c.lastSeq == uint64(head) && len(c.inflight) == 0 && len(c.queued) == 0
			c.mu.Unlock()
			if !ok {
				return false
			}
		}
		return true
	})
	v := cs[0].view()
	for _, c := range cs[1:] {
		if c.view() != v {
			t.Fatalf("replicas diverged:\n%s\n%s", v, c.view())
		}
	}
	return v
}

func testConverge(t *testing.T, st store.Store) {
	e := newEnv(t, st, 1000)
	doc := e.newDoc()
	a, b, c := e.client(0, doc), e.client(1, doc), e.client(0, doc)
	if a.clientID == c.clientID || a.clientID == 0 {
		t.Fatal("client ids must be unique per session")
	}
	r := rand.New(rand.NewSource(7))
	cs := []*client{a, b, c}
	for i := 0; i < 300; i++ {
		x := cs[r.Intn(3)]
		switch k := r.Intn(10); {
		case k < 7:
			x.edit(typeAt(string(rune('a'+r.Intn(26))), func(n int) int { return r.Intn(n + 1) }))
		default:
			x.edit(func(d *collab.Doc, id uint64) []collab.Op {
				n := len([]rune(d.Text(paragraph)))
				if n == 0 {
					return nil
				}
				return d.DeleteText(id, paragraph, r.Intn(n), 1)
			})
		}
	}
	converge(t, st, doc, a, b, c)
	head, _ := st.Head(context.Background(), doc)
	if head < 250 {
		t.Fatalf("expected ops persisted, head=%d", head)
	}
	// a late joiner rebuilds the doc purely from the persisted log
	late := e.client(1, doc)
	converge(t, st, doc, a, late)
}

func TestConvergeMemory(t *testing.T) { testConverge(t, store.NewMemory()) }

func TestReconnectCatchUpAndResend(t *testing.T) {
	st := store.NewMemory()
	e := newEnv(t, st, 1000)
	doc := e.newDoc()
	a, b := e.client(0, doc), e.client(1, doc)
	a.edit(typeAt("hello", func(int) int { return 0 }))
	converge(t, st, doc, a, b)

	// b goes offline and keeps editing; a edits meanwhile
	b.disconnect()
	waitFor(t, "room sees b leave", func() bool { return true })
	b.edit(typeAt(" world", func(n int) int { return n }))
	a.edit(typeAt(">", func(int) int { return 0 }))
	if b.idle() {
		t.Fatal("offline edits must stay queued")
	}
	id := b.clientID
	b.connect("")
	if b.clientID != id {
		t.Fatal("reconnect should keep the replica id")
	}
	v := converge(t, st, doc, a, b)
	if !strings.Contains(v, `\u003ehello world"`) {
		t.Fatalf("unexpected text %s", v)
	}

	// resending already-persisted ops (lost ack) must not duplicate them
	head, _ := st.Head(context.Background(), doc)
	b.mu.Lock()
	var dup []collab.Op
	{
		d := collab.NewDoc()
		ops, _ := st.OpsAfter(context.Background(), doc, 0, 0)
		for _, row := range ops {
			o, _ := collab.DecodeOps(row.Bytes)
			for _, op := range o {
				d.Apply(op)
				if op.ID.Client == b.clientID {
					dup = append(dup, op)
				}
			}
		}
	}
	b.queued = dup
	b.mu.Unlock()
	b.edit(func(*collab.Doc, uint64) []collab.Op { return nil })
	waitFor(t, "dup ack", b.idle)
	if h2, _ := st.Head(context.Background(), doc); h2 != head {
		t.Fatalf("duplicates were persisted: %d -> %d", head, h2)
	}
	converge(t, st, doc, a, b)
}

func TestAwareness(t *testing.T) {
	st := store.NewMemory()
	e := newEnv(t, st, 1000)
	doc := e.newDoc()
	a, b := e.client(0, doc), e.client(1, doc)
	a.write(collab.EncodeClientAware(`{"name":"kay","cursor":1}`))
	waitFor(t, "b sees a", func() bool { b.mu.Lock(); defer b.mu.Unlock(); return b.peers[a.clientID] != "" })
	// a newcomer receives existing presence on join
	c := e.client(1, doc)
	waitFor(t, "c sees a", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return b.peers[a.clientID] != "" && c.peers[a.clientID] != ""
	})
	a.disconnect()
	waitFor(t, "a leaves", func() bool {
		b.mu.Lock()
		defer b.mu.Unlock()
		_, ok := b.peers[a.clientID]
		return !ok
	})
	big := make([]byte, maxAwareness+1)
	b.write(collab.EncodeClientAware(string(big)))
	waitFor(t, "too_large", func() bool { b.mu.Lock(); defer b.mu.Unlock(); return len(b.errors) > 0 })
}

func TestSnapshotsAndCompaction(t *testing.T) {
	st := store.NewMemory()
	e := newEnv(t, st, 50)
	doc := e.newDoc()
	a, b := e.client(0, doc), e.client(1, doc)
	for i := 0; i < 120; i++ {
		a.edit(typeAt("x", func(n int) int { return n }))
	}
	converge(t, st, doc, a, b)
	for i := 0; i < 100; i++ { // trailing deletions leave leaf tombstones
		b.edit(func(d *collab.Doc, id uint64) []collab.Op {
			return d.DeleteText(id, paragraph, len([]rune(d.Text(paragraph)))-1, 1)
		})
	}
	v := converge(t, st, doc, a, b)
	for i := 0; i < 60; i++ { // flush acks past the next threshold
		a.edit(typeAt("y", func(int) int { return 0 }))
	}
	v = converge(t, st, doc, a, b)
	seq, state, err := st.LatestSnapshot(context.Background(), doc)
	if err != nil || seq == 0 {
		t.Fatalf("no snapshot: %v", err)
	}
	snap, _ := collab.DecodeState(state)
	full := collab.NewDoc()
	rows, _ := st.OpsAfter(context.Background(), doc, 0, int(seq))
	for _, row := range rows {
		o, _ := collab.DecodeOps(row.Bytes)
		for _, op := range o {
			full.Apply(op)
		}
	}
	if len(state) >= len(full.EncodeState()) {
		t.Fatalf("snapshot not compacted: %d >= %d", len(state), len(full.EncodeState()))
	}
	j1, _ := json.Marshal(snap.View())
	j2, _ := json.Marshal(full.View())
	if string(j1) != string(j2) {
		t.Fatal("compacted snapshot view differs from log replay")
	}
	// a brand-new client starts from the snapshot + tail and converges
	c := e.client(1, doc)
	if !c.gotSnap {
		t.Fatal("new client should receive the snapshot")
	}
	if converge(t, st, doc, a, b, c) != v {
		t.Fatal("view changed")
	}
	// a restarted hub (empty memory) loads from the snapshot too
	e.hub = &Hub{Store: st, SnapshotEvery: 50, PingInterval: time.Hour}
	srv2 := httptest.NewServer(e.handler(e.hub))
	defer srv2.Close()
	d := &client{t: t, user: 0, docID: doc, peers: map[uint64]string{}}
	d.connect(srv2.URL)
	defer d.disconnect()
	d.edit(typeAt("!", func(int) int { return 0 }))
	waitFor(t, "ack", d.idle)
	converge(t, st, doc, d)
}

func TestAuthorization(t *testing.T) {
	st := store.NewMemory()
	e := newEnv(t, st, 1000)
	doc := e.newDoc()
	m := e.client(2, doc) // mallory: not a workspace member
	waitFor(t, "rejected", func() bool { m.mu.Lock(); defer m.mu.Unlock(); return len(m.errors) > 0 })
	if m.errors[0] != "not_found" {
		t.Fatalf("got %v", m.errors)
	}
	a, b := e.client(0, doc), e.client(1, doc)
	// b forges ops as a's replica: rejected and disconnected
	forged := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: a.clientID, Clock: 99}, Block: paragraph, Parent: collab.Root, Side: 1, Text: "x"}
	bb, _ := collab.EncodeOps([]collab.Op{forged})
	b.write(collab.EncodeClientOps(bb))
	select {
	case <-b.done:
	case <-time.After(5 * time.Second):
		t.Fatal("forger not disconnected")
	}
	if h, _ := st.Head(context.Background(), doc); h != 2 {
		t.Fatalf("forged op persisted, head=%d", h)
	}
	// claiming someone else's client id yields a fresh id
	b.clientID = a.clientID
	b.errors = nil
	b.connect("")
	if b.clientID == a.clientID {
		t.Fatal("stole client id")
	}
	// Causally unready ops are rejected without acknowledging the batch.
	orphan := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: b.clientID, Clock: 500}, Block: paragraph, Parent: collab.OpID{Client: 77, Clock: 1}, Side: 1, Text: "x"}
	b.edit(func(*collab.Doc, uint64) []collab.Op { return []collab.Op{orphan} })
	waitFor(t, "rejected batch", func() bool { b.mu.Lock(); defer b.mu.Unlock(); return len(b.errors) > 0 })
	b.mu.Lock()
	defer b.mu.Unlock()
	if fmt.Sprint(b.errors) != "[not_ready]" {
		t.Fatalf("errors %v", b.errors)
	}
	if len(b.inflight) != 1 || len(b.inflight[0]) != 1 {
		t.Fatalf("rejected operation was acknowledged: %v", b.inflight)
	}
}

func TestConnectedSharePermissionChanges(t *testing.T) {
	t.Run("downgrade rejects writes and preserves read access on a new connection", func(t *testing.T) {
		st := store.NewMemory()
		e := newEnv(t, st, 1000)
		doc := e.newDoc()
		ctx := context.Background()
		if err := st.SetShare(ctx, doc, e.users[2].ID, store.RoleEdit); err != nil {
			t.Fatal(err)
		}
		owner, shared := e.client(0, doc), e.client(2, doc)
		shared.edit(typeAt("before", func(n int) int { return n }))
		converge(t, st, doc, owner, shared)
		head, err := st.Head(ctx, doc)
		if err != nil {
			t.Fatal(err)
		}
		if err := st.SetShare(ctx, doc, e.users[2].ID, store.RoleView); err != nil {
			t.Fatal(err)
		}
		shared.edit(typeAt("forbidden", func(n int) int { return n }))
		waitFor(t, "read-only rejection", func() bool {
			shared.mu.Lock()
			defer shared.mu.Unlock()
			return len(shared.errors) > 0
		})
		shared.mu.Lock()
		gotErr := shared.errors[len(shared.errors)-1]
		shared.mu.Unlock()
		if gotErr != "read_only" {
			t.Fatalf("got %q, want read_only", gotErr)
		}
		if h, _ := st.Head(ctx, doc); h != head {
			t.Fatalf("downgraded write persisted: %d -> %d", head, h)
		}
		select {
		case <-shared.done:
		case <-time.After(5 * time.Second):
			t.Fatal("connection not closed after rejected batch")
		}
		// Reconnect without replaying the rejected local draft: viewer access
		// continues, while the original connection retains its pending batch.
		viewer := e.client(2, doc)
		owner.edit(typeAt("after", func(n int) int { return n }))
		waitFor(t, "viewer receives later changes", func() bool {
			viewer.mu.Lock()
			defer viewer.mu.Unlock()
			return viewer.lastSeq > uint64(head) || isClosed(viewer.done)
		})
		if isClosed(viewer.done) {
			t.Fatal("viewer connection lost after downgrade")
		}
	})

	t.Run("upgrade applies without reconnect", func(t *testing.T) {
		st := store.NewMemory()
		e := newEnv(t, st, 1000)
		doc := e.newDoc()
		ctx := context.Background()
		if err := st.SetShare(ctx, doc, e.users[2].ID, store.RoleView); err != nil {
			t.Fatal(err)
		}
		owner, shared := e.client(0, doc), e.client(2, doc)
		if err := st.SetShare(ctx, doc, e.users[2].ID, store.RoleEdit); err != nil {
			t.Fatal(err)
		}
		shared.edit(typeAt("allowed", func(n int) int { return n }))
		if v := converge(t, st, doc, owner, shared); !strings.Contains(v, "allowed") {
			t.Fatalf("write missing: %s", v)
		}
	})

	t.Run("revoked connection cannot receive new broadcasts", func(t *testing.T) {
		st := store.NewMemory()
		e := newEnv(t, st, 1000)
		doc := e.newDoc()
		ctx := context.Background()
		if err := st.SetShare(ctx, doc, e.users[2].ID, store.RoleEdit); err != nil {
			t.Fatal(err)
		}
		owner, shared := e.client(0, doc), e.client(2, doc)
		shared.mu.Lock()
		before := shared.lastSeq
		shared.mu.Unlock()
		if err := st.SetShare(ctx, doc, e.users[2].ID, ""); err != nil {
			t.Fatal(err)
		}
		owner.edit(typeAt("secret after revoke", func(n int) int { return n }))
		waitFor(t, "owner write", owner.idle)
		select {
		case <-shared.done:
		case <-time.After(5 * time.Second):
			t.Fatal("revoked connection remained open on broadcast")
		}
		shared.mu.Lock()
		defer shared.mu.Unlock()
		if shared.lastSeq != before || strings.Contains(shared.doc.Text(paragraph), "secret after revoke") {
			t.Fatal("revoked connection received document content")
		}
	})

	t.Run("revoked connection cannot write", func(t *testing.T) {
		st := store.NewMemory()
		e := newEnv(t, st, 1000)
		doc := e.newDoc()
		ctx := context.Background()
		if err := st.SetShare(ctx, doc, e.users[2].ID, store.RoleEdit); err != nil {
			t.Fatal(err)
		}
		shared := e.client(2, doc)
		head, _ := st.Head(ctx, doc)
		if err := st.SetShare(ctx, doc, e.users[2].ID, ""); err != nil {
			t.Fatal(err)
		}
		shared.edit(typeAt("forbidden", func(n int) int { return n }))
		select {
		case <-shared.done:
		case <-time.After(5 * time.Second):
			t.Fatal("revoked writer remained connected")
		}
		if h, _ := st.Head(ctx, doc); h != head {
			t.Fatalf("revoked write persisted: %d -> %d", head, h)
		}
	})
}

func TestHelloDoesNotTrustReplicaFromAnotherDocument(t *testing.T) {
	st := store.NewMemory()
	e := newEnv(t, st, 1000)
	firstDoc, secondDoc := e.newDoc(), e.newDoc()
	first := e.client(0, firstDoc)
	second := &client{t: t, user: 0, docID: secondDoc, clientID: first.clientID, peers: map[uint64]string{}}
	second.connect(e.srv.URL)
	defer second.disconnect()
	if second.clientID == first.clientID {
		t.Fatal("replica id from a different document was reused")
	}

	// A stale pending operation for the first document must not become an
	// authorized replica merely because both documents have the same owner.
	doc := collab.NewDoc()
	rows, err := st.OpsAfter(context.Background(), secondDoc, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		ops, err := collab.DecodeOps(row.Bytes)
		if err != nil {
			t.Fatal(err)
		}
		for _, op := range ops {
			doc.Apply(op)
		}
	}
	forged := doc.InsertText(first.clientID, paragraph, 0, "wrong document")
	batch, err := collab.EncodeOps([]collab.Op{forged})
	if err != nil {
		t.Fatal(err)
	}
	head, _ := st.Head(context.Background(), secondDoc)
	second.write(collab.EncodeClientOps(batch))
	select {
	case <-second.done:
	case <-time.After(5 * time.Second):
		t.Fatal("cross-document replica not rejected")
	}
	if after, _ := st.Head(context.Background(), secondDoc); after != head {
		t.Fatalf("cross-document operation persisted: %d -> %d", head, after)
	}
}

// gatedDocStore makes authorization checks wait without holding a room lock.
// It lets tests change the grant after a frame was queued but before sending.
type gatedDocStore struct {
	store.DocStore
	mu        sync.Mutex
	user      int64
	remaining int
	entered   chan struct{}
	release   chan struct{}
	fail      bool
}

func (g *gatedDocStore) GetDoc(ctx context.Context, user, doc int64) (store.DocMeta, error) {
	g.mu.Lock()
	var release <-chan struct{}
	fail := false
	if user == g.user {
		fail = g.fail
		if g.remaining > 0 {
			g.remaining--
			if g.remaining == 0 {
				close(g.entered)
				release = g.release
			}
		}
	}
	g.mu.Unlock()
	if release != nil {
		select {
		case <-release:
		case <-ctx.Done():
			return store.DocMeta{}, ctx.Err()
		}
	}
	if fail {
		return store.DocMeta{}, errors.New("simulated permission lookup failure")
	}
	return g.DocStore.GetDoc(ctx, user, doc)
}

func (g *gatedDocStore) gate(user int64, nth int) (<-chan struct{}, chan struct{}) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.user, g.remaining = user, nth
	g.entered, g.release = make(chan struct{}), make(chan struct{})
	return g.entered, g.release
}

func TestRevokedDuringInitialCatchUp(t *testing.T) {
	st := store.NewMemory()
	e := newEnv(t, st, 1000)
	doc := e.newDoc()
	ctx := context.Background()
	if err := st.SetShare(ctx, doc, e.users[2].ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	gate := &gatedDocStore{DocStore: st}
	e.hub.Store = gate
	entered, release := gate.gate(e.users[2].ID, 2) // HELLO check, then queued WELCOME
	ws, _, err := websocket.Dial(ctx, strings.Replace(e.srv.URL, "http", "ws", 1), &websocket.DialOptions{HTTPHeader: http.Header{"X-User": {"2"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")
	if err := ws.Write(ctx, websocket.MessageBinary, collab.EncodeHello(uint64(doc), 0, 0)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("welcome did not reach send check")
	}
	if err := st.SetShare(ctx, doc, e.users[2].ID, ""); err != nil {
		t.Fatal(err)
	}
	close(release)
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, _, err := ws.Read(rctx); err == nil {
		t.Fatal("revoked user received catch-up frame")
	}
}

func TestRevokedWhileBroadcastQueued(t *testing.T) {
	st := store.NewMemory()
	e := newEnv(t, st, 1000)
	doc := e.newDoc()
	ctx := context.Background()
	if err := st.SetShare(ctx, doc, e.users[2].ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	gate := &gatedDocStore{DocStore: st}
	e.hub.Store = gate
	owner, shared := e.client(0, doc), e.client(2, doc)
	shared.mu.Lock()
	before := shared.lastSeq
	shared.mu.Unlock()
	// Wait for the catch-up ACK so the next target permission check is the
	// writer checking the owner's queued broadcast, not the incoming ACK.
	waitFor(t, "initial server ACK", func() bool {
		e.hub.mu.Lock()
		r := e.hub.rooms[doc]
		e.hub.mu.Unlock()
		if r == nil {
			return false
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		for c := range r.conns {
			if c.user.ID == e.users[2].ID {
				return c.acked >= int64(before)
			}
		}
		return false
	})
	entered, release := gate.gate(e.users[2].ID, 1)
	owner.edit(typeAt("private queued content", func(n int) int { return n }))
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("queued broadcast did not reach send check")
	}
	if err := st.SetShare(ctx, doc, e.users[2].ID, ""); err != nil {
		t.Fatal(err)
	}
	close(release)
	waitFor(t, "owner write", owner.idle)
	select {
	case <-shared.done:
	case <-time.After(5 * time.Second):
		t.Fatal("revoked recipient remained connected")
	}
	shared.mu.Lock()
	defer shared.mu.Unlock()
	if shared.lastSeq != before || strings.Contains(shared.doc.Text(paragraph), "private queued content") {
		t.Fatal("revoked user received a previously queued frame")
	}
}

func TestPermissionLookupFailureFailsClosed(t *testing.T) {
	st := store.NewMemory()
	e := newEnv(t, st, 1000)
	doc := e.newDoc()
	ctx := context.Background()
	if err := st.SetShare(ctx, doc, e.users[2].ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	gate := &gatedDocStore{DocStore: st}
	e.hub.Store = gate
	owner, shared := e.client(0, doc), e.client(2, doc)
	shared.mu.Lock()
	before := shared.lastSeq
	shared.mu.Unlock()
	gate.mu.Lock()
	gate.user, gate.fail = e.users[2].ID, true
	gate.mu.Unlock()
	owner.edit(typeAt("private", func(n int) int { return n }))
	waitFor(t, "owner write", owner.idle)
	select {
	case <-shared.done:
	case <-time.After(5 * time.Second):
		t.Fatal("lookup failure did not disconnect")
	}
	shared.mu.Lock()
	defer shared.mu.Unlock()
	if shared.lastSeq != before {
		t.Fatal("sent document content after failed authorization check")
	}
}

func TestPermissionLookupFailureRejectsWrites(t *testing.T) {
	st := store.NewMemory()
	e := newEnv(t, st, 1000)
	doc := e.newDoc()
	ctx := context.Background()
	if err := st.SetShare(ctx, doc, e.users[2].ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	gate := &gatedDocStore{DocStore: st}
	e.hub.Store = gate
	shared := e.client(2, doc)
	head, _ := st.Head(ctx, doc)
	gate.mu.Lock()
	gate.user, gate.fail = e.users[2].ID, true
	gate.mu.Unlock()
	shared.edit(typeAt("forbidden", func(n int) int { return n }))
	select {
	case <-shared.done:
	case <-time.After(5 * time.Second):
		t.Fatal("lookup failure did not disconnect writer")
	}
	if after, _ := st.Head(ctx, doc); after != head {
		t.Fatalf("write persisted after authorization failure: %d -> %d", head, after)
	}
}

func TestAwarenessBurstDoesNotBlockDocumentWrites(t *testing.T) {
	st := store.NewMemory()
	e := newEnv(t, st, 1000)
	doc := e.newDoc()
	a, b := e.client(0, doc), e.client(1, doc)
	for i := 0; i < 100; i++ {
		a.write(collab.EncodeClientAware(fmt.Sprintf(`{"cursor":%d}`, i)))
	}
	b.edit(typeAt("still editable", func(n int) int { return n }))
	if v := converge(t, st, doc, a, b); !strings.Contains(v, "still editable") {
		t.Fatalf("write not propagated: %s", v)
	}
}

// Two hubs (two server instances) on one Postgres: fan-out via LISTEN/NOTIFY.
func TestPostgresMultiInstance(t *testing.T) {
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
	defer cancel() // stop LISTEN goroutines before closing the pool
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	e := newEnv(t, pg, 40)
	go e.hub.Run(ctx)
	hub2 := &Hub{Store: pg, SnapshotEvery: 40, PingInterval: time.Hour}
	go hub2.Run(ctx)
	srv2 := httptest.NewServer(e.handler(hub2))
	defer srv2.Close()
	time.Sleep(100 * time.Millisecond) // let LISTEN connections start
	doc := e.newDoc()
	a := e.client(0, doc)
	b := &client{t: t, user: 1, docID: doc, peers: map[uint64]string{}}
	b.connect(srv2.URL)
	defer b.disconnect()
	r := rand.New(rand.NewSource(3))
	for i := 0; i < 150; i++ {
		x := []*client{a, b}[r.Intn(2)]
		x.edit(typeAt(string(rune('a'+r.Intn(26))), func(n int) int { return r.Intn(n + 1) }))
	}
	converge(t, pg, doc, a, b)
	if seq, _, err := pg.LatestSnapshot(ctx, doc); err != nil || seq == 0 {
		t.Fatalf("expected a snapshot: %v", err)
	}
	t.Log(converge(t, pg, doc, a, b)[:80])
}

var _ = testConverge
