package store_test

import (
	"bytes"
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
	root, err := st.CreateDriveFolder(ctx, guard, ws.ID, nil, "Root", false)
	if err != nil {
		t.Fatal(err)
	}
	child, err := st.CreateDriveFolder(ctx, guard, ws.ID, &root.ID, "Child", false)
	if err != nil {
		t.Fatal(err)
	}
	grand, err := st.CreateDriveFolder(ctx, guard, ws.ID, &child.ID, "Previously deleted", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.CreateDriveFolder(ctx, other, ws.ID, nil, "unauthorized", false); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("outside root workspace: %v", err)
	}
	if err = st.SetShare(ctx, root.ID, outsider.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = st.ListDriveChildren(ctx, other, ws.ID, &root.ID, false); err != nil {
		t.Fatalf("inherited viewer listing: %v", err)
	}
	if _, err = st.CreateDriveFolder(ctx, other, ws.ID, &root.ID, "unauthorized", false); !errors.Is(err, store.ErrForbidden) {
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
	entries, err := st.ListDriveChildren(ctx, guard, ws.ID, &root.ID, false)
	if err != nil || len(entries) != 1 || entries[0].ID != child.ID {
		t.Fatalf("restored child: %+v %v", entries, err)
	}
	entries, err = st.ListDriveChildren(ctx, guard, ws.ID, &child.ID, false)
	if err != nil || len(entries) != 0 {
		t.Fatalf("prior deletion was undone: %+v %v", entries, err)
	}
	// Guarded creation of docs/bases inside folders; the fence triggers reject
	// the legacy creation paths there.
	docNode, err := st.CreateDriveNode(ctx, guard, ws.ID, &root.ID, "doc", "Folder doc", false)
	if err != nil {
		t.Fatalf("create drive doc: %v", err)
	}
	ops, err := st.OpsAfter(ctx, docNode.ID, 0, 10)
	initial := store.InitialDocOps("Folder doc")
	if err != nil || len(ops) != len(initial) {
		t.Fatalf("initial drive document ops: %v %v", ops, err)
	}
	for i := range initial {
		if ops[i].Seq != int64(i+1) || !bytes.Equal(ops[i].Bytes, initial[i].Bytes) {
			t.Fatalf("initial operation %d differs", i)
		}
	}
	baseNode, err := st.CreateDriveNode(ctx, guard, ws.ID, &root.ID, "base", "Folder base", false)
	if err != nil {
		t.Fatalf("create drive base: %v", err)
	}
	if _, err = st.CreateDriveNode(ctx, guard, ws.ID, &root.ID, "wiki", "bad kind", false); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("bad kind: %v", err)
	}
	entries, err = st.ListDriveChildren(ctx, guard, ws.ID, &root.ID, false)
	if err != nil || len(entries) != 3 {
		t.Fatalf("folder children after create: %+v %v", entries, err)
	}
	if docNode.Revision != 1 || docNode.Kind != "doc" || baseNode.Kind != "base" {
		t.Fatalf("created entries: %+v %+v", docNode, baseNode)
	}
	if _, err = st.CreateDriveNode(ctx, other, ws.ID, &root.ID, "doc", "unauthorized", false); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer cannot create doc: %v", err)
	}
	// 我的空间：personal 节点对其他成员（含 workspace owner）不可见、不可编辑；
	// 子节点继承空间；跨空间移动被拒；回收后不泄漏到他人回收站。
	if err = st.AddWorkspaceMember(ctx, ws.ID, outsider.ID); err != nil {
		t.Fatalf("add member: %v", err)
	}
	mine, err := st.CreateDriveFolder(ctx, guard, ws.ID, nil, "我的空间根", true)
	if err != nil {
		t.Fatalf("personal create: %v", err)
	}
	if !mine.Personal {
		t.Fatalf("personal flag missing: %+v", mine)
	}
	mineDoc, err := st.CreateDriveNode(ctx, guard, ws.ID, &mine.ID, "doc", "私有文档", false)
	if err != nil {
		t.Fatalf("personal child create: %v", err)
	}
	if !mineDoc.Personal {
		t.Fatalf("child scope not inherited: %+v", mineDoc)
	}
	if entries, e := st.ListDriveChildren(ctx, guard, ws.ID, nil, true); e != nil || len(entries) != 1 || entries[0].ID != mine.ID {
		t.Fatalf("personal root listing: %+v %v", entries, e)
	}
	if entries, e := st.ListDriveChildren(ctx, other, ws.ID, nil, true); e != nil || len(entries) != 0 {
		t.Fatalf("member sees another user's personal scope: %+v %v", entries, e)
	}
	if _, e := st.ListDriveChildren(ctx, other, ws.ID, &mine.ID, false); !errors.Is(e, store.ErrForbidden) {
		t.Fatalf("member lists personal folder: %v", e)
	}
	otherDocs, e := st.ListDocs(ctx, outsider.ID)
	if e != nil {
		t.Fatal(e)
	}
	for _, d := range otherDocs {
		if d.ID == mine.ID || d.ID == mineDoc.ID {
			t.Fatalf("personal node leaked to member doc list: %+v", d)
		}
	}
	if e := st.MoveDriveNode(ctx, guard, mineDoc.ID, &root.ID, mineDoc.Revision); !errors.Is(e, store.ErrForbidden) {
		t.Fatalf("cross-scope move: %v", e)
	}
	if e := st.TrashDriveNode(ctx, guard, mineDoc.ID, mineDoc.Revision); e != nil {
		t.Fatalf("trash personal doc: %v", e)
	}
	trashList, e := st.ListTrash(ctx, outsider.ID)
	if e != nil {
		t.Fatal(e)
	}
	for _, d := range trashList {
		if d.ID == mineDoc.ID {
			t.Fatalf("personal trash leaked to member: %+v", d)
		}
	}
	if e := st.RestoreDriveNode(ctx, guard, mineDoc.ID, mineDoc.Revision+1); e != nil {
		t.Fatalf("creator restores personal doc: %v", err)
	}
	if err = st.RestoreDriveNode(ctx, guard, grand.ID, grand.Revision+1); err != nil {
		t.Fatalf("restore earlier batch: %v", err)
	}
	expired := guard
	expired.Now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if _, err = st.CreateDriveFolder(ctx, expired, ws.ID, nil, "expired", false); !errors.Is(err, store.ErrUnauthenticated) {
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
