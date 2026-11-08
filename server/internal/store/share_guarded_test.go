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

func guardedSharingFixture(t *testing.T, st store.Store) (store.DocMeta, store.DocMeta, store.User, store.User, store.RestoreGuard) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "guard-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	manager, _, err := st.CreateUser(ctx, "guard-manager@example.test", "Manager", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := st.CreateUser(ctx, "guard-guest@example.test", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	parent, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Parent", nil)
	if err != nil {
		t.Fatal(err)
	}
	child, err := st.CreateDoc(ctx, ws.ID, owner.ID, &parent.ID, "Child", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, parent.ID, manager.ID, store.RoleManage); err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: manager.ID, SessionHash: []byte("share-guard-session")}
	if err := st.CreateSession(ctx, guard.SessionHash, manager.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	return parent, child, manager, guest, guard
}

func checkGuardedSharing(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	parent, child, manager, guest, guard := guardedSharingFixture(t, st)
	if err := st.SetShareGuarded(ctx, guard, child.ID, guest.ID, store.RoleView, true); err != nil {
		t.Fatalf("inherited manager: %v", err)
	}
	if err := st.SetShareGuarded(ctx, guard, child.ID, guest.ID, store.RoleManage, true); !errors.Is(err, store.ErrShareExists) {
		t.Fatalf("duplicate invite: %v", err)
	}
	list, err := st.ListShares(ctx, child.ID)
	if err != nil || len(list) != 1 || list[0].Role != store.RoleView {
		t.Fatalf("duplicate changed grant: %+v, %v", list, err)
	}
	if _, err := st.ChangeLinkRoleGuarded(ctx, guard, child.ID, store.RoleView, "guarded-link-token"); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, parent.ID, manager.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShareGuarded(ctx, guard, child.ID, guest.ID, store.RoleEdit, false); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("revoked manager: %v", err)
	}
	if _, err := st.ChangeLinkRoleGuarded(ctx, guard, child.ID, "none", ""); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("revoked link manager: %v", err)
	}
	list, _ = st.ListShares(ctx, child.ID)
	link, _ := st.GetLink(ctx, child.ID)
	if len(list) != 1 || list[0].Role != store.RoleView || link.Role != store.RoleView || link.Token != "guarded-link-token" {
		t.Fatalf("revoked write changed state: %+v %+v", list, link)
	}
	if err := st.SetShare(ctx, parent.ID, manager.ID, store.RoleManage); err != nil {
		t.Fatal(err)
	}
	expired := guard
	expired.Now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if err := st.SetShareGuarded(ctx, expired, child.ID, guest.ID, store.RoleEdit, false); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expired session: %v", err)
	}
	if _, err := st.ChangeLinkRoleGuarded(ctx, expired, child.ID, "none", ""); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expired link session: %v", err)
	}
	calls := 0
	expiresDuringWrite := guard
	expiresDuringWrite.Now = func() time.Time {
		calls++
		if calls >= 2 {
			return time.Now().Add(2 * time.Hour)
		}
		return time.Now()
	}
	if _, err := st.ChangeLinkRoleGuarded(ctx, expiresDuringWrite, child.ID, "none", ""); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expiry during mutation: %v", err)
	}
	link, _ = st.GetLink(ctx, child.ID)
	if link.Role != store.RoleView || link.Token != "guarded-link-token" {
		t.Fatalf("expired mutation committed: %+v", link)
	}
	if err := st.DeleteSession(ctx, guard.SessionHash); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShareGuarded(ctx, guard, child.ID, guest.ID, store.RoleEdit, false); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("logged out session: %v", err)
	}
	if err := st.CreateSession(ctx, guard.SessionHash, guard.UserID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	// An inherited manager's grant must remain locked until the write commits.
	// The second clock check runs immediately before mutation (Memory) or
	// transaction commit (PostgreSQL), while the relevant locks are held.
	ready, release := make(chan struct{}), make(chan struct{})
	checks := 0
	blocking := guard
	blocking.Now = func() time.Time {
		checks++
		if checks == 2 {
			close(ready)
			<-release
		}
		return time.Now()
	}
	written := make(chan error, 1)
	go func() { written <- st.SetShareGuarded(ctx, blocking, child.ID, guest.ID, store.RoleEdit, false) }()
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("guarded write did not acquire locks")
	}
	revoked := make(chan error, 1)
	go func() { revoked <- st.SetShare(ctx, parent.ID, manager.ID, store.RoleView) }()
	select {
	case err := <-revoked:
		t.Fatalf("revocation completed before protected write: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if err := <-written; err != nil {
		t.Fatalf("guarded write: %v", err)
	}
	if err := <-revoked; err != nil {
		t.Fatalf("revocation: %v", err)
	}
	if _, err := st.ChangeLinkRoleGuarded(ctx, guard, child.ID, "none", ""); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("write after revocation: %v", err)
	}
	// Verify a mixed title/move/protection patch is atomic if the session
	// expires during the transaction.
	if err := st.SetShare(ctx, parent.ID, manager.ID, store.RoleManage); err != nil {
		t.Fatal(err)
	}
	checks = 0
	expiresDuringWrite.Now = func() time.Time {
		checks++
		if checks >= 2 {
			return time.Now().Add(2 * time.Hour)
		}
		return time.Now()
	}
	title := "not committed"
	if err := st.PatchManagedDocGuarded(ctx, expiresDuringWrite, child.ID, store.ManagedDocPatch{Title: &title, Move: true, CopyProtected: true}); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("mixed patch expiry: %v", err)
	}
	unchanged, err := st.GetDoc(ctx, manager.ID, child.ID)
	if err != nil || unchanged.Title != "Child" || unchanged.CopyProtected || unchanged.ParentID == nil || *unchanged.ParentID != parent.ID {
		t.Fatalf("mixed patch partially committed: %+v %v", unchanged, err)
	}
	incorrect := true
	if err := st.PatchManagedDocGuarded(ctx, guard, child.ID, store.ManagedDocPatch{Title: &title, CopyProtected: true, ExpectedCopyProtected: &incorrect}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale protection value: %v", err)
	}
	unchanged, err = st.GetDoc(ctx, manager.ID, child.ID)
	if err != nil || unchanged.Title != "Child" || unchanged.CopyProtected {
		t.Fatalf("stale mixed patch changed state: %+v %v", unchanged, err)
	}
	expected := false
	patchResult := make(chan error, 2)
	start := make(chan struct{})
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			patchResult <- st.PatchManagedDocGuarded(ctx, guard, child.ID, store.ManagedDocPatch{CopyProtected: true, ExpectedCopyProtected: &expected})
		}()
	}
	close(start)
	successes, conflicts := 0, 0
	for i := 0; i < 2; i++ {
		err := <-patchResult
		if err == nil {
			successes++
		} else if errors.Is(err, store.ErrConflict) {
			conflicts++
		} else {
			t.Fatalf("concurrent patch: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("CAS successes=%d conflicts=%d", successes, conflicts)
	}
	ready, release = make(chan struct{}), make(chan struct{})
	checks = 0
	blocking.Now = func() time.Time {
		checks++
		if checks == 2 {
			close(ready)
			<-release
		}
		return time.Now()
	}
	go func() { _, err := st.ChangeLinkRoleGuarded(ctx, blocking, child.ID, "none", ""); written <- err }()
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("link write did not acquire locks")
	}
	loggedOut := make(chan error, 1)
	go func() { loggedOut <- st.DeleteSession(ctx, guard.SessionHash) }()
	select {
	case err := <-loggedOut:
		t.Fatalf("logout completed before protected write: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if err := <-written; err != nil {
		t.Fatalf("link write: %v", err)
	}
	if err := <-loggedOut; err != nil {
		t.Fatalf("logout: %v", err)
	}
	if err := st.PatchManagedDocGuarded(ctx, guard, child.ID, store.ManagedDocPatch{CopyProtected: true}); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("patch after logout: %v", err)
	}
}

