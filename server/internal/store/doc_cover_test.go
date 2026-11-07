package store_test

import (
	"context"
	"errors"
	"math"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestCoverValidation(t *testing.T) {
	valid := []store.DocCover{{Kind: "none", Position: 0.5}, {Kind: "builtin", Asset: "misty-lake", Position: 0}, {Kind: "file", FileID: 1, Position: 1}}
	for _, c := range valid {
		if !store.ValidDocCover(c) {
			t.Errorf("valid rejected: %+v", c)
		}
	}
	invalid := []store.DocCover{{Kind: "file", Position: 0.5}, {Kind: "builtin", Asset: "https://example.test", Position: 0.5}, {Kind: "builtin", Asset: "unknown", Position: 0.5}, {Kind: "none", FileID: 1, Position: 0.5}, {Kind: "file", FileID: 1, Position: math.NaN()}, {Kind: "none", Position: 2}}
	for _, c := range invalid {
		if store.ValidDocCover(c) {
			t.Errorf("invalid accepted: %+v", c)
		}
	}
}

func exerciseDocCover(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	parent, child, editor, viewer, guard := guardedSharingFixture(t, st)
	viewerGuard := store.RestoreGuard{UserID: viewer.ID, SessionHash: []byte("cover-viewer")}
	if err := st.CreateSession(ctx, viewerGuard.SessionHash, viewer.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, child.ID, viewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	initial, err := st.DocCoverGuarded(ctx, viewerGuard, child.ID)
	if err != nil || initial.Kind != "none" || initial.Revision != 0 || initial.Position != 0.5 {
		t.Fatalf("initial cover: %+v %v", initial, err)
	}
	builtin := store.DocCover{Kind: "builtin", Asset: "misty-lake", Position: 0.25}
	if _, err = st.SetDocCoverGuarded(ctx, viewerGuard, child.ID, builtin, 0); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer wrote: %v", err)
	}
	if _, err = st.SetDocCoverGuarded(ctx, guard, child.ID, builtin, 0); err != nil {
		t.Fatal(err)
	}
	if _, err = st.SetDocCoverGuarded(ctx, guard, child.ID, builtin, 0); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale CAS: %v", err)
	}
	foreign, err := st.CreateFile(ctx, store.FileMeta{DocID: parent.ID, UploaderID: editor.ID, Name: "foreign.png", Mime: "image/png", ObjectKey: "foreign", Size: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.SetDocCoverGuarded(ctx, guard, child.ID, store.DocCover{Kind: "file", FileID: foreign.ID, Position: 0.5}, 1); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("foreign file accepted: %v", err)
	}
	file, err := st.CreateFile(ctx, store.FileMeta{DocID: child.ID, UploaderID: editor.ID, Name: "cover.png", Mime: "image/png", ObjectKey: "cover", Size: 1})
	if err != nil {
		t.Fatal(err)
	}
	fileCover := store.DocCover{Kind: "file", FileID: file.ID, Position: 0.6}
	written, err := st.SetDocCoverGuarded(ctx, guard, child.ID, fileCover, 1)
	if err != nil || written.Revision != 2 {
		t.Fatalf("file cover: %+v %v", written, err)
	}
	spaces, err := st.Workspaces(ctx, editor.ID)
	if err != nil || len(spaces) == 0 {
		t.Fatalf("workspace: %v", err)
	}
	copyMeta, err := st.CopyDoc(ctx, store.DocCopy{SourceID: child.ID, UserID: editor.ID, WorkspaceID: spaces[0].ID, Title: "Copy", FileIDs: []int64{file.ID}, Guard: &guard, Cover: &written}, func(map[int64]int64) ([]store.RawOp, error) { return nil, nil })
	if err != nil {
		t.Fatalf("copy: %v", err)
	}
	copyCover, err := st.DocCoverSystem(ctx, copyMeta.ID)
	if err != nil || copyCover.Kind != "file" || copyCover.FileID == file.ID || copyCover.Position != written.Position {
		t.Fatalf("copy cover: %+v %v", copyCover, err)
	}
	copyFile, err := st.GetFile(ctx, copyCover.FileID)
	if err != nil || copyFile.DocID != copyMeta.ID || copyFile.ObjectKey != file.ObjectKey {
		t.Fatalf("copy attachment: %+v %v", copyFile, err)
	}
	if _, err = st.SetDocCoverGuarded(ctx, guard, child.ID, builtin, 2); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CopyDoc(ctx, store.DocCopy{SourceID: child.ID, UserID: editor.ID, WorkspaceID: spaces[0].ID, Title: "Stale", FileIDs: []int64{file.ID}, Guard: &guard, Cover: &written}, func(map[int64]int64) ([]store.RawOp, error) { return nil, nil }); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale cover copy: %v", err)
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, e := st.SetDocCoverGuarded(ctx, guard, child.ID, builtin, 3); results <- e }()
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
		t.Fatalf("concurrent: %d success %d conflict", success, conflicts)
	}
	if err = st.SetShare(ctx, parent.ID, editor.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = st.SetDocCoverGuarded(ctx, guard, child.ID, builtin, 4); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("revoked editor: %v", err)
	}
}

func TestMemoryDocCover(t *testing.T) { exerciseDocCover(t, store.NewMemory()) }

func TestPostgresDocCover(t *testing.T) {
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
	if _, err = pg.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err = migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	exerciseDocCover(t, pg)
	if _, err = pg.Pool.Exec(ctx, `UPDATE nodes SET cover_kind='file',cover_file_id=NULL,cover_revision=cover_revision+1 WHERE kind='doc'`); err == nil {
		t.Fatal("NULL file cover accepted")
	}
}
