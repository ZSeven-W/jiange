package migrate_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Each test gets its own schema; it never clears a caller's tables.
func driveTestPool(t *testing.T) (*pgxpool.Pool, context.Context) {
	t.Helper()
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("drive_migration_%d", time.Now().UnixNano())
	ident := pgx.Identifier{schema}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+ident); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+ident+" CASCADE")
		admin.Close()
	})
	if _, err = migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool, ctx
}

func seedDriveNodes(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(ctx, `INSERT INTO users(id,email,name,password_hash) VALUES(1,'drive@example.test','Drive','x');
		INSERT INTO workspaces(id,name,owner_id) VALUES(1,'one',1),(2,'two',1);
		INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(1,1,'owner'),(2,1,'owner');
		INSERT INTO nodes(id,workspace_id,kind,sort_key,title,creator_id) VALUES(100,1,'doc','V','legacy',1),(101,1,'base','V','legacy base',1);
		INSERT INTO nodes(id,workspace_id,kind,sort_key,title,creator_id,drive_revision) VALUES(200,1,'folder','V','one',1,1),(300,2,'folder','V','two',1,1)`)
	if err != nil {
		t.Fatal(err)
	}
}

func TestDriveFolderMigrationFencesAndTrashBatches(t *testing.T) {
	pool, ctx := driveTestPool(t)
	seedDriveNodes(t, ctx, pool)
	assertRejected := func(label, sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err == nil {
			t.Fatalf("%s unexpectedly succeeded", label)
		}
	}
	assertRejected("old folder insert", `INSERT INTO nodes(id,workspace_id,kind,sort_key,title,creator_id) VALUES(201,1,'folder','V','old',1)`)
	assertRejected("legacy child insert", `INSERT INTO nodes(id,workspace_id,parent_id,kind,sort_key,title,creator_id) VALUES(202,1,200,'doc','V','old',1)`)
	assertRejected("folder below doc", `INSERT INTO nodes(id,workspace_id,parent_id,kind,sort_key,title,creator_id,drive_revision) VALUES(203,1,100,'folder','V','wrong',1,1)`)
	if _, err := pool.Exec(ctx, `INSERT INTO nodes(id,workspace_id,parent_id,kind,sort_key,title,creator_id,drive_revision) VALUES(204,1,200,'folder','V','child',1,1),(205,1,200,'doc','V','independent',1,1),(206,1,200,'doc','V','active',1,1)`); err != nil {
		t.Fatal(err)
	}
	assertRejected("legacy same parent", `UPDATE nodes SET parent_id=parent_id WHERE id=205`)
	assertRejected("legacy same title", `UPDATE nodes SET title=title WHERE id=200`)
	assertRejected("legacy same deletion", `UPDATE nodes SET deleted_at=deleted_at WHERE id=200`)
	assertRejected("cross workspace", `UPDATE nodes SET parent_id=300,drive_revision=drive_revision+1 WHERE id=200`)
	assertRejected("cycle", `UPDATE nodes SET parent_id=204,drive_revision=drive_revision+1 WHERE id=200`)
	assertRejected("wrong parent kind", `UPDATE nodes SET parent_id=100,drive_revision=drive_revision+1 WHERE id=200`)
	assertRejected("kind conversion", `UPDATE nodes SET kind='doc',drive_revision=drive_revision+1 WHERE id=200`)
	// Existing doc/base operations outside a folder retain their prior shape.
	if _, err := pool.Exec(ctx, `UPDATE nodes SET parent_id=100 WHERE id=101; UPDATE nodes SET title='renamed',deleted_at=now() WHERE id=101`); err != nil {
		t.Fatalf("legacy tree changed: %v", err)
	}
	// A separately trashed child belongs to a different batch and must not be
	// revived when the parent is trashed and restored later.
	if _, err := pool.Exec(ctx, `UPDATE nodes SET deleted_at=now(),trash_batch_id=11,drive_revision=drive_revision+1 WHERE id=205`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE nodes SET deleted_at=now(),trash_batch_id=12,drive_revision=drive_revision+1 WHERE id IN (200,204,206) AND deleted_at IS NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE nodes SET deleted_at=NULL,trash_batch_id=NULL,drive_revision=drive_revision+1 WHERE id IN (200,204,205,206) AND trash_batch_id=12`); err != nil {
		t.Fatal(err)
	}
	var kept, revived int
	if err := pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE id=205 AND deleted_at IS NOT NULL AND trash_batch_id=11), count(*) FILTER(WHERE id IN(200,204,206) AND deleted_at IS NULL) FROM nodes`).Scan(&kept, &revived); err != nil || kept != 1 || revived != 3 {
		t.Fatalf("restore batches: kept=%d revived=%d err=%v", kept, revived, err)
	}
}

func TestDriveWorkspaceLockSerializesOppositeMoves(t *testing.T) {
	pool, ctx := driveTestPool(t)
	seedDriveNodes(t, ctx, pool)
	if _, err := pool.Exec(ctx, `INSERT INTO nodes(id,workspace_id,kind,sort_key,title,creator_id,drive_revision) VALUES(201,1,'folder','V','sibling',1,1)`); err != nil {
		t.Fatal(err)
	}
	first, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Rollback(ctx)
	if _, err = first.Exec(ctx, `SELECT drive_lock_workspace(1)`); err != nil {
		t.Fatal(err)
	}
	if _, err = first.Exec(ctx, `UPDATE nodes SET parent_id=201,drive_revision=drive_revision+1 WHERE id=200`); err != nil {
		t.Fatal(err)
	}
	var acquired bool
	if err = pool.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended('jiange:drive:1',0))`).Scan(&acquired); err != nil || acquired {
		t.Fatalf("second workspace lock should be unavailable: acquired=%t err=%v", acquired, err)
	}
	secondResult := make(chan error, 1)
	go func() {
		tx, err := pool.Begin(ctx)
		if err != nil {
			secondResult <- err
			return
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, `SELECT drive_lock_workspace(1)`); err == nil {
			_, err = tx.Exec(ctx, `UPDATE nodes SET parent_id=200,drive_revision=drive_revision+1 WHERE id=201`)
		}
		if err == nil {
			err = tx.Commit(ctx)
		}
		secondResult <- err
	}()
	if err = first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-secondResult:
		if err == nil {
			t.Fatal("opposite move accepted a cycle")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("opposite move failed to finish")
	}
}
