package store_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresOperationIndexUpgrade(t *testing.T) {
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
	schema := pgx.Identifier{fmt.Sprintf("jiange_range_%d", time.Now().UnixNano())}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
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
	migrations, err := migrate.List()
	if err != nil {
		t.Fatal(err)
	}
	var indexMigration string
	for _, m := range migrations {
		if m.Version == 28 {
			indexMigration = m.SQL
			continue
		}
		if m.Version < 28 {
			if _, err := pool.Exec(ctx, m.SQL); err != nil {
				t.Fatalf("migration %s: %v", m.Name, err)
			}
		}
	}
	if indexMigration == "" {
		t.Fatal("missing range migration")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,name,password_hash) VALUES (1,'a@example.test','A','x');
      INSERT INTO workspaces(id,name,owner_id) VALUES(1,'workspace',1);
      INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(1,1,'owner');
	  INSERT INTO nodes(id,workspace_id,kind,sort_key,title,creator_id) VALUES(1,1,'doc','V','old',1),(2,1,'doc','V','damaged',1),(4,1,'doc','V','retry',1),(5,1,'doc','V','concurrent',1);
	  INSERT INTO doc_heads(doc_id,seq) VALUES(1,2),(2,2),(4,2),(5,2)`); err != nil {
		t.Fatal(err)
	}
	raw := func(clock uint64, text string) store.RawOp {
		op := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 12, Clock: clock}, Block: collab.OpID{Client: 1, Clock: 1}, Parent: collab.Root, Side: 1, Text: text}
		b, e := collab.EncodeOps([]collab.Op{op})
		if e != nil {
			t.Fatal(e)
		}
		return store.RawOp{ClientID: 12, Clock: int64(clock), Bytes: b}
	}
	for _, entry := range []struct {
		doc, seq int64
		op       store.RawOp
	}{
		{1, 1, raw(1, "😀文")}, {1, 2, raw(4, "a")},
		{2, 1, raw(1, "abcd")}, {2, 2, raw(3, "x")},
		{4, 1, raw(1, "a")}, {4, 2, raw(3, "b")},
		{5, 1, raw(1, "a")}, {5, 2, raw(3, "b")},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO doc_ops(doc_id,seq,client_id,clock,op) VALUES ($1,$2,$3,$4,$5)`, entry.doc, entry.seq, entry.op.ClientID, entry.op.Clock, entry.op.Bytes); err != nil {
			t.Fatal(err)
		}
	}
	perfCount, _ := strconv.Atoi(os.Getenv("JIANGE_TEST_INDEX_PERF"))
	if perfCount > 0 {
		if _, err := pool.Exec(ctx, `INSERT INTO nodes(id,workspace_id,kind,sort_key,title,creator_id) VALUES(3,1,'doc','V','history',1)`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO doc_heads(doc_id,seq) VALUES(3,$1)`, perfCount); err != nil {
			t.Fatal(err)
		}
		_, err := pool.CopyFrom(ctx, pgx.Identifier{"doc_ops"}, []string{"doc_id", "seq", "client_id", "clock", "op"}, pgx.CopyFromSlice(perfCount, func(i int) ([]any, error) {
			op := raw(uint64(i*2+1), "文")
			return []any{int64(3), int64(i + 1), op.ClientID, op.Clock, op.Bytes}, nil
		}))
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, indexMigration); err != nil {
		t.Fatalf("index migration: %v", err)
	}
	s := &store.Postgres{Pool: pool}
	if perfCount > 0 {
		start := time.Now()
		if _, err := s.AppendOps(ctx, 3, []store.RawOp{raw(uint64(perfCount*2+1), "新")}); err != nil {
			t.Fatalf("large history backfill: %v", err)
		}
		t.Logf("%d-history first write and backfill: %s", perfCount, time.Since(start))
		start = time.Now()
		for i := 0; i < 200; i++ {
			if _, err := s.AppendOps(ctx, 3, []store.RawOp{raw(uint64(perfCount*2+3+i*2), "新")}); err != nil {
				t.Fatalf("steady indexed write %d: %v", i, err)
			}
		}
		t.Logf("200 sequential indexed writes: %s", time.Since(start))
	}
	if result, err := s.AppendOps(ctx, 1, []store.RawOp{raw(1, "😀文"), raw(6, "新")}); err != nil || len(result) != 2 || result[0] != 0 || result[1] != 3 {
		t.Fatalf("indexed retry/append %v %v", result, err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM doc_op_ranges WHERE doc_id=1`).Scan(&count); err != nil || count != 3 {
		t.Fatalf("backfill count %d: %v", count, err)
	}
	if _, err := s.AppendOps(ctx, 1, []store.RawOp{raw(2, "重")}); !errors.Is(err, store.ErrOpIdentityConflict) {
		t.Fatalf("overlap accepted: %v", err)
	}
	if _, err := s.AppendOps(ctx, 2, []store.RawOp{raw(10, "new")}); !errors.Is(err, store.ErrOpIdentityConflict) {
		t.Fatalf("damaged history accepted: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM doc_op_ranges WHERE doc_id=2`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("damaged history changed: %d %v", count, err)
	}
	// A failed backfill must leave no partial ranges or ready marker, and an
	// ordinary retry must be able to index the original history afterwards.
	if _, err := pool.Exec(ctx, `CREATE FUNCTION fail_range_backfill() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.doc_id=4 AND NEW.seq=2 THEN RAISE EXCEPTION 'simulated backfill failure'; END IF; RETURN NEW; END $$;
	CREATE TRIGGER fail_range_backfill BEFORE INSERT ON doc_op_ranges FOR EACH ROW EXECUTE FUNCTION fail_range_backfill()`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendOps(ctx, 4, []store.RawOp{raw(10, "new")}); err == nil {
		t.Fatal("simulated backfill error was ignored")
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM doc_op_ranges WHERE doc_id=4`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial failed backfill: %d %v", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM doc_op_range_clients WHERE doc_id=4`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed backfill marked ready: %d %v", count, err)
	}
	if _, err := pool.Exec(ctx, `DROP TRIGGER fail_range_backfill ON doc_op_ranges; DROP FUNCTION fail_range_backfill()`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendOps(ctx, 4, []store.RawOp{raw(10, "new")}); err != nil {
		t.Fatalf("retry after failed backfill: %v", err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, clock := range []uint64{10, 12} {
		op := raw(clock, "x")
		go func() { <-start; _, err := s.AppendOps(ctx, 5, []store.RawOp{op}); results <- err }()
	}
	close(start)
	for range 2 {
		if err := <-results; err != nil {
			t.Fatalf("concurrent initial backfill: %v", err)
		}
	}
	if head, err := s.Head(ctx, 5); err != nil || head != 4 {
		t.Fatalf("concurrent backfill head %d: %v", head, err)
	}
	// An older server inserts doc_ops without a corresponding range. Its
	// transaction must fail and leave both the head and log untouched.
	err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE doc_heads SET seq=seq+1 WHERE doc_id=1`); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO doc_ops(doc_id,seq,client_id,clock,op) VALUES(1,4,12,8,$1)`, raw(8, "old writer").Bytes)
		return err
	})
	if err == nil {
		t.Fatal("old writer committed without range")
	}
	if head, err := s.Head(ctx, 1); err != nil || head != 3 {
		t.Fatalf("old writer changed head %d %v", head, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM nodes WHERE id=1`); err != nil {
		t.Fatalf("delete cascades: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM doc_op_ranges WHERE doc_id=1`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("ranges not deleted: %d %v", count, err)
	}
}
