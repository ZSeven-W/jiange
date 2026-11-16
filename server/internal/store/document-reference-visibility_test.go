package store_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type visibilityStore interface {
	store.Store
	store.ReferenceVisibilityStore
}

func checkReferenceVisibility(t *testing.T, st visibilityStore) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "visibility-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := st.CreateUser(ctx, "visibility-editor@test.dev", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	viewer, _, err := st.CreateUser(ctx, "visibility-viewer@test.dev", "Viewer", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "文档", store.InitialDocOps("文档"))
	if err != nil {
		t.Fatal(err)
	}
	for _, pair := range []struct {
		id   int64
		role string
	}{{editor.ID, store.RoleEdit}, {viewer.ID, store.RoleView}} {
		if err = st.SetShare(ctx, doc.ID, pair.id, pair.role); err != nil {
			t.Fatal(err)
		}
	}
	og := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("visibility-owner")}
	eg := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("visibility-editor")}
	vg := store.RestoreGuard{UserID: viewer.ID, SessionHash: []byte("visibility-viewer")}
	for _, g := range []store.RestoreGuard{og, eg, vg} {
		if err = st.CreateSession(ctx, g.SessionHash, g.UserID, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	if value, e := st.ReferenceVisibilityGuarded(ctx, vg, doc.ID); e != nil || !value.Visible || value.Revision != 0 {
		t.Fatalf("default: %+v %v", value, e)
	}
	if _, e := st.SetReferenceVisibilityGuarded(ctx, vg, doc.ID, false, 0); !errors.Is(e, store.ErrForbidden) {
		t.Fatalf("viewer write: %v", e)
	}
	if value, e := st.SetReferenceVisibilityGuarded(ctx, eg, doc.ID, false, 0); e != nil || value.Visible || value.Revision != 1 {
		t.Fatalf("hide: %+v %v", value, e)
	}
	if value, e := st.ReferenceVisibilityGuarded(ctx, vg, doc.ID); e != nil || value.Visible || value.Revision != 1 {
		t.Fatalf("viewer hidden: %+v %v", value, e)
	}
	if _, e := st.SetReferenceVisibilityGuarded(ctx, eg, doc.ID, true, 0); !errors.Is(e, store.ErrConflict) {
		t.Fatalf("stale: %v", e)
	}
	if value, e := st.SetReferenceVisibilityGuarded(ctx, eg, doc.ID, false, 1); e != nil || value.Revision != 1 {
		t.Fatalf("unchanged: %+v %v", value, e)
	}
	copied, e := st.CopyDoc(ctx, store.DocCopy{SourceID: doc.ID, UserID: owner.ID, WorkspaceID: ws.ID, Title: "副本", Guard: &og}, func(map[int64]int64) ([]store.RawOp, error) { return store.InitialDocOps("副本"), nil })
	if e != nil {
		t.Fatal(e)
	}
	if value, e := st.ReferenceVisibilityGuarded(ctx, og, copied.ID); e != nil || value.Visible {
		t.Fatalf("copy lost setting: %+v %v", value, e)
	}
	if value, e := st.SetReferenceVisibilityGuarded(ctx, eg, doc.ID, true, 1); e != nil || !value.Visible || value.Revision != 2 {
		t.Fatalf("show: %+v %v", value, e)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, e := st.SetReferenceVisibilityGuarded(ctx, eg, doc.ID, false, 2)
			results <- e
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for e := range results {
		if e == nil {
			successes++
		} else if errors.Is(e, store.ErrConflict) {
			conflicts++
		} else {
			t.Fatalf("race: %v", e)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("race counts %d %d", successes, conflicts)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, e := st.SetReferenceVisibilityGuarded(ctx, eg, doc.ID, true, 3); !errors.Is(e, store.ErrForbidden) {
		t.Fatalf("revoked: %v", e)
	}
	if err = st.DeleteSession(ctx, vg.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, e := st.ReferenceVisibilityGuarded(ctx, vg, doc.ID); !errors.Is(e, store.ErrUnauthenticated) {
		t.Fatalf("session: %v", e)
	}
}
func TestMemoryReferenceVisibility(t *testing.T) { checkReferenceVisibility(t, store.NewMemory()) }
func TestPostgresReferenceVisibility(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := pgx.Identifier{fmt.Sprintf("reference_visibility_%d", time.Now().UnixNano())}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
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
	if _, err = migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	checkReferenceVisibility(t, &store.Postgres{Pool: pool})
}
