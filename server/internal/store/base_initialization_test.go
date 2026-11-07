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
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func checkInitializedBase(t *testing.T, s store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := s.CreateUser(ctx, "init-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, otherWS, err := s.CreateUser(ctx, "init-guest@example.test", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	parent, err := s.CreateDoc(ctx, ws.ID, owner.ID, nil, "Parent", nil)
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := s.CreateDoc(ctx, otherWS.ID, guest.ID, nil, "Foreign", nil)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := s.CreateInitializedBase(ctx, ws.ID, guest.ID, nil, "No permission"); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("foreign member: %v", err)
	}
	missing := int64(987654321)
	for _, invalid := range []int64{missing, foreign.ID} {
		if _, err := s.CreateInitializedBase(ctx, ws.ID, owner.ID, &invalid, "Invalid parent"); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("parent %d: %v", invalid, err)
		}
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := s.CreateInitializedBase(cancelled, ws.ID, owner.ID, nil, "Canceled"); err == nil {
		t.Fatal("canceled create succeeded")
	}
	base, err := s.CreateInitializedBase(ctx, ws.ID, owner.ID, &parent.ID, "项目")
	if err != nil {
		t.Fatal(err)
	}
	if base.Kind != "base" || base.Title != "项目" || base.ParentID == nil || *base.ParentID != parent.ID {
		t.Fatalf("base: %+v", base)
	}
	fields, err := s.Fields(ctx, base.ID)
	if err != nil || len(fields) != 1 || fields[0].Name != "文本" || fields[0].Type != "text" {
		t.Fatalf("fields=%+v err=%v", fields, err)
	}
	views, err := s.Views(ctx, base.ID)
	if err != nil || len(views) != 1 || views[0].Name != "表格" || views[0].Type != "grid" || string(views[0].Config) != "{}" {
		t.Fatalf("views=%+v err=%v", views, err)
	}
	records, err := s.Records(ctx, base.ID)
	if err != nil || len(records) != 5 {
		t.Fatalf("records=%+v err=%v", records, err)
	}
	for i, rec := range records {
		if rec.BaseID != base.ID || len(rec.Cells) != 0 || rec.CreatorID == nil || *rec.CreatorID != owner.ID || rec.CreatedAt == nil || rec.UpdatedAt == nil || (i > 0 && rec.Position <= records[i-1].Position) {
			t.Fatalf("record %d: %+v", i, rec)
		}
	}
	if err := s.Trash(ctx, parent.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateInitializedBase(ctx, ws.ID, owner.ID, &parent.ID, "Trashed parent"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("trashed parent: %v", err)
	}

	// The legacy low-level constructor remains empty: copy/import and test
	// callers can build their own schema without duplicating defaults.
	raw, err := s.CreateBase(ctx, ws.ID, owner.ID, nil, "Raw")
	if err != nil {
		t.Fatal(err)
	}
	rawFields, err := s.Fields(ctx, raw.ID)
	if err != nil || len(rawFields) != 0 {
		t.Fatalf("legacy fields=%+v err=%v", rawFields, err)
	}
	rawViews, err := s.Views(ctx, raw.ID)
	if err != nil || len(rawViews) != 0 {
		t.Fatalf("legacy views=%+v err=%v", rawViews, err)
	}

	// Concurrent creates must never mix schema/records between new bases.
	const n = 12
	var wg sync.WaitGroup
	ids := make(chan int64, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			b, err := s.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "并发")
			if err != nil {
				t.Errorf("concurrent create: %v", err)
				return
			}
			ids <- b.ID
		}()
	}
	wg.Wait()
	close(ids)
	seen := map[int64]bool{}
	for id := range ids {
		if seen[id] {
			t.Fatalf("duplicate ID %d", id)
		}
		seen[id] = true
		f, e1 := s.Fields(ctx, id)
		v, e2 := s.Views(ctx, id)
		r, e3 := s.Records(ctx, id)
		if e1 != nil || e2 != nil || e3 != nil || len(f) != 1 || len(v) != 1 || len(r) != 5 {
			t.Fatalf("partial base %d: f=%v v=%v r=%v errors=%v/%v/%v", id, f, v, r, e1, e2, e3)
		}
	}
	if len(seen) != n {
		t.Fatalf("created=%d want=%d", len(seen), n)
	}
}

func TestMemoryInitializedBase(t *testing.T) { checkInitializedBase(t, store.NewMemory()) }

