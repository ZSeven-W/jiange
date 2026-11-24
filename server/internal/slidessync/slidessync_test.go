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
	PresenterID   int64          `json:"presenterId"`
	PresenterName string         `json:"presenterName"`
	Active        bool           `json:"active"`
	PageID        int64          `json:"pageId"`
	AnimStep      int            `json:"animStep"`
	LaserX        *float64       `json:"laserX"`
	LaserY        *float64       `json:"laserY"`
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

func readUntilType(t *testing.T, ctx context.Context, c *websocket.Conn, wantType string) wsMsg {
	t.Helper()
	for i := 0; i < 8; i++ {
		m := readMsg(t, ctx, c)
		if m.Type == wantType {
			return m
		}
	}
	t.Fatalf("did not receive message of type %q", wantType)
	return wsMsg{}
}

func TestPresenterSyncBroadcastLateJoinAndDisconnect(t *testing.T) {
	hub := &Hub{
		PingInterval:  time.Second,
		SweepInterval: time.Second,
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("u") {
		case "1":
			hub.Serve(w, r, 77, store.User{ID: 1, Name: "Alice"}, func(context.Context) error { return nil })
		case "2":
			hub.Serve(w, r, 77, store.User{ID: 2, Name: "Bob"}, func(context.Context) error { return nil })
		case "3":
			hub.Serve(w, r, 77, store.User{ID: 3, Name: "Carol"}, func(context.Context) error { return nil })
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
	_ = readUntilType(t, ctx, c1, "presence")

	c2, _, err := websocket.Dial(ctx, wsURL+"?u=2", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.CloseNow()
	_ = readUntilType(t, ctx, c1, "presence")
	_ = readUntilType(t, ctx, c2, "presence")

	// 1. Presenter broadcasts active slide + animStep + out-of-range laser coords -> clamped to [0, 1].
	if err := c1.Write(ctx, websocket.MessageText, []byte(`{"type":"presenter_sync","active":true,"pageId":123,"animStep":2,"laserX":1.5,"laserY":-0.2}`)); err != nil {
		t.Fatal(err)
	}
	syncC2 := readUntilType(t, ctx, c2, "presenter_sync")
	if !syncC2.Active || syncC2.PresenterID != 1 || syncC2.PresenterName != "Alice" || syncC2.PageID != 123 || syncC2.AnimStep != 2 {
		t.Fatalf("unexpected presenter_sync on c2: %+v", syncC2)
	}
	if syncC2.LaserX == nil || *syncC2.LaserX != 1 || syncC2.LaserY == nil || *syncC2.LaserY != 0 {
		t.Fatalf("expected laser clamped to (1, 0), got (%v, %v)", syncC2.LaserX, syncC2.LaserY)
	}
	_ = readUntilType(t, ctx, c1, "presenter_sync")

	// 2. Late-joining viewer (c3) immediately receives current active presenter_sync on join!
	c3, _, err := websocket.Dial(ctx, wsURL+"?u=3", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c3.CloseNow()
	p3 := readMsg(t, ctx, c3)
	if p3.Type != "presence" {
		t.Fatalf("expected initial presence on c3, got %+v", p3)
	}
	joinSync := readMsg(t, ctx, c3)
	if joinSync.Type != "presenter_sync" || !joinSync.Active || joinSync.PresenterID != 1 || joinSync.PageID != 123 || joinSync.AnimStep != 2 {
		t.Fatalf("expected live presenter_sync immediately on late join, got %+v", joinSync)
	}

	// 3. Presenter changes page without laser -> laser coords omitted.
	if err := c1.Write(ctx, websocket.MessageText, []byte(`{"type":"presenter_sync","active":true,"pageId":456,"animStep":0}`)); err != nil {
		t.Fatal(err)
	}
	stepSync := readUntilType(t, ctx, c3, "presenter_sync")
	if !stepSync.Active || stepSync.PageID != 456 || stepSync.AnimStep != 0 || stepSync.LaserX != nil || stepSync.LaserY != nil {
		t.Fatalf("expected page 456 with nil laser, got %+v", stepSync)
	}
	_ = readUntilType(t, ctx, c2, "presenter_sync")

	// 4. Presenter disconnects abruptly -> remaining peers automatically receive active=false!
	_ = c1.Close(websocket.StatusNormalClosure, "presenter left")
	endC2 := readUntilType(t, ctx, c2, "presenter_sync")
	endC3 := readUntilType(t, ctx, c3, "presenter_sync")
	if endC2.Active || endC2.PresenterID != 1 {
		t.Fatalf("c2 should receive presenter ended on disconnect, got %+v", endC2)
	}
	if endC3.Active || endC3.PresenterID != 1 {
		t.Fatalf("c3 should receive presenter ended on disconnect, got %+v", endC3)
	}

	// 5. Explicit active:false also clears room presenter state.
	if err := c2.Write(ctx, websocket.MessageText, []byte(`{"type":"presenter_sync","active":true,"pageId":9,"animStep":1}`)); err != nil {
		t.Fatal(err)
	}
	startC3 := readUntilType(t, ctx, c3, "presenter_sync")
	if !startC3.Active || startC3.PresenterID != 2 || startC3.PageID != 9 {
		t.Fatalf("expected Bob presenting page 9, got %+v", startC3)
	}
	if err := c2.Write(ctx, websocket.MessageText, []byte(`{"type":"presenter_sync","active":false}`)); err != nil {
		t.Fatal(err)
	}
	stopC3 := readUntilType(t, ctx, c3, "presenter_sync")
	if stopC3.Active || stopC3.PresenterID != 2 {
		t.Fatalf("expected Bob stop presenting, got %+v", stopC3)
	}
}
