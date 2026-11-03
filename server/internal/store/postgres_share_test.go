package store_test

import (
	"context"
	"os"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestPostgresShares(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pg, err := store.NewPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	pg.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`)
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	kay, ws, _ := pg.CreateUser(ctx, "kay@x.com", "Kay", "h")
	bob, _, _ := pg.CreateUser(ctx, "bob@x.com", "Bob", "h")
	d, _ := pg.CreateDoc(ctx, ws.ID, kay.ID, nil, "方案", nil)
	c, _ := pg.CreateDoc(ctx, ws.ID, kay.ID, &d.ID, "子页", nil)
	if got, err := pg.GetDoc(ctx, kay.ID, c.ID); err != nil || got.Role != "manage" {
		t.Fatalf("owner role: %+v %v", got, err)
	}
	if _, err := pg.GetDoc(ctx, bob.ID, c.ID); err != store.ErrNotFound {
		t.Fatalf("outsider: %v", err)
	}
	pg.SetShare(ctx, d.ID, bob.ID, "view")
	pg.SetShare(ctx, c.ID, bob.ID, "edit")
	if got, err := pg.GetDoc(ctx, bob.ID, c.ID); err != nil || got.Role != "edit" {
		t.Fatalf("inherited max: %+v %v", got, err)
	}
	if got, _ := pg.GetDoc(ctx, bob.ID, d.ID); got.Role != "view" {
		t.Fatalf("parent: %+v", got)
	}
	if sh, _ := pg.SharedWithMe(ctx, bob.ID); len(sh) != 2 {
		t.Fatalf("shared: %+v", sh)
	}
	pg.SetLink(ctx, d.ID, store.Link{Role: "view", Token: "tok"})
	if id, r, err := pg.DocByToken(ctx, "tok"); err != nil || id != d.ID || r != "view" {
		t.Fatalf("token: %d %s %v", id, r, err)
	}
	f, err := pg.CreateFile(ctx, store.FileMeta{DocID: d.ID, UploaderID: kay.ID, Name: "a.png", Mime: "image/png", Size: 3, ObjectKey: "k"})
	if g, err2 := pg.GetFile(ctx, f.ID); err != nil || err2 != nil || g.ObjectKey != "k" {
		t.Fatalf("file: %v %v", err, err2)
	}
}
