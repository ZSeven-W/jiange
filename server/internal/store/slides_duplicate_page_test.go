package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func exerciseDuplicateSlide(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	u, ws, err := st.CreateUser(ctx, "duplicate-slide@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := store.RestoreGuard{UserID: u.ID, SessionHash: []byte("duplicate-slide-session")}
	if err = st.CreateSession(ctx, g.SessionHash, u.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	deck, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "Deck", true)
	if err != nil {
		t.Fatal(err)
	}
	pages, err := st.ListSlidesPages(ctx, u.ID, deck.ID)
	if err != nil || len(pages) != 1 {
		t.Fatalf("initial: %+v %v", pages, err)
	}
	other, err := st.CreateSlidesPage(ctx, g, deck.ID, "Next")
	if err != nil {
		t.Fatal(err)
	}
	image, err := st.CreateSlidesFile(ctx, g, deck.ID, store.FileMeta{Name: "fixture.png", Mime: "image/png", Size: 3, ObjectKey: "slides/test/fixture"})
	if err != nil {
		t.Fatal(err)
	}
	shapes := json.RawMessage(fmt.Sprintf(`[{"id":"one","kind":"text","x":1,"y":2,"color":"#000000","text":"Test"},{"id":"two","kind":"image","x":4,"y":5,"color":"#ffffff","fileId":%d}]`, image.ID))
	notes := "notes"
	src, err := st.UpdateSlidesPage(ctx, g, pages[0].ID, "Title", "Body", "#123456", &notes, &shapes, pages[0].Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.DuplicateSlidesPage(ctx, g, deck.ID, src.ID, src.Revision-1); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale version: %v", err)
	}
	if pg, ok := st.(*store.Postgres); ok {
		_, err = pg.Pool.Exec(ctx, `CREATE FUNCTION fail_slide_copy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$; CREATE TRIGGER fail_slide_copy BEFORE INSERT ON slides_pages FOR EACH ROW EXECUTE FUNCTION fail_slide_copy()`)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = st.DuplicateSlidesPage(ctx, g, deck.ID, src.ID, src.Revision); err == nil {
			t.Fatal("copy must fail under injected insert error")
		}
		if _, err = pg.Pool.Exec(ctx, `DROP TRIGGER fail_slide_copy ON slides_pages; DROP FUNCTION fail_slide_copy()`); err != nil {
			t.Fatal(err)
		}
		pages, err = st.ListSlidesPages(ctx, u.ID, deck.ID)
		if err != nil || len(pages) != 2 {
			t.Fatalf("failed copy left a page: %+v %v", pages, err)
		}
	}
	copy, err := st.DuplicateSlidesPage(ctx, g, deck.ID, src.ID, src.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if copy.ID == src.ID || copy.SlidesID != deck.ID || copy.Revision != 1 || copy.Title != src.Title || copy.Body != src.Body || copy.Notes != src.Notes || copy.Background != src.Background || !json.Valid(copy.Shapes) {
		t.Fatalf("copy: %+v", copy)
	}
	var wantShapes, gotShapes any
	if json.Unmarshal(src.Shapes, &wantShapes) != nil || json.Unmarshal(copy.Shapes, &gotShapes) != nil || !reflect.DeepEqual(wantShapes, gotShapes) {
		t.Fatalf("copied shapes: %s", copy.Shapes)
	}
	pages, err = st.ListSlidesPages(ctx, u.ID, deck.ID)
	if err != nil || len(pages) != 3 || pages[0].ID != src.ID || pages[1].ID != copy.ID || pages[2].ID != other.ID {
		t.Fatalf("order: %+v %v", pages, err)
	}
	copy.Shapes[0] = 'x'
	pages, err = st.ListSlidesPages(ctx, u.ID, deck.ID)
	if err != nil || !json.Valid(pages[1].Shapes) {
		t.Fatalf("alias leaked: %+v %v", pages, err)
	}
	// Different source pages in one deck may be duplicated concurrently.
	// Both operations must finish without a lock-upgrade deadlock or lost page.
	concurrent, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	results := make(chan error, 2)
	for _, source := range []store.SlidesPage{src, other} {
		go func(page store.SlidesPage) {
			_, e := st.DuplicateSlidesPage(concurrent, g, deck.ID, page.ID, page.Revision)
			results <- e
		}(source)
	}
	for range 2 {
		if e := <-results; e != nil {
			t.Fatalf("concurrent copy: %v", e)
		}
	}
	pages, err = st.ListSlidesPages(ctx, u.ID, deck.ID)
	if err != nil || len(pages) != 5 {
		t.Fatalf("concurrent pages: %+v %v", pages, err)
	}
	editor, _, err := st.CreateUser(ctx, "duplicate-slide-editor@example.test", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	eg := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("duplicate-slide-editor")}
	if err = st.CreateSession(ctx, eg.SessionHash, editor.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, deck.ID, editor.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = st.DuplicateSlidesPage(ctx, eg, deck.ID, src.ID, src.Revision); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer copied: %v", err)
	}
	if err = st.SetShare(ctx, deck.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err = st.PatchManagedDocGuarded(ctx, g, deck.ID, store.ManagedDocPatch{CopyProtected: true}); err != nil {
		t.Fatal(err)
	}
	if _, err = st.DuplicateSlidesPage(ctx, eg, deck.ID, src.ID, src.Revision); !errors.Is(err, store.ErrCopyProtected) {
		t.Fatalf("copy restriction: %v", err)
	}
	if err = st.DeleteSession(ctx, g.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = st.DuplicateSlidesPage(ctx, g, deck.ID, src.ID, src.Revision); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("revoked session: %v", err)
	}
	pages, err = st.ListSlidesPages(ctx, u.ID, deck.ID)
	if err != nil || len(pages) != 5 {
		t.Fatalf("rejected copy mutated pages: %+v %v", pages, err)
	}
}

func TestMemoryDuplicateSlidePage(t *testing.T)   { exerciseDuplicateSlide(t, store.NewMemory()) }
func TestPostgresDuplicateSlidePage(t *testing.T) { exerciseDuplicateSlide(t, atomicPostgres(t)) }
