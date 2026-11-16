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

func exerciseInsertSlideLayout(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "insert-layout-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("insert-layout-owner")}
	if err = st.CreateSession(ctx, g.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	deck, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "Deck", true)
	if err != nil {
		t.Fatal(err)
	}
	pages, err := st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(pages) != 1 {
		t.Fatalf("initial pages: %+v %v", pages, err)
	}
	anchor := pages[0]
	if _, err = st.InsertSlidesPageWithLayout(ctx, g, deck.ID, anchor.ID, anchor.Revision+1, "title"); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale anchor: %v", err)
	}
	if _, err = st.InsertSlidesPageWithLayout(ctx, g, deck.ID, anchor.ID, anchor.Revision, "unknown"); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("invalid layout: %v", err)
	}
	page, err := st.InsertSlidesPageWithLayout(ctx, g, deck.ID, anchor.ID, anchor.Revision, "title")
	if err != nil || page.Layout != "title" || page.Revision != 1 || page.Title != "" || page.Hidden {
		t.Fatalf("insert title: %+v %v", page, err)
	}
	second, err := st.InsertSlidesPageWithLayout(ctx, g, deck.ID, page.ID, page.Revision, "blank")
	if err != nil || second.Layout != "blank" || second.Revision != 1 {
		t.Fatalf("insert blank: %+v %v", second, err)
	}
	columns, err := st.InsertSlidesPageWithLayout(ctx, g, deck.ID, second.ID, second.Revision, "two-column")
	var shapes []struct {
		ID   string  `json:"id"`
		Kind string  `json:"kind"`
		Text *string `json:"text"`
	}
	if err != nil || columns.Layout != "blank" || columns.Revision != 1 || json.Unmarshal(columns.Shapes, &shapes) != nil || len(shapes) != 3 || shapes[0].ID != "preset-two-title" || shapes[1].ID != "preset-two-left" || shapes[2].ID != "preset-two-right" || shapes[0].Kind != "text" || shapes[1].Kind != "text" || shapes[2].Kind != "text" || shapes[0].Text == nil || *shapes[0].Text != "" {
		t.Fatalf("insert two-column preset: %+v %s %v", columns, columns.Shapes, err)
	}
	pages, err = st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(pages) != 4 || pages[0].ID != anchor.ID || pages[1].ID != page.ID || pages[2].ID != second.ID || pages[3].ID != columns.ID {
		t.Fatalf("order: %+v %v", pages, err)
	}
	viewer, _, err := st.CreateUser(ctx, "insert-layout-viewer@example.test", "Viewer", "hash")
	if err != nil {
		t.Fatal(err)
	}
	viewerGuard := store.RestoreGuard{UserID: viewer.ID, SessionHash: []byte("insert-layout-viewer")}
	if err = st.CreateSession(ctx, viewerGuard.SessionHash, viewer.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, deck.ID, viewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = st.InsertSlidesPageWithLayout(ctx, viewerGuard, deck.ID, anchor.ID, anchor.Revision, "title"); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer: %v", err)
	}
	deadline, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	type result struct {
		page store.SlidesPage
		err  error
	}
	results := make(chan result, 2)
	for _, layout := range []string{"blank", "title"} {
		go func(layout string) {
			p, e := st.InsertSlidesPageWithLayout(deadline, g, deck.ID, anchor.ID, anchor.Revision, layout)
			results <- result{p, e}
		}(layout)
	}
	firstConcurrent, secondConcurrent := <-results, <-results
	if firstConcurrent.err != nil || secondConcurrent.err != nil || firstConcurrent.page.ID == secondConcurrent.page.ID || firstConcurrent.page.Pos == secondConcurrent.page.Pos {
		t.Fatalf("concurrent insert: %+v %+v", firstConcurrent, secondConcurrent)
	}
	if err = st.DeleteSession(ctx, g.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = st.InsertSlidesPageWithLayout(ctx, g, deck.ID, second.ID, second.Revision, "title"); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("revoked: %v", err)
	}
}

func TestMemoryInsertSlideLayout(t *testing.T)   { exerciseInsertSlideLayout(t, store.NewMemory()) }
func TestPostgresInsertSlideLayout(t *testing.T) { exerciseInsertSlideLayout(t, atomicPostgres(t)) }
