package store_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func checkMetadataVisibility(t *testing.T, s store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := s.CreateUser(ctx, "metadata-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := s.CreateUser(ctx, "metadata-guest@example.test", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	// Moving an older parent under a newer root makes ID order differ from
	// ancestry order and detects sorting by ID instead of depth.
	parent, err := s.CreateDoc(ctx, ws.ID, owner.ID, nil, "私密父级", nil)
	if err != nil {
		t.Fatal(err)
	}
	child, err := s.CreateDoc(ctx, ws.ID, owner.ID, &parent.ID, "共享子级", nil)
	if err != nil {
		t.Fatal(err)
	}
	root, err := s.CreateDoc(ctx, ws.ID, owner.ID, nil, "较新的根级", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Move(ctx, parent.ID, &root.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.SetShare(ctx, child.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Ancestors(ctx, guest.ID, child.ID); err != nil || len(got) != 0 {
		t.Fatalf("direct child grant revealed private ancestors: %+v, %v", got, err)
	}
	if err := s.AddFavorite(ctx, guest.ID, child.ID); err != nil {
		t.Fatal(err)
	}
	if got, err := s.ListFavorites(ctx, guest.ID); err != nil || len(got) != 1 || got[0].ID != child.ID || got[0].Role != store.RoleView {
		t.Fatalf("permitted favorite: %+v, %v", got, err)
	}
	if err := s.SetShare(ctx, child.ID, guest.ID, ""); err != nil {
		t.Fatal(err)
	}
	if got, err := s.ListFavorites(ctx, guest.ID); err != nil || len(got) != 0 {
		t.Fatalf("revoked favorite leaked metadata: %+v, %v", got, err)
	}
	if _, err := s.Ancestors(ctx, guest.ID, child.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("ancestors of inaccessible document: %v", err)
	}
	if err := s.SetShare(ctx, child.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if got, err := s.ListFavorites(ctx, guest.ID); err != nil || len(got) != 1 || got[0].ID != child.ID {
		t.Fatalf("favorite record not preserved across regrant: %+v, %v", got, err)
	}
	if err := s.SetShare(ctx, parent.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Ancestors(ctx, guest.ID, child.ID); err != nil || len(got) != 1 || got[0].ID != parent.ID {
		t.Fatalf("only accessible parent should be visible: %+v, %v", got, err)
	}
	if err := s.SetShare(ctx, root.ID, guest.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Ancestors(ctx, guest.ID, child.ID); err != nil || len(got) != 2 || got[0].ID != root.ID || got[1].ID != parent.ID || got[0].Role != store.RoleEdit || got[1].Role != store.RoleEdit {
		t.Fatalf("root-first ancestors and inherited role: %+v, %v", got, err)
	}
	// Link-derived access disappears when the link closes, while the favorite
	// entry remains available if the user later gets a direct grant.
	if err := s.SetShare(ctx, parent.ID, guest.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := s.SetShare(ctx, child.ID, guest.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := s.SetShare(ctx, root.ID, guest.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := s.SetLink(ctx, root.ID, store.Link{Role: store.RoleView, Token: "metadata-test-link"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.JoinLink(ctx, "metadata-test-link", guest.ID); err != nil {
		t.Fatal(err)
	}
	if got, err := s.ListFavorites(ctx, guest.ID); err != nil || len(got) != 1 || got[0].ID != child.ID {
		t.Fatalf("inherited link favorite: %+v, %v", got, err)
	}
	if err := s.SetLink(ctx, root.ID, store.Link{Role: "none"}); err != nil {
		t.Fatal(err)
	}
	if got, err := s.ListFavorites(ctx, guest.ID); err != nil || len(got) != 0 {
		t.Fatalf("closed link leaked favorite: %+v, %v", got, err)
	}
	if err := s.SetShare(ctx, child.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if err := s.Trash(ctx, root.ID); err != nil {
		t.Fatal(err)
	}
	if got, err := s.ListFavorites(ctx, guest.ID); err != nil || len(got) != 0 {
		t.Fatalf("trash leaked favorite: %+v, %v", got, err)
	}
	if err := s.Restore(ctx, root.ID); err != nil {
		t.Fatal(err)
	}
	if got, err := s.ListFavorites(ctx, guest.ID); err != nil || len(got) != 1 || got[0].ID != child.ID {
		t.Fatalf("favorite not restored: %+v, %v", got, err)
	}
	if err := s.Move(ctx, parent.ID, nil); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Ancestors(ctx, guest.ID, child.ID); err != nil || len(got) != 0 {
		t.Fatalf("move exposed private parent: %+v, %v", got, err)
	}
}

func TestMemoryMetadataVisibility(t *testing.T) { checkMetadataVisibility(t, store.NewMemory()) }

func TestPostgresMetadataVisibility(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_metadata_%d", time.Now().UnixNano())
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
	checkMetadataVisibility(t, &store.Postgres{Pool: pool})
}
