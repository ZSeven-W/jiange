package store_test

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestValidateRealtimeChannelAndPayloadLimits(t *testing.T) {
	for _, valid := range []string{
		store.RealtimeChannelBt,
		store.RealtimeChannelSheet,
		store.RealtimeChannelSlides,
		"a",
		"ch_0123456789",
		strings.Repeat("a", 63),
	} {
		if err := store.ValidateRealtimeChannel(valid); err != nil {
			t.Fatalf("expected valid channel %q, got %v", valid, err)
		}
	}

	for _, invalid := range []string{
		"",
		"Uppercase",
		"1leading_digit",
		"_leading_underscore",
		"has-dash",
		"has space",
		"jiange_bt_events; DROP TABLE users;",
		strings.Repeat("a", 64),
	} {
		if err := store.ValidateRealtimeChannel(invalid); !errors.Is(err, store.ErrInvalidInput) {
			t.Fatalf("invalid channel %q expected ErrInvalidInput, got %v", invalid, err)
		}
	}

	bus := store.NewMemoryRealtimeBus()
	ctx := context.Background()

	if err := bus.PublishRealtime(ctx, "bad;sql", "hi"); !errors.Is(err, store.ErrInvalidInput) {
		t.Fatalf("publish bad channel want ErrInvalidInput, got %v", err)
	}
	if err := bus.ListenRealtime(ctx, "bad;sql", func(string) {}); !errors.Is(err, store.ErrInvalidInput) {
		t.Fatalf("listen bad channel want ErrInvalidInput, got %v", err)
	}
	if err := bus.ListenRealtime(ctx, store.RealtimeChannelBt, nil); !errors.Is(err, store.ErrInvalidInput) {
		t.Fatalf("listen nil callback want ErrInvalidInput, got %v", err)
	}

	maxOK := strings.Repeat("x", store.MaxRealtimePayloadBytes)
	if err := bus.PublishRealtime(ctx, store.RealtimeChannelBt, maxOK); err != nil {
		t.Fatalf("publish exact max bytes failed: %v", err)
	}
	tooBig := strings.Repeat("x", store.MaxRealtimePayloadBytes+1)
	if err := bus.PublishRealtime(ctx, store.RealtimeChannelBt, tooBig); !errors.Is(err, store.ErrRealtimePayloadTooLarge) {
		t.Fatalf("publish oversized payload want ErrRealtimePayloadTooLarge, got %v", err)
	}
}

