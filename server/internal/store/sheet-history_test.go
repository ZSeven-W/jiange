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

func exerciseSheetHistoryStore(t *testing.T, st store.Store, hist store.SheetHistoryStore) {
	t.Helper()
	ctx := context.Background()

	owner, ws, err := st.CreateUser(ctx, "hist-owner@example.test", "HistOwner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := st.CreateUser(ctx, "hist-editor@example.test", "HistEditor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	viewer, _, err := st.CreateUser(ctx, "hist-viewer@example.test", "HistViewer", "hash")
	if err != nil {
		t.Fatal(err)
	}
	outsider, _, err := st.CreateUser(ctx, "hist-outsider@example.test", "HistOutsider", "hash")
	if err != nil {
		t.Fatal(err)
	}

	ownerGuard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("hist-owner-sess")}
	editorGuard := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("hist-editor-sess")}
	viewerGuard := store.RestoreGuard{UserID: viewer.ID, SessionHash: []byte("hist-viewer-sess")}
	outsiderGuard := store.RestoreGuard{UserID: outsider.ID, SessionHash: []byte("hist-outsider-sess")}

	for _, item := range []struct {
		id   int64
		hash []byte
	}{
		{owner.ID, ownerGuard.SessionHash},
		{editor.ID, editorGuard.SessionHash},
		{viewer.ID, viewerGuard.SessionHash},
		{outsider.ID, outsiderGuard.SessionHash},
	} {
		if err := st.CreateSession(ctx, item.hash, item.id, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}

	entry, err := st.CreateDriveNodeWithType(ctx, ownerGuard, ws.ID, nil, "sheet", "", "财务季报", true)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, entry.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, entry.ID, viewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}

	snap, err := st.GetSheetWorkbook(ctx, ownerGuard, entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	ws1 := snap.Sheets[0]

	// Write rich content: styled value, formula, merge, chart, validation, and a second worksheet.
	bold := store.SheetCellStyle{Bold: true, Color: "#1f2329", Bg: "#eef3ff", NumFmt: "currency"}
	if _, err := st.WriteSheetCells(ctx, ownerGuard, entry.ID, store.SheetCellBatch{
		MutationID:  "11111111111111111111111111111111",
		WorksheetID: ws1.ID,
		Cells: []store.SheetCellWrite{
			{RowID: ws1.Rows[0].ID, ColumnID: ws1.Columns[0].ID, ExpectedRevision: 0, Raw: strPtr("1000"), Style: &bold},
			{RowID: ws1.Rows[0].ID, ColumnID: ws1.Columns[1].ID, ExpectedRevision: 0, Raw: strPtr("=A1*2")},
		},
	}); err != nil {
		t.Fatal(err)
	}

	frozenRows := 1
	merges := []store.SheetMerge{{Top: 2, Left: 0, Bottom: 3, Right: 1}}
	charts := []store.SheetChart{{
		ID: "chart-1", Title: "营收趋势", Type: "column",
		Top: 0, Left: 0, Bottom: 5, Right: 2, HeaderRow: true,
		X: 120, Y: 40, Width: 420, Height: 280, ShowLegend: true,
	}}
	validations := []store.SheetDataValidation{{
		ID: "val-1", Top: 1, Left: 0, Bottom: 4, Right: 0, Type: "list", Options: []string{"草稿", "完成"}, Strict: true,
	}}
	if _, _, err := st.UpdateWorksheetMeta(ctx, ownerGuard, entry.ID, ws1.ID, store.WorksheetPatch{
		FrozenRows:  &frozenRows,
		Merges:      &merges,
		Charts:      &charts,
		Validations: &validations,
	}); err != nil {
		t.Fatal(err)
	}

	ws2, _, err := st.CreateWorksheet(ctx, editorGuard, entry.ID, "明细表")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.WriteSheetCells(ctx, editorGuard, entry.ID, store.SheetCellBatch{
		MutationID:  "22222222222222222222222222222222",
		WorksheetID: ws2.ID,
		Cells: []store.SheetCellWrite{
			{RowID: ws2.Rows[0].ID, ColumnID: ws2.Columns[0].ID, ExpectedRevision: 0, Raw: strPtr("华东区")},
		},
	}); err != nil {
		t.Fatal(err)
	}

	// Permissions: outsider denied, viewer read-only.
	if _, err := hist.ListSheetVersions(ctx, outsiderGuard, entry.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("outsider ListSheetVersions = %v, want ErrNotFound", err)
	}
	if _, err := hist.CreateSheetVersionGuarded(ctx, viewerGuard, entry.ID, "viewer-fail", false); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer CreateSheetVersionGuarded = %v, want ErrForbidden", err)
	}

	// Create named version v1.
	v1, err := hist.CreateSheetVersionGuarded(ctx, editorGuard, entry.ID, "Q1 冻结基线", false)
	if err != nil {
		t.Fatal(err)
	}
	if v1.ID <= 0 || v1.Label != "Q1 冻结基线" || v1.AutoSaved || v1.ActorName != "HistEditor" || v1.WorksheetCount != 2 || v1.CellCount != 3 {
		t.Fatalf("unexpected v1 meta: %+v", v1)
	}

	// Viewer can list versions, cannot restore.
	versions, err := hist.ListSheetVersions(ctx, viewerGuard, entry.ID)
	if err != nil || len(versions) != 1 || versions[0].ID != v1.ID {
		t.Fatalf("viewer ListSheetVersions = %+v err=%v", versions, err)
	}
	if _, err := hist.RestoreSheetVersionGuarded(ctx, viewerGuard, entry.ID, v1.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer RestoreSheetVersionGuarded = %v, want ErrForbidden", err)
	}

	// Mutate live workbook drastically: overwrite A1 and delete ws2.
	if _, err := st.WriteSheetCells(ctx, ownerGuard, entry.ID, store.SheetCellBatch{
		MutationID:  "33333333333333333333333333333333",
		WorksheetID: ws1.ID,
		Cells: []store.SheetCellWrite{
			{RowID: ws1.Rows[0].ID, ColumnID: ws1.Columns[0].ID, ExpectedRevision: 1, Raw: strPtr("99999")},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.DeleteWorksheet(ctx, ownerGuard, entry.ID, ws2.ID); err != nil {
		t.Fatal(err)
	}

	// Non-existent version returns ErrNotFound.
	if _, err := hist.RestoreSheetVersionGuarded(ctx, ownerGuard, entry.ID, 999999); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing version restore = %v, want ErrNotFound", err)
	}

	// Restore v1 -> automatically creates pre-restore backup and restores full state.
	restored, err := hist.RestoreSheetVersionGuarded(ctx, ownerGuard, entry.ID, v1.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(restored.Sheets) != 2 {
		t.Fatalf("restored sheet count = %d, want 2", len(restored.Sheets))
	}
	rws1 := restored.Sheets[0]
	if rws1.Title != "Sheet1" || rws1.FrozenRows != 1 || len(rws1.Merges) != 1 || len(rws1.Charts) != 1 || len(rws1.Validations) != 1 {
		t.Fatalf("restored ws1 metadata mismatch: %+v", rws1)
	}
	var gotA1, gotB1 string
	var gotA1Bold bool
	for _, c := range rws1.Cells {
		if c.RowID == rws1.Rows[0].ID && c.ColumnID == rws1.Columns[0].ID {
			gotA1 = c.Raw
			gotA1Bold = c.Style.Bold
		}
		if c.RowID == rws1.Rows[0].ID && c.ColumnID == rws1.Columns[1].ID {
			gotB1 = c.Raw
		}
	}
	if gotA1 != "1000" || !gotA1Bold || gotB1 != "=A1*2" {
		t.Fatalf("restored cells mismatch: A1=%q(bold=%v) B1=%q", gotA1, gotA1Bold, gotB1)
	}
	if restored.Sheets[1].Title != "明细表" || len(restored.Sheets[1].Cells) != 1 || restored.Sheets[1].Cells[0].Raw != "华东区" {
		t.Fatalf("restored ws2 mismatch: %+v", restored.Sheets[1])
	}

	// Version list now has pre-restore auto backup first, then v1.
	versionsAfter, err := hist.ListSheetVersions(ctx, ownerGuard, entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(versionsAfter) != 2 {
		t.Fatalf("versions count = %d, want 2", len(versionsAfter))
	}
	if !versionsAfter[0].AutoSaved || versionsAfter[0].Label != "恢复前自动备份" || versionsAfter[0].WorksheetCount != 1 {
		t.Fatalf("expected auto pre-restore backup first, got %+v", versionsAfter[0])
	}
	if versionsAfter[1].ID != v1.ID {
		t.Fatalf("expected v1 second, got %+v", versionsAfter[1])
	}

	// Cell history: records diffs, skips unchanged, enforces RoleView, orders newest-first, respects limit.
	baseTime := time.Now().UTC().Add(-10 * time.Minute)
	if err := hist.RecordSheetCellHistory(ctx, []store.SheetCellHistoryEntry{
		{
			SheetID: entry.ID, WorksheetID: rws1.ID, Row: 0, Col: 0,
			PrevValue: "", NextValue: "1000", ActorID: owner.ID, ActorName: owner.Name, CreatedAt: baseTime,
		},
		{
			// Unchanged entry must be skipped!
			SheetID: entry.ID, WorksheetID: rws1.ID, Row: 0, Col: 0,
			PrevValue: "1000", NextValue: "1000", PrevFormula: "", NextFormula: "",
			ActorID: owner.ID, ActorName: owner.Name, CreatedAt: baseTime.Add(time.Minute),
		},
		{
			SheetID: entry.ID, WorksheetID: rws1.ID, Row: 0, Col: 0,
			PrevValue: "1000", NextValue: "", PrevFormula: "", NextFormula: "=500*3",
			ActorID: editor.ID, ActorName: editor.Name, CreatedAt: baseTime.Add(2 * time.Minute),
		},
		{
			// Different cell (0,1) should not pollute (0,0) query.
			SheetID: entry.ID, WorksheetID: rws1.ID, Row: 0, Col: 1,
			PrevValue: "", NextValue: "other", ActorID: editor.ID, ActorName: editor.Name, CreatedAt: baseTime.Add(3 * time.Minute),
		},
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := hist.ListSheetCellHistory(ctx, outsiderGuard, entry.ID, rws1.ID, 0, 0, 20); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("outsider ListSheetCellHistory = %v, want ErrNotFound", err)
	}
	cellLogs, err := hist.ListSheetCellHistory(ctx, viewerGuard, entry.ID, rws1.ID, 0, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(cellLogs) != 2 {
		t.Fatalf("cell history len = %d, want 2: %+v", len(cellLogs), cellLogs)
	}
	if cellLogs[0].NextFormula != "=500*3" || cellLogs[0].PrevValue != "1000" || cellLogs[0].ActorName != "HistEditor" {
		t.Fatalf("newest cell history mismatch: %+v", cellLogs[0])
	}
	if cellLogs[1].NextValue != "1000" || cellLogs[1].PrevValue != "" || cellLogs[1].ActorName != "HistOwner" {
		t.Fatalf("older cell history mismatch: %+v", cellLogs[1])
	}
	limitedLogs, err := hist.ListSheetCellHistory(ctx, viewerGuard, entry.ID, rws1.ID, 0, 0, 1)
	if err != nil || len(limitedLogs) != 1 || limitedLogs[0].ID != cellLogs[0].ID {
		t.Fatalf("limited cell history = %+v err=%v", limitedLogs, err)
	}
}

func TestSheetHistoryMemory(t *testing.T) {
	m := store.NewMemory()
	exerciseSheetHistoryStore(t, m, m)
}

func TestSheetHistoryPostgres(t *testing.T) {
	dsn := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	schema := fmt.Sprintf("test_sheet_hist_%d", time.Now().UnixNano())
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	pg := &store.Postgres{Pool: pool}
	exerciseSheetHistoryStore(t, pg, pg)
}
