package store_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func boolPtr(b bool) *bool { return &b }

func exerciseSheetConcurrentMerge(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	exp := time.Now().Add(time.Hour)

	alice, ws, err := st.CreateUser(ctx, "sheet-merge-alice@example.test", "Alice", "hash")
	if err != nil {
		t.Fatal(err)
	}
	bob, _, err := st.CreateUser(ctx, "sheet-merge-bob@example.test", "Bob", "hash")
	if err != nil {
		t.Fatal(err)
	}
	charlie, _, err := st.CreateUser(ctx, "sheet-merge-charlie@example.test", "Charlie", "hash")
	if err != nil {
		t.Fatal(err)
	}

	makeGuard := func(u store.User, tag string) store.RestoreGuard {
		g := store.RestoreGuard{UserID: u.ID, SessionHash: []byte("sheet-merge-sess-" + tag)}
		if e := st.CreateSession(ctx, g.SessionHash, u.ID, exp); e != nil {
			t.Fatal(e)
		}
		return g
	}
	aliceG := makeGuard(alice, "alice")
	bobG := makeGuard(bob, "bob")
	charlieG := makeGuard(charlie, "charlie")

	// Invite Bob & Charlie into Alice's workspace so all 3 can collaborate.
	for _, tc := range []struct {
		u store.User
		g store.RestoreGuard
	}{{bob, bobG}, {charlie, charlieG}} {
		ch, err := st.UpsertWorkspaceMemberGuarded(ctx, aliceG, ws.ID, tc.u.Email, store.WorkspaceRoleMember)
		if err != nil || ch.Invitation == nil {
			t.Fatalf("invite %s: %+v err=%v", tc.u.Email, ch, err)
		}
		if err := st.RespondInvitationGuarded(ctx, tc.g, ch.Invitation.ID, true); err != nil {
			t.Fatal(err)
		}
	}

	sheetNode, err := st.CreateDriveNode(ctx, aliceG, ws.ID, nil, "sheet", "高并发协同测试表", false)
	if err != nil {
		t.Fatal(err)
	}
	snap, err := st.GetSheetWorkbook(ctx, aliceG, sheetNode.ID)
	if err != nil {
		t.Fatal(err)
	}
	sheet := snap.Sheets[0]
	rowID := func(r int) int64 { return sheet.Rows[r].ID }
	colID := func(c int) int64 { return sheet.Columns[c].ID }
	mut := func(n int) string { return fmt.Sprintf("%032x", n) }

	// 1. Orthogonal 3-way same-cell merge on A1: raw + bold + bg all at stale expectedRevision=0.
	r1, err := st.WriteSheetCells(ctx, aliceG, sheetNode.ID, store.SheetCellBatch{
		MutationID:  mut(1),
		WorksheetID: sheet.ID,
		MergeMode:   store.SheetMergeModeAuto,
		Cells: []store.SheetCellWrite{
			{RowID: rowID(0), ColumnID: colID(0), ExpectedRevision: 0, Raw: strPtr("=100+200")},
		},
	})
	if err != nil || len(r1.Cells) != 1 || r1.Cells[0].Revision != 1 || r1.MergedCount != 0 {
		t.Fatalf("alice raw write: %+v err=%v", r1, err)
	}

	// Strict mode still rejects stale expectedRevision=0.
	if _, err := st.WriteSheetCells(ctx, bobG, sheetNode.ID, store.SheetCellBatch{
		MutationID:  mut(2),
		WorksheetID: sheet.ID,
		MergeMode:   store.SheetMergeModeStrict,
		Cells: []store.SheetCellWrite{
			{RowID: rowID(0), ColumnID: colID(0), ExpectedRevision: 0, StylePatch: &store.SheetStylePatch{Bold: boolPtr(true)}},
		},
	}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("strict mode stale write = %v, want ErrConflict", err)
	}

	// Auto mode merges Bob's bold onto Alice's raw!
	r2, err := st.WriteSheetCells(ctx, bobG, sheetNode.ID, store.SheetCellBatch{
		MutationID:  mut(3),
		WorksheetID: sheet.ID,
		MergeMode:   store.SheetMergeModeAuto,
		Cells: []store.SheetCellWrite{
			{RowID: rowID(0), ColumnID: colID(0), ExpectedRevision: 0, StylePatch: &store.SheetStylePatch{Bold: boolPtr(true)}},
		},
	})
	if err != nil || len(r2.Cells) != 1 || len(r2.Conflicts) != 0 || r2.MergedCount != 1 || !r2.Cells[0].Merged || r2.Cells[0].Raw != "=100+200" || !r2.Cells[0].Style.Bold {
		t.Fatalf("bob auto-merge bold: %+v err=%v", r2, err)
	}

	// Charlie also sets bg at stale expectedRevision=0 -> merges cleanly with BOTH raw AND bold!
	r3, err := st.WriteSheetCells(ctx, charlieG, sheetNode.ID, store.SheetCellBatch{
		MutationID:  mut(4),
		WorksheetID: sheet.ID,
		MergeMode:   store.SheetMergeModeAuto,
		Cells: []store.SheetCellWrite{
			{RowID: rowID(0), ColumnID: colID(0), ExpectedRevision: 0, StylePatch: &store.SheetStylePatch{Bg: strPtr("#fff2cc")}},
		},
	})
	if err != nil || len(r3.Cells) != 1 || len(r3.Conflicts) != 0 || r3.MergedCount != 1 || r3.Cells[0].Raw != "=100+200" || !r3.Cells[0].Style.Bold || r3.Cells[0].Style.Bg != "#fff2cc" {
		t.Fatalf("charlie auto-merge bg: %+v err=%v", r3, err)
	}

	// 2. Convergent identical value write on B1 converges with zero conflicts.
	if _, err := st.WriteSheetCells(ctx, aliceG, sheetNode.ID, store.SheetCellBatch{
		MutationID:  mut(5),
		WorksheetID: sheet.ID,
		MergeMode:   store.SheetMergeModeAuto,
		Cells:       []store.SheetCellWrite{{RowID: rowID(0), ColumnID: colID(1), ExpectedRevision: 0, Raw: strPtr("OK")}},
	}); err != nil {
		t.Fatal(err)
	}
	rConv, err := st.WriteSheetCells(ctx, bobG, sheetNode.ID, store.SheetCellBatch{
		MutationID:  mut(6),
		WorksheetID: sheet.ID,
		MergeMode:   store.SheetMergeModeAuto,
		Cells:       []store.SheetCellWrite{{RowID: rowID(0), ColumnID: colID(1), ExpectedRevision: 0, Raw: strPtr("OK")}},
	})
	if err != nil || len(rConv.Conflicts) != 0 || rConv.MergedCount != 1 {
		t.Fatalf("convergent write: %+v err=%v", rConv, err)
	}

	// 3. True same-cell value conflict on A2 + partial batch commit for B2.
	if _, err := st.WriteSheetCells(ctx, aliceG, sheetNode.ID, store.SheetCellBatch{
		MutationID:  mut(7),
		WorksheetID: sheet.ID,
		MergeMode:   store.SheetMergeModeAuto,
		Cells:       []store.SheetCellWrite{{RowID: rowID(1), ColumnID: colID(0), ExpectedRevision: 0, Raw: strPtr("Alice-A2")}},
	}); err != nil {
		t.Fatal(err)
	}
	rPartial, err := st.WriteSheetCells(ctx, bobG, sheetNode.ID, store.SheetCellBatch{
		MutationID:  mut(8),
		WorksheetID: sheet.ID,
		MergeMode:   store.SheetMergeModeAuto,
		Cells: []store.SheetCellWrite{
			{RowID: rowID(1), ColumnID: colID(0), ExpectedRevision: 0, Raw: strPtr("Bob-A2")},
			{RowID: rowID(1), ColumnID: colID(1), ExpectedRevision: 0, Raw: strPtr("Bob-B2-Clean")},
		},
	})
	if err != nil {
		t.Fatalf("partial batch err=%v", err)
	}
	if len(rPartial.Cells) != 1 || rPartial.Cells[0].ColumnID != colID(1) || rPartial.Cells[0].Raw != "Bob-B2-Clean" {
		t.Fatalf("expected B2 to commit in partial batch, got cells=%+v", rPartial.Cells)
	}
	if len(rPartial.Conflicts) != 1 || rPartial.Conflicts[0].Reason != "value_conflict" || rPartial.Conflicts[0].CurrentRaw != "Alice-A2" || rPartial.Conflicts[0].UpdatedByName != "Alice" {
		t.Fatalf("expected structured value_conflict on A2, got %+v", rPartial.Conflicts)
	}

	// Rebase Bob's A2 onto CurrentRevision -> succeeds!
	rRebase, err := st.WriteSheetCells(ctx, bobG, sheetNode.ID, store.SheetCellBatch{
		MutationID:  mut(9),
		WorksheetID: sheet.ID,
		MergeMode:   store.SheetMergeModeAuto,
		Cells: []store.SheetCellWrite{
			{RowID: rowID(1), ColumnID: colID(0), ExpectedRevision: rPartial.Conflicts[0].CurrentRevision, Raw: strPtr("Bob-A2")},
		},
	})
	if err != nil || len(rRebase.Cells) != 1 || len(rRebase.Conflicts) != 0 || rRebase.Cells[0].Raw != "Bob-A2" {
		t.Fatalf("rebase A2 failed: %+v err=%v", rRebase, err)
	}

	// 4. Disjoint concurrent region merges preserve BOTH merges!
	ws1, _, err := st.UpdateWorksheetMeta(ctx, aliceG, sheetNode.ID, sheet.ID, store.WorksheetPatch{
		MergeOp: &store.SheetMergeOp{
			Op:   "merge",
			Rect: store.SheetMerge{Top: 2, Left: 0, Bottom: 3, Right: 1}, // A3:B4
		},
	})
	if err != nil || len(ws1.Merges) != 1 {
		t.Fatalf("alice merge A3:B4 = %+v err=%v", ws1.Merges, err)
	}
	// Bob with stale empty ExpectedMerges merges disjoint D3:E4 -> BOTH survive!
	ws2, _, err := st.UpdateWorksheetMeta(ctx, bobG, sheetNode.ID, sheet.ID, store.WorksheetPatch{
		MergeOp: &store.SheetMergeOp{
			Op:             "merge",
			Rect:           store.SheetMerge{Top: 2, Left: 3, Bottom: 3, Right: 4}, // D3:E4
			ExpectedMerges: []store.SheetMerge{},
		},
	})
	if err != nil || len(ws2.Merges) != 2 {
		t.Fatalf("bob disjoint merge D3:E4 expected 2 merges, got %+v err=%v", ws2.Merges, err)
	}

	// 5. Overlapping unseen merge returns structured SheetRegionConflictError!
	_, _, err = st.UpdateWorksheetMeta(ctx, bobG, sheetNode.ID, sheet.ID, store.WorksheetPatch{
		MergeOp: &store.SheetMergeOp{
			Op:             "merge",
			Rect:           store.SheetMerge{Top: 3, Left: 1, Bottom: 4, Right: 2}, // B4:C5 overlaps A3:B4
			ExpectedMerges: []store.SheetMerge{},
		},
	})
	var regionErr *store.SheetRegionConflictError
	if !errors.As(err, &regionErr) || regionErr.Code != "merge_overlap_conflict" || len(regionErr.ConflictingMerges) != 1 {
		t.Fatalf("overlapping merge expected SheetRegionConflictError, got err=%v", err)
	}

	// Force=true replaces overlapping A3:B4 while preserving disjoint D3:E4!
	ws3, _, err := st.UpdateWorksheetMeta(ctx, bobG, sheetNode.ID, sheet.ID, store.WorksheetPatch{
		MergeOp: &store.SheetMergeOp{
			Op:    "merge",
			Rect:  store.SheetMerge{Top: 3, Left: 1, Bottom: 4, Right: 2}, // B4:C5
			Force: true,
		},
	})
	if err != nil || len(ws3.Merges) != 2 {
		t.Fatalf("force overlapping merge expected 2 merges (B4:C5 + D3:E4), got %+v err=%v", ws3.Merges, err)
	}

	// 6. Writing non-empty raw into a merge slave cell (C5 inside B4:C5) yields merge_slave_conflict!
	rSlave, err := st.WriteSheetCells(ctx, aliceG, sheetNode.ID, store.SheetCellBatch{
		MutationID:  mut(10),
		WorksheetID: sheet.ID,
		MergeMode:   store.SheetMergeModeAuto,
		Cells: []store.SheetCellWrite{
			{RowID: rowID(4), ColumnID: colID(2), ExpectedRevision: 0, Raw: strPtr("HiddenValue")},
		},
	})
	if err != nil || len(rSlave.Cells) != 0 || len(rSlave.Conflicts) != 1 || rSlave.Conflicts[0].Reason != "merge_slave_conflict" || rSlave.Conflicts[0].AnchorRowID != rowID(3) || rSlave.Conflicts[0].AnchorColumnID != colID(1) {
		t.Fatalf("expected merge_slave_conflict pointing to B4, got %+v err=%v", rSlave, err)
	}

	// 7. High-concurrency goroutine stress test: 12 concurrent workers writing orthogonal
	// fields to the same cell (row 6, col 0) and disjoint cells (row 6, col 1..9).
	var wg sync.WaitGroup
	errs := make(chan error, 12)
	workers := []struct {
		g     store.RestoreGuard
		write store.SheetCellWrite
		id    int
	}{
		{aliceG, store.SheetCellWrite{RowID: rowID(6), ColumnID: colID(0), ExpectedRevision: 0, Raw: strPtr("ConcurrentRoot")}, 101},
		{bobG, store.SheetCellWrite{RowID: rowID(6), ColumnID: colID(0), ExpectedRevision: 0, StylePatch: &store.SheetStylePatch{Bold: boolPtr(true)}}, 102},
		{charlieG, store.SheetCellWrite{RowID: rowID(6), ColumnID: colID(0), ExpectedRevision: 0, StylePatch: &store.SheetStylePatch{Italic: boolPtr(true)}}, 103},
		{aliceG, store.SheetCellWrite{RowID: rowID(6), ColumnID: colID(0), ExpectedRevision: 0, StylePatch: &store.SheetStylePatch{Color: strPtr("#3370ff")}}, 104},
		{bobG, store.SheetCellWrite{RowID: rowID(6), ColumnID: colID(0), ExpectedRevision: 0, StylePatch: &store.SheetStylePatch{Bg: strPtr("#e8f3ff")}}, 105},
		{charlieG, store.SheetCellWrite{RowID: rowID(6), ColumnID: colID(0), ExpectedRevision: 0, StylePatch: &store.SheetStylePatch{Align: strPtr("center")}}, 106},
	}
	for i := 1; i <= 6; i++ {
		g := aliceG
		if i%2 == 0 {
			g = bobG
		}
		workers = append(workers, struct {
			g     store.RestoreGuard
			write store.SheetCellWrite
			id    int
		}{
			g:     g,
			write: store.SheetCellWrite{RowID: rowID(6), ColumnID: colID(i), ExpectedRevision: 0, Raw: strPtr(fmt.Sprintf("V%d", i))},
			id:    110 + i,
		})
	}
	for _, wk := range workers {
		wk := wk
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, e := st.WriteSheetCells(ctx, wk.g, sheetNode.ID, store.SheetCellBatch{
				MutationID:  mut(wk.id),
				WorksheetID: sheet.ID,
				MergeMode:   store.SheetMergeModeAuto,
				Cells:       []store.SheetCellWrite{wk.write},
			})
			if e != nil {
				errs <- fmt.Errorf("worker %d err: %w", wk.id, e)
				return
			}
			if len(res.Conflicts) != 0 || len(res.Cells) != 1 {
				errs <- fmt.Errorf("worker %d unexpected result: %+v", wk.id, res)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}

	finalSnap, err := st.GetSheetWorkbook(ctx, aliceG, sheetNode.ID)
	if err != nil {
		t.Fatal(err)
	}
	var rootCell *store.SheetCell
	for i := range finalSnap.Sheets[0].Cells {
		c := &finalSnap.Sheets[0].Cells[i]
		if c.RowID == rowID(6) && c.ColumnID == colID(0) {
			rootCell = c
			break
		}
	}
	if rootCell == nil || rootCell.Raw != "ConcurrentRoot" || !rootCell.Style.Bold || !rootCell.Style.Italic || rootCell.Style.Color != "#3370ff" || rootCell.Style.Bg != "#e8f3ff" || rootCell.Style.Align != "center" {
		t.Fatalf("6-way concurrent orthogonal cell merge lost fields: %+v", rootCell)
	}
}

func TestMemorySheetConcurrentMerge(t *testing.T) {
	exerciseSheetConcurrentMerge(t, store.NewMemory())
}

func TestPostgresSheetConcurrentMerge(t *testing.T) {
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
	exerciseSheetConcurrentMerge(t, pg)
}
