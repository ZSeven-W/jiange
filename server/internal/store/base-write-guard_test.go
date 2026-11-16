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

func baseGuardFixture(t *testing.T, s Store) (DocMeta, User, BaseWriteGuard, View) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := s.CreateUser(ctx, "guard-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := s.CreateUser(ctx, "guard-editor@example.test", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := s.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "base")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetShare(ctx, base.ID, editor.ID, RoleEdit); err != nil {
		t.Fatal(err)
	}
	guard := BaseWriteGuard{UserID: editor.ID, SessionHash: []byte("guard-session")}
	if err := s.CreateSession(ctx, guard.SessionHash, editor.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	views, err := s.Views(ctx, base.ID)
	if err != nil || len(views) != 1 {
		t.Fatalf("views=%v err=%v", views, err)
	}
	return base, owner, guard, views[0]
}

func TestMemoryBaseWriteGuard(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	base, _, guard, view := baseGuardFixture(t, m)
	m.mu.Lock()
	role, expires, err := m.checkBaseWriteLocked(guard, base.ID)
	m.mu.Unlock()
	if err != nil || role != RoleEdit || expires.IsZero() {
		t.Fatalf("role=%q expires=%v err=%v", role, expires, err)
	}
	view.Config = []byte(`{"locked":true}`)
	if _, err := m.UpdateView(ctx, view); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	_, _, err = m.checkBaseWriteLocked(guard, base.ID)
	m.mu.Unlock()
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("locked: %v", err)
	}
	if err := m.DeleteSession(ctx, guard.SessionHash); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	_, _, err = m.checkBaseWriteLocked(guard, base.ID)
	m.mu.Unlock()
	if !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("deleted session: %v", err)
	}
}

func TestPostgresBaseWriteGuardSerializesViewAndSession(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_base_guard_%d", time.Now().UnixNano())
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
	base, _, guard, view := baseGuardFixture(t, s)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	role, expires, err := lockBaseWrite(ctx, tx, guard, base.ID)
	if err != nil || role != RoleEdit || expires.IsZero() {
		t.Fatalf("role=%q expires=%v err=%v", role, expires, err)
	}
	view.Config = []byte(`{"locked":true}`)
	viewDone := make(chan error, 1)
	go func() { _, e := s.UpdateView(ctx, view); viewDone <- e }()
	logoutDone := make(chan error, 1)
	go func() { logoutDone <- s.DeleteSession(ctx, guard.SessionHash) }()
	select {
	case err := <-viewDone:
		t.Fatalf("view update did not wait for guarded write: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	select {
	case err := <-logoutDone:
		t.Fatalf("logout did not wait for guarded write: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-viewDone; err != nil {
		t.Fatal(err)
	}
	if err := <-logoutDone; err != nil {
		t.Fatal(err)
	}
	if err := s.CreateSession(ctx, guard.SessionHash, guard.UserID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	tx2, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx2.Rollback(ctx)
	if _, _, err := lockBaseWrite(ctx, tx2, guard, base.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("locked view after concurrent update: %v", err)
	}
	if err := tx2.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	view.Config = []byte(`{}`)
	if _, err := s.UpdateView(ctx, view); err != nil {
		t.Fatal(err)
	}
	tx3, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx3.Rollback(ctx)
	if _, _, err := lockBaseWrite(ctx, tx3, guard, base.ID); err != nil {
		t.Fatal(err)
	}
	revokeDone := make(chan error, 1)
	go func() { revokeDone <- s.SetShare(ctx, base.ID, guard.UserID, "") }()
	select {
	case err := <-revokeDone:
		t.Fatalf("share revocation did not wait for guarded write: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	if err := tx3.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-revokeDone; err != nil {
		t.Fatal(err)
	}
	tx4, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx4.Rollback(ctx)
	if _, _, err := lockBaseWrite(ctx, tx4, guard, base.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("revoked share: %v", err)
	}
}