func TestMemoryGuardedSharing(t *testing.T) { checkGuardedSharing(t, store.NewMemory()) }
func TestPostgresGuardedSharing(t *testing.T) {
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
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	checkGuardedSharing(t, pg)
}

func TestPostgresGuardedSharingWaitsForRevocation(t *testing.T) {
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
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	parent, child, manager, guest, guard := guardedSharingFixture(t, pg)
	tx, err := pg.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE doc_shares SET role='view' WHERE doc_id=$1 AND user_id=$2`, parent.ID, manager.ID); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() { result <- pg.SetShareGuarded(ctx, guard, child.ID, guest.ID, store.RoleEdit, true) }()
	select {
	case err := <-result:
		t.Fatalf("write did not wait for pending revocation: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-result; !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("write after committed revocation: %v", err)
	}
	shares, err := pg.ListShares(ctx, child.ID)
	if err != nil || len(shares) != 0 {
		t.Fatalf("revoked write changed grants: %+v %v", shares, err)
	}
	if err := pg.SetShare(ctx, parent.ID, manager.ID, store.RoleManage); err != nil {
		t.Fatal(err)
	}
	tx, err = pg.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE token_hash=$1`, guard.SessionHash); err != nil {
		t.Fatal(err)
	}
	go func() {
		_, err := pg.ChangeLinkRoleGuarded(ctx, guard, child.ID, store.RoleView, "should-not-commit")
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("write did not wait for pending logout: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-result; !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("write after committed logout: %v", err)
	}
	link, err := pg.GetLink(ctx, child.ID)
	if err != nil || link.Role != "none" || link.Token != "" {
		t.Fatalf("logged-out write changed link: %+v %v", link, err)
	}
}

