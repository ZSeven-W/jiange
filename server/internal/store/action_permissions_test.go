package store_test

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func exerciseActionPermissions(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	_, doc, manager, _, guard := guardedSharingFixture(t, st)
	read := func() store.DocMeta {
		t.Helper()
		d, err := st.GetDoc(ctx, manager.ID, doc.ID)
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	initial := read()
	if initial.CopyMinRole != store.RoleView || initial.DownloadMinRole != store.RoleView || initial.PermissionsRevision != 0 {
		t.Fatalf("new document policy: %+v", initial)
	}
	copyRole, downloadRole := store.RoleView, store.RoleEdit
	rev := initial.PermissionsRevision
	if err := st.PatchManagedDocGuarded(ctx, guard, doc.ID, store.ManagedDocPatch{CopyMinRole: &copyRole, DownloadMinRole: &downloadRole, ExpectedPermissionsRevision: &rev}); err != nil {
		t.Fatal(err)
	}
	d := read()
	if d.CopyMinRole != store.RoleView || d.DownloadMinRole != store.RoleEdit || !d.CopyProtected || d.PermissionsRevision != rev+1 {
		t.Fatalf("split policy: %+v", d)
	}
	for _, tc := range []struct {
		role           string
		copy, download bool
	}{
		{"", false, false}, {"anon", true, false}, {store.RoleView, true, false}, {store.RoleEdit, true, true}, {store.RoleManage, true, true},
	} {
		if store.DocumentCopyAllowed(d, tc.role) != tc.copy || store.DocumentDownloadAllowed(d, tc.role) != tc.download {
			t.Fatalf("role %q: %+v", tc.role, d)
		}
	}
	// Change away and back; old revision must still conflict (ABA).
	other := store.RoleManage
	current := d.PermissionsRevision
	if err := st.PatchManagedDocGuarded(ctx, guard, doc.ID, store.ManagedDocPatch{DownloadMinRole: &other, ExpectedPermissionsRevision: &current}); err != nil {
		t.Fatal(err)
	}
	current++
	if err := st.PatchManagedDocGuarded(ctx, guard, doc.ID, store.ManagedDocPatch{DownloadMinRole: &downloadRole, ExpectedPermissionsRevision: &current}); err != nil {
		t.Fatal(err)
	}
	oldTitle := "must not commit"
	if err := st.PatchManagedDocGuarded(ctx, guard, doc.ID, store.ManagedDocPatch{Title: &oldTitle, CopyMinRole: &other, ExpectedPermissionsRevision: &rev}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale ABA: %v", err)
	}
	d = read()
	if d.Title == oldTitle || d.CopyMinRole != store.RoleView || d.DownloadMinRole != store.RoleEdit || d.PermissionsRevision != rev+3 {
		t.Fatalf("stale patch changed doc: %+v", d)
	}
	if err := st.PatchManagedDocGuarded(ctx, guard, doc.ID, store.ManagedDocPatch{CopyProtected: true}); err != nil {
		t.Fatal(err)
	}
	d = read()
	if d.CopyMinRole != store.RoleManage || d.DownloadMinRole != store.RoleManage || !d.CopyProtected || d.PermissionsRevision != rev+4 {
		t.Fatalf("legacy protect: %+v", d)
	}
	if err := st.PatchManagedDocGuarded(ctx, guard, doc.ID, store.ManagedDocPatch{CopyProtected: false}); err != nil {
		t.Fatal(err)
	}
	d = read()
	if d.CopyMinRole != store.RoleView || d.DownloadMinRole != store.RoleView || d.CopyProtected || d.PermissionsRevision != rev+5 {
		t.Fatalf("legacy unprotect: %+v", d)
	}
}

func TestMemoryActionPermissions(t *testing.T) { exerciseActionPermissions(t, store.NewMemory()) }

func TestPostgresActionPermissions(t *testing.T) {
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
	exerciseActionPermissions(t, pg)
	// A legacy binary changing only the old flag must fail closed for docs.
	var id int64
	if err := pg.Pool.QueryRow(ctx, `SELECT id FROM nodes WHERE kind='doc' ORDER BY id LIMIT 1`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := pg.Pool.Exec(ctx, `UPDATE nodes SET copy_protected=true WHERE id=$1`, id); err == nil {
		t.Fatal("legacy update bypassed projection constraint")
	}
	// UPDATE OF fires even when a stale process writes the existing value.
	if _, err := pg.Pool.Exec(ctx, `UPDATE nodes SET copy_protected=false WHERE id=$1`, id); err == nil {
		t.Fatal("legacy same-value update was incorrectly accepted")
	}
	if _, err := pg.Pool.Exec(ctx, `UPDATE nodes SET copy_protected=true, copy_min_role='manage', download_min_role='view', permissions_revision=permissions_revision+1 WHERE id=$1`, id); err != nil {
		t.Fatalf("new split update: %v", err)
	}
	if _, err := pg.Pool.Exec(ctx, `UPDATE nodes SET copy_protected=true WHERE id=$1`, id); err == nil {
		t.Fatal("legacy same-value protected update incorrectly accepted a split policy")
	}
	if _, err := pg.Pool.Exec(ctx, `UPDATE nodes SET title='Allowed' WHERE id=$1`, id); err != nil {
		t.Fatalf("unrelated update rejected: %v", err)
	}
	if _, err := pg.Pool.Exec(ctx, `UPDATE nodes SET kind='base' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := pg.Pool.Exec(ctx, `UPDATE nodes SET copy_protected=false WHERE id=$1`, id); err != nil {
		t.Fatalf("base legacy behavior changed: %v", err)
	}
}

func TestPostgresActionPermissionsLegacyMigration(t *testing.T) {
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
	owner, ws, err := pg.CreateUser(ctx, "old-policy@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	protected, err := pg.CreateDoc(ctx, ws.ID, owner.ID, nil, "Protected", nil)
	if err != nil {
		t.Fatal(err)
	}
	open, err := pg.CreateDoc(ctx, ws.ID, owner.ID, nil, "Open", nil)
	if err != nil {
		t.Fatal(err)
	}
	// Reconstruct the exact pre-0029 policy columns while retaining old data.
	if _, err := pg.Pool.Exec(ctx, `ALTER TABLE nodes DROP COLUMN copy_min_role CASCADE, DROP COLUMN download_min_role CASCADE, DROP COLUMN permissions_revision CASCADE;
		DROP FUNCTION require_document_permission_revision() CASCADE;
		DELETE FROM schema_migrations WHERE version=29`); err != nil {
		t.Fatal(err)
	}
	if _, err := pg.Pool.Exec(ctx, `UPDATE nodes SET copy_protected=true WHERE id=$1`, protected.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		id        int64
		role      string
		protected bool
	}{{protected.ID, store.RoleManage, true}, {open.ID, store.RoleView, false}} {
		d, err := pg.GetDoc(ctx, owner.ID, tc.id)
		if err != nil || d.CopyMinRole != tc.role || d.DownloadMinRole != tc.role || d.CopyProtected != tc.protected || d.PermissionsRevision != 0 {
			t.Fatalf("migrated policy: %+v %v", d, err)
		}
	}
}
