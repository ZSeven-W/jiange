package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func dateValue(s string) json.RawMessage { b, _ := json.Marshal(s); return b }

func checkDateComparison(t *testing.T, st Store) {
	t.Helper()
	ctx := context.Background()
	base, _, guard, view := baseGuardFixture(t, st)
	start, err := st.AddField(ctx, Field{BaseID: base.ID, Name: "Start", Type: "date"})
	if err != nil {
		t.Fatal(err)
	}
	end, err := st.AddField(ctx, Field{BaseID: base.ID, Name: "End", Type: "date"})
	if err != nil {
		t.Fatal(err)
	}
	fields, err := st.Fields(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := st.Records(ctx, base.ID)
	if err != nil || len(rows) == 0 {
		t.Fatalf("records=%v err=%v", rows, err)
	}
	rid := rows[0].ID
	a, b := strconv.FormatInt(start.ID, 10), strconv.FormatInt(end.ID, 10)
	nilValue := json.RawMessage("null")
	expected := map[string]json.RawMessage{a: nilValue, b: nilValue}
	next := map[string]json.RawMessage{a: dateValue("2026-03-08"), b: dateValue("2026-03-09")}
	updated, changed, err := st.CompareDateCells(ctx, guard, base.ID, rid, expected, next)
	if err != nil || !changed || string(updated.Cells[a]) != `"2026-03-08"` || string(updated.Cells[b]) != `"2026-03-09"` {
		t.Fatalf("initial compare: %+v changed=%v err=%v", updated, changed, err)
	}
	head, err := st.BtHead(ctx, base.ID)
	if err != nil || head == 0 {
		t.Fatalf("event head=%d err=%v", head, err)
	}
	if _, _, err := st.CompareDateCells(ctx, guard, base.ID, rid, expected, next); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale compare: %v", err)
	}
	head2, _ := st.BtHead(ctx, base.ID)
	if head2 != head {
		t.Fatalf("stale compare emitted event: %d -> %d", head, head2)
	}
	_, changed, err = st.CompareDateCells(ctx, guard, base.ID, rid, next, next)
	if err != nil || changed {
		t.Fatalf("no-op changed=%v err=%v", changed, err)
	}
	if after, _ := st.BtHead(ctx, base.ID); after != head {
		t.Fatalf("no-op emitted event %d", after)
	}
	if _, _, err := st.CompareDateCells(ctx, guard, base.ID, rid, next, map[string]json.RawMessage{a: dateValue("2026-02-30"), b: nilValue}); !errors.Is(err, ErrInvalidDateCells) {
		t.Fatalf("invalid date: %v", err)
	}
	if _, _, err := st.CompareDateCells(ctx, guard, base.ID, rid, map[string]json.RawMessage{strconv.FormatInt(fields[0].ID, 10): nilValue}, map[string]json.RawMessage{strconv.FormatInt(fields[0].ID, 10): dateValue("2026-01-01")}); !errors.Is(err, ErrInvalidDateCells) {
		t.Fatalf("non-date field: %v", err)
	}

	// Two concurrent users of the same snapshot: exactly one CAS can commit.
	one := map[string]json.RawMessage{a: dateValue("2026-03-10"), b: dateValue("2026-03-11")}
	two := map[string]json.RawMessage{a: dateValue("2026-03-12"), b: dateValue("2026-03-13")}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, candidate := range []map[string]json.RawMessage{one, two} {
		wg.Add(1)
		go func(c map[string]json.RawMessage) {
			defer wg.Done()
			_, _, e := st.CompareDateCells(ctx, guard, base.ID, rid, next, c)
			results <- e
		}(candidate)
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for e := range results {
		if e == nil {
			success++
		} else if errors.Is(e, ErrConflict) {
			conflict++
		} else {
			t.Fatalf("concurrent CAS: %v", e)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("success=%d conflict=%d", success, conflict)
	}
	view.Config = json.RawMessage(`{"locked":true}`)
	if _, err := st.UpdateView(ctx, view); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.CompareDateCells(ctx, guard, base.ID, rid, next, one); !errors.Is(err, ErrForbidden) {
		t.Fatalf("locked compare: %v", err)
	}
	if err := st.DeleteSession(ctx, guard.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.CompareDateCells(ctx, guard, base.ID, rid, next, one); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("session removed: %v", err)
	}
}

func TestMemoryCompareDateCells(t *testing.T) { checkDateComparison(t, NewMemory()) }

func TestPostgresCompareDateCells(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_compare_%d", time.Now().UnixNano())
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
	s := &Postgres{Pool: pool}
	checkDateComparison(t, s)

	// Failure after the record UPDATE but before its event insert must roll
	// back both the changed cells and the event head.
	owner, ws, err := s.CreateUser(ctx, "compare-rollback@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := s.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "rollback")
	if err != nil {
		t.Fatal(err)
	}
	field, err := s.AddField(ctx, Field{BaseID: base.ID, Name: "Date", Type: "date"})
	if err != nil {
		t.Fatal(err)
	}
	rows, err := s.Records(ctx, base.ID)
	if err != nil || len(rows) == 0 {
		t.Fatalf("rows=%v err=%v", rows, err)
	}
	guard := BaseWriteGuard{UserID: owner.ID, SessionHash: []byte("compare-rollback-session")}
	if err := s.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE FUNCTION fail_compare_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected event failure'; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TRIGGER fail_compare_event BEFORE INSERT ON bt_events FOR EACH ROW EXECUTE FUNCTION fail_compare_event()`); err != nil {
		t.Fatal(err)
	}
	key := strconv.FormatInt(field.ID, 10)
	if _, _, err := s.CompareDateCells(ctx, guard, base.ID, rows[0].ID, map[string]json.RawMessage{key: json.RawMessage("null")}, map[string]json.RawMessage{key: dateValue("2026-04-01")}); err == nil {
		t.Fatal("event failure unexpectedly committed")
	}
	rows, err = s.Records(ctx, base.ID)
	if err != nil || len(rows[0].Cells[key]) != 0 {
		t.Fatalf("partial update: rows=%+v err=%v", rows, err)
	}
	if head, err := s.BtHead(ctx, base.ID); err != nil || head != 0 {
		t.Fatalf("head=%d err=%v", head, err)
	}
}
