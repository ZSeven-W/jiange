package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func exerciseDeleteSlideVersion(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	u, ws, err := st.CreateUser(ctx, "slide-delete@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := store.RestoreGuard{UserID: u.ID, SessionHash: []byte("slide-delete-session")}
	if err = st.CreateSession(ctx, g.SessionHash, u.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	deck, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "Deck", true)
	if err != nil {
		t.Fatal(err)
	}
	other, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "Other", true)
	if err != nil {
		t.Fatal(err)
	}
	pages, err := st.ListSlidesPages(ctx, u.ID, deck.ID)
	if err != nil || len(pages) != 1 {
		t.Fatalf("pages: %+v %v", pages, err)
	}
	original := pages[0]
	changed, err := st.UpdateSlidesPage(ctx, g, original.ID, "new", "body", "", nil, nil, original.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.DeleteSlidesPageVersion(ctx, g, deck.ID, original.ID, original.Revision); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale delete: %v", err)
	}
	if err = st.DeleteSlidesPageVersion(ctx, g, other.ID, original.ID, changed.Revision); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("wrong deck: %v", err)
	}
	viewer, _, err := st.CreateUser(ctx, "slide-delete-viewer@example.test", "Viewer", "hash")
	if err != nil {
		t.Fatal(err)
	}
	vg := store.RestoreGuard{UserID: viewer.ID, SessionHash: []byte("slide-delete-viewer")}
	if err = st.CreateSession(ctx, vg.SessionHash, viewer.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, deck.ID, viewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if err = st.DeleteSlidesPageVersion(ctx, vg, deck.ID, original.ID, changed.Revision); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer delete: %v", err)
	}
	pages, err = st.ListSlidesPages(ctx, u.ID, deck.ID)
	if err != nil || len(pages) != 1 || pages[0].Title != "new" {
		t.Fatalf("rejected deletion mutated: %+v %v", pages, err)
	}
	if err = st.DeleteSlidesPageVersion(ctx, g, deck.ID, original.ID, changed.Revision); err != nil {
		t.Fatalf("delete: %v", err)
	}
	pages, err = st.ListSlidesPages(ctx, u.ID, deck.ID)
	if err != nil || len(pages) != 0 {
		t.Fatalf("after delete: %+v %v", pages, err)
	}
	for i := 0; i < 10; i++ {
		page, e := st.CreateSlidesPage(ctx, g, deck.ID, "race")
		if e != nil {
			t.Fatal(e)
		}
		start := make(chan struct{})
		results := make(chan error, 2)
		go func() {
			<-start
			_, e := st.UpdateSlidesPage(ctx, g, page.ID, "edited", "", "", nil, nil, page.Revision)
			results <- e
		}()
		go func() { <-start; results <- st.DeleteSlidesPageVersion(ctx, g, deck.ID, page.ID, page.Revision) }()
		close(start)
		a, b := <-results, <-results
		if (a == nil) == (b == nil) {
			t.Fatalf("edit/delete race: %v, %v", a, b)
		}
	}
	guardedPage, err := st.CreateSlidesPage(ctx, g, deck.ID, "protected")
	if err != nil {
		t.Fatal(err)
	}
	if err = st.DeleteSession(ctx, g.SessionHash); err != nil {
		t.Fatal(err)
	}
	if err = st.DeleteSlidesPageVersion(ctx, g, deck.ID, guardedPage.ID, guardedPage.Revision); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("revoked session: %v", err)
	}
}
func TestMemoryDeleteSlideVersion(t *testing.T)   { exerciseDeleteSlideVersion(t, store.NewMemory()) }
func TestPostgresDeleteSlideVersion(t *testing.T) { exerciseDeleteSlideVersion(t, atomicPostgres(t)) }
