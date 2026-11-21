package sync

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	gosync "sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/sdk/go/storage"
)

type errConn struct {
	closed bool
}

func (e *errConn) Send([]byte) error { return errors.New("broken pipe") }
func (e *errConn) Close() error {
	e.closed = true
	return nil
}

func TestChanConn(t *testing.T) {
	c := NewChanConn(0) // defaults to 64
	if err := c.Send([]byte("hi")); err != nil {
		t.Fatalf("send failed: %v", err)
	}
	msg := <-c.Events()
	if string(msg) != "hi" {
		t.Fatalf("unexpected msg: %q", msg)
	}

	small := NewChanConn(1)
	if err := small.Send([]byte("a")); err != nil {
		t.Fatal(err)
	}
	if err := small.Send([]byte("b")); !errors.Is(err, ErrSendBufferFull) {
		t.Fatalf("expected ErrSendBufferFull, got %v", err)
	}
	if err := small.Close(); err != nil {
		t.Fatal(err)
	}
	if err := small.Close(); err != nil {
		t.Fatal(err)
	}
	if err := small.Send([]byte("c")); !errors.Is(err, ErrConnClosed) {
		t.Fatalf("expected ErrConnClosed, got %v", err)
	}
}

func TestRoomHubCoreAndTTL(t *testing.T) {
	now := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	var mu gosync.Mutex
	clock := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	advance := func(d time.Duration) {
		mu.Lock()
		now = now.Add(d)
		mu.Unlock()
	}

	hub := NewRoomHub(WithMaxHistory(2), WithPresenceTTL(10*time.Second), WithClock(clock))

	// Empty room queries
	ops, latest := hub.PullSince("r1", 0)
	if len(ops) != 0 || latest != 0 {
		t.Fatalf("expected empty room, got %v %d", ops, latest)
	}
	snap := hub.Snapshot("r1")
	if snap.Seq != 0 || len(snap.Ops) != 0 || len(snap.Presence) != 0 {
		t.Fatalf("unexpected empty snapshot: %+v", snap)
	}
	if pres := hub.ListPresence("r1"); len(pres) != 0 {
		t.Fatalf("expected empty presence, got %v", pres)
	}

	// Subscribe good conn & failing conn
	good := NewChanConn(8)
	bad := &errConn{}
	subGood := hub.Subscribe("r1", good)
	hub.Subscribe("r1", bad)

	// Append 3 ops -> history bounded to 2, failing subscriber evicted & closed
	op1, err := hub.Append("r1", 0, "c1", "patch", json.RawMessage(`{"a":1}`))
	if err != nil || op1.Seq != 1 {
		t.Fatalf("op1 failed: %+v err=%v", op1, err)
	}
	if !bad.closed {
		t.Fatal("expected failing subscriber to be closed on broadcast error")
	}
	if _, err := hub.Append("r1", 0, "c2", "patch", nil); !errors.Is(err, ErrSeqConflict) {
		t.Fatalf("expected ErrSeqConflict, got %v", err)
	}
	if _, err := hub.Append("r1", 1, "c1", "patch", json.RawMessage(`{"a":2}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Append("r1", 2, "c1", "patch", json.RawMessage(`{"a":3}`)); err != nil {
		t.Fatal(err)
	}

	// Verify bounded history retains seq 2 & 3
	pulled, latest := hub.PullSince("r1", 1)
	if latest != 3 || len(pulled) != 2 || pulled[0].Seq != 2 || pulled[1].Seq != 3 {
		t.Fatalf("unexpected pull: latest=%d ops=%+v", latest, pulled)
	}

	// Drain 3 op frames received by good conn
	for i := 0; i < 3; i++ {
		raw := <-good.Events()
		var frame EventFrame
		if err := json.Unmarshal(raw, &frame); err != nil || frame.Event != "op" {
			t.Fatalf("unexpected frame %d: %s err=%v", i, raw, err)
		}
	}

	// Presence updates, sorting, and TTL eviction
	hub.UpdatePresence("r1", Presence{ClientID: "c2", UserName: "Bob", Cursor: map[string]any{"x": 10}})
	advance(5 * time.Second)
	hub.UpdatePresence("r1", Presence{ClientID: "c1", UserName: "Alice"})

	active := hub.ListPresence("r1")
	if len(active) != 2 || active[0].ClientID != "c1" || active[1].ClientID != "c2" {
		t.Fatalf("unexpected active presence: %+v", active)
	}
	// Snapshot on room with ops & presence
	snap = hub.Snapshot("r1")
	if snap.Seq != 3 || len(snap.Ops) != 2 || len(snap.Presence) != 2 {
		t.Fatalf("unexpected snapshot: %+v", snap)
	}

	// Snapshot on room created via presence only (rm.ops == nil branch)
	hub.UpdatePresence("r-pres-only", Presence{ClientID: "c9"})
	snapPres := hub.Snapshot("r-pres-only")
	if len(snapPres.Ops) != 0 || len(snapPres.Presence) != 1 {
		t.Fatalf("unexpected presence-only snapshot: %+v", snapPres)
	}

	// Advance 6 more seconds -> c2 (11s old) evicted, c1 (6s old) remains
	advance(6 * time.Second)
	active = hub.ListPresence("r1")
	if len(active) != 1 || active[0].ClientID != "c1" {
		t.Fatalf("expected c2 evicted, got %+v", active)
	}

	hub.Unsubscribe("r1", subGood)
	// Unsubscribe non-existent room/sub is safe no-op
	hub.Unsubscribe("unknown", "sub-999")
}

func TestHTTPHandler(t *testing.T) {
	hub := NewRoomHub()
	auth := storage.NewBearerTokenAuth(map[string]storage.Principal{
		"secret": {ID: "u1", Roles: []string{"editor"}},
	})
	h := NewHandler(hub, WithAuth(auth, storage.NewRoleAuthorizer(nil)))

	reqWithAuth := func(method, target string, body string) *http.Request {
		r := httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer secret")
		return r
	}

	// Unauthorized request blocked
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/rooms/r1/ops", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}

	// POST /ops validation errors
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, reqWithAuth(http.MethodPost, "/rooms/r1/ops", "{bad"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on bad json, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, reqWithAuth(http.MethodPost, "/rooms/r1/ops", `{"baseSeq":0}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on missing clientId, got %d", rec.Code)
	}

	// POST /ops success & conflict
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, reqWithAuth(http.MethodPost, "/rooms/r1/ops", `{"baseSeq":0,"clientId":"c1","type":"setCell","payload":{"a1":"A1"}}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, reqWithAuth(http.MethodPost, "/rooms/r1/ops", `{"baseSeq":0,"clientId":"c2","type":"setCell"}`))
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", rec.Code)
	}

	// GET /ops valid & invalid after param
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, reqWithAuth(http.MethodGet, "/rooms/r1/ops?after=notanint", ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, reqWithAuth(http.MethodGet, "/rooms/r1/ops?after=0", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"latestSeq":1`) {
		t.Fatalf("unexpected GET /ops: %d %s", rec.Code, rec.Body.String())
	}

	// POST /presence & GET /presence
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, reqWithAuth(http.MethodPost, "/rooms/r1/presence", "{bad"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, reqWithAuth(http.MethodPost, "/rooms/r1/presence", `{}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on missing clientId, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, reqWithAuth(http.MethodPost, "/rooms/r1/presence", `{"clientId":"c1","userName":"Alice","color":"#3370ff"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, reqWithAuth(http.MethodGet, "/rooms/r1/presence", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Alice") {
		t.Fatalf("unexpected presence response: %d %s", rec.Code, rec.Body.String())
	}

	// SSE stream test: receive snapshot, receive live event, cancel context
	srv := httptest.NewServer(NewHandler(hub))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/rooms/r1/events", nil)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("SSE connect failed: %v", err)
	}
	defer resp.Body.Close()

	reader := bufio.NewReader(resp.Body)
	line1, err := reader.ReadString('\n')
	if err != nil || !strings.HasPrefix(line1, "event: snapshot") {
		t.Fatalf("expected snapshot event, got %q err=%v", line1, err)
	}
	_, _ = reader.ReadString('\n') // data: ...
	_, _ = reader.ReadString('\n') // blank line

	// Trigger a live op event
	if _, err := hub.Append("r1", 1, "c2", "edit", json.RawMessage(`{"x":1}`)); err != nil {
		t.Fatal(err)
	}
	msgEvent, err := reader.ReadString('\n')
	if err != nil || !strings.HasPrefix(msgEvent, "event: message") {
		t.Fatalf("expected message event, got %q err=%v", msgEvent, err)
	}
	cancel()

	// Also test SSE exiting cleanly when hub forcibly closes subscriber channel (e.g. Unsubscribe)
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	rec2 := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		r := httptest.NewRequest(http.MethodGet, "/rooms/r-close/events", nil).WithContext(ctx2)
		NewHandler(hub).ServeHTTP(rec2, r)
	}()

	// Wait until subscriber registers, then close it via hub.Unsubscribe
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		hub.mu.RLock()
		rm := hub.rooms["r-close"]
		var subID string
		if rm != nil {
			for id := range rm.subs {
				subID = id
				break
			}
		}
		hub.mu.RUnlock()
		if subID != "" {
			hub.Unsubscribe("r-close", subID)
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("SSE handler did not exit after unsubscribe")
	}
	if !bytes.Contains(rec2.Body.Bytes(), []byte("event: snapshot")) {
		t.Fatalf("expected snapshot in rec2: %s", rec2.Body.String())
	}
}
