package store_test

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
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
	eve, _, _ := pg.CreateUser(ctx, "eve@x.com", "Eve", "h")
	d, _ := pg.CreateDoc(ctx, ws.ID, kay.ID, nil, "方案", nil)
	c, _ := pg.CreateDoc(ctx, ws.ID, kay.ID, &d.ID, "子页", nil)
	if err := pg.SetCopyProtected(ctx, d.ID, true); err != nil {
		t.Fatal(err)
	}
	if got, err := pg.GetDocSystem(ctx, d.ID); err != nil || !got.CopyProtected {
		t.Fatalf("system metadata lost copy protection: %+v %v", got, err)
	}
	member, _, _ := pg.CreateUser(ctx, "member@x.com", "Member", "h")
	if _, err := pg.Pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'member')`, ws.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	checkMemberExplicitGrant(t, pg, member.ID, d.ID, c.ID)
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
	if id, err := pg.JoinLink(ctx, "tok", eve.ID); err != nil || id != d.ID {
		t.Fatalf("join: %d %v", id, err)
	}
	if got, err := pg.GetDoc(ctx, eve.ID, c.ID); err != nil || got.Role != "view" {
		t.Fatalf("inherited link: %+v %v", got, err)
	}
	if sh, err := pg.SharedWithMe(ctx, eve.ID); err != nil || len(sh) != 1 || sh[0].Role != "view" {
		t.Fatalf("link shared list: %+v %v", sh, err)
	}
	if err := pg.SetLink(ctx, d.ID, store.Link{Role: "edit", Token: "tok"}); err != nil {
		t.Fatal(err)
	}
	if got, err := pg.GetDoc(ctx, eve.ID, c.ID); err != nil || got.Role != "edit" {
		t.Fatalf("upgraded link: %+v %v", got, err)
	}
	if err := pg.SetShare(ctx, d.ID, eve.ID, "view"); err != nil {
		t.Fatal(err)
	}
	if err := pg.SetLink(ctx, d.ID, store.Link{Role: "none", Token: "tok"}); err != nil {
		t.Fatal(err)
	}
	if got, err := pg.GetDoc(ctx, eve.ID, c.ID); err != nil || got.Role != "view" {
		t.Fatalf("direct invitation after close: %+v %v", got, err)
	}
	if err := pg.SetShare(ctx, d.ID, eve.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := pg.SetLink(ctx, d.ID, store.Link{Role: "edit", Token: "tok"}); err != nil {
		t.Fatal(err)
	}
	if _, err := pg.GetDoc(ctx, eve.ID, d.ID); err != store.ErrNotFound {
		t.Fatalf("old join must not return: %v", err)
	}
	if _, err := pg.JoinLink(ctx, "tok", eve.ID); err != nil {
		t.Fatal(err)
	}
	if err := pg.SetLink(ctx, d.ID, store.Link{Role: "view", Token: "new-token"}); err != nil {
		t.Fatal(err)
	}
	if _, err := pg.GetDoc(ctx, eve.ID, d.ID); err != store.ErrNotFound {
		t.Fatalf("rotated token retained grant: %v", err)
	}
	checkConcurrentLinkClose(t, pg, kay.ID, eve.ID, d.ID)
	checkConcurrentLinkRoleChanges(t, pg, d.ID)
	f, err := pg.CreateFile(ctx, store.FileMeta{DocID: d.ID, UploaderID: kay.ID, Name: "a.png", Mime: "image/png", Size: 3, ObjectKey: "k"})
	if g, err2 := pg.GetFile(ctx, f.ID); err != nil || err2 != nil || g.ObjectKey != "k" {
		t.Fatalf("file: %v %v", err, err2)
	}

	b, err := pg.CreateBase(ctx, ws.ID, kay.ID, nil, "需求池")
	if err != nil || b.Kind != "base" {
		t.Fatalf("base: %+v %v", b, err)
	}
	fd, _ := pg.AddField(ctx, store.Field{BaseID: b.ID, Name: "状态", Type: "select", Options: []string{"a"}})
	key := strconv.FormatInt(fd.ID, 10)
	rec, err := pg.AddRecord(ctx, store.Record{BaseID: b.ID, Cells: map[string]json.RawMessage{key: json.RawMessage(`"a"`), "x": json.RawMessage(`1`)}})
	if err != nil || rec.Position != 1 {
		t.Fatalf("record: %+v %v", rec, err)
	}
	if rec, err = pg.SetCells(ctx, b.ID, rec.ID, map[string]json.RawMessage{"x": nil}); err != nil || len(rec.Cells) != 1 {
		t.Fatalf("set: %+v %v", rec, err)
	}
	if err := pg.DeleteField(ctx, b.ID, fd.ID); err != nil {
		t.Fatal(err)
	}
	if rs, _ := pg.Records(ctx, b.ID); len(rs) != 1 || len(rs[0].Cells) != 0 {
		t.Fatalf("after field delete: %+v", rs)
	}
}

func TestPostgresLegacySharesRemainExplicitAfterMigration(t *testing.T) {
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
	if _, err := pg.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE TABLE schema_migrations (version int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	ms, err := migrate.List()
	if err != nil {
		t.Fatal(err)
	}
	for _, migration := range ms {
		if migration.Version >= 21 {
			continue
		}
		if _, err := pg.Pool.Exec(ctx, migration.SQL); err != nil {
			t.Fatalf("migration %s: %v", migration.Name, err)
		}
		if _, err := pg.Pool.Exec(ctx, `INSERT INTO schema_migrations (version,name) VALUES ($1,$2)`, migration.Version, migration.Name); err != nil {
			t.Fatal(err)
		}
	}
	owner, ws, err := pg.CreateUser(ctx, "legacy-owner@x.test", "Owner", "h")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := pg.CreateUser(ctx, "legacy-guest@x.test", "Guest", "h")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := pg.CreateDoc(ctx, ws.ID, owner.ID, nil, "legacy", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pg.Pool.Exec(ctx, `INSERT INTO doc_shares (doc_id,user_id,role) VALUES ($1,$2,'edit')`, doc.ID, guest.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	if got, err := pg.GetDoc(ctx, guest.ID, doc.ID); err != nil || got.Role != "edit" {
		t.Fatalf("legacy grant changed: %+v %v", got, err)
	}
	if err := pg.SetLink(ctx, doc.ID, store.Link{Role: "none", Token: ""}); err != nil {
		t.Fatal(err)
	}
	if got, err := pg.GetDoc(ctx, guest.ID, doc.ID); err != nil || got.Role != "edit" {
		t.Fatalf("closing link changed legacy grant: %+v %v", got, err)
	}
}
