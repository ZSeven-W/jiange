package store_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
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

func checkViewManagement(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "view-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := st.CreateUser(ctx, "view-guest@example.test", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Views")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.BaseWriteGuard{UserID: owner.ID, SessionHash: []byte("view-owner-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	views, err := st.Views(ctx, b.ID)
	if err != nil || len(views) != 1 {
		t.Fatalf("defaults %v %v", views, err)
	}
	first := views[0]
	if err = st.DeleteViewGuarded(ctx, guard, b.ID, first.ID); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("last delete: %v", err)
	}
	if err = st.DeleteView(ctx, b.ID, first.ID); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("last low-level delete: %v", err)
	}
	invalid := first
	invalid.Config = json.RawMessage(`{"locked":true,"filters":{"conj":"and","rules":[{"f":999999,"op":"is","v":"x"}]}}`)
	if _, err = st.UpdateViewGuarded(ctx, guard, first, invalid); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("invalid locked schema: %v", err)
	}
	fields, err := st.Fields(ctx, b.ID)
	if err != nil || len(fields) != 1 {
		t.Fatalf("fields: %v, %v", fields, err)
	}
	configBytes, err := json.Marshal(map[string]any{"group": fields[0].ID})
	if err != nil {
		t.Fatal(err)
	}
	source, err := st.AddView(ctx, store.View{BaseID: b.ID, Name: "看板", Type: "kanban", Config: configBytes})
	if err != nil {
		t.Fatal(err)
	}
	last, err := st.AddView(ctx, store.View{BaseID: b.ID, Name: "日历", Type: "calendar"})
	if err != nil {
		t.Fatal(err)
	}
	dup, err := st.DuplicateView(ctx, guard, b.ID, source.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal(dup.Config, &config); err != nil || dup.Name != "看板 副本" || dup.Type != "kanban" || config["group"] != float64(fields[0].ID) {
		t.Fatalf("copy: %+v %v", dup, err)
	}
	views, err = st.Views(ctx, b.ID)
	if err != nil || len(views) != 4 || views[0].ID != first.ID || views[1].ID != source.ID || views[2].ID != dup.ID || views[3].ID != last.ID {
		t.Fatalf("copy order %+v %v", views, err)
	}
	current := []int64{first.ID, source.ID, dup.ID, last.ID}
	_, err = st.ReorderViews(ctx, guard, b.ID, []int64{first.ID, dup.ID}, []int64{first.ID, dup.ID})
	if !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale set: %v", err)
	}
	_, err = st.ReorderViews(ctx, guard, b.ID, current, []int64{first.ID, source.ID, dup.ID, dup.ID})
	if !errors.Is(err, store.ErrConflict) {
		t.Fatalf("duplicate id: %v", err)
	}
	order := []int64{last.ID, dup.ID, first.ID, source.ID}
	views, err = st.ReorderViews(ctx, guard, b.ID, current, order)
	if err != nil {
		t.Fatal(err)
	}
	for i, v := range views {
		if v.ID != order[i] || v.Pos != float64(i+1) {
			t.Fatalf("reorder %v", views)
		}
	}
	// A stale legacy PATCH must not restore the position or config captured
	// before a concurrent reorder. Only a fresh snapshot may be updated.
	stale := first
	stale.Name = "过期重命名"
	if _, err = st.UpdateViewGuarded(ctx, guard, first, stale); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale patch after reorder: %v", err)
	}
	currentFirst := views[2]
	renamed, err := st.RenameViewGuarded(ctx, guard, b.ID, first.ID, currentFirst.Name, "新的名称")
	if err != nil || renamed.Name != "新的名称" || renamed.Pos != currentFirst.Pos || renamed.Type != currentFirst.Type {
		t.Fatalf("rename overwrote other properties: %+v %v", renamed, err)
	}
	if _, err = st.RenameViewGuarded(ctx, guard, b.ID, first.ID, currentFirst.Name, "过期名称"); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale rename: %v", err)
	}
	outsider := store.BaseWriteGuard{UserID: guest.ID, SessionHash: []byte("view-guest-session")}
	if err = st.CreateSession(ctx, outsider.SessionHash, guest.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err = st.DuplicateView(ctx, outsider, b.ID, first.ID, ""); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("unshared copy: %v", err)
	}
	if _, err = st.ReorderViews(ctx, guard, b.ID, current, current); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("concurrent reorder: %v", err)
	}
	if _, err = st.ReorderViews(ctx, outsider, b.ID, order, order); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("unshared reorder: %v", err)
	}
	for _, v := range views[:2] {
		if err = st.DeleteViewGuarded(ctx, guard, b.ID, v.ID); err != nil {
			t.Fatal(err)
		}
	}
	remaining, err := st.Views(ctx, b.ID)
	if err != nil || len(remaining) != 2 {
		t.Fatalf("remaining %v %v", remaining, err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, v := range remaining {
		wg.Add(1)
		go func(id int64) { defer wg.Done(); results <- st.DeleteViewGuarded(ctx, guard, b.ID, id) }(v.ID)
	}
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, store.ErrConflict) {
			conflicts++
		} else {
			t.Fatalf("concurrent delete: %v", err)
		}
	}
	remaining, err = st.Views(ctx, b.ID)
	if err != nil || len(remaining) != 1 || successes != 1 || conflicts != 1 {
		t.Fatalf("after delete %v success=%d conflict=%d err=%v", remaining, successes, conflicts, err)
	}
	// Guarded type changes must fence a delayed revision-0 publication even
	// when no publication row existed before the first conversion.
	form, err := st.AddView(ctx, store.View{BaseID: b.ID, Type: "form", Name: "Form"})
	if err != nil {
		t.Fatal(err)
	}
	other := form
	other.Type = "grid"
	other, err = st.UpdateViewGuarded(ctx, guard, form, other)
	if err != nil {
		t.Fatal(err)
	}
	back := other
	back.Type = "form"
	if _, err = st.UpdateViewGuarded(ctx, guard, other, back); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("stale-form-publish"))
	if _, err = st.SetPublicFormToken(ctx, guard, b.ID, form.ID, 0, hash[:], formTestSnapshot(t, st, b.ID, form.ID)); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("guarded type conversion revived publication: %v", err)
	}
	if err = st.DeleteSession(ctx, guard.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = st.DuplicateView(ctx, guard, b.ID, remaining[0].ID, ""); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("revoked session: %v", err)
	}
}

func TestMemoryViewManagement(t *testing.T) { checkViewManagement(t, store.NewMemory()) }
func TestPostgresViewManagement(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_view_management_%d", time.Now().UnixNano())
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
	checkViewManagement(t, &store.Postgres{Pool: pool})
}
