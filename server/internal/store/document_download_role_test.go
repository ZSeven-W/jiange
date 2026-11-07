package store_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMemoryDocumentCopySessionExpiresBeforePublish(t *testing.T) {
	ctx := context.Background()
	s := store.NewMemory()
	owner, ownerSpace, err := s.CreateUser(ctx, "memory-copy-owner@example.test", "owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, guestSpace, err := s.CreateUser(ctx, "memory-copy-guest@example.test", "guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := s.CreateDoc(ctx, ownerSpace.ID, owner.ID, nil, "source", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetShare(ctx, doc.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	hash := []byte("memory-copy-session")
	if err := s.CreateSession(ctx, hash, guest.ID, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	guard := store.RestoreGuard{UserID: guest.ID, SessionHash: hash, Now: func() time.Time {
		if calls.Add(1) >= 3 {
			return now.Add(2 * time.Hour)
		}
		return now
	}}
	req := store.DocCopy{SourceID: doc.ID, UserID: guest.ID, WorkspaceID: guestSpace.ID, Title: "copy", Guard: &guard}
	_, err = s.CopyDoc(ctx, req, func(map[int64]int64) ([]store.RawOp, error) { return nil, nil })
	if !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("copy after session expiry: %v", err)
	}
	docs, err := s.ListDocs(ctx, guest.ID)
	if err != nil || len(docs) != 0 {
		t.Fatalf("expired copy persisted: %+v %v", docs, err)
	}
}

func TestPostgresDocumentCopyDownloadThreshold(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_copy_role_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	defer func() { _, _ = admin.Exec(ctx, "DROP SCHEMA IF EXISTS "+quoted+" CASCADE"); admin.Close() }()
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
	owner, ownerSpace, err := s.CreateUser(ctx, "copy-role-owner@example.test", "owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, guestSpace, err := s.CreateUser(ctx, "copy-role-guest@example.test", "guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := s.CreateDoc(ctx, ownerSpace.ID, owner.ID, nil, "source", nil)
	if err != nil {
		t.Fatal(err)
	}
	req := store.DocCopy{SourceID: doc.ID, UserID: guest.ID, WorkspaceID: guestSpace.ID, Title: "copy"}
	build := func(map[int64]int64) ([]store.RawOp, error) { return nil, nil }
	for _, threshold := range []string{store.RoleView, store.RoleEdit, store.RoleManage} {
		if _, err := pool.Exec(ctx, `UPDATE nodes SET copy_min_role='view',download_min_role=$2,copy_protected=($2<>'view'),permissions_revision=permissions_revision+1 WHERE id=$1`, doc.ID, threshold); err != nil {
			t.Fatal(err)
		}
		for _, role := range []string{store.RoleView, store.RoleEdit, store.RoleManage} {
			if err := s.SetShare(ctx, doc.ID, guest.ID, role); err != nil {
				t.Fatal(err)
			}
			clone, err := s.CopyDoc(ctx, req, build)
			if store.RoleRank(role) >= store.RoleRank(threshold) {
				if err != nil {
					t.Fatalf("role %s threshold %s: %v", role, threshold, err)
				}
				if clone.CopyMinRole != store.RoleView || clone.DownloadMinRole != store.RoleView || clone.PermissionsRevision != 0 {
					t.Fatalf("new copy permission defaults: %+v", clone)
				}
			} else if !errors.Is(err, store.ErrCopyProtected) {
				t.Fatalf("role %s threshold %s: expected protected, got %v", role, threshold, err)
			}
		}
	}

	// A policy change which holds the source row before a copy starts must
	// finish first; the copy must then observe the stricter committed policy.
	if err := s.SetShare(ctx, doc.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE nodes SET copy_min_role='view',download_min_role='view',copy_protected=false,permissions_revision=permissions_revision+1 WHERE id=$1`, doc.ID); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE nodes SET download_min_role='manage',copy_protected=true,permissions_revision=permissions_revision+1 WHERE id=$1`, doc.ID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := s.CopyDoc(ctx, req, build); done <- err }()
	deadline, waiting := time.Now().Add(5*time.Second), false
	for time.Now().Before(deadline) {
		select {
		case err := <-done:
			t.Fatalf("copy completed before policy commit: %v", err)
		default:
		}
		if err := admin.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock')`, schema).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !waiting {
		t.Fatal("copy did not wait for policy transaction")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, store.ErrCopyProtected) {
			t.Fatalf("copy after restriction: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("copy did not finish")
	}

	// In the opposite order, publishing the copy and changing its source
	// policy serialize: the policy update must wait for the copy to commit.
	if _, err := pool.Exec(ctx, `UPDATE nodes SET download_min_role='view',copy_protected=false,permissions_revision=permissions_revision+1 WHERE id=$1`, doc.ID); err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	copyDone, updateDone := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := s.CopyDoc(ctx, req, func(map[int64]int64) ([]store.RawOp, error) { close(entered); <-release; return nil, nil })
		copyDone <- err
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("copy did not reach builder")
	}
	go func() {
		_, err := pool.Exec(ctx, `UPDATE nodes SET download_min_role='manage',copy_protected=true,permissions_revision=permissions_revision+1 WHERE id=$1`, doc.ID)
		updateDone <- err
	}()
	deadline, waiting = time.Now().Add(5*time.Second), false
	for time.Now().Before(deadline) {
		select {
		case err := <-updateDone:
			close(release)
			t.Fatalf("policy changed while copy held source lock: %v", err)
		default:
		}
		if err := admin.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock')`, schema).Scan(&waiting); err != nil {
			close(release)
			t.Fatal(err)
		}
		if waiting {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !waiting {
		close(release)
		t.Fatal("policy update did not wait for copy")
	}
	close(release)
	select {
	case err := <-copyDone:
		if err != nil {
			t.Fatalf("copy: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("copy did not finish")
	}
	select {
	case err := <-updateDone:
		if err != nil {
			t.Fatalf("policy update: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("policy update did not finish")
	}

	// A session expiring during the builder must roll back the node and its
	// contents, even though it was valid when the transaction began.
	if _, err := pool.Exec(ctx, `UPDATE nodes SET download_min_role='view',copy_protected=false,permissions_revision=permissions_revision+1 WHERE id=$1`, doc.ID); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	hash := []byte("copy-session-test-hash")
	if err := s.CreateSession(ctx, hash, guest.ID, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	var expired atomic.Bool
	guard := store.RestoreGuard{UserID: guest.ID, SessionHash: hash, Now: func() time.Time {
		if expired.Load() {
			return now.Add(2 * time.Hour)
		}
		return now
	}}
	guarded := req
	guarded.Guard = &guard
	var before, after int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM nodes`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	_, err = s.CopyDoc(ctx, guarded, func(map[int64]int64) ([]store.RawOp, error) { expired.Store(true); return nil, nil })
	if !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expired session: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM nodes`).Scan(&after); err != nil || before != after {
		t.Fatalf("expired copy committed node: before=%d after=%d err=%v", before, after, err)
	}
	expired.Store(false)

	// Logout must wait for a copy already holding the session row; a later
	// copy with the deleted session is rejected instead of using stale auth.
	entered, release = make(chan struct{}), make(chan struct{})
	copyDone, updateDone = make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := s.CopyDoc(ctx, guarded, func(map[int64]int64) ([]store.RawOp, error) { close(entered); <-release; return nil, nil })
		copyDone <- err
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("guarded copy did not reach builder")
	}
	go func() { updateDone <- s.DeleteSession(ctx, hash) }()
	deadline, waiting = time.Now().Add(5*time.Second), false
	for time.Now().Before(deadline) {
		select {
		case err := <-updateDone:
			close(release)
			t.Fatalf("logout bypassed session lock: %v", err)
		default:
		}
		if err := admin.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock')`, schema).Scan(&waiting); err != nil {
			close(release)
			t.Fatal(err)
		}
		if waiting {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !waiting {
		close(release)
		t.Fatal("logout did not wait for copy session lock")
	}
	close(release)
	select {
	case err := <-copyDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("guarded copy did not finish")
	}
	select {
	case err := <-updateDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("logout did not finish")
	}
	if _, err := s.CopyDoc(ctx, guarded, build); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("copy after logout: %v", err)
	}
}
