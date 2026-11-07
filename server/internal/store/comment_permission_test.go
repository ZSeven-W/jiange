package store_test

import (
	"context"
	"errors"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"os"
	"testing"
	"time"
)

func exerciseCommentPermissions(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	parent, doc, manager, guest, managerGuard := guardedSharingFixture(t, st)
	if err := st.SetShare(ctx, doc.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	guestGuard := store.RestoreGuard{UserID: guest.ID, SessionHash: []byte("comment-guest-session")}
	if err := st.CreateSession(ctx, guestGuard.SessionHash, guest.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	d, err := st.GetDoc(ctx, manager.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.CommentMinRole != store.RoleView {
		t.Fatalf("new policy: %+v", d)
	}
	c, err := st.AddCommentGuarded(ctx, guestGuard, store.Comment{DocID: doc.ID, UserID: guest.ID, Body: "first"})
	if err != nil {
		t.Fatal(err)
	}
	x := int64(99999)
	if _, err := st.AddCommentGuarded(ctx, guestGuard, store.Comment{DocID: doc.ID, UserID: guest.ID, ParentID: &x, Body: "bad"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing parent: %v", err)
	}
	other, err := st.AddCommentGuarded(ctx, managerGuard, store.Comment{DocID: parent.ID, UserID: manager.ID, Body: "other"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddCommentGuarded(ctx, guestGuard, store.Comment{DocID: doc.ID, UserID: guest.ID, ParentID: &other.ID, Body: "bad"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-doc parent: %v", err)
	}
	edit := store.RoleEdit
	rev := d.PermissionsRevision
	if err := st.PatchManagedDocGuarded(ctx, managerGuard, doc.ID, store.ManagedDocPatch{CommentMinRole: &edit, ExpectedPermissionsRevision: &rev}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddCommentGuarded(ctx, guestGuard, store.Comment{DocID: doc.ID, UserID: guest.ID, Body: "denied"}); !errors.Is(err, store.ErrCommentPermissionDenied) {
		t.Fatalf("view denied: %v", err)
	}
	body := "denied"
	if _, _, err := st.PatchCommentGuarded(ctx, guestGuard, doc.ID, c.ID, &body, nil); !errors.Is(err, store.ErrCommentPermissionDenied) {
		t.Fatalf("view patch denied: %v", err)
	}
	if err := st.DeleteCommentGuarded(ctx, guestGuard, doc.ID, c.ID); !errors.Is(err, store.ErrCommentPermissionDenied) {
		t.Fatalf("view delete denied: %v", err)
	}
	if err := st.SetShare(ctx, doc.ID, guest.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	updated, changed, err := st.PatchCommentGuarded(ctx, guestGuard, doc.ID, c.ID, &body, nil)
	if err != nil || changed || updated.Body != body {
		t.Fatalf("edit own: %+v %v %v", updated, changed, err)
	}
	resolved := true
	_, changed, err = st.PatchCommentGuarded(ctx, managerGuard, doc.ID, c.ID, nil, &resolved)
	if err != nil || !changed {
		t.Fatalf("resolve: %v %v", changed, err)
	}
	_, changed, err = st.PatchCommentGuarded(ctx, managerGuard, doc.ID, c.ID, nil, &resolved)
	if err != nil || changed {
		t.Fatalf("duplicate resolve: %v %v", changed, err)
	}
	if _, _, err = st.PatchCommentGuarded(ctx, managerGuard, doc.ID, c.ID, &body, nil); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("other author edit: %v", err)
	}
	if err := st.DeleteSession(ctx, guestGuard.SessionHash); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteCommentGuarded(ctx, guestGuard, doc.ID, c.ID); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("logged out: %v", err)
	}
	if err := st.DeleteCommentGuarded(ctx, managerGuard, doc.ID, c.ID); err != nil {
		t.Fatalf("manager delete: %v", err)
	}
	stale := rev
	view := store.RoleView
	if err := st.PatchManagedDocGuarded(ctx, managerGuard, doc.ID, store.ManagedDocPatch{CommentMinRole: &view, ExpectedPermissionsRevision: &stale}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale revision: %v", err)
	}
}
func TestMemoryCommentPermissions(t *testing.T) { exerciseCommentPermissions(t, store.NewMemory()) }
func TestPostgresCommentPermissions(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	p, err := store.NewPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if _, err := p.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err := migrate.Up(ctx, p.Pool); err != nil {
		t.Fatal(err)
	}
	exerciseCommentPermissions(t, p)
}

func exerciseCommentLocking(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	parent, doc, manager, _, guard := guardedSharingFixture(t, st)
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
	go func() {
		_, err := st.AddCommentGuarded(ctx, blocking, store.Comment{DocID: doc.ID, UserID: manager.ID, Body: "locked"})
		written <- err
	}()
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("guarded comment did not acquire lock")
	}
	revoked := make(chan error, 1)
	go func() { revoked <- st.SetShare(ctx, parent.ID, manager.ID, store.RoleView) }()
	select {
	case err := <-revoked:
		t.Fatalf("revocation bypassed locked authorization: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if err := <-revoked; err != nil {
		t.Fatal(err)
	}
	// Existing direct permission no longer grants access to the child.
	if _, err := st.AddCommentGuarded(ctx, guard, store.Comment{DocID: doc.ID, UserID: manager.ID, Body: "after"}); err != nil {
		t.Fatalf("new default view should allow inherited viewer: %v", err)
	}
	d, err := st.GetDoc(ctx, manager.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.Role != store.RoleView {
		t.Fatalf("role: %q", d.Role)
	}
}
func TestMemoryCommentLocking(t *testing.T) { exerciseCommentLocking(t, store.NewMemory()) }
func TestPostgresCommentLocking(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	p, err := store.NewPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if _, err = p.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err = migrate.Up(ctx, p.Pool); err != nil {
		t.Fatal(err)
	}
	exerciseCommentLocking(t, p)
}

func TestPostgresLegacyCommentPermissionMigration(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	p, err := store.NewPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if _, err = p.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err = migrate.Up(ctx, p.Pool); err != nil {
		t.Fatal(err)
	}
	u, w, err := p.CreateUser(ctx, "comment-old@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	old, err := p.CreateDoc(ctx, w.ID, u.ID, nil, "Old", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.Pool.Exec(ctx, `ALTER TABLE nodes DROP COLUMN comment_min_role CASCADE; DELETE FROM schema_migrations WHERE version=30`); err != nil {
		t.Fatal(err)
	}
	if _, err = migrate.Up(ctx, p.Pool); err != nil {
		t.Fatal(err)
	}
	d, err := p.GetDoc(ctx, u.ID, old.ID)
	if err != nil || d.CommentMinRole != store.RoleEdit {
		t.Fatalf("old policy %+v %v", d, err)
	}
	fresh, err := p.CreateDoc(ctx, w.ID, u.ID, nil, "New", nil)
	if err != nil {
		t.Fatal(err)
	}
	d, err = p.GetDoc(ctx, u.ID, fresh.ID)
	if err != nil || d.CommentMinRole != store.RoleView {
		t.Fatalf("new policy %+v %v", d, err)
	}
	if _, err = p.Pool.Exec(ctx, `UPDATE nodes SET comment_min_role='view' WHERE id=$1`, old.ID); err == nil {
		t.Fatal("update without revision succeeded")
	}
}

func exerciseLegacyCrossDocumentComment(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	parent, doc, manager, _, guard := guardedSharingFixture(t, st)
	root, err := st.AddCommentGuarded(ctx, guard, store.Comment{DocID: doc.ID, UserID: manager.ID, Body: "root"})
	if err != nil {
		t.Fatal(err)
	}
	child, err := st.AddCommentGuarded(ctx, guard, store.Comment{DocID: doc.ID, UserID: manager.ID, ParentID: &root.ID, Body: "child"})
	if err != nil {
		t.Fatal(err)
	}
	// Emulate historical versions which allowed a child in another document.
	bad, err := st.AddComment(ctx, store.Comment{DocID: parent.ID, UserID: manager.ID, ParentID: &child.ID, Body: "legacy cross-document"})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteCommentGuarded(ctx, guard, doc.ID, root.ID); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("unsafe cascade accepted: %v", err)
	}
	a, err := st.Comments(ctx, doc.ID)
	if err != nil || len(a) != 2 {
		t.Fatalf("original changed: %+v %v", a, err)
	}
	b, err := st.Comments(ctx, parent.ID)
	if err != nil || len(b) != 1 || b[0].ID != bad.ID {
		t.Fatalf("foreign changed: %+v %v", b, err)
	}
}
func TestMemoryCommentLegacyCrossDocument(t *testing.T) {
	exerciseLegacyCrossDocumentComment(t, store.NewMemory())
}
func TestPostgresCommentLegacyCrossDocument(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	p, err := store.NewPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if _, err = p.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err = migrate.Up(ctx, p.Pool); err != nil {
		t.Fatal(err)
	}
	exerciseLegacyCrossDocumentComment(t, p)
}

func TestMemoryCommentIDNeverReusedAfterDelete(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	_, doc, manager, _, guard := guardedSharingFixture(t, st)
	old, err := st.AddCommentGuarded(ctx, guard, store.Comment{DocID: doc.ID, UserID: manager.ID, Body: "old"})
	if err != nil {
		t.Fatal(err)
	}
	if err = st.AddNotifications(ctx, []store.Notification{{UserID: manager.ID, DocID: doc.ID, ActorID: manager.ID, CommentID: &old.ID, Kind: "mention"}}); err != nil {
		t.Fatal(err)
	}
	if err = st.DeleteCommentGuarded(ctx, guard, doc.ID, old.ID); err != nil {
		t.Fatal(err)
	}
	newer, err := st.AddComment(ctx, store.Comment{DocID: doc.ID, UserID: manager.ID, Body: "new"})
	if err != nil {
		t.Fatal(err)
	}
	if newer.ID <= old.ID {
		t.Fatalf("reused id: old=%d new=%d", old.ID, newer.ID)
	}
	items, err := st.Notifications(ctx, manager.ID, 50)
	if err != nil || len(items) != 0 {
		t.Fatalf("notification revived: %+v %v", items, err)
	}
}
