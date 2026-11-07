package store_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func exerciseDriveFolders(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "drive-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	outsider, _, err := st.CreateUser(ctx, "drive-outsider@example.test", "Outsider", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("drive-owner-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	other := store.RestoreGuard{UserID: outsider.ID, SessionHash: []byte("drive-outsider-session")}
	if err = st.CreateSession(ctx, other.SessionHash, outsider.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	root, err := st.CreateDriveFolder(ctx, guard, ws.ID, nil, "Root")
	if err != nil {
		t.Fatal(err)
	}
	child, err := st.CreateDriveFolder(ctx, guard, ws.ID, &root.ID, "Child")
	if err != nil {
		t.Fatal(err)
	}
	grand, err := st.CreateDriveFolder(ctx, guard, ws.ID, &child.ID, "Previously deleted")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.CreateDriveFolder(ctx, other, ws.ID, nil, "unauthorized"); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("outside root workspace: %v", err)
	}
	if err = st.SetShare(ctx, root.ID, outsider.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = st.ListDriveChildren(ctx, other, ws.ID, &root.ID); err != nil {
		t.Fatalf("inherited viewer listing: %v", err)
	}
	if _, err = st.CreateDriveFolder(ctx, other, ws.ID, &root.ID, "unauthorized"); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer cannot create: %v", err)
	}
	if err = st.MoveDriveNode(ctx, guard, root.ID, &grand.ID, root.Revision); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("cycle: %v", err)
	}
	if err = st.TrashDriveNode(ctx, guard, grand.ID, grand.Revision); err != nil {
		t.Fatalf("trash grand: %v", err)
	}
	if err = st.TrashDriveNode(ctx, guard, root.ID, root.Revision); err != nil {
		t.Fatalf("trash root: %v", err)
	}
	// Legacy (pre-drive) deletions carry no trash batch; the guarded restore
	// must still accept them using the revision the trash listing reports.
	legacy, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Legacy", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.Trash(ctx, legacy.ID); err != nil {
		t.Fatalf("legacy trash: %v", err)
	}
	trash, err := st.ListTrash(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	var legacyListed *store.DocMeta
	for i := range trash {
		if trash[i].ID == legacy.ID {
			legacyListed = &trash[i]
		}
	}
	if legacyListed == nil || legacyListed.DriveRevision != 0 || legacyListed.TrashBatchID != 0 {
		t.Fatalf("legacy trash meta: %+v", legacyListed)
	}
	if err = st.RestoreDriveNode(ctx, guard, legacy.ID, legacyListed.DriveRevision); err != nil {
		t.Fatalf("guarded restore of legacy deletion: %v", err)
	}
	if docs, e := st.ListDocs(ctx, owner.ID); e != nil || len(docs) == 0 {
		t.Fatalf("legacy restore listed: %v %v", docs, e)
	}
	if err = st.RestoreDriveNode(ctx, guard, root.ID, root.Revision+1); err != nil {
		t.Fatalf("restore root: %v", err)
	}
	entries, err := st.ListDriveChildren(ctx, guard, ws.ID, &root.ID)
	if err != nil || len(entries) != 1 || entries[0].ID != child.ID {
		t.Fatalf("restored child: %+v %v", entries, err)
	}
	entries, err = st.ListDriveChildren(ctx, guard, ws.ID, &child.ID)
	if err != nil || len(entries) != 0 {
		t.Fatalf("prior deletion was undone: %+v %v", entries, err)
	}
	// Guarded creation of docs/bases inside folders; the fence triggers reject
	// the legacy creation paths there.
	docNode, err := st.CreateDriveNode(ctx, guard, ws.ID, &root.ID, "doc", "Folder doc")
	if err != nil {
		t.Fatalf("create drive doc: %v", err)
	}
	baseNode, err := st.CreateDriveNode(ctx, guard, ws.ID, &root.ID, "base", "Folder base")
	if err != nil {
		t.Fatalf("create drive base: %v", err)
	}
	if _, err = st.CreateDriveNode(ctx, guard, ws.ID, &root.ID, "wiki", "bad kind"); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("bad kind: %v", err)
	}
	entries, err = st.ListDriveChildren(ctx, guard, ws.ID, &root.ID)
	if err != nil || len(entries) != 3 {
		t.Fatalf("folder children after create: %+v %v", entries, err)
	}
	if docNode.Revision != 1 || docNode.Kind != "doc" || baseNode.Kind != "base" {
		t.Fatalf("created entries: %+v %+v", docNode, baseNode)
	}
	if _, err = st.CreateDriveNode(ctx, other, ws.ID, &root.ID, "doc", "unauthorized"); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer cannot create doc: %v", err)
	}
	if err = st.RestoreDriveNode(ctx, guard, grand.ID, grand.Revision+1); err != nil {
		t.Fatalf("restore earlier batch: %v", err)
	}
	expired := guard
	expired.Now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if _, err = st.CreateDriveFolder(ctx, expired, ws.ID, nil, "expired"); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expired create: %v", err)
	}
	if err = st.DeleteSession(ctx, guard.SessionHash); err != nil {
		t.Fatal(err)
	}
	if err = st.MoveDriveNode(ctx, guard, child.ID, nil, child.Revision+2); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("logged out move: %v", err)
	}
}
func TestMemoryDriveFolders(t *testing.T) { exerciseDriveFolders(t, store.NewMemory()) }
func TestPostgresDriveFolders(t *testing.T) {
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
	exerciseDriveFolders(t, pg)
}
