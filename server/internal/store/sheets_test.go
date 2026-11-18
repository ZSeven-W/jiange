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

func strPtr(s string) *string { return &s }

func exerciseSheetStore(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "sheet-owner@example.test", "SheetOwner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := st.CreateUser(ctx, "sheet-editor@example.test", "SheetEditor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	viewer, viewerWS, err := st.CreateUser(ctx, "sheet-viewer@example.test", "SheetViewer", "hash")
	if err != nil {
		t.Fatal(err)
	}
	outsider, _, err := st.CreateUser(ctx, "sheet-outsider@example.test", "Outsider", "hash")
	if err != nil {
		t.Fatal(err)
	}
	ownerGuard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("sheet-owner-sess")}
	editorGuard := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("sheet-editor-sess")}
	viewerGuard := store.RestoreGuard{UserID: viewer.ID, SessionHash: []byte("sheet-viewer-sess")}
	outsiderGuard := store.RestoreGuard{UserID: outsider.ID, SessionHash: []byte("sheet-outsider-sess")}
	for _, item := range []struct {
		id   int64
		hash []byte
	}{
		{owner.ID, ownerGuard.SessionHash},
		{editor.ID, editorGuard.SessionHash},
		{viewer.ID, viewerGuard.SessionHash},
		{outsider.ID, outsiderGuard.SessionHash},
	} {
		if err = st.CreateSession(ctx, item.hash, item.id, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}

	folder, err := st.CreateDriveFolder(ctx, ownerGuard, ws.ID, nil, "财务目录", true)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := st.CreateDriveNodeWithType(ctx, ownerGuard, ws.ID, &folder.ID, "sheet", "", "预算表", true)
	if err != nil {
		t.Fatal(err)
	}
	if entry.Kind != "sheet" || !entry.Personal || entry.Revision != 1 {
		t.Fatalf("unexpected sheet entry: %+v", entry)
	}

	if err = st.SetShare(ctx, entry.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, entry.ID, viewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}

	// Outsider cannot read.
	if _, err = st.GetSheetWorkbook(ctx, outsiderGuard, entry.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("outsider GetSheetWorkbook got %v", err)
	}

	snap, err := st.GetSheetWorkbook(ctx, ownerGuard, entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Title != "预算表" || len(snap.Sheets) != 1 || snap.Sheets[0].Title != "Sheet1" || len(snap.Sheets[0].Rows) != 100 || len(snap.Sheets[0].Columns) != 26 {
		t.Fatalf("unexpected initial workbook: %+v", snap)
	}
	ws1 := snap.Sheets[0]

	// Viewer can read, cannot write.
	if _, err = st.GetSheetWorkbook(ctx, viewerGuard, entry.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = st.WriteSheetCells(ctx, viewerGuard, entry.ID, store.SheetCellBatch{
		MutationID:  "00000000000000000000000000000001",
		WorksheetID: ws1.ID,
		Cells: []store.SheetCellWrite{{
			RowID:            ws1.Rows[0].ID,
			ColumnID:         ws1.Columns[0].ID,
			ExpectedRevision: 0,
			Raw:              strPtr("denied"),
		}},
	}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer WriteSheetCells got %v", err)
	}

	// Editor writes numeric + formula + styled cell, then idempotent replay.
	boldStyle := store.SheetCellStyle{Bold: true, Bg: "#eef3ff", Color: "#1f2329", Align: "center", NumFmt: "currency"}
	batch := store.SheetCellBatch{
		MutationID:  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		WorksheetID: ws1.ID,
		Cells: []store.SheetCellWrite{
			{RowID: ws1.Rows[0].ID, ColumnID: ws1.Columns[0].ID, ExpectedRevision: 0, Raw: strPtr("1200"), Style: &boldStyle},
			{RowID: ws1.Rows[0].ID, ColumnID: ws1.Columns[1].ID, ExpectedRevision: 0, Raw: strPtr("=A1*2")},
		},
	}
	res1, err := st.WriteSheetCells(ctx, editorGuard, entry.ID, batch)
	if err != nil {
		t.Fatal(err)
	}
	if res1.Replayed || res1.WorkbookRevision != 2 || len(res1.Cells) != 2 || res1.Cells[0].Revision != 1 {
		t.Fatalf("unexpected batch result: %+v", res1)
	}
	replay, err := st.WriteSheetCells(ctx, editorGuard, entry.ID, batch)
	if err != nil || !replay.Replayed || replay.WorkbookRevision != 2 {
		t.Fatalf("expected idempotent replay, got %+v err=%v", replay, err)
	}
	// Same mutationId with different content must conflict.
	if _, err = st.WriteSheetCells(ctx, editorGuard, entry.ID, store.SheetCellBatch{
		MutationID:  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		WorksheetID: ws1.ID,
		Cells: []store.SheetCellWrite{{
			RowID: ws1.Rows[0].ID, ColumnID: ws1.Columns[0].ID, ExpectedRevision: 0, Raw: strPtr("999"),
		}},
	}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("expected conflict on mismatched replay, got %v", err)
	}

	// Clear cell (retain tombstone revision=2) then reject stale expectedRevision=0.
	clearRes, err := st.WriteSheetCells(ctx, editorGuard, entry.ID, store.SheetCellBatch{
		MutationID:  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		WorksheetID: ws1.ID,
		Cells: []store.SheetCellWrite{{
			RowID: ws1.Rows[0].ID, ColumnID: ws1.Columns[0].ID, ExpectedRevision: 1, Raw: strPtr(""),
		}},
	})
	if err != nil || clearRes.Cells[0].Revision != 2 {
		t.Fatalf("clear cell failed: %+v err=%v", clearRes, err)
	}
	if _, err = st.WriteSheetCells(ctx, ownerGuard, entry.ID, store.SheetCellBatch{
		MutationID:  "cccccccccccccccccccccccccccccccc",
		WorksheetID: ws1.ID,
		Cells: []store.SheetCellWrite{{
			RowID: ws1.Rows[0].ID, ColumnID: ws1.Columns[0].ID, ExpectedRevision: 0, Raw: strPtr("stale"),
		}},
	}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale expectedRevision=0 after clear should conflict, got %v", err)
	}
	// Restore A1 value at revision 2 while preserving existing style (Style == nil).
	if _, err = st.WriteSheetCells(ctx, ownerGuard, entry.ID, store.SheetCellBatch{
		MutationID:  "dddddddddddddddddddddddddddddddd",
		WorksheetID: ws1.ID,
		Cells: []store.SheetCellWrite{{
			RowID: ws1.Rows[0].ID, ColumnID: ws1.Columns[0].ID, ExpectedRevision: 2, Raw: strPtr("1500"),
		}},
	}); err != nil {
		t.Fatal(err)
	}

	// Create Sheet2, rename, freeze, merge, reorder, and search content.
	ws2, wbRev, err := st.CreateWorksheet(ctx, editorGuard, entry.ID, "汇总")
	if err != nil || ws2.Title != "汇总" || ws2.Pos != 1 || wbRev <= 0 {
		t.Fatalf("CreateWorksheet got ws=%+v rev=%d err=%v", ws2, wbRev, err)
	}
	merges := []store.SheetMerge{{Top: 1, Left: 0, Bottom: 2, Right: 1}}
	frozen := 1
	newPos := 0
	filter := store.SheetFilterConfig{Enabled: true, HeaderRow: 0}
	ws2Updated, _, err := st.UpdateWorksheetMeta(ctx, ownerGuard, entry.ID, ws2.ID, store.WorksheetPatch{
		Pos:        &newPos,
		FrozenRows: &frozen,
		Merges:     &merges,
		Filter:     &filter,
	})
	if err != nil || ws2Updated.Pos != 0 || ws2Updated.FrozenRows != 1 || len(ws2Updated.Merges) != 1 || !ws2Updated.Filter.Enabled {
		t.Fatalf("UpdateWorksheetMeta got %+v err=%v", ws2Updated, err)
	}

	// Insert row before merge (index 1) shifts merge down to Top:2, Bottom:3.
	ws2Inserted, _, err := st.MutateSheetAxis(ctx, ownerGuard, entry.ID, ws2.ID, store.SheetAxisOp{Op: "insert_row", Index: 1, Count: 1})
	if err != nil || len(ws2Inserted.Rows) != 101 || ws2Inserted.Merges[0].Top != 2 || ws2Inserted.Merges[0].Bottom != 3 {
		t.Fatalf("insert_row got len=%d merges=%+v err=%v", len(ws2Inserted.Rows), ws2Inserted.Merges, err)
	}
	// Resize column 0 to 160px.
	ws2Resized, _, err := st.MutateSheetAxis(ctx, ownerGuard, entry.ID, ws2.ID, store.SheetAxisOp{Op: "resize_col", Index: 0, Size: 160})
	if err != nil || ws2Resized.Columns[0].Size != 160 {
		t.Fatalf("resize_col got col0=%+v err=%v", ws2Resized.Columns[0], err)
	}
	// Delete Sheet1, verify last worksheet cannot be deleted.
	if _, err = st.DeleteWorksheet(ctx, ownerGuard, entry.ID, ws1.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = st.DeleteWorksheet(ctx, ownerGuard, entry.ID, ws2.ID); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("expected conflict deleting last worksheet, got %v", err)
	}

	// SearchSheetContent matches worksheet title & cell values.
	if ok, err := st.SearchSheetContent(ctx, viewer.ID, entry.ID, "汇总"); err != nil || !ok {
		t.Fatalf("SearchSheetContent title expected true, got %v err=%v", ok, err)
	}
	if ok, err := st.SearchSheetContent(ctx, outsider.ID, entry.ID, "汇总"); err != nil || ok {
		t.Fatalf("SearchSheetContent outsider expected false, got %v err=%v", ok, err)
	}

	// RenameSheetTitle enforces expectedTitle & expectedDriveRevision.
	renamed, err := st.RenameSheetTitle(ctx, editorGuard, entry.ID, "Q4 预算表", "预算表", entry.Revision)
	if err != nil || renamed.Title != "Q4 预算表" || renamed.Revision != entry.Revision+1 {
		t.Fatalf("RenameSheetTitle got %+v err=%v", renamed, err)
	}

	// CopySheetWorkbook cannot publish into an unjoined workspace, and copies cleanly to viewer's workspace.
	if _, err = st.CopySheetWorkbook(ctx, store.SheetWorkbookCopy{
		SourceID:    entry.ID,
		UserID:      viewer.ID,
		WorkspaceID: ws.ID,
		Title:       "denied ws copy",
		Guard:       &viewerGuard,
	}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("expected ErrForbidden copying to unjoined workspace, got %v", err)
	}
	copied, err := st.CopySheetWorkbook(ctx, store.SheetWorkbookCopy{
		SourceID:    entry.ID,
		UserID:      viewer.ID,
		WorkspaceID: viewerWS.ID,
		Title:       "Q4 预算表 副本",
		Guard:       &viewerGuard,
	})
	if err != nil || copied.Kind != "sheet" || copied.Title != "Q4 预算表 副本" {
		t.Fatalf("CopySheetWorkbook got %+v err=%v", copied, err)
	}
	if err = st.SetCopyProtected(ctx, entry.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CopySheetWorkbook(ctx, store.SheetWorkbookCopy{
		SourceID:    entry.ID,
		UserID:      viewer.ID,
		WorkspaceID: viewerWS.ID,
		Title:       "forbidden copy",
		Guard:       &viewerGuard,
	}); !errors.Is(err, store.ErrCopyProtected) {
		t.Fatalf("expected ErrCopyProtected, got %v", err)
	}

	// ReplaceSheetWorkbook replaces workbook atomically (XLSX import).
	latestSnap, err := st.GetSheetWorkbook(ctx, ownerGuard, entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	replaced, err := st.ReplaceSheetWorkbook(ctx, ownerGuard, entry.ID, latestSnap.WorkbookRevision, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", []store.ImportedWorksheet{
		{
			Title: "导入主表",
			Rows:  20,
			Cols:  8,
			Cells: []store.ImportedSheetCell{
				{Row: 0, Col: 0, Raw: "项目", Style: store.SheetCellStyle{Bold: true}},
				{Row: 1, Col: 0, Raw: "100"},
				{Row: 1, Col: 1, Raw: "=导入明细!A1+A2"},
			},
		},
		{
			Title: "导入明细",
			Rows:  10,
			Cols:  5,
			Cells: []store.ImportedSheetCell{{Row: 0, Col: 0, Raw: "50"}},
		},
	})
	if err != nil || len(replaced.Sheets) != 2 || replaced.Sheets[0].Title != "导入主表" || len(replaced.Sheets[0].Cells) != 3 {
		t.Fatalf("ReplaceSheetWorkbook got %+v err=%v", replaced, err)
	}
	if ok, err := st.SearchSheetContent(ctx, viewer.ID, entry.ID, "导入明细"); err != nil || !ok {
		t.Fatalf("SearchSheetContent post-import got %v err=%v", ok, err)
	}

	// Trash & Restore & Purge work cleanly with sheet kind.
	if err = st.TrashDriveNode(ctx, ownerGuard, entry.ID, renamed.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err = st.GetSheetWorkbook(ctx, ownerGuard, entry.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("trashed sheet should return ErrNotFound, got %v", err)
	}
	if err = st.RestoreDriveNode(ctx, ownerGuard, entry.ID, renamed.Revision+1); err != nil {
		t.Fatal(err)
	}
	if snapAfterRestore, err := st.GetSheetWorkbook(ctx, ownerGuard, entry.ID); err != nil || len(snapAfterRestore.Sheets) != 2 {
		t.Fatalf("restored sheet got %+v err=%v", snapAfterRestore, err)
	}
}

func TestMemorySheetStore(t *testing.T) {
	exerciseSheetStore(t, store.NewMemory())
}

func TestPostgresSheetStore(t *testing.T) {
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
	schema := pgx.Identifier{fmt.Sprintf("sheet_store_%d", time.Now().UnixNano())}.Sanitize()
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
	exerciseSheetStore(t, &store.Postgres{Pool: pool})
}
