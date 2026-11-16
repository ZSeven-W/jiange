package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func exerciseSlidesLayout(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	user, ws, err := st.CreateUser(ctx, "slides-layout@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: user.ID, SessionHash: []byte("slides-layout-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	deck, err := st.CreateDriveNode(ctx, guard, ws.ID, nil, "slides", "Deck", true)
	if err != nil {
		t.Fatal(err)
	}
	pages, err := st.ListSlidesPages(ctx, user.ID, deck.ID)
	if err != nil || len(pages) != 1 {
		t.Fatalf("initial: %+v %v", pages, err)
	}
	original := pages[0]
	changed, err := st.UpdateSlidesPageV3(ctx, guard, deck.ID, original.ID, "Title", "Keep body", "", "title", nil, nil, original.Revision)
	if err != nil || changed.Layout != "title" || changed.Body != "Keep body" {
		t.Fatalf("change: %+v %v", changed, err)
	}
	changed, err = st.UpdateSlidesPageV3(ctx, guard, deck.ID, original.ID, changed.Title, changed.Body, changed.Background, "blank-title", nil, nil, changed.Revision)
	if err != nil || changed.Layout != "blank-title" || changed.Body != "Keep body" {
		t.Fatalf("blank layout: %+v %v", changed, err)
	}
	if _, err = st.UpdateSlidesPage(ctx, guard, original.ID, "old client", "", "", nil, nil, changed.Revision); !errors.Is(err, store.ErrSlideClientOutdated) {
		t.Fatalf("old client: %v", err)
	}
	if _, err = st.UpdateSlidesPageV3(ctx, guard, deck.ID, original.ID, "stale", "", "", "", nil, nil, original.Revision); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale: %v", err)
	}
	copied, err := st.DuplicateSlidesPage(ctx, guard, deck.ID, original.ID, changed.Revision)
	if err != nil || copied.Layout != "blank-title" || copied.Body != changed.Body {
		t.Fatalf("copy: %+v %v", copied, err)
	}
	blank, err := st.InsertSlidesPage(ctx, guard, deck.ID, original.ID, changed.Revision)
	if err != nil || blank.Layout != "" {
		t.Fatalf("insert: %+v %v", blank, err)
	}
	blank, err = st.UpdateSlidesPageV3(ctx, guard, deck.ID, blank.ID, "", "", "", "blank", nil, nil, blank.Revision)
	if err != nil || blank.Layout != "blank" {
		t.Fatalf("empty blank layout: %+v %v", blank, err)
	}
	_, cloned, err := st.CopySlidesDeck(ctx, store.SlidesDeckCopy{SourceID: deck.ID, UserID: user.ID, WorkspaceID: ws.ID, Title: "Copy", Guard: &guard})
	if err != nil || len(cloned) != 3 || cloned[0].Layout != "blank-title" || cloned[1].Layout != "blank" {
		t.Fatalf("deck copy: %+v %v", cloned, err)
	}
	restored, err := st.UpdateSlidesPageV3(ctx, guard, deck.ID, original.ID, changed.Title, changed.Body, changed.Background, "", nil, nil, changed.Revision)
	if err != nil || restored.Layout != "" || restored.Body != "Keep body" {
		t.Fatalf("restore layout: %+v %v", restored, err)
	}
	if _, err = st.UpdateSlidesPage(ctx, guard, original.ID, "legacy", "Keep body", "", nil, nil, restored.Revision); err != nil {
		t.Fatalf("legacy after restore: %v", err)
	}
}
func TestMemorySlidesLayout(t *testing.T)   { exerciseSlidesLayout(t, store.NewMemory()) }
func TestPostgresSlidesLayout(t *testing.T) { exerciseSlidesLayout(t, atomicPostgres(t)) }
