package store_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// Integration test; runs only when JIANGE_TEST_DATABASE_URL points at a disposable database.
func TestPostgresStore(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pg, err := store.NewPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err := pg.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	applied, err := migrate.Up(ctx, pg.Pool)
	if err != nil || len(applied) != 5 {
		t.Fatalf("migrate: %v %v", applied, err)
	}
	if again, err := migrate.Up(ctx, pg.Pool); err != nil || len(again) != 0 {
		t.Fatalf("migrate not idempotent: %v %v", again, err)
	}

	u, w, err := pg.CreateUser(ctx, "Kay@Example.com", "Kay", "hash")
	if err != nil || w.OwnerID != u.ID {
		t.Fatalf("create: %v", err)
	}
	if _, _, err := pg.CreateUser(ctx, "kay@example.com", "K", "h"); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("expected conflict, got %v", err)
	}
	got, err := pg.UserByEmail(ctx, "KAY@example.com")
	if err != nil || got.ID != u.ID {
		t.Fatalf("by email: %v", err)
	}
	now := time.Now()
	h := []byte("0123456789abcdef0123456789abcdef")
	if err := pg.CreateSession(ctx, h, u.ID, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if su, err := pg.SessionUser(ctx, h, now); err != nil || su.ID != u.ID {
		t.Fatalf("session: %v", err)
	}
	if _, err := pg.SessionUser(ctx, h, now.Add(2*time.Hour)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired session: %v", err)
	}
	ws, err := pg.Workspaces(ctx, u.ID)
	if err != nil || len(ws) != 1 {
		t.Fatalf("workspaces: %v %v", ws, err)
	}
	_ = pg.DeleteSession(ctx, h)
	if _, err := pg.SessionUser(ctx, h, now); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("session not deleted")
	}
}
