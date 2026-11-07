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

func checkAtomicRestore(t *testing.T, st store.Store) (store.DocMeta, store.User, store.RestoreGuard) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "restore-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := st.CreateUser(ctx, "restore-editor@example.test", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Doc", []store.RawOp{{ClientID: 0, Clock: 1, Bytes: []byte{1}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, doc.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("test-session")}
	if err := st.CreateSession(ctx, guard.SessionHash, editor.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	body := []store.RawOp{{ClientID: 77, Clock: 1, Bytes: []byte{2}}}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := st.AppendRestoreOps(cancelled, guard, doc.ID, 1, body); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled request: %v", err)
	}
	if head, _ := st.Head(ctx, doc.ID); head != 1 {
		t.Fatalf("cancelled plan changed head: %d", head)
	}
	if _, err := st.AppendRestoreOps(ctx, guard, doc.ID, 0, body); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale head: %v", err)
	}
	if head, _ := st.Head(ctx, doc.ID); head != 1 {
		t.Fatalf("stale plan changed head: %d", head)
	}
	// Even an empty restore must check the captured head.
	if _, err := st.AppendRestoreOps(ctx, guard, doc.ID, 0, nil); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("empty stale plan: %v", err)
	}
	// A conflicting op after a fresh one must roll back the entire batch.
	duplicate := append(append([]store.RawOp{}, body...), store.RawOp{ClientID: 0, Clock: 1, Bytes: []byte{1}})
	if _, err := st.AppendRestoreOps(ctx, guard, doc.ID, 1, duplicate); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("duplicate identity: %v", err)
	}
	if head, _ := st.Head(ctx, doc.ID); head != 1 {
		t.Fatalf("partial batch changed head: %d", head)
	}
	seqs, err := st.AppendRestoreOps(ctx, guard, doc.ID, 1, body)
	if err != nil || len(seqs) != 1 || seqs[0] != 2 {
		t.Fatalf("restore: %v %v", seqs, err)
	}
	if err := st.SetShare(ctx, doc.ID, editor.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendRestoreOps(ctx, guard, doc.ID, 2, nil); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("downgrade: %v", err)
	}
	if head, _ := st.Head(ctx, doc.ID); head != 2 {
		t.Fatalf("forbidden plan changed head: %d", head)
	}
	expired := guard
	expired.Now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if _, err := st.AppendRestoreOps(ctx, expired, doc.ID, 2, nil); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expired session: %v", err)
	}
	wrongUser := guard
	wrongUser.UserID = owner.ID
	if _, err := st.AppendRestoreOps(ctx, wrongUser, doc.ID, 2, nil); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("session user mismatch: %v", err)
	}
	if err := st.SetShare(ctx, doc.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	clockCalls := 0
	whileWaiting := guard
	whileWaiting.Now = func() time.Time {
		clockCalls++
		if clockCalls >= 2 {
			return time.Now().Add(2 * time.Hour)
		}
		return time.Now()
	}
	if _, err := st.AppendRestoreOps(ctx, whileWaiting, doc.ID, 2, []store.RawOp{{ClientID: 77, Clock: 2, Bytes: []byte{3}}}); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("session expired while waiting: %v", err)
	}
	if head, _ := st.Head(ctx, doc.ID); head != 2 {
		t.Fatalf("expired plan changed head: %d", head)
	}
	if _, ok := st.(*store.Postgres); ok {
		clockCalls = 0
		afterWrite := guard
		afterWrite.Now = func() time.Time {
			clockCalls++
			if clockCalls >= 3 {
				return time.Now().Add(2 * time.Hour)
			}
			return time.Now()
		}
		if _, err := st.AppendRestoreOps(ctx, afterWrite, doc.ID, 2, []store.RawOp{{ClientID: 77, Clock: 2, Bytes: []byte{3}}}); !errors.Is(err, store.ErrUnauthenticated) {
			t.Fatalf("session expired before commit: %v", err)
		}
		if head, _ := st.Head(ctx, doc.ID); head != 2 {
			t.Fatalf("expired transaction committed: %d", head)
		}
	}
	return doc, editor, guard
}

func TestMemoryAtomicRestore(t *testing.T) { checkAtomicRestore(t, store.NewMemory()) }

func TestPostgresAtomicRestore(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_restore_%d", time.Now().UnixNano())
	name := pgx.Identifier{schema}.Sanitize()
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+name+" CASCADE")
		admin.Close()
	}()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+name); err != nil {
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	st := &store.Postgres{Pool: pool}
	doc, editor, guard := checkAtomicRestore(t, st)
	if err := st.SetShare(ctx, doc.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	// Hold an uncommitted revocation. The restore must wait for the grant row,
	// then observe the committed revocation rather than authorize stale access.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM doc_shares WHERE doc_id=$1 AND user_id=$2`, doc.ID, editor.ID); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := st.AppendRestoreOps(ctx, guard, doc.ID, 2, []store.RawOp{{ClientID: 77, Clock: 2, Bytes: []byte{3}}})
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("restore did not wait for revocation: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, store.ErrForbidden) {
			t.Fatalf("committed revocation: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("restore remained blocked")
	}
	if head, _ := st.Head(ctx, doc.ID); head != 2 {
		t.Fatalf("revocation race wrote: %d", head)
	}
	if err := st.SetShare(ctx, doc.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	logout, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer logout.Rollback(ctx)
	if _, err := logout.Exec(ctx, `DELETE FROM sessions WHERE token_hash=$1`, guard.SessionHash); err != nil {
		t.Fatal(err)
	}
	sessionResult := make(chan error, 1)
	go func() {
		_, err := st.AppendRestoreOps(ctx, guard, doc.ID, 2, []store.RawOp{{ClientID: 77, Clock: 2, Bytes: []byte{3}}})
		sessionResult <- err
	}()
	select {
	case err := <-sessionResult:
		t.Fatalf("restore did not wait for logout: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := logout.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-sessionResult:
		if !errors.Is(err, store.ErrUnauthenticated) {
			t.Fatalf("committed logout: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("restore remained blocked after logout")
	}
	if head, _ := st.Head(ctx, doc.ID); head != 2 {
		t.Fatalf("logout race wrote: %d", head)
	}
}
