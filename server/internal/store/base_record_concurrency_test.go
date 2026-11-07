package store

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// A slow scalar write to one Base should not stop an unrelated Base from
// saving its own scalar value. The trigger pauses only the first write after
// its transaction has acquired the locks, making the overlap deterministic.
func TestPostgresIndependentScalarWritesOverlap(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_scalar_overlap_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
		admin.Close()
	}()
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
	s := &Postgres{Pool: pool}
	owner, ws, err := s.CreateUser(ctx, "scalar-overlap@example.test", "Owner", "")
	if err != nil {
		t.Fatal(err)
	}
	guard := BaseWriteGuard{UserID: owner.ID, SessionHash: []byte("scalar-overlap-test")}
	if err = s.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	type sample struct {
		base, record int64
		field        string
	}
	var samples [2]sample
	for i := range samples {
		base, e := s.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, fmt.Sprintf("base-%d", i))
		if e != nil {
			t.Fatal(e)
		}
		fields, e := s.Fields(ctx, base.ID)
		if e != nil || len(fields) == 0 {
			t.Fatalf("fields=%v err=%v", fields, e)
		}
		records, e := s.Records(ctx, base.ID)
		if e != nil || len(records) == 0 {
			t.Fatalf("records=%v err=%v", records, e)
		}
		samples[i] = sample{base.ID, records[0].ID, strconv.FormatInt(fields[0].ID, 10)}
	}
	const lockKey int64 = 590123472391
	if _, err = pool.Exec(ctx, fmt.Sprintf(`CREATE FUNCTION pause_scalar_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.base_id=%d THEN PERFORM pg_advisory_xact_lock(%d); END IF; RETURN NEW; END $$`, samples[0].base, lockKey)); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `CREATE TRIGGER pause_scalar_write BEFORE UPDATE ON base_records FOR EACH ROW EXECUTE FUNCTION pause_scalar_write()`); err != nil {
		t.Fatal(err)
	}
	holder, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Release()
	if _, err = holder.Exec(ctx, `SELECT pg_advisory_lock($1)`, lockKey); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = holder.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, lockKey) }()
	firstDone := make(chan error, 1)
	go func() {
		_, _, err := s.MutateRecordGuarded(ctx, guard, samples[0].base, BaseRecordMutation{Operation: "update", RecordID: samples[0].record, Cells: map[string]json.RawMessage{samples[0].field: json.RawMessage(`"first"`)}}, func([]Field) error { return nil })
		firstDone <- err
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=$1::oid AND objid=$2::oid)`, int64(uint64(lockKey)>>32), int64(uint64(lockKey)&0xffffffff)).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("first write did not reach the pause")
		}
		time.Sleep(10 * time.Millisecond)
	}
	secondCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	start := time.Now()
	_, _, secondErr := s.MutateRecordGuarded(secondCtx, guard, samples[1].base, BaseRecordMutation{Operation: "update", RecordID: samples[1].record, Cells: map[string]json.RawMessage{samples[1].field: json.RawMessage(`"second"`)}}, func([]Field) error { return nil })
	cancel()
	t.Logf("unrelated scalar write while first is paused: %s", time.Since(start))
	// Legacy schema edits do not take the Base lock. They must nevertheless
	// wait until the paused scalar transaction has finished validating/writing.
	schemaDone := make(chan error, 1)
	go func() {
		_, err := pool.Exec(ctx, `UPDATE base_fields SET description='changed' WHERE base_id=$1`, samples[1].base)
		schemaDone <- err
	}()
	select {
	case err := <-schemaDone:
		t.Fatalf("schema edit ran while scalar write held its schema snapshot: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	if _, err := holder.Exec(ctx, `SELECT pg_advisory_unlock($1)`, lockKey); err != nil {
		t.Fatal(err)
	}
	if err := <-firstDone; err != nil {
		t.Fatalf("first write: %v", err)
	}
	if err := <-schemaDone; err != nil {
		t.Fatalf("schema edit after scalar write: %v", err)
	}
	if secondErr != nil {
		t.Fatalf("unrelated scalar write blocked: %v", secondErr)
	}
}
