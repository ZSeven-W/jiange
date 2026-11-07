package btsync

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

// Embed the interface so only the calls exercised by these tests need a stub.
type slowStore struct {
	store.DocStore
	headStarted chan struct{}
	eventStart  chan struct{}
}

func (s *slowStore) BtHead(ctx context.Context, base int64) (int64, error) {
	if base == 1 {
		close(s.headStarted)
		<-ctx.Done()
		return 0, ctx.Err()
	}
	return 7, nil
}

func (s *slowStore) BtEventsAfter(ctx context.Context, _, _ int64, _ int) ([]store.BtEvent, error) {
	select {
	case s.eventStart <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

func TestSlowHeadDoesNotBlockOtherRooms(t *testing.T) {
	s := &slowStore{headStarted: make(chan struct{}), eventStart: make(chan struct{}, 1)}
	h := &Hub{Store: s, StoreTimeout: time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	slowDone := make(chan error, 1)
	go func() { _, err := h.room(ctx, 1); slowDone <- err }()
	select {
	case <-s.headStarted:
	case <-time.After(time.Second):
		t.Fatal("slow head query did not start")
	}
	fastDone := make(chan *room, 1)
	go func() {
		r, err := h.room(context.Background(), 2)
		if err == nil {
			fastDone <- r
		}
	}()
	select {
	case r := <-fastDone:
		if r.head != 7 {
			t.Fatalf("head = %d, want 7", r.head)
		}
		h.release(r)
	case <-time.After(300 * time.Millisecond):
		t.Fatal("unrelated room blocked on another Base's head query")
	}
	cancel()
	select {
	case err := <-slowDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("slow room error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled room query did not return")
	}
}

func TestNotifyCoalescesAndBoundsSlowStore(t *testing.T) {
	s := &slowStore{headStarted: make(chan struct{}), eventStart: make(chan struct{}, 1)}
	h := &Hub{Store: s, StoreTimeout: 40 * time.Millisecond}
	r, err := h.room(context.Background(), 2)
	if err != nil {
		t.Fatal(err)
	}
	defer h.release(r)
	h.Notify(2)
	select {
	case <-s.eventStart:
	case <-time.After(time.Second):
		t.Fatal("notification did not start catch-up")
	}
	done := make(chan struct{})
	go func() {
		for range 100 {
			h.Notify(2)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(300 * time.Millisecond):
		t.Fatal("notifications waited for slow storage")
	}
	// At least one of the notifications during the first query must schedule a
	// follow-up; both calls are bounded by StoreTimeout, even with no response.
	select {
	case <-s.eventStart:
	case <-time.After(time.Second):
		t.Fatal("coalesced notification was not retried after timeout")
	}
}

func TestReplayTimeoutCancelsConnection(t *testing.T) {
	s := &slowStore{headStarted: make(chan struct{}), eventStart: make(chan struct{}, 1)}
	h := &Hub{Store: s, StoreTimeout: 30 * time.Millisecond}
	r := &room{hub: h, id: 2, head: 7}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &conn{out: make(chan []byte, 1), cancel: cancel}
	done := make(chan struct{})
	go func() { r.replay(ctx, c, 0); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("replay did not honor storage timeout")
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("incomplete replay must close the connection")
	}
}

func TestReplayStopsWhenConnectionIsCanceled(t *testing.T) {
	s := &slowStore{headStarted: make(chan struct{}), eventStart: make(chan struct{}, 1)}
	h := &Hub{Store: s, StoreTimeout: time.Second}
	r := &room{hub: h, id: 2, head: 7}
	ctx, cancel := context.WithCancel(context.Background())
	c := &conn{out: make(chan []byte, 1), cancel: cancel}
	done := make(chan struct{})
	go func() { r.replay(ctx, c, 0); close(done) }()
	select {
	case <-s.eventStart:
	case <-time.After(time.Second):
		t.Fatal("replay query did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(300 * time.Millisecond):
		t.Fatal("replay query outlived canceled connection")
	}
}

func TestCanceledReplayDoesNotWaitForRoomLock(t *testing.T) {
	r := &room{hub: &Hub{}, id: 1, head: 1}
	r.mu.Lock()
	defer r.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	c := &conn{out: make(chan []byte, 1), cancel: cancel}
	done := make(chan struct{})
	go func() { r.replay(ctx, c, 0); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(300 * time.Millisecond):
		t.Fatal("canceled replay remained queued for the room lock")
	}
}

func TestReplayTimeoutWhileWaitingClosesConnection(t *testing.T) {
	r := &room{hub: &Hub{ReplayTimeout: 30 * time.Millisecond}, id: 1, head: 1}
	r.mu.Lock()
	defer r.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &conn{out: make(chan []byte, 1), cancel: cancel}
	done := make(chan struct{})
	go func() { r.replay(ctx, c, 0); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("replay did not time out while waiting for the room")
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("timed out replay must close the connection")
	}
}

func TestJoinTimeoutDoesNotRegisterConnection(t *testing.T) {
	r := &room{hub: &Hub{ReplayTimeout: 30 * time.Millisecond}, id: 1, conns: map[*conn]struct{}{}}
	r.mu.Lock()
	defer r.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &conn{out: make(chan []byte, 1), cancel: cancel}
	done := make(chan bool, 1)
	go func() { done <- r.join(ctx, c) }()
	select {
	case joined := <-done:
		if joined {
			t.Fatal("timed out connection was registered")
		}
	case <-time.After(time.Second):
		t.Fatal("join did not honor its timeout")
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("timed out join must close the connection")
	}
	if len(r.conns) != 0 {
		t.Fatal("timed out join changed room membership")
	}
}

type sharedHeadStore struct {
	store.DocStore
	calls atomic.Int32
	start chan struct{}
	allow chan struct{}
}

func (s *sharedHeadStore) BtHead(ctx context.Context, _ int64) (int64, error) {
	if s.calls.Add(1) == 1 {
		close(s.start)
	}
	select {
	case <-s.allow:
		return 9, nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

func TestConcurrentRoomInitializationSharesHeadRead(t *testing.T) {
	s := &sharedHeadStore{start: make(chan struct{}), allow: make(chan struct{})}
	h := &Hub{Store: s, StoreTimeout: time.Second}
	const clients = 24
	ready := make(chan struct{}, clients)
	rooms := make(chan *room, clients)
	for range clients {
		go func() {
			ready <- struct{}{}
			r, err := h.room(context.Background(), 42)
			if err == nil {
				rooms <- r
			}
		}()
	}
	for range clients {
		<-ready
	}
	select {
	case <-s.start:
	case <-time.After(time.Second):
		t.Fatal("head query did not start")
	}
	close(s.allow)
	var first *room
	for range clients {
		select {
		case r := <-rooms:
			if first == nil {
				first = r
			} else if r != first {
				t.Fatal("connections received different rooms")
			}
		case <-time.After(time.Second):
			t.Fatal("room initialization did not finish")
		}
	}
	if n := s.calls.Load(); n != 1 {
		t.Fatalf("head reads = %d, want 1", n)
	}
	for range clients {
		h.release(first)
	}
}

func TestRoomHeadReadSurvivesOneWaiterDisconnect(t *testing.T) {
	s := &sharedHeadStore{start: make(chan struct{}), allow: make(chan struct{})}
	h := &Hub{Store: s, StoreTimeout: time.Second}
	firstCtx, firstCancel := context.WithCancel(context.Background())
	firstDone := make(chan error, 1)
	go func() { _, err := h.room(firstCtx, 42); firstDone <- err }()
	select {
	case <-s.start:
	case <-time.After(time.Second):
		t.Fatal("head query did not start")
	}
	secondDone := make(chan *room, 1)
	go func() {
		r, err := h.room(context.Background(), 42)
		if err == nil {
			secondDone <- r
		}
	}()
	deadline := time.Now().Add(time.Second)
	for {
		h.mu.Lock()
		waiters := h.initializing[42].waiters
		h.mu.Unlock()
		if waiters == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("second connection did not join the shared head read")
		}
		time.Sleep(time.Millisecond)
	}
	firstCancel()
	select {
	case err := <-firstDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("first error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("first caller did not stop")
	}
	close(s.allow)
	select {
	case r := <-secondDone:
		h.release(r)
	case <-time.After(time.Second):
		t.Fatal("other connection lost its shared head read")
	}
	if n := s.calls.Load(); n != 1 {
		t.Fatalf("head reads = %d, want 1", n)
	}
}

type fullPageStore struct {
	store.DocStore
	calls int
}

func (s *fullPageStore) BtEventsAfter(_ context.Context, _, after int64, limit int) ([]store.BtEvent, error) {
	s.calls++
	events := make([]store.BtEvent, limit)
	for i := range events {
		events[i].Seq = after + int64(i) + 1
	}
	return events, nil
}

func TestCatchUpYieldsAfterBoundedBatches(t *testing.T) {
	s := &fullPageStore{}
	r := &room{hub: &Hub{Store: s}, id: 1, wake: make(chan struct{}, 1)}
	r.catchUp()
	if s.calls != catchUpBatches {
		t.Fatalf("batches = %d, want %d", s.calls, catchUpBatches)
	}
	if r.head != int64(catchUpBatches*catchUpChunk) {
		t.Fatalf("head = %d", r.head)
	}
	select {
	case <-r.wake:
	default:
		t.Fatal("full batch budget must schedule another pass")
	}
}
