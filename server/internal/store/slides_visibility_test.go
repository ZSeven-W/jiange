package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func exerciseSlideVisibility(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "visibility-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("visibility-owner")}
	if err = st.CreateSession(ctx, g.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	deck, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "Deck", true)
	if err != nil {
		t.Fatal(err)
	}
	pages, err := st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(pages) != 1 || pages[0].Hidden {
		t.Fatalf("initial: %+v %v", pages, err)
	}
	base := pages[0]
	hidden, err := st.SetSlidesPageHidden(ctx, g, deck.ID, base.ID, base.Revision, true)
	if err != nil || !hidden.Hidden || hidden.Revision != base.Revision+1 {
		t.Fatalf("hide: %+v %v", hidden, err)
	}
	if _, err = st.SetSlidesPageHidden(ctx, g, deck.ID, base.ID, base.Revision, false); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale unhide: %v", err)
	}
	if _, err = st.UpdateSlidesPage(ctx, g, base.ID, "stale", "", "", nil, nil, base.Revision); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale edit: %v", err)
	}
	updated, err := st.UpdateSlidesPage(ctx, g, base.ID, "Hidden", "body", "", nil, nil, hidden.Revision)
	if err != nil || !updated.Hidden {
		t.Fatalf("edit preserved hidden: %+v %v", updated, err)
	}
	copy, err := st.DuplicateSlidesPage(ctx, g, deck.ID, base.ID, updated.Revision)
	if err != nil || !copy.Hidden {
		t.Fatalf("duplicate preserved hidden: %+v %v", copy, err)
	}
	blank, err := st.InsertSlidesPage(ctx, g, deck.ID, base.ID, updated.Revision)
	if err != nil || blank.Hidden {
		t.Fatalf("new page should be visible: %+v %v", blank, err)
	}
	clone, cloned, err := st.CopySlidesDeck(ctx, store.SlidesDeckCopy{SourceID: deck.ID, UserID: owner.ID, WorkspaceID: ws.ID, Title: "Copy", Guard: &g})
	if err != nil || clone.ID == 0 || len(cloned) != 3 || !cloned[0].Hidden || !cloned[2].Hidden || cloned[1].Hidden {
		t.Fatalf("deck copy: %+v %+v %v", clone, cloned, err)
	}
	unchanged, err := st.SetSlidesPageHidden(ctx, g, deck.ID, base.ID, updated.Revision, true)
	if err != nil || unchanged.Revision != updated.Revision {
		t.Fatalf("no-op: %+v %v", unchanged, err)
	}
	visible, err := st.SetSlidesPageHidden(ctx, g, deck.ID, base.ID, updated.Revision, false)
	if err != nil || visible.Hidden || visible.Revision != updated.Revision+1 {
		t.Fatalf("unhide: %+v %v", visible, err)
	}
	viewer, _, err := st.CreateUser(ctx, "visibility-viewer@example.test", "Viewer", "hash")
	if err != nil {
		t.Fatal(err)
	}
	vg := store.RestoreGuard{UserID: viewer.ID, SessionHash: []byte("visibility-viewer")}
	if err = st.CreateSession(ctx, vg.SessionHash, viewer.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, deck.ID, viewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = st.SetSlidesPageHidden(ctx, vg, deck.ID, base.ID, visible.Revision, true); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer: %v", err)
	}
	deadline, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	results := make(chan error, 2)
	go func() {
		_, e := st.SetSlidesPageHidden(deadline, g, deck.ID, base.ID, visible.Revision, true)
		results <- e
	}()
	go func() {
		_, e := st.UpdateSlidesPage(deadline, g, base.ID, "concurrent", "body", "", nil, nil, visible.Revision)
		results <- e
	}()
	wins, conflicts := 0, 0
	for range 2 {
		e := <-results
		if e == nil {
			wins++
		} else if errors.Is(e, store.ErrConflict) {
			conflicts++
		} else {
			t.Fatalf("concurrent mutation: %v", e)
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatalf("expected one winning revision, got %d wins and %d conflicts", wins, conflicts)
	}
	if err = st.DeleteSession(ctx, g.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = st.SetSlidesPageHidden(ctx, g, deck.ID, base.ID, visible.Revision, true); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("revoked: %v", err)
	}
}

func TestMemorySlideVisibility(t *testing.T)   { exerciseSlideVisibility(t, store.NewMemory()) }
func TestPostgresSlideVisibility(t *testing.T) { exerciseSlideVisibility(t, atomicPostgres(t)) }

func TestPostgresSlideVisibilityMigrationPreservesExistingPage(t *testing.T) {
	pg := atomicPostgres(t)
	ctx := context.Background()
	owner, ws, err := pg.CreateUser(ctx, "visibility-migration@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("visibility-migration")}
	if err = pg.CreateSession(ctx, g.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	deck, err := pg.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "Before", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pg.Pool.Exec(ctx, `UPDATE slides_pages SET title='existing' WHERE slides_id=$1`, deck.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pg.Pool.Exec(ctx, `ALTER TABLE slides_pages DROP COLUMN hidden; DELETE FROM schema_migrations WHERE version=55`); err != nil {
		t.Fatal(err)
	}
	if _, err = migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	pages, err := pg.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(pages) != 1 || pages[0].Title != "existing" || pages[0].Hidden {
		t.Fatalf("migrated page: %+v %v", pages, err)
	}
}
