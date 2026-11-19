package slidessync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/coder/websocket"
)

type wsMsg struct {
	Type          string         `json:"type"`
	Seq           int64          `json:"seq"`
	ActorID       int64          `json:"actorId"`
	Collaborators []Collaborator `json:"collaborators"`
}

func readMsg(t *testing.T, ctx context.Context, c *websocket.Conn) wsMsg {
	t.Helper()
	rctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	_, data, err := c.Read(rctx)
	if err != nil {
		t.Fatalf("ws read: %v", err)
	}
	var m wsMsg
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal %s: %v", data, err)
	}
	return m
}

func TestHubPresenceCursorRevisionAndRevocation(t *testing.T) {
	hub := &Hub{
		PingInterval:  time.Second,
		SweepInterval: 40 * time.Millisecond,
	}
	var allowSecond atomic.Bool
	allowSecond.Store(true)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("u") {
		case "1":
			hub.Serve(w, r, 10, store.User{ID: 1, Name: "Alice"}, func(context.Context) error { return nil })
		case "2":
			hub.Serve(w, r, 10, store.User{ID: 2, Name: "Bob"}, func(context.Context) error {
				if !allowSecond.Load() {
					return store.ErrNotFound
				}
				return nil
			})
		}
	}))
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http")
	ctx := context.Background()
	c1, _, err := websocket.Dial(ctx, wsURL+"?u=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c1.CloseNow()

	m := readMsg(t, ctx, c1)
	if m.Type != "presence" || len(m.Collaborators) != 1 || m.Collaborators[0].UserID != 1 {
		t.Fatalf("initial presence: %+v", m)
	}

	c2, _, err := websocket.Dial(ctx, wsURL+"?u=2", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.CloseNow()

	// Both clients should see 2 collaborators sorted by UserID.
	m1 := readMsg(t, ctx, c1)
	m2 := readMsg(t, ctx, c2)
	if m1.Type != "presence" || len(m1.Collaborators) != 2 || m1.Collaborators[0].UserID != 1 || m1.Collaborators[1].UserID != 2 {
		t.Fatalf("c1 presence after join: %+v", m1)
	}
	if m2.Type != "presence" || len(m2.Collaborators) != 2 {
		t.Fatalf("c2 presence after join: %+v", m2)
	}

	// Send cursor update from c1 -> c2 should receive pageId=42.
	if err := c1.Write(ctx, websocket.MessageText, []byte(`{"type":"cursor","pageId":42}`)); err != nil {
		t.Fatal(err)
	}
	cur := readMsg(t, ctx, c2)
	if cur.Type != "presence" || len(cur.Collaborators) != 2 || cur.Collaborators[0].PageID != 42 {
		t.Fatalf("c2 cursor presence: %+v", cur)
	}
	_ = readMsg(t, ctx, c1) // consume c1's own presence echo

	// Notify broadcasts revision to both clients.
	hub.Notify(10, 1)
	rev1 := readMsg(t, ctx, c1)
	rev2 := readMsg(t, ctx, c2)
	if rev1.Type != "revision" || rev1.Seq != 1 || rev1.ActorID != 1 {
		t.Fatalf("c1 revision: %+v", rev1)
	}
	if rev2.Type != "revision" || rev2.Seq != 1 || rev2.ActorID != 1 {
		t.Fatalf("c2 revision: %+v", rev2)
	}

	// Revoke c2 access -> c2 must be closed with StatusPolicyViolation.
	allowSecond.Store(false)
	rctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, _, err = c2.Read(rctx)
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("expected StatusPolicyViolation on revoke, got err=%v status=%v", err, websocket.CloseStatus(err))
	}

	// c1 should see presence shrink back to 1.
	left := readMsg(t, ctx, c1)
	if left.Type != "presence" || len(left.Collaborators) != 1 || left.Collaborators[0].UserID != 1 {
		t.Fatalf("presence after c2 revoked: %+v", left)
	}

	_ = c1.Close(websocket.StatusNormalClosure, "done")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if hub.Rooms() == 0 {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatalf("expected hub rooms to drain to 0, got %d", hub.Rooms())
}
