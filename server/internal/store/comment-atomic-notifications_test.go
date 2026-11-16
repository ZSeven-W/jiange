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

func exerciseAtomicCommentNotifications(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	_, doc, manager, guest, managerGuard := guardedSharingFixture(t, st)
	if err := st.SetShare(ctx, doc.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	guestGuard := store.RestoreGuard{UserID: guest.ID, SessionHash: []byte("atomic-comment-guest")}
	if err := st.CreateSession(ctx, guestGuard.SessionHash, guest.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	outsider, _, err := st.CreateUser(ctx, "atomic-outsider@example.test", "Outsider", "hash")
	if err != nil {
		t.Fatal(err)
	}
	first, err := st.AddCommentGuarded(ctx, managerGuard, store.Comment{DocID: doc.ID, UserID: manager.ID, Body: "first", Mentions: []int64{guest.ID, guest.ID, manager.ID, outsider.ID, 999999}})
	if err != nil {
		t.Fatal(err)
	}
	guestNotes, err := st.Notifications(ctx, guest.ID, 50)
	if err != nil || len(guestNotes) != 1 || guestNotes[0].Kind != "mention" || *guestNotes[0].CommentID != first.ID {
		t.Fatalf("mention dedupe: %+v %v", guestNotes, err)
	}
	out, err := st.Notifications(ctx, outsider.ID, 50)
	if err != nil || len(out) != 0 {
		t.Fatalf("unauthorized recipient: %+v %v", out, err)
	}
	if _, err := st.AddCommentGuarded(ctx, guestGuard, store.Comment{DocID: doc.ID, UserID: guest.ID, ParentID: &first.ID, Body: "reply", Mentions: []int64{manager.ID, manager.ID}}); err != nil {
		t.Fatal(err)
	}
	managerNotes, err := st.Notifications(ctx, manager.ID, 50)
	if err != nil || len(managerNotes) != 1 || managerNotes[0].Kind != "reply" {
		t.Fatalf("reply dedupe: %+v %v", managerNotes, err)
	}
	yes, no := true, false
	if _, changed, err := st.PatchCommentGuarded(ctx, managerGuard, doc.ID, first.ID, nil, &yes); err != nil || !changed {
		t.Fatalf("resolve: %v %v", changed, err)
	}
	if _, changed, err := st.PatchCommentGuarded(ctx, managerGuard, doc.ID, first.ID, nil, &yes); err != nil || changed {
		t.Fatalf("repeat resolve: %v %v", changed, err)
	}
	guestNotes, err = st.Notifications(ctx, guest.ID, 50)
	if err != nil || len(guestNotes) != 2 || guestNotes[0].Kind != "resolve" {
		t.Fatalf("resolve notification: %+v %v", guestNotes, err)
	}
	if _, _, err := st.PatchCommentGuarded(ctx, managerGuard, doc.ID, first.ID, nil, &no); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.PatchCommentGuarded(ctx, managerGuard, doc.ID, first.ID, nil, &yes); err != nil {
		t.Fatal(err)
	}
	guestNotes, err = st.Notifications(ctx, guest.ID, 50)
	if err != nil || len(guestNotes) != 3 || guestNotes[0].Kind != "resolve" {
		t.Fatalf("re-resolve notification: %+v %v", guestNotes, err)
	}
	if err := st.SetShare(ctx, doc.ID, guest.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddCommentGuarded(ctx, managerGuard, store.Comment{DocID: doc.ID, UserID: manager.ID, Body: "after revoke", Mentions: []int64{guest.ID}}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, doc.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	guestNotes, err = st.Notifications(ctx, guest.ID, 50)
	if err != nil || len(guestNotes) != 3 {
		t.Fatalf("revoked user got new notice: %+v %v", guestNotes, err)
	}
}

func TestMemoryAtomicCommentNotifications(t *testing.T) {
	exerciseAtomicCommentNotifications(t, store.NewMemory())
}

func exerciseBaseCommentRecipients(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	parent, _, manager, guest, guard := guardedSharingFixture(t, st)
	base, err := st.CreateBase(ctx, parent.WorkspaceID, parent.CreatorID, &parent.ID, "base comments")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddCommentGuarded(ctx, guard, store.Comment{DocID: base.ID, UserID: manager.ID, Body: "base mention", Mentions: []int64{guest.ID, guest.ID, 999999}}); err != nil {
		t.Fatal(err)
	}
	// Base comments now follow doc semantics: no notice without view access.
	notes, err := st.Notifications(ctx, guest.ID, 50)
	if err != nil || len(notes) != 0 {
		t.Fatalf("base mention reached a user without access: %+v %v", notes, err)
	}
	if err := st.SetShare(ctx, base.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddCommentGuarded(ctx, guard, store.Comment{DocID: base.ID, UserID: manager.ID, Body: "base mention 2", Mentions: []int64{guest.ID, guest.ID, 999999}}); err != nil {
		t.Fatal(err)
	}
	notes, err = st.Notifications(ctx, guest.ID, 50)
	if err != nil || len(notes) != 1 || notes[0].Kind != "mention" {
		t.Fatalf("base mention: %+v %v", notes, err)
	}
}

func TestMemoryBaseCommentRecipients(t *testing.T) {
	exerciseBaseCommentRecipients(t, store.NewMemory())
}
func TestPostgresBaseCommentRecipients(t *testing.T) {
	exerciseBaseCommentRecipients(t, atomicPostgres(t))
}

func TestMemoryAtomicCommentExpiryBeforePublish(t *testing.T) {
	st := store.NewMemory()
	ctx := context.Background()
	_, doc, manager, guest, guard := guardedSharingFixture(t, st)
	if err := st.SetShare(ctx, doc.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	count := 0
	guard.Now = func() time.Time {
		count++
		if count >= 3 {
			return time.Now().Add(2 * time.Hour)
		}
		return time.Now()
	}
	if _, err := st.AddCommentGuarded(ctx, guard, store.Comment{DocID: doc.ID, UserID: manager.ID, Body: "not committed", Mentions: []int64{guest.ID}}); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expiry: %v", err)
	}
	comments, err := st.Comments(ctx, doc.ID)
	if err != nil || len(comments) != 0 {
		t.Fatalf("comment persisted: %+v %v", comments, err)
	}
	notes, err := st.Notifications(ctx, guest.ID, 50)
	if err != nil || len(notes) != 0 {
		t.Fatalf("notice persisted: %+v %v", notes, err)
	}
}

func atomicPostgres(t *testing.T) *store.Postgres {
	t.Helper()
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	p, err := store.NewPostgres(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	if _, err = p.Pool.Exec(context.Background(), `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err = migrate.Up(context.Background(), p.Pool); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestPostgresAtomicCommentNotifications(t *testing.T) {
	exerciseAtomicCommentNotifications(t, atomicPostgres(t))
}

func TestPostgresCommentNotificationFailureRollsBack(t *testing.T) {
	p := atomicPostgres(t)
	ctx := context.Background()
	_, doc, manager, guest, guard := guardedSharingFixture(t, p)
	if err := p.SetShare(ctx, doc.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	install := func() {
		t.Helper()
		if _, err := p.Pool.Exec(ctx, `CREATE OR REPLACE FUNCTION fail_comment_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test notice failure'; END $$; CREATE TRIGGER fail_comment_notice BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION fail_comment_notice()`); err != nil {
			t.Fatal(err)
		}
	}
	remove := func() {
		t.Helper()
		if _, err := p.Pool.Exec(ctx, `DROP TRIGGER fail_comment_notice ON notifications`); err != nil {
			t.Fatal(err)
		}
	}
	install()
	if _, err := p.AddCommentGuarded(ctx, guard, store.Comment{DocID: doc.ID, UserID: manager.ID, Body: "must roll back", Mentions: []int64{guest.ID}}); err == nil {
		t.Fatal("notification failure must reject entire comment")
	}
	comments, err := p.Comments(ctx, doc.ID)
	if err != nil || len(comments) != 0 {
		t.Fatalf("comment after rollback: %+v %v", comments, err)
	}
	remove()
	c, err := p.AddCommentGuarded(ctx, guard, store.Comment{DocID: doc.ID, UserID: manager.ID, Body: "ok", Mentions: []int64{guest.ID}})
	if err != nil {
		t.Fatal(err)
	}
	install()
	yes := true
	if _, _, err = p.PatchCommentGuarded(ctx, guard, doc.ID, c.ID, nil, &yes); err == nil {
		t.Fatal("notification failure must reject resolution")
	}
	comments, err = p.Comments(ctx, doc.ID)
	if err != nil || len(comments) != 1 || comments[0].Resolved {
		t.Fatalf("resolution after rollback: %+v %v", comments, err)
	}
	notes, err := p.Notifications(ctx, guest.ID, 50)
	if err != nil || len(notes) != 1 || notes[0].Kind != "mention" {
		t.Fatalf("notices after rollback: %+v %v", notes, err)
	}
}

func TestPostgresCommentNotificationLocksRecipientGrant(t *testing.T) {
	p := atomicPostgres(t)
	ctx := context.Background()
	_, doc, manager, guest, guard := guardedSharingFixture(t, p)
	if err := p.SetShare(ctx, doc.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	ready, release := make(chan struct{}), make(chan struct{})
	checks := 0
	guard.Now = func() time.Time {
		checks++
		if checks == 2 {
			close(ready)
			<-release
		}
		return time.Now()
	}
	written := make(chan error, 1)
	go func() {
		_, err := p.AddCommentGuarded(ctx, guard, store.Comment{DocID: doc.ID, UserID: manager.ID, Body: "locked recipient", Mentions: []int64{guest.ID}})
		written <- err
	}()
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("comment did not reach pre-commit")
	}
	revoked := make(chan error, 1)
	go func() { revoked <- p.SetShare(ctx, doc.ID, guest.ID, "") }()
	deadline := time.Now().Add(5 * time.Second)
	blocked := false
	for time.Now().Before(deadline) {
		var count int
		err := p.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'DELETE FROM doc_shares%'`).Scan(&count)
		if err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			blocked = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		close(release)
		t.Fatal("recipient revocation did not wait for the notification transaction")
	}
	close(release)
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if err := <-revoked; err != nil {
		t.Fatal(err)
	}
	if err := p.SetShare(ctx, doc.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	notes, err := p.Notifications(ctx, guest.ID, 50)
	if err != nil || len(notes) != 1 {
		t.Fatalf("authorized notice was not committed: %+v %v", notes, err)
	}
}
