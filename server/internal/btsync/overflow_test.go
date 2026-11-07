package btsync

import (
	"context"
	"testing"
)

func TestOverflowCancelsSlowConnection(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &conn{out: make(chan []byte, 1), cancel: cancel}
	if !c.send([]byte("first")) {
		t.Fatal("first frame was not queued")
	}
	if c.send([]byte("second")) {
		t.Fatal("overflow should refuse the frame")
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("overflow must cancel the connection so the client refreshes")
	}
}
