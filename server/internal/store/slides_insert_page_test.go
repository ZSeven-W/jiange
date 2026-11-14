package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func exerciseInsertSlide(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "insert-slide-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("insert-slide-owner")}
	if err = st.CreateSession(ctx, g.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	deck, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "Deck", true)
	if err != nil {
		t.Fatal(err)
	}
	pages, err := st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(pages) != 1 {
		t.Fatalf("initial: %+v %v", pages, err)
	}
	first := pages[0]
	last, err := st.CreateSlidesPage(ctx, g, deck.ID, "Last")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.InsertSlidesPage(ctx, g, deck.ID, first.ID, first.Revision+1); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale: %v", err)
	}
	if _, err = st.InsertSlidesPage(ctx, g, deck.ID, 0, 0); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("non-empty first: %v", err)
	}
	blank, err := st.InsertSlidesPage(ctx, g, deck.ID, first.ID, first.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if blank.ID == first.ID || blank.Title != "" || blank.Body != "" || blank.Notes != "" || blank.Revision != 1 || !json.Valid(blank.Shapes) || string(blank.Shapes) != "[]" {
		t.Fatalf("blank: %+v", blank)
	}
	pages, err = st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(pages) != 3 || pages[0].ID != first.ID || pages[1].ID != blank.ID || pages[2].ID != last.ID {
		t.Fatalf("order: %+v %v", pages, err)
	}

	peer, _, err := st.CreateUser(ctx, "insert-slide-peer@example.test", "Peer", "hash")
	if err != nil {
		t.Fatal(err)
	}
	pg := store.RestoreGuard{UserID: peer.ID, SessionHash: []byte("insert-slide-peer")}
	if err = st.CreateSession(ctx, pg.SessionHash, peer.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, deck.ID, peer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = st.InsertSlidesPage(ctx, pg, deck.ID, first.ID, first.Revision); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer insert: %v", err)
	}
	if err = st.SetShare(ctx, deck.ID, peer.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err = st.PatchManagedDocGuarded(ctx, g, deck.ID, store.ManagedDocPatch{CopyProtected: true}); err != nil {
		t.Fatal(err)
	}
	if _, err = st.InsertSlidesPage(ctx, pg, deck.ID, last.ID, last.Revision); err != nil {
		t.Fatalf("copy restriction blocked blank insertion: %v", err)
	}

	deadline, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	results := make(chan error, 2)
	for _, p := range []store.SlidesPage{first, last} {
		go func(anchor store.SlidesPage) {
			_, e := st.InsertSlidesPage(deadline, g, deck.ID, anchor.ID, anchor.Revision)
			results <- e
		}(p)
	}
	for range 2 {
		if err = <-results; err != nil {
			t.Fatalf("concurrent insert: %v", err)
		}
	}
	pages, err = st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(pages) != 6 {
		t.Fatalf("concurrent insert pages: %+v %v", pages, err)
	}

	empty, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "Empty", true)
	if err != nil {
		t.Fatal(err)
	}
	initial, err := st.ListSlidesPages(ctx, owner.ID, empty.ID)
	if err != nil || len(initial) != 1 {
		t.Fatalf("empty initial: %+v %v", initial, err)
	}
	if err = st.DeleteSlidesPage(ctx, g, initial[0].ID); err != nil {
		t.Fatal(err)
	}
	if _, err = st.InsertSlidesPage(ctx, g, empty.ID, 0, 0); err != nil {
		t.Fatalf("insert first: %v", err)
	}
	if _, err = st.InsertSlidesPage(ctx, g, empty.ID, 0, 0); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("duplicate first: %v", err)
	}
	if err = st.DeleteSession(ctx, g.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = st.InsertSlidesPage(ctx, g, deck.ID, first.ID, first.Revision); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("revoked: %v", err)
	}
}

func TestMemoryInsertSlidePage(t *testing.T)   { exerciseInsertSlide(t, store.NewMemory()) }
func TestPostgresInsertSlidePage(t *testing.T) { exerciseInsertSlide(t, atomicPostgres(t)) }
