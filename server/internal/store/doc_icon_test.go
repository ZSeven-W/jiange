package store_test

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestDocIconValidation(t *testing.T) {
	for _, text := range []string{"", "😀", "🧑‍💻", "🇨🇳", "文", "1️⃣"} {
		if !store.ValidDocIcon(text) {
			t.Errorf("valid icon rejected: %q", text)
		}
	}
	for _, text := range []string{" ", "a b", "<svg>", "https://bad.test", "javascript:alert", "a\x00b", "\u202eX", string([]byte{0xff}), "\u200d", "12345678901234567"} {
		if store.ValidDocIcon(text) {
			t.Errorf("invalid icon accepted: %q", text)
		}
	}
}

func exerciseDocIcon(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	parent, child, manager, guest, managerGuard := guardedSharingFixture(t, st)
	guestGuard := store.RestoreGuard{UserID: guest.ID, SessionHash: []byte("icon-guest")}
	if err := st.CreateSession(ctx, guestGuard.SessionHash, guest.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, child.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	initial, err := st.DocIconGuarded(ctx, guestGuard, child.ID)
	if err != nil || initial.Icon != "" || initial.Revision != 0 {
		t.Fatalf("initial icon: %+v %v", initial, err)
	}
	if _, err := st.SetDocIconGuarded(ctx, guestGuard, child.ID, "😀", 0); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer icon write: %v", err)
	}
	// An inherited editor can change and remove the icon. Revision changes on
	// every successful write, even if another writer later restores the value.
	if err := st.SetShare(ctx, parent.ID, manager.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	a, err := st.SetDocIconGuarded(ctx, managerGuard, child.ID, "🧑‍💻", 0)
	if err != nil || a.Icon != "🧑‍💻" || a.Revision != 1 {
		t.Fatalf("editor update: %+v %v", a, err)
	}
	if _, err = st.SetDocIconGuarded(ctx, managerGuard, child.ID, "😀", 0); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale write: %v", err)
	}
	b, err := st.SetDocIconGuarded(ctx, managerGuard, child.ID, "", 1)
	if err != nil || b.Icon != "" || b.Revision != 2 {
		t.Fatalf("remove: %+v %v", b, err)
	}
	if _, err = st.SetDocIconGuarded(ctx, managerGuard, child.ID, "😀", 0); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("ABA write: %v", err)
	}
	meta, err := st.GetDoc(ctx, guest.ID, child.ID)
	if err != nil || meta.Icon != "" {
		t.Fatalf("metadata after remove: %+v %v", meta, err)
	}
	if _, err = st.SetDocIconGuarded(ctx, managerGuard, child.ID, "<img>", 2); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("invalid icon store write: %v", err)
	}
	// Two writers using the same observation cannot both succeed.
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, icon := range []string{"😀", "🚀"} {
		wg.Add(1)
		go func(icon string) {
			defer wg.Done()
			_, err := st.SetDocIconGuarded(ctx, managerGuard, child.ID, icon, 2)
			errs <- err
		}(icon)
	}
	wg.Wait()
	close(errs)
	success, conflict := 0, 0
	for err := range errs {
		if err == nil {
			success++
		} else if errors.Is(err, store.ErrConflict) {
			conflict++
		} else {
			t.Fatalf("concurrent write: %v", err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("concurrent result: %d success, %d conflict", success, conflict)
	}
	before, err := st.DocIconGuarded(ctx, managerGuard, child.ID)
	if err != nil || before.Revision != 3 {
		t.Fatalf("after concurrent writes: %+v %v", before, err)
	}
	calls := 0
	expiresDuringWrite := managerGuard
	expiresDuringWrite.Now = func() time.Time {
		calls++
		if calls >= 2 {
			return time.Now().Add(2 * time.Hour)
		}
		return time.Now()
	}
	if _, err = st.SetDocIconGuarded(ctx, expiresDuringWrite, child.ID, "💡", 3); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expiry during write: %v", err)
	}
	after, err := st.DocIconGuarded(ctx, managerGuard, child.ID)
	if err != nil || after != before {
		t.Fatalf("expired write modified icon: before=%+v after=%+v err=%v", before, after, err)
	}
	if err := st.SetShare(ctx, parent.ID, manager.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = st.SetDocIconGuarded(ctx, managerGuard, child.ID, "😀", 3); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("revoked edit: %v", err)
	}
	if _, err = st.DocIconGuarded(ctx, managerGuard, child.ID); err != nil {
		t.Fatalf("retained viewer read: %v", err)
	}
	expired := guestGuard
	expired.Now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if _, err = st.DocIconGuarded(ctx, expired, child.ID); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expired read: %v", err)
	}
	if err := st.DeleteSession(ctx, guestGuard.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = st.DocIconGuarded(ctx, guestGuard, child.ID); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("logged out read: %v", err)
	}
}

func TestMemoryDocIcon(t *testing.T) { exerciseDocIcon(t, store.NewMemory()) }

func TestPostgresDocIcon(t *testing.T) {
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
	if _, err = pg.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err = migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	exerciseDocIcon(t, pg)
	var id int64
	if err = pg.Pool.QueryRow(ctx, `SELECT id FROM nodes WHERE kind='doc' ORDER BY id LIMIT 1`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err = pg.Pool.Exec(ctx, `UPDATE nodes SET icon=icon WHERE id=$1`, id); err == nil {
		t.Fatal("legacy same-value icon update bypassed revision trigger")
	}
}

func TestPostgresDocIconWaitsForRevocation(t *testing.T) {
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
	if _, err = pg.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err = migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	parent, child, manager, _, guard := guardedSharingFixture(t, pg)
	tx, err := pg.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE doc_shares SET role='view' WHERE doc_id=$1 AND user_id=$2`, parent.ID, manager.ID); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := pg.SetDocIconGuarded(ctx, guard, child.ID, "💡", 0)
		result <- err
	}()
	waitForPGBlock(t, pg, `SELECT role FROM doc_shares`)
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-result; !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("write after revocation: %v", err)
	}
	meta, err := pg.GetDocSystem(ctx, child.ID)
	if err != nil || meta.Icon != "" {
		t.Fatalf("revocation changed icon: %+v %v", meta, err)
	}
}

func TestPostgresDocIconReadUsesSharedLock(t *testing.T) {
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
	if _, err = pg.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err = migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	_, child, _, _, guard := guardedSharingFixture(t, pg)
	tx, err := pg.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT id FROM nodes WHERE id=$1 FOR SHARE`, child.ID); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := pg.DocIconGuarded(ctx, guard, child.ID)
		result <- err
	}()
	select {
	case err = <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("read blocked behind another shared metadata lock")
	}
}
