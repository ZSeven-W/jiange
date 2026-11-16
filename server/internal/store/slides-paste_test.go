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

func exercisePasteSlide(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	u, ws, err := st.CreateUser(ctx, "paste-slide@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := store.RestoreGuard{UserID: u.ID, SessionHash: []byte("paste-slide-session")}
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
	second, err := st.InsertSlidesPage(ctx, g, deck.ID, pages[0].ID, pages[0].Revision)
	if err != nil {
		t.Fatal(err)
	}
	third, err := st.InsertSlidesPage(ctx, g, deck.ID, second.ID, second.Revision)
	if err != nil {
		t.Fatal(err)
	}
	image, err := st.CreateSlidesFile(ctx, g, deck.ID, store.FileMeta{Name: "fixture.png", Mime: "image/png", Size: 3, ObjectKey: "slides/test/fixture"})
	if err != nil {
		t.Fatal(err)
	}
	shapes := json.RawMessage(fmt.Sprintf(`[{"id":"one","kind":"text","x":1,"y":2,"color":"#000000","text":"内容"},{"id":"two","kind":"image","x":4,"y":5,"color":"#ffffff","fileId":%d}]`, image.ID))
	notes := "备注"
	source, err := st.UpdateSlidesPage(ctx, g, pages[0].ID, "标题", "正文", "#123456", &notes, &shapes, pages[0].Revision)
	if err != nil {
		t.Fatal(err)
	}
	paste := st.(store.SlidesPasteStore)
	otherDeck, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "Other", true)
	if err != nil {
		t.Fatal(err)
	}
	otherPages, err := st.ListSlidesPages(ctx, u.ID, otherDeck.ID)
	if err != nil || len(otherPages) != 1 {
		t.Fatalf("other deck: %+v %v", otherPages, err)
	}
	if _, err = paste.PasteSlidesPage(ctx, g, deck.ID, otherPages[0].ID, otherPages[0].Revision, second.ID, second.Revision); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross deck: %v", err)
	}
	if _, err = paste.PasteSlidesPage(ctx, g, deck.ID, source.ID, source.Revision-1, second.ID, second.Revision); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale source: %v", err)
	}
	if _, err = paste.PasteSlidesPage(ctx, g, deck.ID, source.ID, source.Revision, second.ID, second.Revision+1); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale anchor: %v", err)
	}
	pasted, err := paste.PasteSlidesPage(ctx, g, deck.ID, source.ID, source.Revision, second.ID, second.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if pasted.ID == source.ID || pasted.Title != source.Title || pasted.Body != source.Body || pasted.Notes != source.Notes || pasted.Background != source.Background || pasted.Revision != 1 {
		t.Fatalf("paste: %+v", pasted)
	}
	var a, b any
	if json.Unmarshal(source.Shapes, &a) != nil || json.Unmarshal(pasted.Shapes, &b) != nil || !reflect.DeepEqual(a, b) {
		t.Fatalf("shapes: %s", pasted.Shapes)
	}
	pages, err = st.ListSlidesPages(ctx, u.ID, deck.ID)
	if err != nil || len(pages) != 4 || pages[0].ID != source.ID || pages[1].ID != second.ID || pages[2].ID != pasted.ID || pages[3].ID != third.ID {
		t.Fatalf("order: %+v %v", pages, err)
	}
	concurrent, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	results := make(chan error, 2)
	for range 2 {
		go func() {
			_, e := paste.PasteSlidesPage(concurrent, g, deck.ID, source.ID, source.Revision, second.ID, second.Revision)
			results <- e
		}()
	}
	for range 2 {
		if e := <-results; e != nil {
			t.Fatalf("concurrent paste: %v", e)
		}
	}
	pages, err = st.ListSlidesPages(ctx, u.ID, deck.ID)
	if err != nil || len(pages) != 6 {
		t.Fatalf("concurrent pages: %+v %v", pages, err)
	}
	for i := 1; i < len(pages); i++ {
		if pages[i-1].Pos >= pages[i].Pos {
			t.Fatalf("duplicate order: %+v", pages)
		}
	}
	editor, _, err := st.CreateUser(ctx, "paste-slide-editor@example.test", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	eg := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("paste-slide-editor")}
	if err = st.CreateSession(ctx, eg.SessionHash, editor.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, deck.ID, editor.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = paste.PasteSlidesPage(ctx, eg, deck.ID, source.ID, source.Revision, second.ID, second.Revision); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer: %v", err)
	}
	if err = st.SetShare(ctx, deck.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err = st.PatchManagedDocGuarded(ctx, g, deck.ID, store.ManagedDocPatch{CopyProtected: true}); err != nil {
		t.Fatal(err)
	}
	if _, err = paste.PasteSlidesPage(ctx, eg, deck.ID, source.ID, source.Revision, second.ID, second.Revision); !errors.Is(err, store.ErrCopyProtected) {
		t.Fatalf("protected: %v", err)
	}
	if err = st.DeleteSession(ctx, g.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = paste.PasteSlidesPage(ctx, g, deck.ID, source.ID, source.Revision, second.ID, second.Revision); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("revoked: %v", err)
	}
}
func TestMemoryPasteSlide(t *testing.T)   { exercisePasteSlide(t, store.NewMemory()) }
func TestPostgresPasteSlide(t *testing.T) { exercisePasteSlide(t, atomicPostgres(t)) }
