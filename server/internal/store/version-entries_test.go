package store

import (
	"bytes"
	"context"
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

type versionEntryTestStore interface {
	Store
	CreateVersionEntry(context.Context, RestoreGuard, int64, int64, int64, []byte, string, string) (VersionEntry, error)
	ListVersionEntries(context.Context, RestoreGuard, int64) ([]VersionEntry, error)
}

func checkVersionEntries(t *testing.T, st versionEntryTestStore) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "entries-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := st.CreateUser(ctx, "entries-guest@test.dev", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	og := RestoreGuard{UserID: owner.ID, SessionHash: []byte("entries-owner-session")}
	gg := RestoreGuard{UserID: guest.ID, SessionHash: []byte("entries-guest-session")}
	for _, g := range []RestoreGuard{og, gg} {
		if err = st.CreateSession(ctx, g.SessionHash, g.UserID, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	d, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Doc", InitialDocOps("Doc"))
	if err != nil {
		t.Fatal(err)
	}
	epoch, head, err := st.HeadVersion(ctx, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	state := []byte("shared snapshot")
	if err = st.SaveSnapshot(ctx, d.ID, head, state); err != nil {
		t.Fatal(err)
	}
	if err = st.SaveVersion(ctx, d.ID, head, "Legacy", owner.ID); err != nil {
		t.Fatal(err)
	}
	entries, err := st.ListVersionEntries(ctx, og, d.ID)
	if err != nil || len(entries) != 1 || entries[0].Label != "Legacy" {
		t.Fatalf("legacy: %+v %v", entries, err)
	}
	request1 := "11111111111111111111111111111111"
	request2 := "22222222222222222222222222222222"
	first, err := st.CreateVersionEntry(ctx, og, d.ID, epoch, head, state, "A", request1)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := st.CreateVersionEntry(ctx, og, d.ID, epoch, head, state, "A", request1)
	if err != nil || retry.ID != first.ID {
		t.Fatalf("retry: %+v %v", retry, err)
	}
	if _, err = st.CreateVersionEntry(ctx, og, d.ID, epoch, head, state, "changed", request1); !errors.Is(err, ErrConflict) {
		t.Fatalf("request reuse: %v", err)
	}
	second, err := st.CreateVersionEntry(ctx, og, d.ID, epoch, head, state, "B", request2)
	if err != nil || first.ID == second.ID || first.Seq != second.Seq {
		t.Fatalf("second name: %+v %v", second, err)
	}
	third, err := st.CreateVersionEntry(ctx, og, d.ID, epoch, head, state, "A", "44444444444444444444444444444444")
	if err != nil || third.ID == first.ID {
		t.Fatalf("same label new request: %+v %v", third, err)
	}
	entries, err = st.ListVersionEntries(ctx, og, d.ID)
	if err != nil || len(entries) != 4 {
		t.Fatalf("entries: %+v %v", entries, err)
	}
	labels := map[string]bool{}
	for _, v := range entries {
		labels[v.Label] = true
	}
	if !labels["Legacy"] || !labels["A"] || !labels["B"] {
		t.Fatalf("labels: %v", labels)
	}
	got, err := st.VersionState(ctx, d.ID, head)
	if err != nil || !bytes.Equal(got, state) {
		t.Fatalf("snapshot: %v", err)
	}
	request3 := "33333333333333333333333333333333"
	var wg sync.WaitGroup
	ids := make([]string, 6)
	errs := make([]error, 6)
	for i := range ids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var v VersionEntry
			v, errs[i] = st.CreateVersionEntry(ctx, og, d.ID, epoch, head, state, "Concurrent", request3)
			ids[i] = v.ID
		}(i)
	}
	wg.Wait()
	for i := range ids {
		if errs[i] != nil || ids[i] != ids[0] || ids[i] == "" {
			t.Fatalf("concurrent retry: %v %v", ids, errs)
		}
	}
	entries, err = st.ListVersionEntries(ctx, og, d.ID)
	if err != nil || len(entries) != 5 {
		t.Fatalf("after retry: %+v %v", entries, err)
	}
	parallelIDs := make([]string, 2)
	parallelErrs := make([]error, 2)
	for i, request := range []string{"55555555555555555555555555555555", "66666666666666666666666666666666"} {
		wg.Add(1)
		go func(i int, request string) {
			defer wg.Done()
			var v VersionEntry
			v, parallelErrs[i] = st.CreateVersionEntry(ctx, og, d.ID, epoch, head, state, "Parallel", request)
			parallelIDs[i] = v.ID
		}(i, request)
	}
	wg.Wait()
	if parallelErrs[0] != nil || parallelErrs[1] != nil || parallelIDs[0] == parallelIDs[1] {
		t.Fatalf("parallel distinct requests: %v %v", parallelIDs, parallelErrs)
	}
	if err = st.SetShare(ctx, d.ID, guest.ID, RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = st.ListVersionEntries(ctx, gg, d.ID); err != nil {
		t.Fatalf("viewer list: %v", err)
	}
	if _, err = st.CreateVersionEntry(ctx, gg, d.ID, epoch, head, state, "No", request1); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer create: %v", err)
	}
	if err = st.SetShare(ctx, d.ID, guest.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = st.ListVersionEntries(ctx, gg, d.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("revoked list: %v", err)
	}
	if err = st.BumpHistoryEpoch(ctx, d.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CreateVersionEntry(ctx, og, d.ID, epoch, head, state, "stale", request2); !errors.Is(err, ErrConflict) {
		t.Fatalf("old epoch: %v", err)
	}
	if err = st.DeleteSession(ctx, og.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = st.ListVersionEntries(ctx, og, d.ID); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("old session list: %v", err)
	}
}

func TestMemoryVersionEntries(t *testing.T) { checkVersionEntries(t, NewMemory()) }
func TestPostgresVersionEntries(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("jiange_version_entries_%d", time.Now().UnixNano())}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
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
	if _, err = migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	checkVersionEntries(t, &Postgres{Pool: pool})
}

// Apply the new migration over an actual pre-existing named snapshot.
func TestPostgresVersionEntryMigration(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("jiange_version_migrate_%d", time.Now().UnixNano())}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
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
	if _, err = pool.Exec(ctx, `CREATE TABLE schema_migrations (version int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	migrations, err := migrate.List()
	if err != nil {
		t.Fatal(err)
	}
	for _, migration := range migrations {
		if migration.Version >= 53 {
			continue
		}
		err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			if _, e := tx.Exec(ctx, migration.SQL); e != nil {
				return e
			}
			_, e := tx.Exec(ctx, `INSERT INTO schema_migrations(version,name) VALUES($1,$2)`, migration.Version, migration.Name)
			return e
		})
		if err != nil {
			t.Fatalf("migration %s: %v", migration.Name, err)
		}
	}
	pg := &Postgres{Pool: pool}
	owner, ws, err := pg.CreateUser(ctx, "legacy-version@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guard := RestoreGuard{UserID: owner.ID, SessionHash: []byte("legacy-migration-session")}
	if err = pg.CreateSession(ctx, guard.SessionHash, guard.UserID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	doc, err := pg.CreateDoc(ctx, ws.ID, owner.ID, nil, "Legacy", InitialDocOps("Legacy"))
	if err != nil {
		t.Fatal(err)
	}
	epoch, head, err := pg.HeadVersion(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	state := []byte("original")
	if err = pg.SaveSnapshot(ctx, doc.ID, head, state); err != nil {
		t.Fatal(err)
	}
	if err = pg.SaveVersion(ctx, doc.ID, head, "原版本", owner.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	entries, err := pg.ListVersionEntries(ctx, guard, doc.ID)
	if err != nil || len(entries) != 1 || entries[0].Label != "原版本" {
		t.Fatalf("after migration: %+v %v", entries, err)
	}
	if _, err = pg.CreateVersionEntry(ctx, guard, doc.ID, epoch, head, state, "新版本", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); err != nil {
		t.Fatal(err)
	}
	entries, err = pg.ListVersionEntries(ctx, guard, doc.ID)
	if err != nil || len(entries) != 2 {
		t.Fatalf("after create: %+v %v", entries, err)
	}
	got, err := pg.VersionState(ctx, doc.ID, head)
	if err != nil || !bytes.Equal(got, state) {
		t.Fatalf("legacy snapshot: %v", err)
	}
}
