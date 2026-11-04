package btsync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

type btClient struct {
	t   *testing.T
	ws  *websocket.Conn
	ctx context.Context
}

func (c *btClient) send(v any) {
	c.t.Helper()
	b, _ := json.Marshal(v)
	if err := c.ws.Write(c.ctx, websocket.MessageText, b); err != nil {
		c.t.Fatal(err)
	}
}

// next reads frames until one matches want ("hello"/"events").
func (c *btClient) next(want string) map[string]any {
	c.t.Helper()
	rctx, cancel := context.WithTimeout(c.ctx, 3*time.Second)
	defer cancel()
	for {
		_, data, err := c.ws.Read(rctx)
		if err != nil {
			c.t.Fatalf("read %s: %v", want, err)
		}
		var m map[string]any
		if json.Unmarshal(data, &m) != nil || m["t"] != want {
			continue
		}
		return m
	}
}

func (c *btClient) close() { c.ws.Close(websocket.StatusNormalClosure, "") }

func dial(t *testing.T, url string, base int64, lastSeq *int64) *btClient {
	t.Helper()
	ctx := context.Background()
	ws, _, err := websocket.Dial(ctx, url+"/sync/"+strconv.FormatInt(base, 10), nil)
	if err != nil {
		t.Fatal(err)
	}
	c := &btClient{t: t, ws: ws, ctx: ctx}
	hello := c.next("hello")
	if hello["head"] == nil {
		t.Fatalf("hello missing head: %v", hello)
	}
	if lastSeq != nil {
		c.send(map[string]any{"t": "hello", "lastSeq": *lastSeq})
	}
	return c
}

type btEnv struct {
	t    *testing.T
	hub  *Hub
	srv  *httptest.Server
	st   store.Store
	base int64
}

func newHubEnv(t *testing.T) *btEnv {
	t.Helper()
	st := store.NewMemory()
	hub := &Hub{Store: st, PingInterval: time.Hour}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /sync/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		hub.Serve(w, r, id)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	ctx := context.Background()
	u, ws, err := st.CreateUser(ctx, "bt@t.dev", "bt", "x")
	if err != nil {
		t.Fatal(err)
	}
	base, err := st.CreateBase(ctx, ws.ID, u.ID, nil, "b")
	if err != nil {
		t.Fatal(err)
	}
	return &btEnv{t: t, hub: hub, srv: srv, st: st, base: base.ID}
}

func (e *btEnv) event(body string) int64 {
	e.t.Helper()
	seq, err := e.st.AppendBtEvent(context.Background(), e.base, []byte(body))
	if err != nil {
		e.t.Fatal(err)
	}
	e.hub.Notify(e.base)
	return seq
}

func TestBtSyncFanoutAndConvergence(t *testing.T) {
	e := newHubEnv(t)

	a := dial(t, e.srv.URL, e.base, nil)
	defer a.close()
	b := dial(t, e.srv.URL, e.base, nil)
	defer b.close()

	// a REST-style mutation appends an event and notifies
	seq := e.event(`{"kind":"cells","rid":7,"cells":{"1":"先写"}}`)
	for name, c := range map[string]*btClient{"a": a, "b": b} {
		m := c.next("events")
		evs := m["events"].([]any)
		if len(evs) != 1 {
			t.Fatalf("%s: expected 1 event, got %v", name, evs)
		}
		ev := evs[0].(map[string]any)
		if int64(ev["seq"].(float64)) != seq {
			t.Fatalf("%s: seq mismatch: %v", name, ev)
		}
		body, ok := ev["body"].(map[string]any)
		if !ok || body["kind"] != "cells" {
			t.Fatalf("%s: bad body: %v", name, ev)
		}
	}

	// concurrent writes to the same cell: both clients converge on the later seq
	seq2 := e.event(`{"kind":"cells","rid":7,"cells":{"1":"后写"}}`)
	for name, c := range map[string]*btClient{"a": a, "b": b} {
		m := c.next("events")
		last := m["events"].([]any)[0].(map[string]any)
		if int64(last["seq"].(float64)) != seq2 {
			t.Fatalf("%s: expected seq %d, got %v", name, seq2, last)
		}
		body, _ := last["body"].(map[string]any)
		if body["cells"].(map[string]any)["1"] != "后写" {
			t.Fatalf("%s: last write should win: %v", name, body)
		}
	}
}

func TestBtSyncReconnectReplay(t *testing.T) {
	e := newHubEnv(t)
	// events while nobody is connected
	seq1 := e.event(`{"kind":"record","op":"add","record":{"id":1}}`)
	seq2 := e.event(`{"kind":"record","op":"del","rid":1}`)

	// a client that saw seq1 reconnects and only gets the tail
	last := seq1
	c := dial(t, e.srv.URL, e.base, &last)
	defer c.close()
	m := c.next("events")
	evs := m["events"].([]any)
	if len(evs) != 1 || int64(evs[0].(map[string]any)["seq"].(float64)) != seq2 {
		t.Fatalf("replay should send only seq %d, got %v", seq2, evs)
	}

	// a fresh client (lastSeq 0) gets the whole log
	zero := int64(0)
	c2 := dial(t, e.srv.URL, e.base, &zero)
	defer c2.close()
	m2 := c2.next("events")
	if len(m2["events"].([]any)) != 2 {
		t.Fatalf("fresh replay: %v", m2)
	}
}
