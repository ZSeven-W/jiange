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

func TestSlidesSyncMultiReplicaFanout(t *testing.T) {
	bus := store.NewMemoryRealtimeBus()
	hubA := &Hub{Bus: bus, PingInterval: time.Hour, SweepInterval: time.Hour}
	hubB := &Hub{Bus: bus, PingInterval: time.Hour, SweepInterval: time.Hour}

	ctx := context.Background()
	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	go func() { _ = hubA.Run(runCtx) }()
	go func() { _ = hubB.Run(runCtx) }()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && bus.SubscriberCount(RealtimeChannel) < 2 {
		time.Sleep(5 * time.Millisecond)
	}
	if got := bus.SubscriberCount(RealtimeChannel); got != 2 {
		t.Fatalf("expected 2 slides realtime subscribers, got %d", got)
	}

	const deckID int64 = 505
	srvA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hubA.Serve(w, r, deckID, store.User{ID: 1, Name: "Alice"}, func(context.Context) error { return nil })
	}))
	defer srvA.Close()
	srvB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := store.User{ID: 2, Name: "Bob"}
		if r.URL.Query().Get("u") == "3" {
			user = store.User{ID: 3, Name: "Carol"}
		}
		hubB.Serve(w, r, deckID, user, func(context.Context) error { return nil })
	}))
	defer srvB.Close()

	cAlice, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srvA.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cAlice.CloseNow()
	cBob, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srvB.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cBob.CloseNow()

	// Wait for both sockets' initial presence frames so hubA and hubB have
	// registered their local rooms before sending cross-replica events.
	_ = readUntilType(t, ctx, cAlice, "presence")
	_ = readUntilType(t, ctx, cBob, "presence")

	// 1. Cross-replica cursor presence: Alice on hubA -> Bob on hubB.
	if err := cAlice.Write(ctx, websocket.MessageText, []byte(`{"type":"cursor","pageId":42}`)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 12; i++ {
		m := readMsg(t, ctx, cBob)
		if m.Type == "presence" {
			foundAlice := false
			for _, col := range m.Collaborators {
				if col.UserID == 1 && col.Name == "Alice" && col.PageID == 42 {
					foundAlice = true
				}
			}
			if foundAlice {
				break
			}
		}
		if i == 11 {
			t.Fatal("Bob on hubB did not receive Alice's remote cursor presence")
		}
	}

	// 2. Cross-replica revision notification: hubA.Notify -> Bob on hubB.
	hubA.Notify(deckID, 1)
	revBob := readUntilType(t, ctx, cBob, "revision")
	if revBob.ActorID != 1 || revBob.Seq < 1 {
		t.Fatalf("unexpected remote revision on Bob: %+v", revBob)
	}

	// 3. Cross-replica live presenter sync: Alice starts presenting on hubA -> Bob on hubB receives presenter_sync.
	if err := cAlice.Write(ctx, websocket.MessageText, []byte(`{"type":"presenter_sync","active":true,"pageId":99,"animStep":3,"laserX":0.4,"laserY":0.6}`)); err != nil {
		t.Fatal(err)
	}
	presBob := readUntilType(t, ctx, cBob, "presenter_sync")
	if !presBob.Active || presBob.PresenterID != 1 || presBob.PresenterName != "Alice" || presBob.PageID != 99 || presBob.AnimStep != 3 {
		t.Fatalf("unexpected remote presenter_sync on Bob: %+v", presBob)
	}
	if presBob.LaserX == nil || *presBob.LaserX != 0.4 || presBob.LaserY == nil || *presBob.LaserY != 0.6 {
		t.Fatalf("unexpected remote laser coords on Bob: (%v, %v)", presBob.LaserX, presBob.LaserY)
	}

	// 4. Late-joining viewer Carol connects to hubB and immediately receives Alice's active presenter state.
	cCarol, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srvB.URL, "http")+"?u=3", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cCarol.CloseNow()
	presCarol := readUntilType(t, ctx, cCarol, "presenter_sync")
	if !presCarol.Active || presCarol.PresenterID != 1 || presCarol.PageID != 99 || presCarol.AnimStep != 3 {
		t.Fatalf("late joiner Carol on hubB missed active remote presenter: %+v", presCarol)
	}

	// 5. Alice disconnects from hubA -> Bob and Carol on hubB receive presenter stop AND Alice removed from presence.
	_ = cAlice.Close(websocket.StatusNormalClosure, "presenter disconnected")
	stopCarol := readUntilType(t, ctx, cCarol, "presenter_sync")
	if stopCarol.Active || stopCarol.PresenterID != 1 {
		t.Fatalf("Carol expected presenter stop on remote disconnect, got %+v", stopCarol)
	}
	var sawStopBob, sawAliceGoneBob bool
	for i := 0; i < 16 && !(sawStopBob && sawAliceGoneBob); i++ {
		m := readMsg(t, ctx, cBob)
		switch m.Type {
		case "presenter_sync":
			if !m.Active && m.PresenterID == 1 {
				sawStopBob = true
			}
		case "presence":
			hasAlice := false
			for _, col := range m.Collaborators {
				if col.UserID == 1 {
					hasAlice = true
				}
			}
			if !hasAlice {
				sawAliceGoneBob = true
			}
		}
	}
	if !sawStopBob || !sawAliceGoneBob {
		t.Fatalf("Bob did not observe both presenter stop and Alice leave (stop=%v gone=%v)", sawStopBob, sawAliceGoneBob)
	}
}
