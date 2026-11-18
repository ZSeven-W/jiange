package store_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func exerciseDocType(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "board-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := st.CreateUser(ctx, "board-guest@example.test", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("board-owner-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	if _, err = st.CreateDocWithType(ctx, ws.ID, owner.ID, nil, "bad", "diagram", nil); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("expected conflict for invalid CreateDocWithType docType, got %v", err)
	}
	for _, kind := range []string{"base", "slides", "folder"} {
		if _, err = st.CreateDriveNodeWithType(ctx, guard, ws.ID, nil, kind, store.DocTypeBoard, "bad", true); !errors.Is(err, store.ErrConflict) {
			t.Fatalf("expected conflict for kind=%s with board docType, got %v", kind, err)
		}
	}
	if _, err = st.CreateDriveNodeWithType(ctx, guard, ws.ID, nil, "doc", "other", "bad", true); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("expected conflict for unknown drive docType, got %v", err)
	}

	folder, err := st.CreateDriveFolder(ctx, guard, ws.ID, nil, "白板目录", true)
	if err != nil {
		t.Fatal(err)
	}
	sharedFolder, err := st.CreateDriveFolder(ctx, guard, ws.ID, nil, "共享白板目录", false)
	if err != nil {
		t.Fatal(err)
	}
	boardDoc, err := st.CreateDocWithType(ctx, ws.ID, owner.ID, nil, "架构画板", store.DocTypeBoard, store.InitialDocOps("架构画板"))
	if err != nil {
		t.Fatal(err)
	}
	if boardDoc.DocType != store.DocTypeBoard || boardDoc.Kind != "doc" {
		t.Fatalf("CreateDocWithType: %+v", boardDoc)
	}

	sharedDriveBoard, err := st.CreateDriveNodeWithType(ctx, guard, ws.ID, &sharedFolder.ID, "doc", store.DocTypeBoard, "共享画板", false)
	if err != nil {
		t.Fatal(err)
	}
	if sharedDriveBoard.DocType != store.DocTypeBoard || sharedDriveBoard.Kind != "doc" {
		t.Fatalf("CreateDriveNodeWithType shared: %+v", sharedDriveBoard)
	}

	boardDrive, err := st.CreateDriveNodeWithType(ctx, guard, ws.ID, &folder.ID, "doc", store.DocTypeBoard, "目录画板", true)
	if err != nil {
		t.Fatal(err)
	}
	if boardDrive.DocType != store.DocTypeBoard || boardDrive.Kind != "doc" {
		t.Fatalf("CreateDriveNodeWithType: %+v", boardDrive)
	}

	plainDoc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "普通文档", store.InitialDocOps("普通文档"))
	if err != nil {
		t.Fatal(err)
	}
	if plainDoc.DocType != "" {
		t.Fatalf("plain doc DocType = %q", plainDoc.DocType)
	}

	// SetCreatedDocType constraints: creator-only, once-only, doc-only, non-deleted only.
	if err = st.SetCreatedDocType(ctx, plainDoc.ID, guest.ID, store.DocTypeBoard); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("non-creator SetCreatedDocType: got %v", err)
	}
	if err = st.SetCreatedDocType(ctx, folder.ID, owner.ID, store.DocTypeBoard); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("folder SetCreatedDocType: got %v", err)
	}
	if err = st.SetCreatedDocType(ctx, plainDoc.ID, owner.ID, "invalid"); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("invalid SetCreatedDocType: got %v", err)
	}
	if err = st.SetCreatedDocType(ctx, boardDoc.ID, owner.ID, store.DocTypeBoard); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("already-typed SetCreatedDocType: got %v", err)
	}

	// Verify DocType survives all read/projection paths.
	got, err := st.GetDoc(ctx, owner.ID, boardDrive.ID)
	if err != nil || got.DocType != store.DocTypeBoard {
		t.Fatalf("GetDoc: %+v err=%v", got, err)
	}
	sysGot, err := st.GetDocSystem(ctx, boardDrive.ID)
	if err != nil || sysGot.DocType != store.DocTypeBoard {
		t.Fatalf("GetDocSystem: %+v err=%v", sysGot, err)
	}
	docs, err := st.ListDocs(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	var foundInDocs bool
	for _, item := range docs {
		if item.ID == boardDrive.ID && item.DocType == store.DocTypeBoard {
			foundInDocs = true
		}
	}
	if !foundInDocs {
		t.Fatalf("ListDocs missing board DocType: %+v", docs)
	}
	personalChildren, err := st.ListDriveChildren(ctx, guard, ws.ID, &folder.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(personalChildren) != 1 || personalChildren[0].ID != boardDrive.ID || personalChildren[0].DocType != store.DocTypeBoard {
		t.Fatalf("ListDriveChildren personal: got %+v", personalChildren)
	}
	sharedChildren, err := st.ListDriveChildren(ctx, guard, ws.ID, &sharedFolder.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(sharedChildren) != 1 || sharedChildren[0].ID != sharedDriveBoard.ID || sharedChildren[0].DocType != store.DocTypeBoard {
		t.Fatalf("ListDriveChildren shared: got %+v", sharedChildren)
	}
	renamed, err := st.RenameDriveNode(ctx, guard, boardDrive.ID, "改名画板", boardDrive.Revision)
	if err != nil || renamed.DocType != store.DocTypeBoard {
		t.Fatalf("RenameDriveNode dropped DocType: %+v err=%v", renamed, err)
	}
	if err = st.AddFavorite(ctx, owner.ID, boardDrive.ID); err != nil {
		t.Fatal(err)
	}
	favs, err := st.ListFavorites(ctx, owner.ID)
	if err != nil || len(favs) != 1 || favs[0].DocType != store.DocTypeBoard {
		t.Fatalf("ListFavorites: %+v err=%v", favs, err)
	}
	if pinsStore, ok := st.(interface {
		AddPin(context.Context, int64, int64) error
		ListPins(context.Context, int64) ([]store.DocMeta, error)
	}); ok {
		if err = pinsStore.AddPin(ctx, owner.ID, boardDrive.ID); err != nil {
			t.Fatal(err)
		}
		pins, err := pinsStore.ListPins(ctx, owner.ID)
		if err != nil || len(pins) != 1 || pins[0].DocType != store.DocTypeBoard {
			t.Fatalf("ListPins: %+v err=%v", pins, err)
		}
	}
	if err = st.RecordVisit(ctx, owner.ID, boardDrive.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	recents, err := st.RecentDocs(ctx, owner.ID, 10)
	if err != nil || len(recents) != 1 || recents[0].DocType != store.DocTypeBoard {
		t.Fatalf("RecentDocs: %+v err=%v", recents, err)
	}
	searched, err := st.SearchDocs(ctx, owner.ID, "改名画板")
	if err != nil || len(searched) != 1 || searched[0].DocType != store.DocTypeBoard {
		t.Fatalf("SearchDocs: %+v err=%v", searched, err)
	}
	candidates, err := st.SearchCandidates(ctx, owner.ID, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	var foundCand bool
	for _, cand := range candidates {
		if cand.ID == boardDrive.ID && cand.DocType == store.DocTypeBoard {
			foundCand = true
		}
	}
	if !foundCand {
		t.Fatalf("SearchCandidates missing board DocType: %+v", candidates)
	}
	if err = st.SetShare(ctx, boardDrive.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	shared, err := st.SharedWithMe(ctx, guest.ID)
	if err != nil || len(shared) != 1 || shared[0].DocType != store.DocTypeBoard {
		t.Fatalf("SharedWithMe: %+v err=%v", shared, err)
	}
	childInsideBoard, err := st.CreateDocWithType(ctx, ws.ID, owner.ID, &boardDoc.ID, "子页", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	ancestors, err := st.Ancestors(ctx, owner.ID, childInsideBoard.ID)
	if err != nil || len(ancestors) != 1 || ancestors[0].ID != boardDoc.ID || ancestors[0].DocType != store.DocTypeBoard {
		t.Fatalf("Ancestors: %+v err=%v", ancestors, err)
	}

	copied, err := st.CopyDoc(ctx, store.DocCopy{SourceID: boardDrive.ID, UserID: owner.ID, WorkspaceID: ws.ID, Title: "副本画板", Guard: &guard}, func(_ map[int64]int64) ([]store.RawOp, error) {
		return store.InitialDocOps("副本画板"), nil
	})
	if err != nil || copied.DocType != store.DocTypeBoard {
		t.Fatalf("CopyDoc dropped DocType: %+v err=%v", copied, err)
	}

	if err = st.TrashDriveNode(ctx, guard, boardDrive.ID, renamed.Revision); err != nil {
		t.Fatal(err)
	}
	trash, err := st.ListTrash(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	var foundTrash bool
	for _, item := range trash {
		if item.ID == boardDrive.ID && item.DocType == store.DocTypeBoard {
			foundTrash = true
		}
	}
	if !foundTrash {
		t.Fatalf("ListTrash missing board DocType: %+v", trash)
	}
}

func TestMemoryDocType(t *testing.T) {
	exerciseDocType(t, store.NewMemory())
}

func TestPostgresDocType(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := store.NewPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := pgx.Identifier{fmt.Sprintf("doc_type_%d", time.Now().UnixNano())}.Sanitize()
	if _, err = admin.Pool.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Pool.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	exerciseDocType(t, &store.Postgres{Pool: pool})
}
