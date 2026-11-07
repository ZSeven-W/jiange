package store_test

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func checkCreateShareOnce(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "unique-share-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := st.CreateUser(ctx, "unique-share-guest@example.test", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Document", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.AddShare(ctx, doc.ID, owner.ID, store.RoleEdit); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("owner conflict: %v", err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, role := range []string{store.RoleView, store.RoleManage} {
		wg.Add(1)
		go func(role string) { defer wg.Done(); <-start; results <- st.AddShare(ctx, doc.ID, guest.ID, role) }(role)
	}
	close(start)
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, store.ErrConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("success=%d conflict=%d", success, conflict)
	}
	before, err := st.ListShares(ctx, doc.ID)
	if err != nil || len(before) != 1 {
		t.Fatalf("shares %+v %v", before, err)
	}
	if err := st.AddShare(ctx, doc.ID, guest.ID, store.RoleEdit); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("second invite: %v", err)
	}
	after, err := st.ListShares(ctx, doc.ID)
	if err != nil || len(after) != 1 || after[0].Role != before[0].Role {
		t.Fatalf("existing role overwritten: %+v -> %+v, %v", before, after, err)
	}
	other, _, err := st.CreateUser(ctx, "unique-share-other@example.test", "Other", "hash")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Trash(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	if err := st.AddShare(ctx, doc.ID, other.ID, store.RoleEdit); err == nil {
		t.Fatal("invited to deleted document")
	}
	if err := st.Restore(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	afterRestore, err := st.ListShares(ctx, doc.ID)
	if err != nil || len(afterRestore) != 1 || afterRestore[0].UserID != guest.ID {
		t.Fatalf("deleted document acquired a share: %+v %v", afterRestore, err)
	}
}
func TestMemoryCreateShareOnce(t *testing.T) { checkCreateShareOnce(t, store.NewMemory()) }
func TestPostgresCreateShareOnceAndAnonymousLink(t *testing.T) {
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
	// Model a pre-existing installation through 0024 before applying later
	// embedded migrations. Existing data must survive the constraint change.
	if _, err = pg.Pool.Exec(ctx, `CREATE TABLE schema_migrations (version int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	migrations, err := migrate.List()
	if err != nil {
		t.Fatal(err)
	}
	for _, migration := range migrations {
		if migration.Version > 24 {
			continue
		}
		if _, err = pg.Pool.Exec(ctx, migration.SQL); err != nil {
			t.Fatal(err)
		}
		if _, err = pg.Pool.Exec(ctx, `INSERT INTO schema_migrations (version,name) VALUES ($1,$2)`, migration.Version, migration.Name); err != nil {
			t.Fatal(err)
		}
	}
	oldOwner, oldWS, err := pg.CreateUser(ctx, "old-owner@example.test", "Old Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	oldDoc, err := pg.CreateDoc(ctx, oldWS.ID, oldOwner.ID, nil, "Existing document", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	if old, err := pg.GetDoc(ctx, oldOwner.ID, oldDoc.ID); err != nil || old.Title != "Existing document" {
		t.Fatalf("existing document after upgrade: %+v %v", old, err)
	}
	if link, err := pg.ChangeLinkRole(ctx, oldDoc.ID, "anon", "existing-doc-anonymous-token"); err != nil || link.Role != "anon" {
		t.Fatalf("existing document anonymous link: %+v %v", link, err)
	}
	checkCreateShareOnce(t, pg)
	owner, err := pg.UserByEmail(ctx, "unique-share-owner@example.test")
	if err != nil {
		t.Fatal(err)
	}
	workspaces, err := pg.Workspaces(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := pg.CreateDoc(ctx, workspaces[0].ID, owner.ID, nil, "Anonymous", nil)
	if err != nil {
		t.Fatal(err)
	}
	link, err := pg.ChangeLinkRole(ctx, doc.ID, "anon", "test-anonymous-token")
	if err != nil || link.Role != "anon" || link.Token == "" {
		t.Fatalf("anonymous link %+v: %v", link, err)
	}
}
