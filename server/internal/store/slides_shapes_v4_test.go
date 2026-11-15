package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"reflect"
	"testing"
	"time"
)

func exerciseSlideShapesV4(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	user, ws, err := st.CreateUser(ctx, "shapes4@example.test", "owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := store.RestoreGuard{UserID: user.ID, SessionHash: []byte("shape4-session")}
	if err = st.CreateSession(ctx, g.SessionHash, user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	deck, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "Deck", true)
	if err != nil {
		t.Fatal(err)
	}
	pages, err := st.ListSlidesPages(ctx, user.ID, deck.ID)
	if err != nil || len(pages) != 1 {
		t.Fatalf("pages %v %v", pages, err)
	}
	shapes := json.RawMessage(`[{"id":"one","kind":"star","x":10,"y":10,"color":"#3370ff"}]`)
	modern := st.(store.SlidesShapesV4Store)
	saved, err := modern.UpdateSlidesPageV4(ctx, g, deck.ID, pages[0].ID, "title", "", "", "", nil, &shapes, pages[0].Revision)
	if err != nil {
		t.Fatal(err)
	}
	empty := json.RawMessage(`[]`)
	if _, err = st.UpdateSlidesPageV3(ctx, g, deck.ID, saved.ID, "old", "", "", "", nil, &empty, saved.Revision); !errors.Is(err, store.ErrSlideClientOutdated) {
		t.Fatalf("v3 overwrite: %v", err)
	}
	if _, err = st.UpdateSlidesPage(ctx, g, saved.ID, "old", "", "", nil, nil, saved.Revision); !errors.Is(err, store.ErrSlideClientOutdated) {
		t.Fatalf("legacy overwrite: %v", err)
	}
	pages, err = st.ListSlidesPages(ctx, user.ID, deck.ID)
	if err != nil || string(pages[0].Shapes) != string(shapes) && !jsonEqual(pages[0].Shapes, shapes) {
		t.Fatalf("shape lost: %+v %v", pages, err)
	}
}
func jsonEqual(a, b json.RawMessage) bool {
	var x, y any
	return json.Unmarshal(a, &x) == nil && json.Unmarshal(b, &y) == nil && reflect.DeepEqual(x, y)
}
func TestMemorySlidesShapesV4(t *testing.T)   { exerciseSlideShapesV4(t, store.NewMemory()) }
func TestPostgresSlidesShapesV4(t *testing.T) { exerciseSlideShapesV4(t, atomicPostgres(t)) }
