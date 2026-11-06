package store_test

import (
	"context"
	"sync"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestMemoryLinkGrantDoesNotOverrideWorkspaceRole(t *testing.T) {
	ctx := context.Background()
	s := store.NewMemory()
	owner, ws, _ := s.CreateUser(ctx, "owner@memory.test", "Owner", "h")
	member, _, _ := s.CreateUser(ctx, "member@memory.test", "Member", "h")
	s.AddMember(ws.ID, member.ID)
	doc, _ := s.CreateDoc(ctx, ws.ID, owner.ID, nil, "doc", nil)
	child, _ := s.CreateDoc(ctx, ws.ID, owner.ID, &doc.ID, "child", nil)
	checkMemberExplicitGrant(t, s, member.ID, doc.ID, child.ID)
	if err := s.SetLink(ctx, doc.ID, store.Link{Role: "view", Token: "member-link"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.JoinLink(ctx, "member-link", member.ID); err != nil {
		t.Fatal(err)
	}
	if got, err := s.GetDoc(ctx, member.ID, doc.ID); err != nil || got.Role != "edit" {
		t.Fatalf("workspace role lost: %+v %v", got, err)
	}
	if err := s.SetLink(ctx, doc.ID, store.Link{Role: "none", Token: "member-link"}); err != nil {
		t.Fatal(err)
	}
	if got, err := s.GetDoc(ctx, member.ID, doc.ID); err != nil || got.Role != "edit" {
		t.Fatalf("workspace role lost after close: %+v %v", got, err)
	}
}

func checkMemberExplicitGrant(t *testing.T, s store.Store, member, doc, child int64) {
	t.Helper()
	ctx := context.Background()
	if got, err := s.GetDoc(ctx, member, child); err != nil || got.Role != "edit" {
		t.Fatalf("workspace member baseline: %+v %v", got, err)
	}
	if err := s.SetShare(ctx, doc, member, "manage"); err != nil {
		t.Fatal(err)
	}
	if got, err := s.GetDoc(ctx, member, doc); err != nil || got.Role != "manage" {
		t.Fatalf("direct manage must exceed workspace edit: %+v %v", got, err)
	}
	if got, err := s.GetDoc(ctx, member, child); err != nil || got.Role != "manage" {
		t.Fatalf("inherited manage must exceed workspace edit: %+v %v", got, err)
	}
	if err := s.SetShare(ctx, doc, member, ""); err != nil {
		t.Fatal(err)
	}
	if got, err := s.GetDoc(ctx, member, child); err != nil || got.Role != "edit" {
		t.Fatalf("revoking direct grant must retain membership: %+v %v", got, err)
	}
}

// A link join and close can happen in either order, but after both finish the
// closed link must never leave a live grant. Exercise the same invariant in
// memory and Postgres to cover the lock/transaction implementations.
func checkConcurrentLinkClose(t *testing.T, s store.Store, owner, guest, doc int64) {
	t.Helper()
	ctx := context.Background()
	for i := 0; i < 30; i++ {
		if err := s.SetLink(ctx, doc, store.Link{Role: "edit", Token: "concurrent-link"}); err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		var joinErr, closeErr error
		go func() { defer wg.Done(); <-start; _, joinErr = s.JoinLink(ctx, "concurrent-link", guest) }()
		go func() {
			defer wg.Done()
			<-start
			closeErr = s.SetLink(ctx, doc, store.Link{Role: "none", Token: "concurrent-link"})
		}()
		close(start)
		wg.Wait()
		if closeErr != nil || joinErr != nil && joinErr != store.ErrNotFound {
			t.Fatalf("join=%v close=%v", joinErr, closeErr)
		}
		if _, err := s.GetDoc(ctx, guest, doc); err != store.ErrNotFound {
			t.Fatalf("closed link left access: %v", err)
		}
		if got, err := s.GetDoc(ctx, owner, doc); err != nil || got.Role != "manage" {
			t.Fatalf("owner changed: %+v %v", got, err)
		}
	}
}

func checkConcurrentLinkRoleChanges(t *testing.T, s store.Store, doc int64) {
	t.Helper()
	ctx := context.Background()
	for i := 0; i < 30; i++ {
		if err := s.SetLink(ctx, doc, store.Link{Role: "edit", Token: "old-token"}); err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		var closeErr, changeErr error
		wg.Add(2)
		go func() { defer wg.Done(); <-start; _, closeErr = s.ChangeLinkRole(ctx, doc, "none", "") }()
		go func() { defer wg.Done(); <-start; _, changeErr = s.ChangeLinkRole(ctx, doc, "view", "fresh-token") }()
		close(start)
		wg.Wait()
		if closeErr != nil || changeErr != nil {
			t.Fatalf("close=%v change=%v", closeErr, changeErr)
		}
		if _, _, err := s.DocByToken(ctx, "old-token"); err != store.ErrNotFound {
			t.Fatalf("old token resurrected: %v", err)
		}
		link, err := s.GetLink(ctx, doc)
		if err != nil {
			t.Fatal(err)
		}
		if link.Role == "none" && link.Token != "" || link.Role == "view" && link.Token != "fresh-token" {
			t.Fatalf("invalid post-race link: %+v", link)
		}
	}
}

func TestMemoryConcurrentLinkClose(t *testing.T) {
	ctx := context.Background()
	s := store.NewMemory()
	owner, ws, _ := s.CreateUser(ctx, "owner@race.test", "Owner", "h")
	guest, _, _ := s.CreateUser(ctx, "guest@race.test", "Guest", "h")
	doc, _ := s.CreateDoc(ctx, ws.ID, owner.ID, nil, "doc", nil)
	checkConcurrentLinkClose(t, s, owner.ID, guest.ID, doc.ID)
	checkConcurrentLinkRoleChanges(t, s, doc.ID)
}
