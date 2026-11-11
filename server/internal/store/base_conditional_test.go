package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type conditionalStore interface {
	Store
	CreateSession(ctx context.Context, hash []byte, userID int64, expires time.Time) error
}

func checkConditionalRecordWrites(t *testing.T, s conditionalStore) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := s.CreateUser(ctx, fmt.Sprintf("cond-%d@example.test", time.Now().UnixNano()), "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := s.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Undo")
	if err != nil {
		t.Fatal(err)
	}
	guard := BaseWriteGuard{UserID: owner.ID, SessionHash: []byte(fmt.Sprintf("cond-session-%d", owner.ID))}
	if err := s.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	fields, err := s.Fields(ctx, base.ID)
	if err != nil || len(fields) == 0 {
		t.Fatalf("fields=%v err=%v", fields, err)
	}
	key := strconv.FormatInt(fields[0].ID, 10)
	ok := func([]Field) error { return nil }
	raw := func(v string) json.RawMessage { return json.RawMessage(v) }
	rec, _, err := s.MutateRecordGuarded(ctx, guard, base.ID, BaseRecordMutation{Operation: "add", Cells: map[string]json.RawMessage{key: raw(`"a"`)}}, ok)
	if err != nil {
		t.Fatal(err)
	}
	update := func(expected, next string) error {
		_, _, err := s.MutateRecordGuarded(ctx, guard, base.ID, BaseRecordMutation{Operation: "update", RecordID: rec.ID, Expected: map[string]json.RawMessage{key: raw(expected)}, Cells: map[string]json.RawMessage{key: raw(next)}}, ok)
		return err
	}
	if err := update(`"a"`, `"b"`); err != nil {
		t.Fatalf("matching update: %v", err)
	}
	if err := update(`"a"`, `"c"`); !errors.Is(err, ErrExpectedCells) {
		t.Fatalf("stale update: %v", err)
	}
	if err := update(`"b"`, `null`); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if err := update(`null`, `"d"`); err != nil {
		t.Fatalf("expected empty: %v", err)
	}
	// Expected keys outside the written cells are rejected before any lookup.
	if _, _, err := s.MutateRecordGuarded(ctx, guard, base.ID, BaseRecordMutation{Operation: "update", RecordID: rec.ID, Expected: map[string]json.RawMessage{"999999": raw(`1`)}, Cells: map[string]json.RawMessage{key: raw(`"e"`)}}, ok); !errors.Is(err, ErrInvalidBaseRecord) {
		t.Fatalf("probe: %v", err)
	}
	del := func(expected map[string]json.RawMessage) error {
		_, _, err := s.MutateRecordGuarded(ctx, guard, base.ID, BaseRecordMutation{Operation: "delete", RecordID: rec.ID, Expected: expected, ExpectExact: true}, ok)
		return err
	}
	if err := del(map[string]json.RawMessage{}); !errors.Is(err, ErrExpectedCells) {
		t.Fatalf("exact delete with content: %v", err)
	}
	if err := del(map[string]json.RawMessage{key: raw(`"d"`)}); err != nil {
		t.Fatalf("exact delete: %v", err)
	}
}

func TestMemoryConditionalRecordWrites(t *testing.T) { checkConditionalRecordWrites(t, NewMemory()) }

func TestPostgresConditionalRecordWrites(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_cond_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
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
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	checkConditionalRecordWrites(t, &Postgres{Pool: pool})
}
