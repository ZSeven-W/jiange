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
)

func intPtr(v int) *int { return &v }

func exerciseSheetChartsAndPivots(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	exp := time.Now().Add(time.Hour)

	owner, ws, err := st.CreateUser(ctx, "analytics-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("analytics-sess-owner")}
	if err := st.CreateSession(ctx, guard.SessionHash, owner.ID, exp); err != nil {
		t.Fatal(err)
	}

	node, err := st.CreateDriveNode(ctx, guard, ws.ID, nil, "sheet", "销售分析工作簿", false)
	if err != nil {
		t.Fatal(err)
	}
	snap, err := st.GetSheetWorkbook(ctx, guard, node.ID)
	if err != nil {
		t.Fatal(err)
	}
	sheet1 := snap.Sheets[0]

	// Create a second worksheet to test cross-sheet pivot table SourceSheetID & copy remapping.
	sheet2, _, err := st.CreateWorksheet(ctx, guard, node.ID, "透视汇总")
	if err != nil {
		t.Fatal(err)
	}

	// Reject invalid chart type and out-of-bounds chart.
	badCharts := []store.SheetChart{{ID: "c1", Title: "Bad", Type: "radar", Top: 0, Left: 0, Bottom: 5, Right: 2}}
	if _, _, err := st.UpdateWorksheetMeta(ctx, guard, node.ID, sheet1.ID, store.WorksheetPatch{Charts: &badCharts}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("invalid chart type = %v, want ErrConflict", err)
	}

	// Persist two charts (column + pie) on Sheet1.
	charts := []store.SheetChart{
		{ID: "chart-1", Title: "月度营收趋势", Type: "column", Top: 1, Left: 1, Bottom: 6, Right: 3, HeaderRow: true, X: 420, Y: 40, Width: 480, Height: 300, ShowLegend: true, ShowValues: true},
		{ID: "chart-2", Title: "产品占比", Type: "pie", Top: 1, Left: 1, Bottom: 6, Right: 2, HeaderRow: true, X: 420, Y: 360, Width: 380, Height: 280, ShowLegend: true},
	}
	wsUpdated, _, err := st.UpdateWorksheetMeta(ctx, guard, node.ID, sheet1.ID, store.WorksheetPatch{Charts: &charts})
	if err != nil || len(wsUpdated.Charts) != 2 || wsUpdated.Charts[0].Title != "月度营收趋势" {
		t.Fatalf("save charts = %+v err=%v", wsUpdated.Charts, err)
	}

	// Persist a same-sheet pivot table on Sheet1 and a cross-sheet pivot table on Sheet2 referencing Sheet1.
	p1 := []store.SheetPivotTable{
		{
			ID:            "piv-1",
			Title:         "部门×季度营收",
			Top:           1,
			Left:          1,
			Bottom:        8,
			Right:         4, // 4 cols: 0=部门, 1=季度, 2=销售额, 3=利润
			RowFields:     []int{0},
			ColField:      intPtr(1),
			Values:        []store.SheetPivotValue{{Col: 2, Agg: "sum"}, {Col: 3, Agg: "avg"}},
			ShowRowTotals: true,
			ShowColTotals: true,
			SortBy:        "value_desc",
		},
	}
	wsUpdated, _, err = st.UpdateWorksheetMeta(ctx, guard, node.ID, sheet1.ID, store.WorksheetPatch{PivotTables: &p1})
	if err != nil || len(wsUpdated.PivotTables) != 1 || wsUpdated.PivotTables[0].ColField == nil || *wsUpdated.PivotTables[0].ColField != 1 {
		t.Fatalf("save same-sheet pivot = %+v err=%v", wsUpdated.PivotTables, err)
	}

	p2 := []store.SheetPivotTable{
		{
			ID:            "piv-cross",
			Title:         "跨表透视",
			SourceSheetID: sheet1.ID,
			Top:           1,
			Left:          1,
			Bottom:        8,
			Right:         4,
			RowFields:     []int{0},
			Values:        []store.SheetPivotValue{{Col: 2, Agg: "sum"}},
			ShowRowTotals: true,
			ShowColTotals: true,
		},
	}
	ws2Updated, _, err := st.UpdateWorksheetMeta(ctx, guard, node.ID, sheet2.ID, store.WorksheetPatch{PivotTables: &p2})
	if err != nil || len(ws2Updated.PivotTables) != 1 || ws2Updated.PivotTables[0].SourceSheetID != sheet1.ID {
		t.Fatalf("save cross-sheet pivot = %+v err=%v", ws2Updated.PivotTables, err)
	}

	// Insert 1 row at index 0 -> chart & pivot Top/Bottom shift down by 1.
	wsAfterRowIns, _, err := st.MutateSheetAxis(ctx, guard, node.ID, sheet1.ID, store.SheetAxisOp{Op: "insert_row", Index: 0, Count: 1})
	if err != nil {
		t.Fatal(err)
	}
	if wsAfterRowIns.Charts[0].Top != 2 || wsAfterRowIns.Charts[0].Bottom != 7 {
		t.Fatalf("chart did not shift on insert_row: %+v", wsAfterRowIns.Charts[0])
	}
	if wsAfterRowIns.PivotTables[0].Top != 2 || wsAfterRowIns.PivotTables[0].Bottom != 9 {
		t.Fatalf("pivot did not shift on insert_row: %+v", wsAfterRowIns.PivotTables[0])
	}

	// Insert 1 column strictly inside pivot range (at col index 2, between Left=1 and Right=4) ->
	// pivot Right expands 4->5 AND relative offsets >= 1 (ColField=1 -> 2, Values[0].Col=2 -> 3, Values[1].Col=3 -> 4)!
	wsAfterColIns, _, err := st.MutateSheetAxis(ctx, guard, node.ID, sheet1.ID, store.SheetAxisOp{Op: "insert_col", Index: 2, Count: 1})
	if err != nil {
		t.Fatal(err)
	}
	pv := wsAfterColIns.PivotTables[0]
	if pv.Left != 1 || pv.Right != 5 || pv.RowFields[0] != 0 || pv.ColField == nil || *pv.ColField != 2 || pv.Values[0].Col != 3 || pv.Values[1].Col != 4 {
		t.Fatalf("pivot offsets did not adjust on inner insert_col: %+v", pv)
	}

	// Copy workbook -> verify charts cloned & cross-sheet pivot SourceSheetID remapped to copied Sheet1 ID!
	copiedMeta, err := st.CopySheetWorkbook(ctx, store.SheetWorkbookCopy{
		SourceID:    node.ID,
		UserID:      owner.ID,
		WorkspaceID: ws.ID,
		Title:       "销售分析副本",
		Guard:       &guard,
	})
	if err != nil {
		t.Fatal(err)
	}
	copiedSnap, err := st.GetSheetWorkbook(ctx, guard, copiedMeta.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(copiedSnap.Sheets) != 2 || len(copiedSnap.Sheets[0].Charts) != 2 || len(copiedSnap.Sheets[1].PivotTables) != 1 {
		t.Fatalf("copied workbook missing charts/pivots: %+v", copiedSnap.Sheets)
	}
	if copiedSnap.Sheets[1].PivotTables[0].SourceSheetID != copiedSnap.Sheets[0].ID {
		t.Fatalf("copied cross-sheet pivot SourceSheetID = %d, want copied sheet1 ID %d",
			copiedSnap.Sheets[1].PivotTables[0].SourceSheetID, copiedSnap.Sheets[0].ID)
	}
}

func exerciseSheetSparklinesAndOutlineGroups(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	exp := time.Now().Add(time.Hour)

	owner, ws, err := st.CreateUser(ctx, "spark-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("spark-sess-owner")}
	if err := st.CreateSession(ctx, guard.SessionHash, owner.ID, exp); err != nil {
		t.Fatal(err)
	}

	node, err := st.CreateDriveNode(ctx, guard, ws.ID, nil, "sheet", "迷你图与分组测试", false)
	if err != nil {
		t.Fatal(err)
	}
	snap, err := st.GetSheetWorkbook(ctx, guard, node.ID)
	if err != nil {
		t.Fatal(err)
	}
	sheet1 := snap.Sheets[0]

	// Invalid sparkline type rejected.
	badSpType := []store.SheetSparkline{{ID: "sp-bad", Row: 1, Col: 5, SourceTop: 1, SourceLeft: 0, SourceBottom: 1, SourceRight: 4, Type: "pie"}}
	if _, _, err := st.UpdateWorksheetMeta(ctx, guard, node.ID, sheet1.ID, store.WorksheetPatch{Sparklines: &badSpType}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("invalid sparkline type = %v, want ErrConflict", err)
	}

	// Invalid hex color rejected.
	badSpColor := []store.SheetSparkline{{ID: "sp-badc", Row: 1, Col: 5, SourceTop: 1, SourceLeft: 0, SourceBottom: 1, SourceRight: 4, Type: "line", Color: "red"}}
	if _, _, err := st.UpdateWorksheetMeta(ctx, guard, node.ID, sheet1.ID, store.WorksheetPatch{Sparklines: &badSpColor}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("invalid sparkline color = %v, want ErrConflict", err)
	}

	// Duplicate target cell rejected.
	dupSpCell := []store.SheetSparkline{
		{ID: "sp-a", Row: 1, Col: 5, SourceTop: 1, SourceLeft: 0, SourceBottom: 1, SourceRight: 4, Type: "line"},
		{ID: "sp-b", Row: 1, Col: 5, SourceTop: 2, SourceLeft: 0, SourceBottom: 2, SourceRight: 4, Type: "bar"},
	}
	if _, _, err := st.UpdateWorksheetMeta(ctx, guard, node.ID, sheet1.ID, store.WorksheetPatch{Sparklines: &dupSpCell}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("duplicate sparkline target cell = %v, want ErrConflict", err)
	}

	// Exceeding 200 sparklines rejected.
	tooManySp := make([]store.SheetSparkline, 201)
	for i := range tooManySp {
		tooManySp[i] = store.SheetSparkline{ID: fmt.Sprintf("sp-%d", i), Row: i % 50, Col: i / 50, SourceTop: 0, SourceLeft: 0, SourceBottom: 0, SourceRight: 3, Type: "line"}
	}
	if _, _, err := st.UpdateWorksheetMeta(ctx, guard, node.ID, sheet1.ID, store.WorksheetPatch{Sparklines: &tooManySp}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("201 sparklines = %v, want ErrConflict", err)
	}

	// Invalid outline group axis and cap (>100) rejected.
	badGroupAxis := []store.SheetOutlineGroup{{ID: "og-bad", Axis: "diag", Start: 1, End: 3}}
	if _, _, err := st.UpdateWorksheetMeta(ctx, guard, node.ID, sheet1.ID, store.WorksheetPatch{OutlineGroups: &badGroupAxis}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("invalid outline group axis = %v, want ErrConflict", err)
	}
	tooManyGroups := make([]store.SheetOutlineGroup, 101)
	for i := range tooManyGroups {
		tooManyGroups[i] = store.SheetOutlineGroup{ID: fmt.Sprintf("og-%d", i), Axis: "row", Start: 1, End: 2}
	}
	if _, _, err := st.UpdateWorksheetMeta(ctx, guard, node.ID, sheet1.ID, store.WorksheetPatch{OutlineGroups: &tooManyGroups}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("101 outline groups = %v, want ErrConflict", err)
	}

	// Valid patch round-trip for sparklines + outlineGroups (including reversed start/end normalization).
	sparklines := []store.SheetSparkline{
		{ID: "sp-1", Row: 2, Col: 5, SourceTop: 2, SourceLeft: 1, SourceBottom: 2, SourceRight: 4, Type: "line", Color: "#1456F0", ShowMarkers: true},
		{ID: "sp-2", Row: 3, Col: 5, SourceTop: 3, SourceLeft: 1, SourceBottom: 3, SourceRight: 4, Type: "winloss", Color: "#00B42A", NegativeColor: "#F54A45"},
	}
	groups := []store.SheetOutlineGroup{
		{ID: "og-row", Axis: "row", Start: 5, End: 2, Collapsed: true}, // reversed -> normalized to [2, 5]
		{ID: "og-col", Axis: "col", Start: 1, End: 3, Collapsed: false},
	}
	wsUpdated, _, err := st.UpdateWorksheetMeta(ctx, guard, node.ID, sheet1.ID, store.WorksheetPatch{
		Sparklines:    &sparklines,
		OutlineGroups: &groups,
	})
	if err != nil {
		t.Fatalf("patch sparklines/outlineGroups err=%v", err)
	}
	if len(wsUpdated.Sparklines) != 2 || wsUpdated.Sparklines[0].Color != "#1456F0" || !wsUpdated.Sparklines[0].ShowMarkers || wsUpdated.Sparklines[1].Type != "winloss" {
		t.Fatalf("unexpected sparklines = %+v", wsUpdated.Sparklines)
	}
	if len(wsUpdated.OutlineGroups) != 2 || wsUpdated.OutlineGroups[0].Start != 2 || wsUpdated.OutlineGroups[0].End != 5 || !wsUpdated.OutlineGroups[0].Collapsed {
		t.Fatalf("unexpected outlineGroups = %+v", wsUpdated.OutlineGroups)
	}

	// Verify GET workbook returns persisted sparklines & outlineGroups.
	reloaded, err := st.GetSheetWorkbook(ctx, guard, node.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(reloaded.Sheets[0].Sparklines) != 2 || len(reloaded.Sheets[0].OutlineGroups) != 2 {
		t.Fatalf("reloaded sheet missing sparklines/outlineGroups: %+v", reloaded.Sheets[0])
	}

	// Save history snapshot, clear sparklines/outlineGroups, then restore snapshot!
	hist, ok := st.(store.SheetHistoryStore)
	if !ok {
		t.Fatal("store does not implement SheetHistoryStore")
	}
	snapEntry, err := hist.CreateSheetVersionGuarded(ctx, guard, node.ID, "含迷你图和分组", false)
	if err != nil {
		t.Fatal(err)
	}
	emptySp := []store.SheetSparkline{}
	emptyOg := []store.SheetOutlineGroup{}
	if _, _, err := st.UpdateWorksheetMeta(ctx, guard, node.ID, sheet1.ID, store.WorksheetPatch{Sparklines: &emptySp, OutlineGroups: &emptyOg}); err != nil {
		t.Fatal(err)
	}
	restored, err := hist.RestoreSheetVersionGuarded(ctx, guard, node.ID, snapEntry.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(restored.Sheets[0].Sparklines) != 2 || len(restored.Sheets[0].OutlineGroups) != 2 {
		t.Fatalf("restored sheet missing sparklines/outlineGroups: sp=%+v og=%+v", restored.Sheets[0].Sparklines, restored.Sheets[0].OutlineGroups)
	}
	restoredSheetID := restored.Sheets[0].ID

	// Insert 1 row at index 0 -> shifts sparkline rows & row outline group down by 1.
	afterIns, _, err := st.MutateSheetAxis(ctx, guard, node.ID, restoredSheetID, store.SheetAxisOp{Op: "insert_row", Index: 0, Count: 1})
	if err != nil {
		t.Fatal(err)
	}
	if afterIns.Sparklines[0].Row != 3 || afterIns.Sparklines[0].SourceTop != 3 {
		t.Fatalf("sparkline did not shift on insert_row: %+v", afterIns.Sparklines[0])
	}
	if afterIns.OutlineGroups[0].Start != 3 || afterIns.OutlineGroups[0].End != 6 {
		t.Fatalf("row outline group did not shift on insert_row: %+v", afterIns.OutlineGroups[0])
	}
	if afterIns.OutlineGroups[1].Start != 1 || afterIns.OutlineGroups[1].End != 3 {
		t.Fatalf("col outline group should be untouched on insert_row: %+v", afterIns.OutlineGroups[1])
	}

	// Copy workbook -> sparklines and outline groups cloned cleanly.
	copied, err := st.CopySheetWorkbook(ctx, store.SheetWorkbookCopy{
		SourceID:    node.ID,
		UserID:      owner.ID,
		WorkspaceID: ws.ID,
		Title:       "迷你图副本",
		Guard:       &guard,
	})
	if err != nil {
		t.Fatal(err)
	}
	copiedSnap, err := st.GetSheetWorkbook(ctx, guard, copied.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(copiedSnap.Sheets[0].Sparklines) != 2 || len(copiedSnap.Sheets[0].OutlineGroups) != 2 {
		t.Fatalf("copied workbook missing sparklines/outlineGroups: %+v", copiedSnap.Sheets[0])
	}
}

func TestSheetSparklinesAndOutlineGroupsMemory(t *testing.T) {
	exerciseSheetSparklinesAndOutlineGroups(t, store.NewMemory())
}

func TestSheetSparklinesAndOutlineGroupsPostgres(t *testing.T) {
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
	if _, err := pg.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	exerciseSheetSparklinesAndOutlineGroups(t, pg)
}

func TestMemorySheetChartsAndPivots(t *testing.T) {
	exerciseSheetChartsAndPivots(t, store.NewMemory())
}

func TestPostgresSheetChartsAndPivots(t *testing.T) {
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
	if _, err := pg.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	exerciseSheetChartsAndPivots(t, pg)
}
