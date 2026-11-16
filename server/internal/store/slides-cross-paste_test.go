package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func exerciseCrossPasteSlide(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "cross-slide@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("cross-slide-session")}
	if err = st.CreateSession(ctx, g.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	sourceDeck, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "Source", true)
	if err != nil {
		t.Fatal(err)
	}
	targetDeck, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "Target", true)
	if err != nil {
		t.Fatal(err)
	}
	sourcePages, err := st.ListSlidesPages(ctx, owner.ID, sourceDeck.ID)
	if err != nil || len(sourcePages) != 1 {
		t.Fatal(err)
	}
	targetPages, err := st.ListSlidesPages(ctx, owner.ID, targetDeck.ID)
	if err != nil || len(targetPages) != 1 {
		t.Fatal(err)
	}
	image, err := st.CreateSlidesFile(ctx, g, sourceDeck.ID, store.FileMeta{Name: "fixture.png", Mime: "image/png", Size: 3, ObjectKey: "slides/test/image"})
	if err != nil {
		t.Fatal(err)
	}
	shapes := json.RawMessage(fmt.Sprintf(`[{"id":"t","kind":"text","x":1,"y":1,"color":"#000000","text":"文字"},{"id":"i","kind":"image","x":2,"y":2,"color":"#ffffff","fileId":%d}]`, image.ID))
	notes := "备注"
	source, err := st.UpdateSlidesPage(ctx, g, sourcePages[0].ID, "标题", "正文", "#123456", &notes, &shapes, sourcePages[0].Revision)
	if err != nil {
		t.Fatal(err)
	}
	anchor := targetPages[0]
	paste := st.(store.SlidesCrossPasteStore)
	if _, _, err = paste.PasteSlidesPageFrom(ctx, g, targetDeck.ID, sourceDeck.ID, source.ID, source.Revision, anchor.ID, anchor.Revision, []int64{}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("unverified image: %v", err)
	}
	if _, _, err = paste.PasteSlidesPageFrom(ctx, g, targetDeck.ID, sourceDeck.ID, source.ID, source.Revision+1, anchor.ID, anchor.Revision, []int64{image.ID}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale source: %v", err)
	}
	if _, _, err = paste.PasteSlidesPageFrom(ctx, g, targetDeck.ID, sourceDeck.ID, source.ID, source.Revision, anchor.ID, anchor.Revision+1, []int64{image.ID}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale target: %v", err)
	}
	if pg, ok := st.(*store.Postgres); ok {
		var before int
		if err = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM attachments WHERE doc_id=$1`, targetDeck.ID).Scan(&before); err != nil {
			t.Fatal(err)
		}
		if _, err = pg.Pool.Exec(ctx, `CREATE FUNCTION fail_cross_slide_paste() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$; CREATE TRIGGER fail_cross_slide_paste BEFORE INSERT ON slides_pages FOR EACH ROW EXECUTE FUNCTION fail_cross_slide_paste()`); err != nil {
			t.Fatal(err)
		}
		if _, _, err = paste.PasteSlidesPageFrom(ctx, g, targetDeck.ID, sourceDeck.ID, source.ID, source.Revision, anchor.ID, anchor.Revision, []int64{image.ID}); err == nil {
			t.Fatal("expected injected failure")
		}
		if _, err = pg.Pool.Exec(ctx, `DROP TRIGGER fail_cross_slide_paste ON slides_pages; DROP FUNCTION fail_cross_slide_paste()`); err != nil {
			t.Fatal(err)
		}
		var after int
		if err = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM attachments WHERE doc_id=$1`, targetDeck.ID).Scan(&after); err != nil || before != after {
			t.Fatalf("attachment rollback: %d -> %d, %v", before, after, err)
		}
		pages, e := st.ListSlidesPages(ctx, owner.ID, targetDeck.ID)
		if e != nil || len(pages) != 1 {
			t.Fatalf("page rollback: %+v %v", pages, e)
		}
	}
	result, mapping, err := paste.PasteSlidesPageFrom(ctx, g, targetDeck.ID, sourceDeck.ID, source.ID, source.Revision, anchor.ID, anchor.Revision, []int64{image.ID})
	if err != nil {
		t.Fatal(err)
	}
	if result.SlidesID != targetDeck.ID || result.Title != source.Title || result.Body != source.Body || result.Notes != source.Notes || result.Background != source.Background || result.Revision != 1 || mapping[image.ID] <= 0 || mapping[image.ID] == image.ID {
		t.Fatalf("copy: %+v mapping=%v", result, mapping)
	}
	var resultShapes []struct {
		Kind   string `json:"kind"`
		FileID int64  `json:"fileId"`
	}
	if err = json.Unmarshal(result.Shapes, &resultShapes); err != nil || len(resultShapes) != 2 || resultShapes[1].FileID != mapping[image.ID] {
		t.Fatalf("shapes: %s %v", result.Shapes, err)
	}
	newFile, err := st.GetFile(ctx, mapping[image.ID])
	if err != nil || newFile.DocID != targetDeck.ID || newFile.ObjectKey != image.ObjectKey {
		t.Fatalf("image: %+v %v", newFile, err)
	}
	targetPages, err = st.ListSlidesPages(ctx, owner.ID, targetDeck.ID)
	if err != nil || len(targetPages) != 2 || targetPages[0].ID != anchor.ID || targetPages[1].ID != result.ID {
		t.Fatalf("order: %+v %v", targetPages, err)
	}
	concurrent, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	errorsCh := make(chan error, 2)
	go func() {
		_, _, e := paste.PasteSlidesPageFrom(concurrent, g, targetDeck.ID, sourceDeck.ID, source.ID, source.Revision, anchor.ID, anchor.Revision, []int64{image.ID})
		errorsCh <- e
	}()
	go func() {
		_, _, e := paste.PasteSlidesPageFrom(concurrent, g, sourceDeck.ID, targetDeck.ID, anchor.ID, anchor.Revision, source.ID, source.Revision, []int64{})
		errorsCh <- e
	}()
	for range 2 {
		if e := <-errorsCh; e != nil {
			t.Fatalf("concurrent cross paste: %v", e)
		}
	}
	guest, _, err := st.CreateUser(ctx, "cross-slide-guest@example.test", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	gg := store.RestoreGuard{UserID: guest.ID, SessionHash: []byte("cross-slide-guest")}
	if err = st.CreateSession(ctx, gg.SessionHash, guest.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, sourceDeck.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, targetDeck.ID, guest.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if _, _, err = paste.PasteSlidesPageFrom(ctx, gg, targetDeck.ID, sourceDeck.ID, source.ID, source.Revision, anchor.ID, anchor.Revision, []int64{image.ID}); err != nil {
		t.Fatalf("viewer source: %v", err)
	}
	if err = st.SetShare(ctx, targetDeck.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, _, err = paste.PasteSlidesPageFrom(ctx, gg, targetDeck.ID, sourceDeck.ID, source.ID, source.Revision, anchor.ID, anchor.Revision, []int64{image.ID}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer target: %v", err)
	}
	if err = st.SetShare(ctx, targetDeck.ID, guest.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err = st.PatchManagedDocGuarded(ctx, g, sourceDeck.ID, store.ManagedDocPatch{CopyProtected: true}); err != nil {
		t.Fatal(err)
	}
	if _, _, err = paste.PasteSlidesPageFrom(ctx, gg, targetDeck.ID, sourceDeck.ID, source.ID, source.Revision, anchor.ID, anchor.Revision, []int64{image.ID}); !errors.Is(err, store.ErrCopyProtected) {
		t.Fatalf("protected source: %v", err)
	}
	if err = st.TrashDriveNode(ctx, g, sourceDeck.ID, sourceDeck.Revision); err != nil {
		t.Fatal(err)
	}
	freed, err := st.PurgeDriveNode(ctx, g, sourceDeck.ID, sourceDeck.Revision+1)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range freed {
		if key == image.ObjectKey {
			t.Fatalf("shared object unexpectedly freed: %q", key)
		}
	}
	if copied, err := st.GetFile(ctx, mapping[image.ID]); err != nil || copied.ObjectKey != image.ObjectKey {
		t.Fatalf("target image after source removal: %+v %v", copied, err)
	}
}
func TestMemoryCrossPasteSlide(t *testing.T)   { exerciseCrossPasteSlide(t, store.NewMemory()) }
func TestPostgresCrossPasteSlide(t *testing.T) { exerciseCrossPasteSlide(t, atomicPostgres(t)) }
