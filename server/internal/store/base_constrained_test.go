package store_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func checkConstrainedQuery(t *testing.T, s store.Store) {
	t.Helper()
	ctx := context.Background()
	u, ws, err := s.CreateUser(ctx, "constrained@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := s.CreateBase(ctx, ws.ID, u.ID, nil, "b")
	if err != nil {
		t.Fatal(err)
	}
	status, err := s.AddField(ctx, store.Field{BaseID: base.ID, Name: "status", Type: "text"})
	if err != nil {
		t.Fatal(err)
	}
	number, err := s.AddField(ctx, store.Field{BaseID: base.ID, Name: "number", Type: "number"})
	if err != nil {
		t.Fatal(err)
	}
	fields := []store.Field{status, number}
	sk, nk := strconv.FormatInt(status.ID, 10), strconv.FormatInt(number.ID, 10)
	for _, row := range []struct{ s, n string }{{`"public"`, `1`}, {`"public"`, `3`}, {`"private"`, `2`}, {`"archived"`, `2`}, {`"public"`, `5`}} {
		_, err := s.AddRecord(ctx, store.Record{BaseID: base.ID, Cells: map[string]json.RawMessage{sk: json.RawMessage(row.s), nk: json.RawMessage(row.n)}})
		if err != nil {
			t.Fatal(err)
		}
	}
	mandatory := []btquery.Config{{Filters: &btquery.Filters{Conj: "or", Rules: []btquery.Rule{{F: status.ID, Op: "is", V: "public"}, {F: status.ID, Op: "is", V: "archived"}}}}}
	user := btquery.Config{Filters: &btquery.Filters{Conj: "or", Rules: []btquery.Rule{{F: number.ID, Op: "lte", V: 3}, {F: status.ID, Op: "is", V: "private"}}}, Sorts: []btquery.Sort{{F: number.ID, Asc: false}}}
	rows, err := s.QueryRecordsConstrained(ctx, base.ID, fields, mandatory, user, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || string(rows[0].Cells[nk]) != "3" || string(rows[1].Cells[nk]) != "2" || string(rows[1].Cells[sk]) != `"archived"` {
		t.Fatalf("constraint/order/limit: %+v", rows)
	}
	if _, err := s.AddRecord(ctx, store.Record{BaseID: base.ID, Cells: map[string]json.RawMessage{sk: json.RawMessage(`"100%_done"`)}}); err != nil {
		t.Fatal(err)
	}
	wildcard := []btquery.Config{{Filters: &btquery.Filters{Conj: "and", Rules: []btquery.Rule{{F: status.ID, Op: "contains", V: "%_"}}}}}
	rows, err = s.QueryRecordsConstrained(ctx, base.ID, fields, wildcard, btquery.Config{}, 100)
	if err != nil || len(rows) != 1 || string(rows[0].Cells[sk]) != `"100%_done"` {
		t.Fatalf("literal wildcard policy: %+v %v", rows, err)
	}
	// Text inequalities are lexical even when both values look numeric.
	if _, err := s.AddRecord(ctx, store.Record{BaseID: base.ID, Cells: map[string]json.RawMessage{sk: json.RawMessage(`"2"`)}}); err != nil {
		t.Fatal(err)
	}
	textGT := []btquery.Config{{Filters: &btquery.Filters{Conj: "and", Rules: []btquery.Rule{{F: status.ID, Op: "gt", V: "10"}}}}}
	rows, err = s.QueryRecordsConstrained(ctx, base.ID, fields, textGT, btquery.Config{}, 100)
	if err != nil {
		t.Fatal(err)
	}
	foundTwo := false
	for _, row := range rows {
		if string(row.Cells[sk]) == `"2"` {
			foundTwo = true
		}
	}
	if !foundTwo {
		t.Fatal("text comparison incorrectly used numeric ordering")
	}
	// JSON numeric equality must bind a number on both implementations.
	equal := []btquery.Config{{Filters: &btquery.Filters{Conj: "and", Rules: []btquery.Rule{{F: number.ID, Op: "is", V: float64(3)}}}}}
	rows, err = s.QueryRecordsConstrained(ctx, base.ID, fields, equal, btquery.Config{}, 100)
	if err != nil || len(rows) != 1 || string(rows[0].Cells[nk]) != "3" {
		t.Fatalf("number equality: %+v %v", rows, err)
	}
	flag, err := s.AddField(ctx, store.Field{BaseID: base.ID, Name: "flag", Type: "checkbox"})
	if err != nil {
		t.Fatal(err)
	}
	fk := strconv.FormatInt(flag.ID, 10)
	for _, value := range []json.RawMessage{json.RawMessage(`true`), json.RawMessage(`false`), json.RawMessage(`null`), json.RawMessage(`"true"`)} {
		if _, err := s.AddRecord(ctx, store.Record{BaseID: base.ID, Cells: map[string]json.RawMessage{fk: value}}); err != nil {
			t.Fatal(err)
		}
	}
	withFlag := append(append([]store.Field(nil), fields...), flag)
	checked := []btquery.Config{{Filters: &btquery.Filters{Conj: "and", Rules: []btquery.Rule{{F: flag.ID, Op: "checked"}}}}}
	rows, err = s.QueryRecordsConstrained(ctx, base.ID, withFlag, checked, btquery.Config{}, 100)
	if err != nil || len(rows) != 1 || string(rows[0].Cells[fk]) != "true" {
		t.Fatalf("checkbox type safety: %+v %v", rows, err)
	}
	unchecked := []btquery.Config{{Filters: &btquery.Filters{Conj: "and", Rules: []btquery.Rule{{F: flag.ID, Op: "unchecked"}}}}}
	rows, err = s.QueryRecordsConstrained(ctx, base.ID, withFlag, unchecked, btquery.Config{}, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if string(row.Cells[fk]) == `"true"` || string(row.Cells[fk]) == "true" {
			t.Fatalf("invalid checkbox included in unchecked: %+v", row)
		}
	}
	// Evaluating a multi-select as serialized JSON would make syntax (such as
	// quotes) match as content. Derived fields are not stored in cells at all.
	for _, typ := range []string{"multi_select", "link", "lookup", "formula", "created_by", "created_at", "modified_at"} {
		f, err := s.AddField(ctx, store.Field{BaseID: base.ID, Name: typ, Type: typ})
		if err != nil {
			t.Fatal(err)
		}
		all := append(append([]store.Field(nil), fields...), f)
		bad := []btquery.Config{{Filters: &btquery.Filters{Conj: "and", Rules: []btquery.Rule{{F: f.ID, Op: "contains", V: `"`}}}}}
		if _, err := s.QueryRecordsConstrained(ctx, base.ID, all, bad, btquery.Config{}, 100); err == nil {
			t.Fatalf("unsupported mandatory filter accepted for %s", typ)
		}
		if typ == "created_by" || typ == "created_at" || typ == "modified_at" || typ == "formula" || typ == "link" || typ == "lookup" {
			bad[0].Filters.Rules[0].Op = "empty"
			if _, err := s.QueryRecordsConstrained(ctx, base.ID, all, bad, btquery.Config{}, 100); err == nil {
				t.Fatalf("derived mandatory empty filter accepted for %s", typ)
			}
		}
	}
	bad := []btquery.Config{{Filters: &btquery.Filters{Conj: "and", Rules: []btquery.Rule{{F: 999999, Op: "is", V: "private"}}}}}
	if _, err := s.QueryRecordsConstrained(ctx, base.ID, fields, bad, btquery.Config{}, 100); err == nil {
		t.Fatal("invalid constraint accepted")
	}
}
func TestMemoryConstrainedBaseQuery(t *testing.T) { checkConstrainedQuery(t, store.NewMemory()) }
func TestPostgresConstrainedBaseQuery(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_constraints_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
		admin.Close()
	}()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
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
	checkConstrainedQuery(t, &store.Postgres{Pool: pool})
}