func waitForPGBlock(t *testing.T, pg *store.Postgres, queryPrefix string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var blocked bool
		// 行锁经由 multixact 队列等待时 pg_blocking_pids 可能为空（postgres 的已知
		// 盲区），因此以 wait_event_type='Lock' 判定等待，而不是依赖阻塞方解析。
		if err := pg.Pool.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE $1 AND wait_event_type='Lock')`, queryPrefix+"%").Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	var active string
	rows, err := pg.Pool.Query(context.Background(), `SELECT state||' '||wait_event_type||'/'||coalesce(wait_event,'')||' '||left(regexp_replace(query,'\s+',' ','g'),90) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`)
	if err == nil {
		for rows.Next() {
			var line string
			if rows.Scan(&line) == nil {
				active += "\n  " + line
			}
		}
		rows.Close()
	}
	var matches string
	mrows, merr := pg.Pool.Query(context.Background(), `SELECT pid||' like='||(query LIKE $1) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`, queryPrefix+"%")
	if merr == nil {
		for mrows.Next() {
			var line string
			if mrows.Scan(&line) == nil {
				matches += "\n  " + line
			}
		}
		mrows.Close()
	}
	t.Fatalf("query %q did not block on a PostgreSQL lock; activity:%s; match:%s", queryPrefix, active, matches)
}

func TestPostgresShareGuardConcurrentAuthorization(t *testing.T) {
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
	reset := func() {
		t.Helper()
		if _, err := pg.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
			t.Fatal(err)
		}
		if _, err := migrate.Up(ctx, pg.Pool); err != nil {
			t.Fatal(err)
		}
	}
	t.Run("workspace_admin_downgrade", func(t *testing.T) {
		reset()
		parent, child, manager, guest, guard := guardedSharingFixture(t, pg)
		if err := pg.SetShare(ctx, parent.ID, manager.ID, ""); err != nil {
			t.Fatal(err)
		}
		if _, err := pg.Pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'admin')`, parent.WorkspaceID, manager.ID); err != nil {
			t.Fatal(err)
		}
		tx, err := pg.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, `UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2`, parent.WorkspaceID, manager.ID); err != nil {
			t.Fatal(err)
		}
		result := make(chan error, 1)
		go func() { result <- pg.SetShareGuarded(ctx, guard, child.ID, guest.ID, store.RoleEdit, true) }()
		waitForPGBlock(t, pg, `SELECT role FROM workspace_members`)
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if err := <-result; !errors.Is(err, store.ErrForbidden) {
			t.Fatalf("write after workspace downgrade: %v", err)
		}
		shares, err := pg.ListShares(ctx, child.ID)
		if err != nil || len(shares) != 0 {
			t.Fatalf("unauthorized share: %+v %v", shares, err)
		}
	})
	t.Run("ancestor_move", func(t *testing.T) {
		reset()
		parent, child, manager, guest, guard := guardedSharingFixture(t, pg)
		owner, err := pg.UserByEmail(ctx, "guard-owner@example.test")
		if err != nil {
			t.Fatal(err)
		}
		grand, err := pg.CreateDoc(ctx, parent.WorkspaceID, owner.ID, nil, "Grandparent", nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := pg.Move(ctx, parent.ID, &grand.ID); err != nil {
			t.Fatal(err)
		}
		if err := pg.SetShare(ctx, parent.ID, manager.ID, ""); err != nil {
			t.Fatal(err)
		}
		if err := pg.SetShare(ctx, grand.ID, manager.ID, store.RoleManage); err != nil {
			t.Fatal(err)
		}
		tx, err := pg.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, `UPDATE nodes SET parent_id=NULL WHERE id=$1`, parent.ID); err != nil {
			t.Fatal(err)
		}
		result := make(chan error, 1)
		go func() { result <- pg.SetShareGuarded(ctx, guard, child.ID, guest.ID, store.RoleEdit, true) }()
		waitForPGBlock(t, pg, `SELECT id,parent_id,workspace_id,creator_id,copy_protected,kind,link_role,deleted_at IS NOT NULL,personal FROM nodes`)
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if err := <-result; !errors.Is(err, store.ErrForbidden) {
			t.Fatalf("write after ancestor move: %v", err)
		}
		shares, err := pg.ListShares(ctx, child.ID)
		if err != nil || len(shares) != 0 {
			t.Fatalf("unauthorized share: %+v %v", shares, err)
		}
	})
	t.Run("managers_demote_each_other", func(t *testing.T) {
		reset()
		parent, _, manager, _, guard := guardedSharingFixture(t, pg)
		other, _, err := pg.CreateUser(ctx, "other-manager@example.test", "Other", "hash")
		if err != nil {
			t.Fatal(err)
		}
		if err := pg.SetShare(ctx, parent.ID, other.ID, store.RoleManage); err != nil {
			t.Fatal(err)
		}
		otherGuard := store.RestoreGuard{UserID: other.ID, SessionHash: []byte("other-manager-session")}
		if err := pg.CreateSession(ctx, otherGuard.SessionHash, other.ID, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		result := make(chan error, 2)
		start := make(chan struct{})
		go func() { <-start; result <- pg.SetShareGuarded(ctx, guard, parent.ID, other.ID, store.RoleView, false) }()
		go func() {
			<-start
			result <- pg.SetShareGuarded(ctx, otherGuard, parent.ID, manager.ID, store.RoleView, false)
		}()
		close(start)
		success, denied := 0, 0
		for i := 0; i < 2; i++ {
			err := <-result
			if err == nil {
				success++
			} else if errors.Is(err, store.ErrForbidden) {
				denied++
			} else {
				t.Fatalf("concurrent manager result: %v", err)
			}
		}
		if success != 1 || denied != 1 {
			t.Fatalf("success=%d denied=%d", success, denied)
		}
		shares, err := pg.ListShares(ctx, parent.ID)
		if err != nil || len(shares) != 2 {
			t.Fatalf("shares %+v %v", shares, err)
		}
		counts := map[string]int{}
		for _, share := range shares {
			counts[share.Role]++
		}
		if counts[store.RoleManage] != 1 || counts[store.RoleView] != 1 {
			t.Fatalf("unexpected final roles: %+v", shares)
		}
	})
	t.Run("ancestor_trash_deadlock_rolls_back", func(t *testing.T) {
		reset()
		parent, child, _, guest, guard := guardedSharingFixture(t, pg)
		ready, release := make(chan struct{}), make(chan struct{})
		calls := 0
		guard.Now = func() time.Time {
			calls++
			if calls == 1 {
				close(ready)
				<-release
			}
			return time.Now()
		}
		shareResult, trashResult := make(chan error, 1), make(chan error, 1)
		go func() { shareResult <- pg.SetShareGuarded(ctx, guard, child.ID, guest.ID, store.RoleEdit, true) }()
		select {
		case <-ready:
		case <-time.After(5 * time.Second):
			t.Fatal("sharing did not lock child")
		}
		go func() { trashResult <- pg.Trash(ctx, parent.ID) }()
		waitForPGBlock(t, pg, `WITH RECURSIVE t(id)`)
		close(release)
		var shareErr, trashErr error
		select {
		case shareErr = <-shareResult:
		case <-time.After(10 * time.Second):
			t.Fatal("sharing did not resolve deadlock")
		}
		select {
		case trashErr = <-trashResult:
		case <-time.After(10 * time.Second):
			t.Fatal("trash did not resolve deadlock")
		}
		if !(shareErr == nil && errors.Is(trashErr, store.ErrConflict) || trashErr == nil && errors.Is(shareErr, store.ErrConflict)) {
			t.Fatalf("expected one committed operation and one conflict: share=%v trash=%v", shareErr, trashErr)
		}
		shares, err := pg.ListShares(ctx, child.ID)
		if err != nil {
			t.Fatal(err)
		}
		_, docErr := pg.GetDocSystem(ctx, child.ID)
		if shareErr == nil && (len(shares) != 1 || docErr != nil) || trashErr == nil && (len(shares) != 0 || !errors.Is(docErr, store.ErrNotFound)) {
			t.Fatalf("partial transaction share=%v trash=%v shares=%+v docErr=%v", shareErr, trashErr, shares, docErr)
		}
	})
}
