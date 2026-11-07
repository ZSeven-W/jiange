package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func kanbanString(s string) *string { return &s }

func checkKanbanMove(t *testing.T, st Store) {
	t.Helper()
	ctx := context.Background()
	base, _, guard, view := baseGuardFixture(t, st)
	field, err := st.AddField(ctx, Field{BaseID: base.ID, Name: "状态", Type: "select", Options: []string{"待办", "进行中"}})
	if err != nil {
		t.Fatal(err)
	}
	rows, err := st.Records(ctx, base.ID)
	if err != nil || len(rows) < 3 {
		t.Fatalf("rows=%v err=%v", rows, err)
	}
	key := strconv.FormatInt(field.ID, 10)
	for i, value := range []string{"待办", "进行中", "进行中"} {
		raw, _ := json.Marshal(value)
		if rows[i], err = st.SetCells(ctx, base.ID, rows[i].ID, map[string]json.RawMessage{key: raw}); err != nil {
			t.Fatal(err)
		}
	}
	head, err := st.BtHead(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	move := KanbanMove{FieldID: field.ID, ExpectedHead: head, ExpectedGroup: kanbanString("待办"), ExpectedPosition: rows[0].Position, ExpectedOptions: []string{"待办", "进行中"}, TargetGroup: kanbanString("进行中"), Before: &KanbanAnchor{ID: rows[1].ID, Position: rows[1].Position}, After: &KanbanAnchor{ID: rows[2].ID, Position: rows[2].Position}}
	updated, changed, err := st.MoveKanbanCard(ctx, guard, base.ID, rows[0].ID, move)
	if err != nil || !changed || string(updated.Cells[key]) != `"进行中"` || updated.Position <= rows[1].Position || updated.Position >= rows[2].Position {
		t.Fatalf("move=%+v changed=%v err=%v", updated, changed, err)
	}
	newHead, err := st.BtHead(ctx, base.ID)
	if err != nil || newHead <= head {
		t.Fatalf("head=%d new=%d err=%v", head, newHead, err)
	}
	if _, _, err := st.MoveKanbanCard(ctx, guard, base.ID, rows[0].ID, move); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale move: %v", err)
	}
	if got, _ := st.BtHead(ctx, base.ID); got != newHead {
		t.Fatalf("conflict emitted event %d -> %d", newHead, got)
	}

	// A second client changing a neighbor without an event must also be caught.
	move.ExpectedHead = newHead
	move.ExpectedGroup = kanbanString("进行中")
	move.ExpectedPosition = updated.Position
	move.TargetGroup = kanbanString("待办")
	move.Before = nil
	move.After = &KanbanAnchor{ID: rows[1].ID, Position: rows[1].Position}
	if _, _, err := st.MoveKanbanCard(ctx, guard, base.ID, rows[0].ID, move); !errors.Is(err, ErrConflict) {
		t.Fatalf("neighbor moved groups: %v", err)
	}

	// Identical snapshot races must have exactly one winner.
	move.TargetGroup = kanbanString("进行中")
	move.Before = nil
	move.After = &KanbanAnchor{ID: rows[1].ID, Position: rows[1].Position}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, e := st.MoveKanbanCard(ctx, guard, base.ID, rows[0].ID, move)
			results <- e
		}()
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrConflict) {
			conflict++
		} else {
			t.Fatalf("race: %v", err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("success=%d conflict=%d", success, conflict)
	}

	view.Config = json.RawMessage(`{"locked":true}`)
	if _, err := st.UpdateView(ctx, view); err != nil {
		t.Fatal(err)
	}
	move.ExpectedHead, _ = st.BtHead(ctx, base.ID)
	if _, _, err := st.MoveKanbanCard(ctx, guard, base.ID, rows[0].ID, move); !errors.Is(err, ErrForbidden) {
		t.Fatalf("locked view: %v", err)
	}
	if err := st.DeleteSession(ctx, guard.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.MoveKanbanCard(ctx, guard, base.ID, rows[0].ID, move); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("session removed: %v", err)
	}
}

func TestMemoryKanbanMove(t *testing.T) { checkKanbanMove(t, NewMemory()) }

func TestPostgresKanbanMove(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_kanban_%d", time.Now().UnixNano())
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
	checkKanbanMove(t, &Postgres{Pool: pool})
}
