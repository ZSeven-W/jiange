package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func fieldIDs(fields []store.Field) []int64 {
	out := make([]int64, len(fields))
	for i := range fields {
		out[i] = fields[i].ID
	}
	return out
}

func checkFieldOrder(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "field-order-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := st.CreateUser(ctx, "field-order-guest@example.test", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Order")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.BaseWriteGuard{UserID: owner.ID, SessionHash: []byte("field-order-owner-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	otherGuard := store.BaseWriteGuard{UserID: guest.ID, SessionHash: []byte("field-order-guest-session")}
	if err = st.CreateSession(ctx, otherGuard.SessionHash, guest.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err = st.AddField(ctx, store.Field{BaseID: b.ID, Name: "B", Type: "text"}); err != nil {
		t.Fatal(err)
	}
	if _, err = st.AddField(ctx, store.Field{BaseID: b.ID, Name: "C", Type: "text"}); err != nil {
		t.Fatal(err)
	}
	fields, err := st.Fields(ctx, b.ID)
	if err != nil || len(fields) != 3 {
		t.Fatalf("fields=%v err=%v", fields, err)
	}
	current := fieldIDs(fields)
	beforeHead, err := st.BtHead(ctx, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.ReorderFieldsGuarded(ctx, guard, b.ID, current, current); err != nil {
		t.Fatalf("no-op: %v", err)
	}
	afterHead, err := st.BtHead(ctx, b.ID)
	if err != nil || beforeHead != afterHead {
		t.Fatalf("no-op event: before=%d after=%d err=%v", beforeHead, afterHead, err)
	}
	if err = st.ReorderFieldsGuarded(ctx, otherGuard, b.ID, current, current); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("unshared: %v", err)
	}
	if err = st.ReorderFieldsGuarded(ctx, guard, b.ID, current[:2], current[:2]); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("partial list: %v", err)
	}
	if err = st.ReorderFieldsGuarded(ctx, guard, b.ID, current, []int64{current[0], current[0], current[2]}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("duplicate ID: %v", err)
	}
	if err = st.ReorderFieldsGuarded(ctx, guard, b.ID, current, []int64{current[0], current[1], 999999}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("foreign ID: %v", err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, order := range [][]int64{{current[0], current[2], current[1]}, {current[0], current[2], current[1]}} {
		wg.Add(1)
		go func(order []int64) {
			defer wg.Done()
			results <- st.ReorderFieldsGuarded(ctx, guard, b.ID, current, order)
		}(order)
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, store.ErrConflict) {
			conflict++
		} else {
			t.Fatalf("concurrent reorder: %v", err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("success=%d conflict=%d", success, conflict)
	}
	fields, err = st.Fields(ctx, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	order := fieldIDs(fields)
	if err = st.ReorderFieldsGuarded(ctx, guard, b.ID, current, current); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale after reorder: %v", err)
	}
	events, err := st.BtEventsAfter(ctx, b.ID, beforeHead, 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("events=%v err=%v", events, err)
	}
	var event struct {
		Kind string `json:"kind"`
	}
	if err = json.Unmarshal(events[0].Body, &event); err != nil || event.Kind != "reload" {
		t.Fatalf("event=%s err=%v", events[0].Body, err)
	}
	if err = st.DeleteSession(ctx, guard.SessionHash); err != nil {
		t.Fatal(err)
	}
	if err = st.ReorderFieldsGuarded(ctx, guard, b.ID, order, order); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expired session: %v", err)
	}
}

func TestMemoryFieldOrderGuarded(t *testing.T) { checkFieldOrder(t, store.NewMemory()) }

func TestPostgresFieldOrderGuarded(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_field_order_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
		admin.Close()
	}()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
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
	if _, err = migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	checkFieldOrder(t, &store.Postgres{Pool: pool})
}

func TestPostgresFieldOrderEventFailureRollsBack(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_field_order_rollback_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
		admin.Close()
	}()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
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
	if _, err = migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	st := &store.Postgres{Pool: pool}
	owner, ws, err := st.CreateUser(ctx, "field-order-rollback@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Order")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.BaseWriteGuard{UserID: owner.ID, SessionHash: []byte("field-order-rollback-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err = st.AddField(ctx, store.Field{BaseID: b.ID, Name: "B", Type: "text"}); err != nil {
		t.Fatal(err)
	}
	if _, err = st.AddField(ctx, store.Field{BaseID: b.ID, Name: "C", Type: "text"}); err != nil {
		t.Fatal(err)
	}
	before, err := st.Fields(ctx, b.ID)
	if err != nil || len(before) != 3 {
		t.Fatalf("fields=%v err=%v", before, err)
	}
	_, err = pool.Exec(ctx, `CREATE FUNCTION fail_field_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
		CREATE TRIGGER fail_field_event BEFORE INSERT ON bt_events FOR EACH ROW EXECUTE FUNCTION fail_field_event()`)
	if err != nil {
		t.Fatal(err)
	}
	ids := fieldIDs(before)
	if err = st.ReorderFieldsGuarded(ctx, guard, b.ID, ids, []int64{ids[0], ids[2], ids[1]}); err == nil {
		t.Fatal("expected injected failure")
	}
	after, err := st.Fields(ctx, b.ID)
	if err != nil || len(after) != 3 || after[0].ID != ids[0] || after[1].ID != ids[1] || after[2].ID != ids[2] || after[0].Position != before[0].Position || after[1].Position != before[1].Position || after[2].Position != before[2].Position {
		t.Fatalf("partial reorder after failure: before=%v after=%v err=%v", before, after, err)
	}
}
