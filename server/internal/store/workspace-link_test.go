package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type workspaceLinkStore interface {
	Store
	ChangeLinkRoleAtRevision(context.Context, RestoreGuard, int64, string, string, int64) (Link, error)
	JoinLinkGuarded(context.Context, RestoreGuard, string) (int64, error)
}

func checkWorkspaceLink(t *testing.T, st workspaceLinkStore, removeMember func(int64, int64), injectOldJoin func(int64, int64)) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "workspace-link-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	member, _, err := st.CreateUser(ctx, "workspace-link-member@test.dev", "Member", "hash")
	if err != nil {
		t.Fatal(err)
	}
	outsider, _, err := st.CreateUser(ctx, "workspace-link-outsider@test.dev", "Outsider", "hash")
	if err != nil {
		t.Fatal(err)
	}
	if err = st.AddWorkspaceMember(ctx, ws.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	og := RestoreGuard{UserID: owner.ID, SessionHash: []byte("workspace-link-owner")}
	mg := RestoreGuard{UserID: member.ID, SessionHash: []byte("workspace-link-member")}
	xg := RestoreGuard{UserID: outsider.ID, SessionHash: []byte("workspace-link-outsider")}
	for _, g := range []RestoreGuard{og, mg, xg} {
		if err = st.CreateSession(ctx, g.SessionHash, g.UserID, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	sharedDoc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Shared workspace document", nil)
	if err != nil {
		t.Fatal(err)
	}
	sharedLink, err := st.ChangeLinkRoleAtRevision(ctx, og, sharedDoc.ID, LinkWorkspaceView, "shared-workspace-link", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.JoinLinkGuarded(ctx, mg, sharedLink.Token); err != nil {
		t.Fatal(err)
	}
	if d, e := st.GetDoc(ctx, member.ID, sharedDoc.ID); e != nil || d.Role != RoleEdit {
		t.Fatalf("workspace baseline was downgraded: %+v %v", d, e)
	}
	node, err := st.CreateDriveNode(ctx, og, ws.ID, nil, "doc", "Private", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.GetDoc(ctx, member.ID, node.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("member has private access before joining: %v", err)
	}
	public, err := st.ChangeLinkRoleAtRevision(ctx, og, node.ID, RoleView, "signed-link", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.JoinLinkGuarded(ctx, xg, public.Token); err != nil {
		t.Fatalf("signed-in join: %v", err)
	}
	if d, e := st.GetDoc(ctx, outsider.ID, node.ID); e != nil || d.Role != RoleView {
		t.Fatalf("signed-in role: %+v %v", d, e)
	}
	scoped, err := st.ChangeLinkRoleAtRevision(ctx, og, node.ID, LinkWorkspaceView, "workspace-link", public.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if scoped.Token == public.Token || scoped.Revision != public.Revision+1 {
		t.Fatalf("scope change did not rotate: %+v", scoped)
	}
	if _, _, err = st.DocByToken(ctx, public.Token); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old token survived: %v", err)
	}
	if _, err = st.GetDoc(ctx, outsider.ID, node.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider retained link grant: %v", err)
	}
	if _, err = st.JoinLinkGuarded(ctx, xg, scoped.Token); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider joined workspace link: %v", err)
	}
	if _, err = st.JoinLink(ctx, scoped.Token, outsider.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("legacy outsider join: %v", err)
	}
	if err = st.SetShare(ctx, node.ID, outsider.ID, RoleEdit); err != nil {
		t.Fatal(err)
	}
	if _, err = st.JoinLinkGuarded(ctx, xg, scoped.Token); !errors.Is(err, ErrNotFound) {
		t.Fatalf("external invite bypassed workspace link: %v", err)
	}
	if d, e := st.GetDoc(ctx, outsider.ID, node.ID); e != nil || d.Role != RoleEdit {
		t.Fatalf("explicit grant changed: %+v %v", d, e)
	}
	if err = st.SetShare(ctx, node.ID, outsider.ID, ""); err != nil {
		t.Fatal(err)
	}
	calls := 0
	expired := mg
	expired.Now = func() time.Time {
		calls++
		if calls >= 2 {
			return time.Now().Add(2 * time.Hour)
		}
		return time.Now()
	}
	if _, err = st.JoinLinkGuarded(ctx, expired, scoped.Token); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expired join: %v", err)
	}
	if _, err = st.GetDoc(ctx, member.ID, node.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired join persisted access: %v", err)
	}
	if _, err = st.JoinLinkGuarded(ctx, mg, scoped.Token); err != nil {
		t.Fatalf("workspace join: %v", err)
	}
	if d, e := st.GetDoc(ctx, member.ID, node.ID); e != nil || d.Role != RoleView {
		t.Fatalf("member view: %+v %v", d, e)
	}
	shared, err := st.SharedWithMe(ctx, member.ID)
	if err != nil || len(shared) != 1 || shared[0].ID != node.ID {
		t.Fatalf("personal shared list: %+v %v", shared, err)
	}
	head, err := st.Head(ctx, node.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.AppendOpsAtHeadGuarded(ctx, mg, node.ID, head, nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer wrote: %v", err)
	}
	edit, err := st.ChangeLinkRoleAtRevision(ctx, og, node.ID, LinkWorkspaceEdit, "unused", scoped.Revision)
	if err != nil || edit.Token != scoped.Token {
		t.Fatalf("edit scope: %+v %v", edit, err)
	}
	if d, e := st.GetDoc(ctx, member.ID, node.ID); e != nil || d.Role != RoleEdit {
		t.Fatalf("member edit: %+v %v", d, e)
	}
	if _, err = st.AppendOpsAtHeadGuarded(ctx, mg, node.ID, head, nil); err != nil {
		t.Fatalf("member edit denied: %v", err)
	}
	removeMember(ws.ID, member.ID)
	if _, err = st.GetDoc(ctx, member.ID, node.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removed member retained access: %v", err)
	}
	if _, err = st.JoinLinkGuarded(ctx, mg, edit.Token); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removed member rejoined: %v", err)
	}
	shared, err = st.SharedWithMe(ctx, member.ID)
	if err != nil || len(shared) != 0 {
		t.Fatalf("removed member sees shared list: %+v %v", shared, err)
	}
	if err = st.SetLink(ctx, node.ID, Link{Role: RoleView, Token: edit.Token}); err == nil {
		t.Fatal("scope transition with unchanged token succeeded")
	}
	// A join inserted by an old binary during workspace-only sharing must not
	// become an effective grant, either now or after broadening the scope.
	injectOldJoin(node.ID, outsider.ID)
	if _, err = st.GetDoc(ctx, outsider.ID, node.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old server join bypassed workspace scope: %v", err)
	}
	broad, err := st.ChangeLinkRoleAtRevision(ctx, og, node.ID, RoleView, "new-signed-link", edit.Revision)
	if err != nil || broad.Token == edit.Token {
		t.Fatalf("broad scope rotation: %+v %v", broad, err)
	}
	if _, err = st.GetDoc(ctx, outsider.ID, node.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old join regained access: %v", err)
	}
	if _, err = st.JoinLinkGuarded(ctx, xg, broad.Token); err != nil {
		t.Fatalf("new signed-in link: %v", err)
	}
	if err = st.DeleteSession(ctx, xg.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = st.JoinLinkGuarded(ctx, xg, broad.Token); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expired session joined: %v", err)
	}
	// An inherited workspace link remains bounded by membership as well.
	if err = st.AddWorkspaceMember(ctx, ws.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	folder, err := st.CreateDriveFolder(ctx, og, ws.ID, nil, "Private folder", true)
	if err != nil {
		t.Fatal(err)
	}
	child, err := st.CreateDriveNode(ctx, og, ws.ID, &folder.ID, "doc", "Child", true)
	if err != nil {
		t.Fatal(err)
	}
	parentLink, err := st.ChangeLinkRoleAtRevision(ctx, og, folder.ID, LinkWorkspaceView, "parent-workspace-link", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.JoinLinkGuarded(ctx, mg, parentLink.Token); err != nil {
		t.Fatal(err)
	}
	if d, e := st.GetDoc(ctx, member.ID, child.ID); e != nil || d.Role != RoleView {
		t.Fatalf("inherited workspace grant: %+v %v", d, e)
	}
	removeMember(ws.ID, member.ID)
	if _, err = st.GetDoc(ctx, member.ID, child.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removed member retained inherited access: %v", err)
	}
}

func TestMemoryWorkspaceLink(t *testing.T) {
	m := NewMemory()
	checkWorkspaceLink(t, m, func(ws, uid int64) {
		m.mu.Lock()
		defer m.mu.Unlock()
		ids := m.members[uid]
		for i, id := range ids {
			if id == ws {
				m.members[uid] = append(ids[:i], ids[i+1:]...)
				break
			}
		}
	}, func(doc, uid int64) {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.sh.joins == nil {
			m.sh.joins = map[int64]map[int64]bool{}
		}
		if m.sh.joins[doc] == nil {
			m.sh.joins[doc] = map[int64]bool{}
		}
		m.sh.joins[doc][uid] = true
	})
}
func TestPostgresWorkspaceLink(t *testing.T) {
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
	schema := pgx.Identifier{fmt.Sprintf("workspace_link_%d", time.Now().UnixNano())}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE")
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
	checkWorkspaceLink(t, &Postgres{Pool: pool}, func(ws, uid int64) {
		if _, e := pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, ws, uid); e != nil {
			t.Fatal(e)
		}
	}, func(doc, uid int64) {
		if _, e := pool.Exec(ctx, `INSERT INTO doc_link_joins(doc_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, doc, uid); e != nil {
			t.Fatal(e)
		}
	})
}

func TestPostgresWorkspaceLinkJoinRacesMembershipRemoval(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	schema := pgx.Identifier{"workspace_link_race_" + suffix}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	app := "workspace-link-race-" + suffix
	cfg.ConnConfig.RuntimeParams["application_name"] = app
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	st := &Postgres{Pool: pool}
	owner, ws, err := st.CreateUser(ctx, "race-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	member, _, err := st.CreateUser(ctx, "race-member@test.dev", "Member", "hash")
	if err != nil {
		t.Fatal(err)
	}
	if err = st.AddWorkspaceMember(ctx, ws.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	og := RestoreGuard{UserID: owner.ID, SessionHash: []byte("race-owner")}
	mg := RestoreGuard{UserID: member.ID, SessionHash: []byte("race-member")}
	for _, g := range []RestoreGuard{og, mg} {
		if err = st.CreateSession(ctx, g.SessionHash, g.UserID, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	node, err := st.CreateDriveNode(ctx, og, ws.ID, nil, "doc", "Private", true)
	if err != nil {
		t.Fatal(err)
	}
	link, err := st.ChangeLinkRoleAtRevision(ctx, og, node.ID, LinkWorkspaceView, "race-token", 0)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	var id int64
	if err = tx.QueryRow(ctx, `SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE`, ws.ID, member.ID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() { _, e := st.JoinLinkGuarded(ctx, mg, link.Token); result <- e }()
	blocked := false
	for i := 0; i < 100; i++ {
		var count int
		err = admin.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%SELECT user_id FROM workspace_members%'`, app).Scan(&count)
		if err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			blocked = true
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(25 * time.Millisecond):
		}
	}
	if !blocked {
		t.Fatal("join did not reach the locked membership row")
	}
	if _, err = tx.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, ws.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-result; !errors.Is(err, ErrNotFound) {
		t.Fatalf("join after membership removal: %v", err)
	}
	if _, err = st.GetDoc(ctx, member.ID, node.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removed member obtained access: %v", err)
	}
}
