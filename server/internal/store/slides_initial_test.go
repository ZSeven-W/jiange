package store_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func checkInitialSlide(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "slide-initial-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("slide-initial-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	deck, err := st.CreateDriveNode(ctx, guard, ws.ID, nil, "slides", "New deck", true)
	if err != nil {
		t.Fatal(err)
	}
	pages, err := st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(pages) != 1 || pages[0].SlidesID != deck.ID || pages[0].Title != "" || pages[0].Body != "" || pages[0].Revision != 1 || string(pages[0].Shapes) != "[]" {
		t.Fatalf("initial page: %+v %v", pages, err)
	}
	if _, err = st.CreateSlidesPage(ctx, guard, deck.ID, "Next"); err != nil {
		t.Fatal(err)
	}
	pages, err = st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(pages) != 2 || pages[0].Pos >= pages[1].Pos {
		t.Fatalf("next page: %+v %v", pages, err)
	}
}

func TestMemoryInitialSlide(t *testing.T) { checkInitialSlide(t, store.NewMemory()) }

func TestPostgresInitialSlide(t *testing.T) {
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
	if _, err = migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	checkInitialSlide(t, pg)
	owner, ws, err := pg.CreateUser(ctx, "slide-rollback-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("slide-rollback-session")}
	if err = pg.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err = pg.Pool.Exec(ctx, `CREATE FUNCTION test_reject_initial_slide() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected page failure'; END $$; CREATE TRIGGER test_reject_initial_slide BEFORE INSERT ON slides_pages FOR EACH ROW EXECUTE FUNCTION test_reject_initial_slide()`); err != nil {
		t.Fatal(err)
	}
	defer pg.Pool.Exec(context.Background(), `DROP TRIGGER IF EXISTS test_reject_initial_slide ON slides_pages; DROP FUNCTION IF EXISTS test_reject_initial_slide()`)
	if _, err = pg.CreateDriveNode(ctx, guard, ws.ID, nil, "slides", "Rollback", true); err == nil {
		t.Fatal("expected injected page failure")
	}
	entries, err := pg.ListDriveChildren(ctx, guard, ws.ID, nil, true)
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed page left a deck: %+v %v", entries, err)
	}
}
