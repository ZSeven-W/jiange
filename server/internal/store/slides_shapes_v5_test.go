package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"testing"
	"time"
)

func exerciseSlideShapesV5(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	user, ws, err := st.CreateUser(ctx, "shapes5@example.test", "owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: user.ID, SessionHash: []byte("shape5-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	deck, err := st.CreateDriveNode(ctx, guard, ws.ID, nil, "slides", "Deck", true)
	if err != nil {
		t.Fatal(err)
	}
	pages, err := st.ListSlidesPages(ctx, user.ID, deck.ID)
	if err != nil || len(pages) != 1 {
		t.Fatalf("pages: %v %v", pages, err)
	}
	shapes := json.RawMessage(`[{"id":"l","kind":"line-arrow","x":10,"y":10,"color":"#1f2329"}]`)
	old := st.(store.SlidesShapesV4Store)
	if _, err = old.UpdateSlidesPageV4(ctx, guard, deck.ID, pages[0].ID, "", "", "", "", nil, &shapes, pages[0].Revision); !errors.Is(err, store.ErrSlideClientOutdated) {
		t.Fatalf("v4 insert: %v", err)
	}
	saved, err := st.(store.SlidesShapesV5Store).UpdateSlidesPageV5(ctx, guard, deck.ID, pages[0].ID, "", "", "", "", nil, &shapes, pages[0].Revision)
	if err != nil {
		t.Fatal(err)
	}
	empty := json.RawMessage(`[]`)
	if _, err = old.UpdateSlidesPageV4(ctx, guard, deck.ID, saved.ID, "", "", "", "", nil, &empty, saved.Revision); !errors.Is(err, store.ErrSlideClientOutdated) {
		t.Fatalf("v4 overwrite: %v", err)
	}
	pages, err = st.ListSlidesPages(ctx, user.ID, deck.ID)
	if err != nil || !jsonEqual(pages[0].Shapes, shapes) {
		t.Fatalf("shape lost: %v %v", pages, err)
	}
}
func TestMemorySlidesShapesV5(t *testing.T)   { exerciseSlideShapesV5(t, store.NewMemory()) }
func TestPostgresSlidesShapesV5(t *testing.T) { exerciseSlideShapesV5(t, atomicPostgres(t)) }
