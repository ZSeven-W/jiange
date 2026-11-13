package store

import (
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

type guardedVersionTestStore interface {
	Store
	CreateNamedVersion(context.Context, RestoreGuard, int64, int64, int64, []byte, string) (Version, error)
}

func checkGuardedNamedVersion(t *testing.T, st guardedVersionTestStore) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "version-guard-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := st.CreateUser(ctx, "version-guard-guest@test.dev", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	og := RestoreGuard{UserID: owner.ID, SessionHash: []byte("version-owner-session")}
	gg := RestoreGuard{UserID: guest.ID, SessionHash: []byte("version-guest-session")}
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
	if err = st.SetShare(ctx, d.ID, guest.ID, RoleView); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, d.ID, guest.ID, RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, d.ID, guest.ID, RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CreateNamedVersion(ctx, gg, d.ID, epoch, head, []byte("state"), "First"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer may save: %v", err)
	}
	if _, err = st.CreateNamedVersion(ctx, og, d.ID, epoch, head+1, []byte("state"), "First"); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale head accepted: %v", err)
	}
	first, err := st.CreateNamedVersion(ctx, og, d.ID, epoch, head, []byte("state"), "First")
	if err != nil {
		t.Fatal(err)
	}
	retry, err := st.CreateNamedVersion(ctx, og, d.ID, epoch, head, []byte("state"), "First")
	if err != nil || retry.Seq != first.Seq || !retry.CreatedAt.Equal(first.CreatedAt) {
		t.Fatalf("retry: %+v %v", retry, err)
	}
	if _, err = st.CreateNamedVersion(ctx, og, d.ID, epoch, head, []byte("state"), "Different"); !errors.Is(err, ErrConflict) {
		t.Fatalf("renamed existing version: %v", err)
	}
	if _, err = st.CreateNamedVersion(ctx, og, d.ID, epoch, head, []byte("other"), "First"); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed snapshot accepted: %v", err)
	}
	versions, err := st.Versions(ctx, d.ID)
	if err != nil || len(versions) != 1 || versions[0].Label != "First" {
		t.Fatalf("versions: %+v %v", versions, err)
	}
	if err = st.BumpHistoryEpoch(ctx, d.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CreateNamedVersion(ctx, og, d.ID, epoch, head, []byte("state"), "First"); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale epoch accepted: %v", err)
	}
	if err = st.DeleteSession(ctx, og.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CreateNamedVersion(ctx, og, d.ID, epoch+1, head, []byte("state"), "First"); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("revoked session accepted: %v", err)
	}

	// Two different names for the same unversioned snapshot cannot overwrite each other.
	if err = st.CreateSession(ctx, og.SessionHash, og.UserID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	d2, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Concurrent", InitialDocOps("Concurrent"))
	if err != nil {
		t.Fatal(err)
	}
	e2, h2, err := st.HeadVersion(ctx, d2.ID)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i, label := range []string{"A", "B"} {
		wg.Add(1)
		go func(i int, label string) {
			defer wg.Done()
			_, errs[i] = st.CreateNamedVersion(ctx, og, d2.ID, e2, h2, []byte("concurrent"), label)
		}(i, label)
	}
	wg.Wait()
	if (errs[0] == nil) == (errs[1] == nil) || !(errors.Is(errs[0], ErrConflict) || errors.Is(errs[1], ErrConflict)) {
		t.Fatalf("concurrent names: %v", errs)
	}
	versions, err = st.Versions(ctx, d2.ID)
	if err != nil || len(versions) != 1 {
		t.Fatalf("concurrent versions: %+v %v", versions, err)
	}
}

func TestMemoryGuardedNamedVersion(t *testing.T) { checkGuardedNamedVersion(t, NewMemory()) }
func TestPostgresGuardedNamedVersion(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("jiange_version_guard_%d", time.Now().UnixNano())}.Sanitize()
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
	checkGuardedNamedVersion(t, &Postgres{Pool: pool})
}
