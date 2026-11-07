package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func checkSearchCandidateCycle(t *testing.T, s Store, cycle func(int64, int64)) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	owner, ws, err := s.CreateUser(ctx, "candidate-owner@test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := s.CreateUser(ctx, "candidate-guest@test", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	other, _, err := s.CreateUser(ctx, "candidate-other@test", "Other", "hash")
	if err != nil {
		t.Fatal(err)
	}
	root, err := s.CreateDoc(ctx, ws.ID, owner.ID, nil, "root", nil)
	if err != nil {
		t.Fatal(err)
	}
	child, err := s.CreateDoc(ctx, ws.ID, owner.ID, &root.ID, "child", nil)
	if err != nil {
		t.Fatal(err)
	}
	cycle(root.ID, child.ID)
	if err := s.SetShare(ctx, root.ID, guest.ID, RoleView); err != nil {
		t.Fatal(err)
	}
	page, err := s.SearchCandidates(ctx, guest.ID, 0, 1)
	if err != nil || len(page) != 1 || page[0].ID != root.ID {
		t.Fatalf("first page: %+v, %v", page, err)
	}
	page, err = s.SearchCandidates(ctx, guest.ID, root.ID, 1)
	if err != nil || len(page) != 1 || page[0].ID != child.ID || page[0].Role != RoleView {
		t.Fatalf("inherited page: %+v, %v", page, err)
	}
	if _, err := s.GetDoc(ctx, other.ID, child.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("private cycle leaked or hung: %v", err)
	}
	page, err = s.SearchCandidates(ctx, other.ID, 0, 100)
	if err != nil || len(page) != 0 {
		t.Fatalf("private cycle candidates leaked: %+v %v", page, err)
	}
}

func TestMemorySearchCandidateCycle(t *testing.T) {
	m := NewMemory()
	checkSearchCandidateCycle(t, m, func(root, child int64) { m.doc(root).meta.ParentID = &child })
}

func TestPostgresSearchCandidateCycle(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("jiange_search_%d", time.Now().UnixNano())}.Sanitize()
	defer func() { _, _ = admin.Exec(ctx, "DROP SCHEMA IF EXISTS "+schema+" CASCADE"); admin.Close() }()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
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
	checkSearchCandidateCycle(t, &Postgres{Pool: pool}, func(root, child int64) {
		if _, err := pool.Exec(ctx, "UPDATE nodes SET parent_id=$2 WHERE id=$1", root, child); err != nil {
			t.Fatal(err)
		}
	})
}
