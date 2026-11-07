package store

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
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func checkGuardedAutomations(t *testing.T, s Store) {
	t.Helper()
	ctx := context.Background()
	base, _, guard, view := baseGuardFixture(t, s)
	initial, err := s.BtHead(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	input := Automation{BaseID: base.ID, Name: "提醒", Enabled: true, TriggerKind: "schedule", Config: []byte(`{"schedule":{"every":"1h"}}`)}
	a, err := s.MutateAutomationGuarded(ctx, guard, base.ID, nil, &input)
	if err != nil || a.ID == 0 {
		t.Fatalf("create: %+v %v", a, err)
	}
	events, err := s.BtEventsAfter(ctx, base.ID, initial, 10)
	var eventBody map[string]any
	if err != nil || len(events) != 1 || json.Unmarshal(events[0].Body, &eventBody) != nil || eventBody["kind"] != "reload" {
		t.Fatalf("event: %+v %v", events, err)
	}
	list, err := s.Automations(ctx, base.ID)
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %+v %v", list, err)
	}
	before := list[0]
	fired := time.Now().UTC().Truncate(time.Microsecond)
	if err := s.MarkFired(ctx, a.ID, fired); err != nil {
		t.Fatal(err)
	}
	changed := before
	changed.Name = "已更新"
	updated, err := s.MutateAutomationGuarded(ctx, guard, base.ID, &before, &changed)
	if err != nil || updated.Name != changed.Name || !updated.LastFiredAt.Equal(fired) {
		t.Fatalf("update retained schedule: %+v %v", updated, err)
	}
	stale := before
	stale.Name = "陈旧名称"
	if _, err := s.MutateAutomationGuarded(ctx, guard, base.ID, &before, &stale); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale update: %v", err)
	}

	// The same observed state may be edited concurrently only once.
	current, err := s.Automations(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, name := range []string{"并发一", "并发二"} {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			next := current[0]
			next.Name = name
			_, err := s.MutateAutomationGuarded(ctx, guard, base.ID, &current[0], &next)
			errs <- err
		}(name)
	}
	wg.Wait()
	close(errs)
	var success, conflict int
	for err := range errs {
		if err == nil {
			success++
		} else if errors.Is(err, ErrConflict) {
			conflict++
		} else {
			t.Fatalf("concurrent update: %v", err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("success=%d conflict=%d", success, conflict)
	}
	view.Config = json.RawMessage(`{"locked":true}`)
	if _, err := s.UpdateView(ctx, view); err != nil {
		t.Fatal(err)
	}
	current, err = s.Automations(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.MutateAutomationGuarded(ctx, guard, base.ID, &current[0], nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("locked delete: %v", err)
	}
	if err := s.DeleteSession(ctx, guard.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err := s.MutateAutomationGuarded(ctx, guard, base.ID, &current[0], nil); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("logged out: %v", err)
	}
}

func TestMemoryGuardedAutomations(t *testing.T) { checkGuardedAutomations(t, NewMemory()) }

func TestPostgresGuardedAutomations(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_auto_guard_%d", time.Now().UnixNano())
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
	checkGuardedAutomations(t, s)
	owner, ws, err := s.CreateUser(ctx, "auto-rollback@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := s.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Rollback")
	if err != nil {
		t.Fatal(err)
	}
	guard := BaseWriteGuard{UserID: owner.ID, SessionHash: []byte("auto-rollback-session")}
	if err := s.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	kept, err := s.MutateAutomationGuarded(ctx, guard, base.ID, nil, &Automation{BaseID: base.ID, Name: "已有规则", Enabled: true, TriggerKind: "record_matches", Config: []byte(`{}`)})
	if err != nil {
		t.Fatal(err)
	}
	headBefore, err := s.BtHead(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE FUNCTION fail_auto_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'event failed'; END $$;
		CREATE TRIGGER fail_auto_event BEFORE INSERT ON bt_events FOR EACH ROW EXECUTE FUNCTION fail_auto_event()`); err != nil {
		t.Fatal(err)
	}
	input := Automation{BaseID: base.ID, Name: "不应保存", Enabled: true, TriggerKind: "record_matches", Config: []byte(`{}`)}
	if _, err := s.MutateAutomationGuarded(ctx, guard, base.ID, nil, &input); err == nil {
		t.Fatal("expected event failure")
	}
	updated := kept
	updated.Name = "不应更新"
	if _, err := s.MutateAutomationGuarded(ctx, guard, base.ID, &kept, &updated); err == nil {
		t.Fatal("expected update event failure")
	}
	if _, err := s.MutateAutomationGuarded(ctx, guard, base.ID, &kept, nil); err == nil {
		t.Fatal("expected delete event failure")
	}
	list, err := s.Automations(ctx, base.ID)
	if err != nil || len(list) != 1 || list[0].Name != kept.Name {
		t.Fatalf("partial mutation: %+v %v", list, err)
	}
	if head, err := s.BtHead(ctx, base.ID); err != nil || head != headBefore {
		t.Fatalf("partial event: %d %v", head, err)
	}
}
