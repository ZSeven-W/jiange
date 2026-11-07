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

func checkRecentVisits(t *testing.T, s store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := s.CreateUser(ctx, "recent-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := s.CreateUser(ctx, "recent-guest@example.test", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	parent, err := s.CreateDoc(ctx, ws.ID, owner.ID, nil, "父文档", nil)
	if err != nil {
		t.Fatal(err)
	}
	child, err := s.CreateDoc(ctx, ws.ID, owner.ID, &parent.ID, "子文档", nil)
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateDoc(ctx, ws.ID, owner.ID, nil, "另一文档", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetCopyProtected(ctx, parent.ID, true); err != nil {
		t.Fatal(err)
	}
	baseTime := time.Date(2026, 11, 7, 8, 0, 0, 0, time.UTC)
	if err := s.RecordVisit(ctx, guest.ID, parent.ID, baseTime); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unshared visit: %v", err)
	}
	if err := s.SetShare(ctx, parent.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordVisit(ctx, guest.ID, child.ID, baseTime); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordVisit(ctx, guest.ID, parent.ID, baseTime.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordVisit(ctx, guest.ID, parent.ID, baseTime.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordVisit(ctx, owner.ID, other.ID, baseTime.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	got, err := s.RecentDocs(ctx, guest.ID, 100)
	if err != nil || len(got) != 2 || got[0].ID != parent.ID || got[1].ID != child.ID || got[0].Role != store.RoleView || !got[0].CopyProtected || !got[0].ViewedAt.Equal(baseTime.Add(time.Minute)) {
		t.Fatalf("guest visits: %+v %v", got, err)
	}
	if own, err := s.RecentDocs(ctx, owner.ID, 100); err != nil || len(own) != 1 || own[0].ID != other.ID {
		t.Fatalf("owner visits: %+v %v", own, err)
	}
	if err := s.SetShare(ctx, child.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if err := s.SetShare(ctx, parent.ID, guest.ID, ""); err != nil {
		t.Fatal(err)
	}
	if got, err := s.RecentDocs(ctx, guest.ID, 1); err != nil || len(got) != 1 || got[0].ID != child.ID {
		t.Fatalf("revoked access leaked or hid an older permitted item: %+v %v", got, err)
	}
	if err := s.SetShare(ctx, child.ID, guest.ID, ""); err != nil {
		t.Fatal(err)
	}
	if got, err := s.RecentDocs(ctx, guest.ID, 100); err != nil || len(got) != 0 {
		t.Fatalf("revoked access leaked: %+v %v", got, err)
	}
	if err := s.SetLink(ctx, parent.ID, store.Link{Role: store.RoleView, Token: "recent-link"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.JoinLink(ctx, "recent-link", guest.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordVisit(ctx, guest.ID, child.ID, baseTime.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := s.SetLink(ctx, parent.ID, store.Link{Role: "none"}); err != nil {
		t.Fatal(err)
	}
	if got, err := s.RecentDocs(ctx, guest.ID, 100); err != nil || len(got) != 0 {
		t.Fatalf("closed link leaked history: %+v %v", got, err)
	}
	if err := s.SetShare(ctx, parent.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if err := s.Trash(ctx, parent.ID); err != nil {
		t.Fatal(err)
	}
	if got, err := s.RecentDocs(ctx, guest.ID, 100); err != nil || len(got) != 0 {
		t.Fatalf("trashed docs leaked: %+v %v", got, err)
	}
	if err := s.Restore(ctx, parent.ID); err != nil {
		t.Fatal(err)
	}
	if got, err := s.RecentDocs(ctx, guest.ID, 1); err != nil || len(got) != 1 || got[0].ID != child.ID {
		t.Fatalf("restore/limit: %+v %v", got, err)
	}
	// Equal timestamps have a deterministic ordering and concurrent requests
	// cannot replace a newer timestamp with an older one.
	if err := s.RecordVisit(ctx, owner.ID, parent.ID, baseTime); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordVisit(ctx, owner.ID, child.ID, baseTime); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := s.RecordVisit(ctx, owner.ID, other.ID, baseTime.Add(time.Duration(i)*time.Hour)); err != nil {
				t.Errorf("concurrent visit: %v", err)
			}
		}(i)
	}
	wg.Wait()
	got, err = s.RecentDocs(ctx, owner.ID, 100)
	if err != nil || len(got) != 3 || got[0].ID != other.ID || !got[0].ViewedAt.Equal(baseTime.Add(11*time.Hour)) || got[1].ID != child.ID || got[2].ID != parent.ID {
		t.Fatalf("ordering: %+v %v", got, err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if err := s.RecordVisit(canceled, owner.ID, parent.ID, baseTime.Add(24*time.Hour)); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled visit: %v", err)
	}
}

func TestMemoryRecentVisits(t *testing.T) { checkRecentVisits(t, store.NewMemory()) }

func TestPostgresRecentVisits(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_recent_%d", time.Now().UnixNano())
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
	checkRecentVisits(t, &store.Postgres{Pool: pool})
}
