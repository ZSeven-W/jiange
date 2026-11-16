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

	"github.com/ZSeven-W/jiange/server/internal/btquery"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func checkRecordConstrained(t *testing.T, st Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "projection-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := st.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "base")
	if err != nil {
		t.Fatal(err)
	}
	fields, err := st.Fields(ctx, base.ID)
	if err != nil || len(fields) == 0 {
		t.Fatalf("fields=%v err=%v", fields, err)
	}
	key := strconv.FormatInt(fields[0].ID, 10)
	bulk := make([]Record, 10001)
	for i := range bulk {
		bulk[i] = Record{Cells: map[string]json.RawMessage{key: json.RawMessage(`"公开"`)}}
	}
	if err := st.AddRecordsBulk(ctx, base.ID, bulk); err != nil {
		t.Fatal(err)
	}
	// The bulk store helper may cap Records at 10k; add the selected last row
	// directly and use its returned ID to prove lookup is not window-limited.
	last, err := st.AddRecord(ctx, Record{BaseID: base.ID, Cells: map[string]json.RawMessage{key: json.RawMessage(`"公开"`)}})
	if err != nil {
		t.Fatal(err)
	}
	match := []btquery.Config{{Filters: &btquery.Filters{Conj: "and", Rules: []btquery.Rule{{F: fields[0].ID, Op: "is", V: "公开"}}}}}
	row, err := st.RecordConstrained(ctx, base.ID, last.ID, fields, match)
	if err != nil || row.ID != last.ID || string(row.Cells[key]) != `"公开"` {
		t.Fatalf("late row=%+v err=%v", row, err)
	}
	deny := []btquery.Config{{Filters: &btquery.Filters{Conj: "and", Rules: []btquery.Rule{{F: fields[0].ID, Op: "is", V: "机密"}}}}}
	if _, err := st.RecordConstrained(ctx, base.ID, last.ID, fields, deny); !errors.Is(err, ErrNotFound) {
		t.Fatalf("denied row: %v", err)
	}
	if _, err := st.RecordConstrained(ctx, base.ID, last.ID+999999, fields, match); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing row: %v", err)
	}
	private, err := st.AddRecord(ctx, Record{BaseID: base.ID, Cells: map[string]json.RawMessage{key: json.RawMessage(`"机密"`)}})
	if err != nil {
		t.Fatal(err)
	}
	visible, err := st.VisibleRecordIDs(ctx, base.ID, []int64{private.ID, last.ID, last.ID, last.ID + 999999}, fields, match)
	if err != nil || len(visible) != 1 || visible[0] != last.ID {
		t.Fatalf("visible IDs=%v err=%v", visible, err)
	}
}

func TestMemoryRecordConstrained(t *testing.T) { checkRecordConstrained(t, NewMemory()) }
func TestPostgresRecordConstrained(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_record_projection_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
		admin.Close()
	}()
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
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	checkRecordConstrained(t, &Postgres{Pool: pool})
}
