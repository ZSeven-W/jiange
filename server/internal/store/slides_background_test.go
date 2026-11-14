package store_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func exerciseSlidesBackground(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "background-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("background-owner")}
	if err := st.CreateSession(ctx, g.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	deck, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "Deck", true)
	if err != nil {
		t.Fatal(err)
	}
	pages, err := st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(pages) != 1 {
		t.Fatalf("pages=%v err=%v", pages, err)
	}
	second, err := st.InsertSlidesPage(ctx, g, deck.ID, pages[0].ID, pages[0].Revision)
	if err != nil {
		t.Fatal(err)
	}
	first := pages[0]
	updated, err := st.UpdateSlidesPage(ctx, g, first.ID, "标题", "正文", "", nil, nil, first.Revision)
	if err != nil {
		t.Fatal(err)
	}
	op := st.(store.SlidesBackgroundStore)
	expected := []store.SlideVersion{{ID: updated.ID, Revision: updated.Revision}, {ID: second.ID, Revision: second.Revision}}
	if _, err := op.ApplySlidesBackground(ctx, g, deck.ID, "#ffcc00", expected[:1]); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("incomplete set: %v", err)
	}
	if _, err := op.ApplySlidesBackground(ctx, g, deck.ID, "#ffcc00", []store.SlideVersion{expected[0], expected[0]}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("duplicate id: %v", err)
	}
	if _, err := op.ApplySlidesBackground(ctx, g, deck.ID, "url(unsafe)", expected); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("invalid color: %v", err)
	}
	got, err := op.ApplySlidesBackground(ctx, g, deck.ID, "#ffcc00", expected)
	if err != nil || len(got) != 2 {
		t.Fatalf("apply=%v err=%v", got, err)
	}
	pages, err = st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(pages) != 2 || pages[0].Background != "#ffcc00" || pages[1].Background != "#ffcc00" || pages[0].Title != "标题" || pages[0].Body != "正文" {
		t.Fatalf("preserve=%+v err=%v", pages, err)
	}
	if _, err := op.ApplySlidesBackground(ctx, g, deck.ID, "#ffffff", expected); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale versions: %v", err)
	}
	current := []store.SlideVersion{{ID: pages[0].ID, Revision: pages[0].Revision}, {ID: pages[1].ID, Revision: pages[1].Revision}}
	noOp, err := op.ApplySlidesBackground(ctx, g, deck.ID, "#ffcc00", current)
	if err != nil || len(noOp) != 2 || noOp[0].Revision != current[0].Revision || noOp[1].Revision != current[1].Revision {
		t.Fatalf("noop=%+v %v", noOp, err)
	}
	viewer, _, err := st.CreateUser(ctx, "background-viewer@example.test", "Viewer", "hash")
	if err != nil {
		t.Fatal(err)
	}
	vg := store.RestoreGuard{UserID: viewer.ID, SessionHash: []byte("background-viewer")}
	if err := st.CreateSession(ctx, vg.SessionHash, viewer.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, deck.ID, viewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err := op.ApplySlidesBackground(ctx, vg, deck.ID, "", current); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer: %v", err)
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, color := range []string{"#112233", "#445566"} {
		wg.Add(1)
		go func(color string) {
			defer wg.Done()
			_, e := op.ApplySlidesBackground(ctx, g, deck.ID, color, current)
			results <- e
		}(color)
	}
	wg.Wait()
	close(results)
	success, conflicts := 0, 0
	for e := range results {
		if e == nil {
			success++
		} else if errors.Is(e, store.ErrConflict) {
			conflicts++
		} else {
			t.Fatalf("concurrent: %v", e)
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatalf("concurrent success=%d conflict=%d", success, conflicts)
	}
	pages, err = st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(pages) != 2 {
		t.Fatalf("pages=%+v err=%v", pages, err)
	}
	snapshot := []store.SlideVersion{{ID: pages[0].ID, Revision: pages[0].Revision}, {ID: pages[1].ID, Revision: pages[1].Revision}}
	deadline, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	results = make(chan error, 2)
	go func() { _, e := op.ApplySlidesBackground(deadline, g, deck.ID, "#abcdef", snapshot); results <- e }()
	go func() {
		_, e := st.InsertSlidesPage(deadline, g, deck.ID, pages[0].ID, pages[0].Revision)
		results <- e
	}()
	success, conflicts = 0, 0
	for range 2 {
		e := <-results
		if e == nil {
			success++
		} else if errors.Is(e, store.ErrConflict) {
			conflicts++
		} else {
			t.Fatalf("insert race: %v", e)
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatalf("insert race success=%d conflict=%d", success, conflicts)
	}
}

func TestMemorySlidesBackground(t *testing.T)   { exerciseSlidesBackground(t, store.NewMemory()) }
func TestPostgresSlidesBackground(t *testing.T) { exerciseSlidesBackground(t, atomicPostgres(t)) }

func TestPostgresSlidesBackgroundRollsBack(t *testing.T) {
	st := atomicPostgres(t)
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "background-rollback@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("background-rollback")}
	if err := st.CreateSession(ctx, g.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	deck, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "Deck", true)
	if err != nil {
		t.Fatal(err)
	}
	pages, err := st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(pages) != 1 {
		t.Fatal("missing page", err)
	}
	second, err := st.InsertSlidesPage(ctx, g, deck.ID, pages[0].ID, pages[0].Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool.Exec(ctx, `CREATE FUNCTION fail_slide_background() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.pos>1 THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_slide_background BEFORE UPDATE ON slides_pages FOR EACH ROW EXECUTE FUNCTION fail_slide_background()`); err != nil {
		t.Fatal(err)
	}
	_, err = st.ApplySlidesBackground(ctx, g, deck.ID, "#123456", []store.SlideVersion{{ID: pages[0].ID, Revision: pages[0].Revision}, {ID: second.ID, Revision: second.Revision}})
	if err == nil {
		t.Fatal("expected trigger failure")
	}
	pages, err = st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(pages) != 2 || pages[0].Background != "" || pages[1].Background != "" {
		t.Fatalf("partial update=%+v err=%v", pages, err)
	}
}
