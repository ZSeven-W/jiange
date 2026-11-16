package store_test

import (
	"context"
	"errors"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"sync"
	"testing"
	"time"
)

func exerciseSlidesOrder(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	user, ws, err := st.CreateUser(ctx, "order@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := store.RestoreGuard{UserID: user.ID, SessionHash: []byte("order-session")}
	if err = st.CreateSession(ctx, g.SessionHash, user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	deck, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "Deck", true)
	if err != nil {
		t.Fatal(err)
	}
	initial, err := st.ListSlidesPages(ctx, user.ID, deck.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := st.InsertSlidesPage(ctx, g, deck.ID, initial[0].ID, initial[0].Revision)
	if err != nil {
		t.Fatal(err)
	}
	third, err := st.InsertSlidesPage(ctx, g, deck.ID, second.ID, second.Revision)
	if err != nil {
		t.Fatal(err)
	}
	expected := []store.SlidePosition{{ID: initial[0].ID, Pos: initial[0].Pos}, {ID: second.ID, Pos: second.Pos}, {ID: third.ID, Pos: third.Pos}}
	order := st.(store.SlidesOrderStore)
	if _, err = order.ReorderSlides(ctx, g, deck.ID, expected[:2], initial[0].ID, 1); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("missing page: %v", err)
	}
	bad := append([]store.SlidePosition(nil), expected...)
	bad[1] = bad[0]
	if _, err = order.ReorderSlides(ctx, g, deck.ID, bad, initial[0].ID, 1); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("duplicate: %v", err)
	}
	viewer, _, err := st.CreateUser(ctx, "order-viewer@example.test", "Viewer", "hash")
	if err != nil {
		t.Fatal(err)
	}
	vg := store.RestoreGuard{UserID: viewer.ID, SessionHash: []byte("order-viewer")}
	if err = st.CreateSession(ctx, vg.SessionHash, viewer.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, deck.ID, viewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = order.ReorderSlides(ctx, vg, deck.ID, expected, initial[0].ID, 2); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer: %v", err)
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, id := range []int64{initial[0].ID, second.ID} {
		wg.Add(1)
		go func(id int64) {
			defer wg.Done()
			_, e := order.ReorderSlides(ctx, g, deck.ID, expected, id, 2)
			results <- e
		}(id)
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for e := range results {
		if e == nil {
			success++
		} else if errors.Is(e, store.ErrConflict) {
			conflict++
		} else {
			t.Fatalf("concurrent error: %v", e)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("success %d conflict %d", success, conflict)
	}
	pages, err := st.ListSlidesPages(ctx, user.ID, deck.ID)
	if err != nil || len(pages) != 3 {
		t.Fatalf("pages: %+v %v", pages, err)
	}
	current := make([]store.SlidePosition, 0, 3)
	for _, page := range pages {
		current = append(current, store.SlidePosition{ID: page.ID, Pos: page.Pos})
	}
	result, err := order.ReorderSlides(ctx, g, deck.ID, current, pages[2].ID, 0)
	if err != nil || result[0].ID != pages[2].ID {
		t.Fatalf("move to top: %+v %v", result, err)
	}
	// Insertion racing a reorder either happens first and invalidates the
	// snapshot, or follows the reorder. Both must leave a valid unique order.
	ctxRace, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	race := make(chan error, 2)
	go func() { _, e := order.ReorderSlides(ctxRace, g, deck.ID, result, result[0].ID, 1); race <- e }()
	go func() {
		_, e := st.InsertSlidesPage(ctxRace, g, deck.ID, initial[0].ID, initial[0].Revision)
		race <- e
	}()
	first, secondErr := <-race, <-race
	if first != nil && !errors.Is(first, store.ErrConflict) || secondErr != nil && !errors.Is(secondErr, store.ErrConflict) {
		t.Fatalf("insert race: %v %v", first, secondErr)
	}
	pages, err = st.ListSlidesPages(ctx, user.ID, deck.ID)
	if err != nil || len(pages) != 4 {
		t.Fatalf("insert race pages: %+v %v", pages, err)
	}
	for i := 1; i < len(pages); i++ {
		if pages[i-1].Pos >= pages[i].Pos {
			t.Fatalf("non-unique positions after race: %+v", pages)
		}
	}
	if err = st.DeleteSession(ctx, g.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = order.ReorderSlides(ctx, g, deck.ID, result, result[0].ID, 1); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expired: %v", err)
	}
}
func TestMemorySlidesOrder(t *testing.T)   { exerciseSlidesOrder(t, store.NewMemory()) }
func TestPostgresSlidesOrder(t *testing.T) { exerciseSlidesOrder(t, atomicPostgres(t)) }
