package store_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func checkDocumentOperationIdentity(t *testing.T, s store.Store) {
	ctx := context.Background()
	u, ws, err := s.CreateUser(ctx, "ids@example.test", "User", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := s.CreateDoc(ctx, ws.ID, u.ID, nil, "Doc", nil)
	if err != nil {
		t.Fatal(err)
	}
	raw := func(clock uint64, text string) store.RawOp {
		op := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 2, Clock: clock}, Block: collab.OpID{Client: 1, Clock: 1}, Parent: collab.Root, Side: 1, Text: text}
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		return store.RawOp{ClientID: 2, Clock: int64(clock), Bytes: b}
	}
	first := raw(3, "😀中")
	if _, err := s.CreateDoc(ctx, ws.ID, u.ID, nil, "overlap", []store.RawOp{first, raw(4, "中")}); !errors.Is(err, store.ErrOpIdentityConflict) {
		t.Fatalf("initial operations with overlap accepted: %v", err)
	}
	if _, err := s.AppendOps(ctx, doc.ID, []store.RawOp{first}); err != nil {
		t.Fatal(err)
	}
	if seq, err := s.AppendOps(ctx, doc.ID, []store.RawOp{first}); err != nil || seq[0] != 0 {
		t.Fatalf("identical retry: %v %v", seq, err)
	}
	if _, err := s.AppendOps(ctx, doc.ID, []store.RawOp{raw(3, "不同")}); err == nil {
		t.Error("accepted same ID with different payload")
	}
	if _, err := s.AppendOps(ctx, doc.ID, []store.RawOp{raw(2, "甲乙")}); err == nil {
		t.Error("accepted partially overlapping clock range")
	}
	if head, _ := s.Head(ctx, doc.ID); head != 1 {
		t.Fatalf("conflicts changed head: %d", head)
	}
	if err := s.SaveSnapshot(ctx, doc.ID, 1, []byte("old snapshot")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendOps(ctx, doc.ID, []store.RawOp{raw(7, "新"), raw(2, "甲乙")}); !errors.Is(err, store.ErrOpIdentityConflict) {
		t.Fatalf("expected conflicting batch: %v", err)
	}
	if head, _ := s.Head(ctx, doc.ID); head != 1 {
		t.Fatalf("partial batch persisted: %d", head)
	}
	if _, err := s.AppendOps(ctx, doc.ID, []store.RawOp{raw(5, "界")}); err != nil {
		t.Fatalf("adjacent range rejected: %v", err)
	}
	results := make(chan error, 2)
	start := make(chan struct{})
	for _, text := range []string{"甲", "乙"} {
		op := raw(20, text)
		go func() { <-start; _, err := s.AppendOps(ctx, doc.ID, []store.RawOp{op}); results <- err }()
	}
	close(start)
	var successes, conflicts int
	for i := 0; i < 2; i++ {
		err := <-results
		if err == nil {
			successes++
		} else if errors.Is(err, store.ErrOpIdentityConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent conflicting writes: successes=%d conflicts=%d", successes, conflicts)
	}
	head, err := s.Head(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: u.ID, SessionHash: []byte("identity-session")}
	if err := s.CreateSession(ctx, guard.SessionHash, u.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendRestoreOps(ctx, guard, doc.ID, head, []store.RawOp{raw(30, "新"), raw(2, "甲乙")}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("expected conflicting restore: %v", err)
	}
	if got, _ := s.Head(ctx, doc.ID); got != head {
		t.Fatalf("partial restore persisted: %d -> %d", head, got)
	}
	if found, err := s.ExistingOpIDs(ctx, doc.ID, []store.RawOp{first, raw(40, "新")}); err != nil || len(found) != 2 || !found[0] || found[1] {
		t.Fatalf("identity lookup: %v %v", found, err)
	}
	if _, err := s.AppendOpsAtHead(ctx, doc.ID, head-1, []store.RawOp{raw(40, "新")}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale head was not fenced: %v", err)
	}
	if got, _ := s.Head(ctx, doc.ID); got != head {
		t.Fatalf("stale head changed log: %d -> %d", head, got)
	}
}

func TestMemoryDocumentOperationIdentity(t *testing.T) {
	checkDocumentOperationIdentity(t, store.NewMemory())
}

func TestPostgresDocumentOperationIdentity(t *testing.T) {
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
	schema := fmt.Sprintf("jiange_identity_%d", time.Now().UnixNano())
	name := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+name); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+name+" CASCADE") }()
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
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	checkDocumentOperationIdentity(t, &store.Postgres{Pool: pool})
}
