package store

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"
)

func TestMemoryTitleReplayPageRejectsCorruptionAndDoesNotSkipLargeRows(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	owner, ws, err := m.CreateUser(ctx, "title-page-internal@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := m.CreateDoc(ctx, ws.ID, owner.ID, nil, "title", InitialDocOps("标题"))
	if err != nil {
		t.Fatal(err)
	}
	guard := RestoreGuard{UserID: owner.ID, SessionHash: []byte("title-page-internal-session")}
	if err = m.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	epoch, head, err := m.HeadVersion(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	d := m.doc(doc.ID)
	firstBytes, secondBytes := len(d.ops[0].Bytes), len(d.ops[1].Bytes)
	m.mu.Unlock()
	page, err := m.ReadTitleReplayPage(ctx, guard, doc.ID, epoch, head, 0, 3, firstBytes+secondBytes-1)
	if err != nil || len(page) != 1 || page[0].Seq != 1 {
		t.Fatalf("byte-limited page: %+v %v", page, err)
	}
	page, err = m.ReadTitleReplayPage(ctx, guard, doc.ID, epoch, head, 1, 3, secondBytes-1)
	if !errors.Is(err, ErrTitleReplayPageLimit) || len(page) != 0 {
		t.Fatalf("oversized row: %+v %v", page, err)
	}

	m.mu.Lock()
	d.ops[1].Seq = 99
	m.mu.Unlock()
	page, err = m.ReadTitleReplayPage(ctx, guard, doc.ID, epoch, head, 0, 3, 4096)
	if !errors.Is(err, ErrConflict) || len(page) != 0 {
		t.Fatalf("missing sequence leaked prefix: %+v %v", page, err)
	}
	m.mu.Lock()
	d.ops[1].Seq = 2
	saved := slices.Clone(d.ops[1].Bytes)
	d.ops[1].Bytes = []byte{0x4a, 1, 2}
	m.mu.Unlock()
	page, err = m.ReadTitleReplayPage(ctx, guard, doc.ID, epoch, head, 0, 3, 4096)
	if !errors.Is(err, ErrConflict) || len(page) != 0 {
		t.Fatalf("malformed row leaked prefix: %+v %v", page, err)
	}
	m.mu.Lock()
	d.ops[1].Bytes = saved
	m.mu.Unlock()
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	page, err = m.ReadTitleReplayPage(cancelled, guard, doc.ID, epoch, head, 0, 3, 4096)
	if !errors.Is(err, context.Canceled) || len(page) != 0 {
		t.Fatalf("cancelled: %+v %v", page, err)
	}
}
