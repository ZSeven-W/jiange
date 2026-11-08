package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func checkSlidesImageStore(t *testing.T, st Store) {
	t.Helper()
	ctx := context.Background()
	u, ws, err := st.CreateUser(ctx, "slide-image-store@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := RestoreGuard{UserID: u.ID, SessionHash: []byte("slide-image-test")}
	if err = st.CreateSession(ctx, g.SessionHash, u.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	d, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "deck", true)
	if err != nil {
		t.Fatal(err)
	}
	other, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "other", true)
	if err != nil {
		t.Fatal(err)
	}
	image, err := st.CreateSlidesFile(ctx, g, d.ID, FileMeta{Name: "a.png", Mime: "image/png", Size: 1, ObjectKey: "test-a"})
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := st.CreateSlidesFile(ctx, g, other.ID, FileMeta{Name: "b.png", Mime: "image/png", Size: 1, ObjectKey: "test-b"})
	if err != nil {
		t.Fatal(err)
	}
	pages, err := st.ListSlidesPages(ctx, u.ID, d.ID)
	if err != nil || len(pages) != 1 {
		t.Fatalf("pages: %v %v", pages, err)
	}
	shape := func(id int64) json.RawMessage {
		return json.RawMessage(fmt.Sprintf(`[{"id":"image","kind":"image","fileId":%d}]`, id))
	}
	bad := shape(foreign.ID)
	if _, err = st.UpdateSlidesPage(ctx, g, pages[0].ID, "", "", "", nil, &bad, 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("foreign image: %v", err)
	}
	valid := shape(image.ID)
	if _, err = st.UpdateSlidesPage(ctx, g, pages[0].ID, "", "", "", nil, &valid, 1); err != nil {
		t.Fatal(err)
	}
	if _, _, err = st.DeleteFile(ctx, image.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("referenced image deleted: %v", err)
	}
	if err = st.DeleteSession(ctx, g.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CreateSlidesFile(ctx, g, d.ID, FileMeta{Name: "late.png", Mime: "image/png", ObjectKey: "late"}); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("revoked upload: %v", err)
	}
}

func TestMemorySlidesImageStore(t *testing.T) { checkSlidesImageStore(t, NewMemory()) }

func TestPostgresSlidesImageStore(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_slide_image_%d", time.Now().UnixNano())
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
	checkSlidesImageStore(t, &Postgres{Pool: pool})
}
