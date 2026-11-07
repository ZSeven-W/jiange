package store_test

import (
	"bytes"
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

func checkTitleSnapshot(t *testing.T, s store.Store) {
	t.Helper()
	ctx := context.Background()
	u, w, err := s.CreateUser(ctx, "snapshot-test@example.test", "test", "hash")
	if err != nil {
		t.Fatal(err)
	}
	d, err := s.CreateDoc(ctx, w.ID, u.ID, nil, "目录", []store.RawOp{{ClientID: 1, Clock: 1, Bytes: []byte{1}}})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SaveSnapshot(ctx, d.ID, 5, []byte("future")); err != nil {
		t.Fatal(err)
	}
	if err = s.SaveSnapshot(ctx, d.ID, 1, bytes.Repeat([]byte("abc"), 500)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.AppendOps(ctx, d.ID, []store.RawOp{{ClientID: 1, Clock: 2, Bytes: []byte{2}}}); err != nil {
		t.Fatal(err)
	}
	got, err := s.ReadTitleSnapshot(ctx, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.DirectoryTitle != "目录" || got.Head != 2 || got.SnapshotSeq != 1 || !bytes.Equal(got.Snapshot, bytes.Repeat([]byte("abc"), 500)) || len(got.Ops) != 1 || got.Ops[0].Seq != 2 {
		t.Fatalf("bad snapshot: %+v", got)
	}
	got.Snapshot[0] = 'X'
	got.Ops[0].Bytes[0] = 9
	again, err := s.ReadTitleSnapshot(ctx, d.ID)
	if err != nil || again.Snapshot[0] != 'a' || again.Ops[0].Bytes[0] != 2 {
		t.Fatalf("snapshot aliased backing storage: %+v %v", again, err)
	}
	c, cancel := context.WithCancel(ctx)
	cancel()
	if _, err = s.ReadTitleSnapshot(c, d.ID); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := int64(3); i < 50; i++ {
			_, _ = s.AppendOps(ctx, d.ID, []store.RawOp{{ClientID: 1, Clock: i, Bytes: []byte{byte(i)}}})
		}
	}()
	for i := 0; i < 30; i++ {
		snap, e := s.ReadTitleSnapshot(ctx, d.ID)
		if e != nil {
			t.Fatal(e)
		}
		if snap.SnapshotSeq+int64(len(snap.Ops)) != snap.Head {
			t.Fatalf("inconsistent observation: %+v", snap)
		}
	}
	wg.Wait()
}
func TestMemoryTitleSnapshot(t *testing.T) { checkTitleSnapshot(t, store.NewMemory()) }
func TestPostgresTitleSnapshot(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_title_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
		admin.Close()
	}()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
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
	defer pool.Close()
	if _, err = migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	checkTitleSnapshot(t, &store.Postgres{Pool: pool})
	if _, err = pool.Exec(ctx, `DELETE FROM doc_ops WHERE doc_id=1 AND seq=6`); err != nil {
		t.Fatal(err)
	}
	if _, err = (&store.Postgres{Pool: pool}).ReadTitleSnapshot(ctx, 1); err == nil {
		t.Fatal("missing log sequence accepted")
	}
}
