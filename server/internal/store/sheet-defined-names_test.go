package store_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func i64Ptr(v int64) *int64 { return &v }

func exerciseSheetDefinedNamesStore(t *testing.T, st store.Store, dns store.SheetDefinedNamesStore) {
	t.Helper()
	ctx := context.Background()

	owner, ws, err := st.CreateUser(ctx, "dn-owner@example.test", "DNOwner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := st.CreateUser(ctx, "dn-editor@example.test", "DNEditor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	viewer, _, err := st.CreateUser(ctx, "dn-viewer@example.test", "DNViewer", "hash")
	if err != nil {
		t.Fatal(err)
	}
	outsider, _, err := st.CreateUser(ctx, "dn-outsider@example.test", "DNOutsider", "hash")
	if err != nil {
		t.Fatal(err)
	}

	ownerGuard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("dn-owner-sess")}
	editorGuard := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("dn-editor-sess")}
	viewerGuard := store.RestoreGuard{UserID: viewer.ID, SessionHash: []byte("dn-viewer-sess")}
	outsiderGuard := store.RestoreGuard{UserID: outsider.ID, SessionHash: []byte("dn-outsider-sess")}
	expiredGuard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("dn-expired-sess")}

	for _, item := range []struct {
		id   int64
		hash []byte
		exp  time.Time
	}{
		{owner.ID, ownerGuard.SessionHash, time.Now().Add(time.Hour)},
		{editor.ID, editorGuard.SessionHash, time.Now().Add(time.Hour)},
		{viewer.ID, viewerGuard.SessionHash, time.Now().Add(time.Hour)},
		{outsider.ID, outsiderGuard.SessionHash, time.Now().Add(time.Hour)},
		{owner.ID, expiredGuard.SessionHash, time.Now().Add(-time.Minute)},
	} {
		if err := st.CreateSession(ctx, item.hash, item.id, item.exp); err != nil {
			t.Fatal(err)
		}
	}

	sheetEntry, err := st.CreateDriveNodeWithType(ctx, ownerGuard, ws.ID, nil, "sheet", "", "预算表", true)
	if err != nil {
		t.Fatal(err)
	}
	docEntry, err := st.CreateDriveNodeWithType(ctx, ownerGuard, ws.ID, nil, "doc", "", "普通文档", true)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, sheetEntry.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, sheetEntry.ID, viewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}

	snap, err := st.GetSheetWorkbook(ctx, ownerGuard, sheetEntry.ID)
	if err != nil {
		t.Fatal(err)
	}
	ws1 := snap.Sheets[0]
	ws2, _, err := st.CreateWorksheet(ctx, editorGuard, sheetEntry.ID, "汇总")
	if err != nil {
		t.Fatal(err)
	}

	// 1. Unset defined names returns empty non-nil slice.
	initial, err := dns.GetSheetDefinedNames(ctx, ownerGuard, sheetEntry.ID)
	if err != nil {
		t.Fatalf("initial GetSheetDefinedNames err = %v", err)
	}
	if initial == nil || len(initial) != 0 {
		t.Fatalf("initial GetSheetDefinedNames = %#v, want empty non-nil slice", initial)
	}

	// 2. Permission & guard checks.
	if _, err := dns.GetSheetDefinedNames(ctx, outsiderGuard, sheetEntry.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("outsider GetSheetDefinedNames = %v, want ErrNotFound", err)
	}
	if _, err := dns.SaveSheetDefinedNamesGuarded(ctx, outsiderGuard, sheetEntry.ID, []store.SheetDefinedName{}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("outsider SaveSheetDefinedNamesGuarded = %v, want ErrNotFound", err)
	}
	if _, err := dns.SaveSheetDefinedNamesGuarded(ctx, viewerGuard, sheetEntry.ID, []store.SheetDefinedName{
		{Name: "TaxRate", Ref: "Sheet1!A1"},
	}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer SaveSheetDefinedNamesGuarded = %v, want ErrForbidden", err)
	}
	if _, err := dns.GetSheetDefinedNames(ctx, expiredGuard, sheetEntry.ID); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expired GetSheetDefinedNames = %v, want ErrUnauthenticated", err)
	}
	if _, err := dns.GetSheetDefinedNames(ctx, ownerGuard, docEntry.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("non-sheet GetSheetDefinedNames = %v, want ErrNotFound", err)
	}

	// 3. Save workbook-global and worksheet-scoped defined names (including same name in distinct scopes).
	ws1ID := ws1.ID
	ws2ID := ws2.ID
	input := []store.SheetDefinedName{
		{Name: " TaxRate ", Ref: " Sheet1!$B$1 ", Comment: " 税率常量 "},
		{Name: "TaxRate", Ref: "Sheet1!C1:C5", SheetID: &ws1ID, Comment: "Sheet1 局部覆盖"},
		{Name: "_Q1.Sales_2026", Ref: "'汇总'!B2:D10", SheetID: &ws2ID},
	}
	saved, err := dns.SaveSheetDefinedNamesGuarded(ctx, editorGuard, sheetEntry.ID, input)
	if err != nil {
		t.Fatalf("SaveSheetDefinedNamesGuarded err = %v", err)
	}
	if len(saved) != 3 {
		t.Fatalf("saved len = %d, want 3", len(saved))
	}
	if saved[0].Name != "TaxRate" || saved[0].Ref != "Sheet1!$B$1" || saved[0].SheetID != nil || saved[0].Comment != "税率常量" {
		t.Fatalf("saved[0] unexpected: %+v", saved[0])
	}
	if saved[1].SheetID == nil || *saved[1].SheetID != ws1.ID {
		t.Fatalf("saved[1] SheetID unexpected: %+v", saved[1])
	}
	// Mutating caller pointers must not corrupt stored values.
	*saved[1].SheetID = 999999
	saved[0].Name = "MUTATED"

	gotViewer, err := dns.GetSheetDefinedNames(ctx, viewerGuard, sheetEntry.ID)
	if err != nil {
		t.Fatalf("viewer GetSheetDefinedNames err = %v", err)
	}
	if len(gotViewer) != 3 || gotViewer[0].Name != "TaxRate" || gotViewer[1].SheetID == nil || *gotViewer[1].SheetID != ws1.ID || gotViewer[2].SheetID == nil || *gotViewer[2].SheetID != ws2.ID {
		t.Fatalf("viewer GetSheetDefinedNames unexpected: %+v", gotViewer)
	}

	// 4. Validation rejections.
	invalidCases := []struct {
		label string
		names []store.SheetDefinedName
	}{
		{"empty_name", []store.SheetDefinedName{{Name: "   ", Ref: "A1"}}},
		{"digit_start_name", []store.SheetDefinedName{{Name: "1Tax", Ref: "A1"}}},
		{"hyphen_name", []store.SheetDefinedName{{Name: "Tax-Rate", Ref: "A1"}}},
		{"name_65_chars", []store.SheetDefinedName{{Name: strings.Repeat("a", 65), Ref: "A1"}}},
		{"empty_ref", []store.SheetDefinedName{{Name: "TaxRate", Ref: "   "}}},
		{"ref_513_chars", []store.SheetDefinedName{{Name: "TaxRate", Ref: strings.Repeat("A", 513)}}},
		{"ref_nul", []store.SheetDefinedName{{Name: "TaxRate", Ref: "A1\x00B1"}}},
		{"comment_257_chars", []store.SheetDefinedName{{Name: "TaxRate", Ref: "A1", Comment: strings.Repeat("评", 257)}}},
		{"comment_nul", []store.SheetDefinedName{{Name: "TaxRate", Ref: "A1", Comment: "ok\x00bad"}}},
		{"zero_sheet_id", []store.SheetDefinedName{{Name: "TaxRate", Ref: "A1", SheetID: i64Ptr(0)}}},
		{"neg_sheet_id", []store.SheetDefinedName{{Name: "TaxRate", Ref: "A1", SheetID: i64Ptr(-3)}}},
		{"dup_global_case_insensitive", []store.SheetDefinedName{
			{Name: "TaxRate", Ref: "A1"},
			{Name: "taxrate", Ref: "A2"},
		}},
		{"dup_scoped_case_insensitive", []store.SheetDefinedName{
			{Name: "LocalSum", Ref: "A1", SheetID: i64Ptr(ws1.ID)},
			{Name: "localsum", Ref: "A2", SheetID: i64Ptr(ws1.ID)},
		}},
	}
	for _, tc := range invalidCases {
		if _, err := dns.SaveSheetDefinedNamesGuarded(ctx, ownerGuard, sheetEntry.ID, tc.names); !errors.Is(err, store.ErrInvalidSheetDefinedName) {
			t.Fatalf("case %s: err = %v, want ErrInvalidSheetDefinedName", tc.label, err)
		}
	}

	// 5. Boundary limits: 200 accepted, 201 rejected; 64-char name, 512-char ref, 256-char comment accepted.
	maxList := make([]store.SheetDefinedName, 200)
	for i := range maxList {
		maxList[i] = store.SheetDefinedName{
			Name: fmt.Sprintf("Name_%03d", i),
			Ref:  fmt.Sprintf("Sheet1!A%d", i+1),
		}
	}
	maxList[0] = store.SheetDefinedName{
		Name:    strings.Repeat("n", 64),
		Ref:     strings.Repeat("R", 512),
		Comment: strings.Repeat("注", 256),
	}
	if gotMax, err := dns.SaveSheetDefinedNamesGuarded(ctx, ownerGuard, sheetEntry.ID, maxList); err != nil || len(gotMax) != 200 {
		t.Fatalf("200 boundary names failed: len=%d err=%v", len(gotMax), err)
	}
	tooMany := append(maxList, store.SheetDefinedName{Name: "Overflow_201", Ref: "Sheet1!B1"})
	if _, err := dns.SaveSheetDefinedNamesGuarded(ctx, ownerGuard, sheetEntry.ID, tooMany); !errors.Is(err, store.ErrInvalidSheetDefinedName) {
		t.Fatalf("201 names err = %v, want ErrInvalidSheetDefinedName", err)
	}

	// 6. Clearing all defined names persists empty non-nil slice.
	cleared, err := dns.SaveSheetDefinedNamesGuarded(ctx, ownerGuard, sheetEntry.ID, []store.SheetDefinedName{})
	if err != nil {
		t.Fatalf("clear err = %v", err)
	}
	if cleared == nil || len(cleared) != 0 {
		t.Fatalf("cleared = %#v, want empty non-nil slice", cleared)
	}
	afterClear, err := dns.GetSheetDefinedNames(ctx, ownerGuard, sheetEntry.ID)
	if err != nil || afterClear == nil || len(afterClear) != 0 {
		t.Fatalf("afterClear = %#v err=%v", afterClear, err)
	}
}

func TestSheetDefinedNamesMemory(t *testing.T) {
	m := store.NewMemory()
	exerciseSheetDefinedNamesStore(t, m, m)
}

func TestSheetDefinedNamesPostgres(t *testing.T) {
	dsn := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	schema := fmt.Sprintf("test_sheet_dn_%d", time.Now().UnixNano())
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
	exerciseSheetDefinedNamesStore(t, pg, pg)
}
