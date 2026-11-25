package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func checkBaseHourlyDateAndFieldRestore(t *testing.T, st Store) {
	t.Helper()
	ctx := context.Background()
	base, _, guard, _ := baseGuardFixture(t, st)

	// 1. ValidBaseDateValue accepts civil dates and minute-precision datetimes, rejects ISO/invalid values.
	for _, valid := range []string{"2026-11-20", "2024-02-29", "2026-11-20 00:00", "2026-11-20 09:30", "2026-11-20 23:59"} {
		if !ValidBaseDateValue(valid) {
			t.Fatalf("expected valid date value %q", valid)
		}
	}
	for _, invalid := range []string{"", "2026-02-30", "2026-11-20T09:30:00Z", "2026-11-20 24:00", "2026-11-20 9:30", "0000-01-01"} {
		if ValidBaseDateValue(invalid) {
			t.Fatalf("expected invalid date value %q", invalid)
		}
	}

	// 2. CompareDateCells supports hourly scheduling timestamps ("YYYY-MM-DD HH:mm") via CAS.
	start, err := st.AddField(ctx, Field{BaseID: base.ID, Name: "开始时间", Type: "date"})
	if err != nil {
		t.Fatal(err)
	}
	end, err := st.AddField(ctx, Field{BaseID: base.ID, Name: "结束时间", Type: "date"})
	if err != nil {
		t.Fatal(err)
	}
	rows, err := st.Records(ctx, base.ID)
	if err != nil || len(rows) == 0 {
		t.Fatalf("records=%v err=%v", rows, err)
	}
	rid := rows[0].ID
	sk, ek := strconv.FormatInt(start.ID, 10), strconv.FormatInt(end.ID, 10)
	updated, changed, err := st.CompareDateCells(
		ctx,
		guard,
		base.ID,
		rid,
		map[string]json.RawMessage{sk: json.RawMessage("null"), ek: json.RawMessage("null")},
		map[string]json.RawMessage{sk: dateValue("2026-11-20 09:30"), ek: dateValue("2026-11-20 11:00")},
	)
	if err != nil || !changed {
		t.Fatalf("hourly compare failed: changed=%v err=%v", changed, err)
	}
	if string(updated.Cells[sk]) != `"2026-11-20 09:30"` || string(updated.Cells[ek]) != `"2026-11-20 11:00"` {
		t.Fatalf("unexpected hourly cells: %+v", updated.Cells)
	}
	if _, _, err := st.CompareDateCells(
		ctx,
		guard,
		base.ID,
		rid,
		map[string]json.RawMessage{sk: dateValue("2026-11-20 09:30")},
		map[string]json.RawMessage{sk: dateValue("2026-11-20 25:00")},
	); !errors.Is(err, ErrInvalidDateCells) {
		t.Fatalf("expected ErrInvalidDateCells for 25:00, got %v", err)
	}

	// 3. RestoreFieldGuarded atomically re-creates a deleted field at its original position and restores cells.
	noteField, err := st.AddField(ctx, Field{BaseID: base.ID, Name: "排期备注", Type: "text", Description: "内部说明"})
	if err != nil {
		t.Fatal(err)
	}
	noteKey := strconv.FormatInt(noteField.ID, 10)
	if _, err := st.SetCells(ctx, base.ID, rid, map[string]json.RawMessage{noteKey: json.RawMessage(`"保留内容"`)}); err != nil {
		t.Fatal(err)
	}
	allFields, err := st.Fields(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	var targetField Field
	for _, f := range allFields {
		if f.ID == noteField.ID {
			targetField = f
			break
		}
	}
	if _, err := st.MutateFieldGuarded(ctx, guard, FieldMutation{
		BaseID: base.ID,
		Before: &targetField,
		After:  nil,
		Fields: allFields,
	}); err != nil {
		t.Fatalf("delete field: %v", err)
	}

	// Reject restoring link field or crossing primary position.
	if _, _, err := st.RestoreFieldGuarded(ctx, guard, base.ID, RestoreFieldInput{
		Field: Field{TableID: targetField.TableID, Name: "BadLink", Type: "link"},
	}, nil); !errors.Is(err, ErrInvalidBaseRecord) {
		t.Fatalf("expected ErrInvalidBaseRecord for link restore, got %v", err)
	}
	if _, _, err := st.RestoreFieldGuarded(ctx, guard, base.ID, RestoreFieldInput{
		Field: Field{TableID: targetField.TableID, Name: "CrossPrimary", Type: "text", Position: 0.5},
	}, nil); !errors.Is(err, ErrPrimaryField) {
		t.Fatalf("expected ErrPrimaryField crossing primary, got %v", err)
	}

	restoredField, restoredCount, err := st.RestoreFieldGuarded(ctx, guard, base.ID, RestoreFieldInput{
		Field: Field{
			TableID:     targetField.TableID,
			Name:        targetField.Name,
			Type:        targetField.Type,
			Description: targetField.Description,
			Position:    targetField.Position,
		},
		Cells: []RestoreFieldCellInput{
			{RecordID: rid, Value: json.RawMessage(`"保留内容"`)},
			{RecordID: 99999999, Value: json.RawMessage(`"已删除记录应安全跳过"`)},
		},
	}, nil)
	if err != nil {
		t.Fatalf("restore field: %v", err)
	}
	if restoredField.ID == 0 || restoredField.Name != "排期备注" || restoredField.Position != targetField.Position {
		t.Fatalf("unexpected restored field: %+v", restoredField)
	}
	if restoredCount != 1 {
		t.Fatalf("expected 1 restored cell, got %d", restoredCount)
	}
	rowsAfter, err := st.Records(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	var gotVal string
	for _, r := range rowsAfter {
		if r.ID == rid {
			gotVal = string(r.Cells[strconv.FormatInt(restoredField.ID, 10)])
		}
	}
	if gotVal != `"保留内容"` {
		t.Fatalf("expected restored cell value \"保留内容\", got %q", gotVal)
	}
}

func TestMemoryBaseHourlyDateAndFieldRestore(t *testing.T) {
	checkBaseHourlyDateAndFieldRestore(t, NewMemory())
}

func TestPostgresBaseHourlyDateAndFieldRestore(t *testing.T) {
	dsn := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_restore_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
		admin.Close()
	}()
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
	checkBaseHourlyDateAndFieldRestore(t, &Postgres{Pool: pool})
}