func TestPostgresInitializedBase(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_base_init_%d", time.Now().UnixNano())
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
	s := &store.Postgres{Pool: pool}
	checkInitializedBase(t, s)

	user, ws, err := s.CreateUser(ctx, "init-failure@example.test", "Failure", "hash")
	if err != nil {
		t.Fatal(err)
	}
	var beforeNodes, beforeFields, beforeViews, beforeRows int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM nodes), (SELECT count(*) FROM base_fields), (SELECT count(*) FROM bt_views), (SELECT count(*) FROM base_records)`).Scan(&beforeNodes, &beforeFields, &beforeViews, &beforeRows); err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `CREATE FUNCTION fail_base_initial_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.position = 3 THEN RAISE EXCEPTION 'injected base initialization failure'; END IF; RETURN NEW; END $$`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TRIGGER fail_base_initial_record BEFORE INSERT ON base_records FOR EACH ROW EXECUTE FUNCTION fail_base_initial_record()`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateInitializedBase(ctx, ws.ID, user.ID, nil, "must roll back"); err == nil {
		t.Fatal("injected failure succeeded")
	}
	var nodes, fields, views, rows int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM nodes), (SELECT count(*) FROM base_fields), (SELECT count(*) FROM bt_views), (SELECT count(*) FROM base_records)`).Scan(&nodes, &fields, &views, &rows); err != nil {
		t.Fatal(err)
	}
	if nodes != beforeNodes || fields != beforeFields || views != beforeViews || rows != beforeRows {
		t.Fatalf("partial publication: nodes %d/%d fields %d/%d views %d/%d rows %d/%d", nodes, beforeNodes, fields, beforeFields, views, beforeViews, rows, beforeRows)
	}
	if _, err := pool.Exec(ctx, `DROP TRIGGER fail_base_initial_record ON base_records`); err != nil {
		t.Fatal(err)
	}

	// Pause the insert partway through the transaction. Neither the new node
	// nor incomplete defaults may be observed, and revoking membership must
	// wait until the create either commits or rolls back.
	lockID := time.Now().UnixNano() % 2000000000
	blocker, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Release()
	if _, err := blocker.Exec(ctx, `SELECT pg_advisory_lock($1)`, lockID); err != nil {
		t.Fatal(err)
	}
	defer blocker.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, lockID)
	function := fmt.Sprintf(`CREATE FUNCTION block_base_initial_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(%d); RETURN NEW; END $$`, lockID)
	if _, err := pool.Exec(ctx, function); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TRIGGER block_base_initial_record BEFORE INSERT ON base_records FOR EACH ROW EXECUTE FUNCTION block_base_initial_record()`); err != nil {
		t.Fatal(err)
	}
	created := make(chan error, 1)
	go func() {
		_, err := s.CreateInitializedBase(ctx, ws.ID, user.ID, nil, "uncommitted base")
		created <- err
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=$1::oid)`, lockID).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("create did not reach the blocked insert")
		}
		time.Sleep(10 * time.Millisecond)
	}
	var visible int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM nodes WHERE title='uncommitted base'`).Scan(&visible); err != nil || visible != 0 {
		t.Fatalf("uncommitted node visible: %d, %v", visible, err)
	}
	revoked := make(chan error, 1)
	go func() {
		_, err := pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, ws.ID, user.ID)
		revoked <- err
	}()
	select {
	case err := <-revoked:
		t.Fatalf("membership change did not wait for create: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if _, err := blocker.Exec(ctx, `SELECT pg_advisory_unlock($1)`, lockID); err != nil {
		t.Fatal(err)
	}
	if err := <-created; err != nil {
		t.Fatalf("create after releasing blocker: %v", err)
	}
	if err := <-revoked; err != nil {
		t.Fatalf("membership revoke: %v", err)
	}
	if _, err := s.CreateInitializedBase(ctx, ws.ID, user.ID, nil, "after revoke"); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("create after membership revoked: %v", err)
	}
}

func TestPostgresCreateBaseDuringAncestorTrash(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_base_trash_%d", time.Now().UnixNano())
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
	cfg.ConnConfig.RuntimeParams["application_name"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	s := &store.Postgres{Pool: pool}
	u, ws, err := s.CreateUser(ctx, "base-trash-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	root, err := s.CreateDoc(ctx, ws.ID, u.ID, nil, "root", nil)
	if err != nil {
		t.Fatal(err)
	}
	parent, err := s.CreateDoc(ctx, ws.ID, u.ID, &root.ID, "parent", nil)
	if err != nil {
		t.Fatal(err)
	}
	lockID := time.Now().UnixNano() % 2000000000
	blocker, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Release()
	if _, err := blocker.Exec(ctx, `SELECT pg_advisory_lock($1)`, lockID); err != nil {
		t.Fatal(err)
	}
	defer blocker.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, lockID)
	function := fmt.Sprintf(`CREATE FUNCTION pause_base_create() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(%d); RETURN NEW; END $$`, lockID)
	if _, err := pool.Exec(ctx, function); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TRIGGER pause_base_create BEFORE INSERT ON base_records FOR EACH ROW EXECUTE FUNCTION pause_base_create()`); err != nil {
		t.Fatal(err)
	}
	type createResult struct {
		base store.DocMeta
		err  error
	}
	created := make(chan createResult, 1)
	go func() {
		base, err := s.CreateInitializedBase(ctx, ws.ID, u.ID, &parent.ID, "child")
		created <- createResult{base, err}
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=$1::oid)`, lockID).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("create did not pause")
		}
		time.Sleep(10 * time.Millisecond)
	}
	trashed := make(chan error, 1)
	go func() { trashed <- s.Trash(ctx, root.ID) }()
	deadline = time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM nodes WHERE id=%FOR UPDATE%')`, schema).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("trash did not wait for ancestor lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := blocker.Exec(ctx, `SELECT pg_advisory_unlock($1)`, lockID); err != nil {
		t.Fatal(err)
	}
	var result createResult
	select {
	case result = <-created:
	case <-time.After(5 * time.Second):
		t.Fatal("create did not finish")
	}
	if result.err != nil {
		t.Fatalf("create: %v", result.err)
	}
	select {
	case err = <-trashed:
		if err != nil {
			t.Fatalf("trash: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("trash did not finish")
	}
	if _, err := s.GetDoc(ctx, u.ID, result.base.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("new descendant escaped trash: %v", err)
	}
}