func TestMemoryRealtimeBusFanoutIsolationAndCleanup(t *testing.T) {
	memA := store.NewMemory()
	memB := store.NewMemory()

	ctxA, cancelA := context.WithCancel(context.Background())
	defer cancelA()
	ctxB, cancelB := context.WithCancel(context.Background())
	defer cancelB()

	got1 := make(chan string, 4)
	got2 := make(chan string, 4)
	gotOtherChan := make(chan string, 4)
	gotOtherMem := make(chan string, 4)

	done1 := make(chan error, 1)
	go func() {
		done1 <- memA.ListenRealtime(ctxA, store.RealtimeChannelBt, func(p string) { got1 <- p })
	}()
	done2 := make(chan error, 1)
	go func() {
		done2 <- memA.ListenRealtime(ctxB, store.RealtimeChannelBt, func(p string) { got2 <- p })
	}()
	go func() {
		_ = memA.ListenRealtime(ctxA, store.RealtimeChannelSheet, func(p string) { gotOtherChan <- p })
	}()
	go func() {
		_ = memB.ListenRealtime(ctxA, store.RealtimeChannelBt, func(p string) { gotOtherMem <- p })
	}()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if memA.RealtimeSubscriberCount(store.RealtimeChannelBt) == 2 &&
			memA.RealtimeSubscriberCount(store.RealtimeChannelSheet) == 1 &&
			memB.RealtimeSubscriberCount(store.RealtimeChannelBt) == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if memA.RealtimeSubscriberCount(store.RealtimeChannelBt) != 2 {
		t.Fatalf("expected 2 bt subscribers on memA, got %d", memA.RealtimeSubscriberCount(store.RealtimeChannelBt))
	}

	if err := memA.PublishRealtime(context.Background(), store.RealtimeChannelBt, `{"origin":"a","baseId":42}`); err != nil {
		t.Fatal(err)
	}

	for name, ch := range map[string]chan string{"sub1": got1, "sub2": got2} {
		select {
		case p := <-ch:
			if p != `{"origin":"a","baseId":42}` {
				t.Fatalf("%s unexpected payload: %q", name, p)
			}
		case <-time.After(time.Second):
			t.Fatalf("%s timed out waiting for payload", name)
		}
	}
	select {
	case p := <-gotOtherChan:
		t.Fatalf("sheet listener received bt payload: %q", p)
	case p := <-gotOtherMem:
		t.Fatalf("isolated memB received memA payload: %q", p)
	case <-time.After(30 * time.Millisecond):
	}

	// Cancelling ctxB cleanly unsubscribes sub2 while sub1 keeps receiving.
	cancelB()
	select {
	case err := <-done2:
		if err != nil {
			t.Fatalf("listen2 exit err: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("listen2 did not exit on cancel")
	}
	if memA.RealtimeSubscriberCount(store.RealtimeChannelBt) != 1 {
		t.Fatalf("expected 1 bt subscriber after cancelB, got %d", memA.RealtimeSubscriberCount(store.RealtimeChannelBt))
	}

	if err := memA.PublishRealtime(context.Background(), store.RealtimeChannelBt, `{"origin":"a","baseId":99}`); err != nil {
		t.Fatal(err)
	}
	select {
	case p := <-got1:
		if p != `{"origin":"a","baseId":99}` {
			t.Fatalf("sub1 second payload mismatch: %q", p)
		}
	case <-time.After(time.Second):
		t.Fatal("sub1 missed second payload")
	}

	cancelA()
	select {
	case err := <-done1:
		if err != nil {
			t.Fatalf("listen1 exit err: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("listen1 did not exit on cancel")
	}
}

func TestRealtimeBusPostgres(t *testing.T) {
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

	listenCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	got1 := make(chan string, 4)
	got2 := make(chan string, 4)
	done1 := make(chan error, 1)
	done2 := make(chan error, 1)

	go func() {
		done1 <- pg.ListenRealtime(listenCtx, store.RealtimeChannelBt, func(p string) { got1 <- p })
	}()
	go func() {
		done2 <- pg.ListenRealtime(listenCtx, store.RealtimeChannelBt, func(p string) { got2 <- p })
	}()

	// Wait briefly for both Postgres LISTEN connections to establish, retrying a probe notify.
	deadline := time.Now().Add(5 * time.Second)
	var seen1, seen2 bool
	for time.Now().Before(deadline) && !(seen1 && seen2) {
		if err := pg.PublishRealtime(ctx, store.RealtimeChannelBt, `{"origin":"pg","baseId":7}`); err != nil {
			t.Fatal(err)
		}
		select {
		case p := <-got1:
			if p == `{"origin":"pg","baseId":7}` {
				seen1 = true
			}
		case <-time.After(100 * time.Millisecond):
		}
		select {
		case p := <-got2:
			if p == `{"origin":"pg","baseId":7}` {
				seen2 = true
			}
		case <-time.After(100 * time.Millisecond):
		}
	}
	if !seen1 || !seen2 {
		t.Fatalf("expected both postgres listeners to receive notify, seen1=%v seen2=%v", seen1, seen2)
	}

	cancel()
	for i, ch := range []chan error{done1, done2} {
		select {
		case err := <-ch:
			if err != nil {
				t.Fatalf("listener %d returned err: %v", i+1, err)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("listener %d did not stop after cancel", i+1)
		}
	}
}
