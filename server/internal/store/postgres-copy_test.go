package store_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresCopyDocAtomic(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_copy_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
		admin.Close()
	}()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.ConnConfig.RuntimeParams["application_name"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	s := &store.Postgres{Pool: pool}
	owner, ownerWS, err := s.CreateUser(ctx, "owner-copy@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, guestWS, err := s.CreateUser(ctx, "guest-copy@example.test", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.CreateDoc(ctx, ownerWS.ID, owner.ID, nil, "源", nil)
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.CreateFile(ctx, store.FileMeta{DocID: source.ID, UploaderID: owner.ID, Name: "a.png", Mime: "image/png", Size: 4, ObjectKey: "objects/a"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetShare(ctx, source.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	base, err := s.CreateBase(ctx, ownerWS.ID, owner.ID, nil, "多维表格")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetShare(ctx, base.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	baseReq := store.DocCopy{SourceID: base.ID, UserID: guest.ID, WorkspaceID: guestWS.ID, Title: "副本"}
	if _, err := s.CopyDoc(ctx, baseReq, func(map[int64]int64) ([]store.RawOp, error) { return nil, nil }); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("base copy must be rejected: %v", err)
	}
	baseReq.UserID = owner.ID + guest.ID + 100
	if _, err := s.CopyDoc(ctx, baseReq, func(map[int64]int64) ([]store.RawOp, error) { return nil, nil }); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("source type must not be disclosed to outsider: %v", err)
	}
	req := store.DocCopy{SourceID: source.ID, UserID: guest.ID, WorkspaceID: guestWS.ID, Title: "副本", FileIDs: []int64{file.ID, file.ID}}
	build := func(ids map[int64]int64) ([]store.RawOp, error) {
		if len(ids) != 1 || ids[file.ID] == file.ID || ids[file.ID] == 0 {
			t.Fatalf("mapping=%v", ids)
		}
		return []store.RawOp{{ClientID: 0, Clock: 1, Bytes: []byte{1}}}, nil
	}
	clone, err := s.CopyDoc(ctx, req, build)
	if err != nil || clone.WorkspaceID != guestWS.ID || clone.CreatorID != guest.ID {
		t.Fatalf("copy=%+v err=%v", clone, err)
	}
	var copiedID int64
	var key string
	if err := pool.QueryRow(ctx, `SELECT id, object_key FROM attachments WHERE doc_id=$1`, clone.ID).Scan(&copiedID, &key); err != nil || copiedID == file.ID || key != file.ObjectKey {
		t.Fatalf("attachment=%d %q err=%v", copiedID, key, err)
	}
	if head, err := s.Head(ctx, clone.ID); err != nil || head != 1 {
		t.Fatalf("head=%d err=%v", head, err)
	}
	unauthorized := req
	unauthorized.WorkspaceID = ownerWS.ID
	if _, err := s.CopyDoc(ctx, unauthorized, build); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("foreign workspace: %v", err)
	}
	wrongParent := req
	wrongParent.ParentID = &source.ID
	if _, err := s.CopyDoc(ctx, wrongParent, build); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("parent from another workspace: %v", err)
	}
	if err := s.SetShare(ctx, source.ID, guest.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CopyDoc(ctx, req, build); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoked source access: %v", err)
	}
	if err := s.SetShare(ctx, source.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if err := s.SetCopyProtected(ctx, source.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CopyDoc(ctx, req, build); !errors.Is(err, store.ErrCopyProtected) {
		t.Fatalf("protected: %v", err)
	}
	if err := s.SetCopyProtected(ctx, source.ID, false); err != nil {
		t.Fatal(err)
	}
	beforeNodes, beforeFiles := 0, 0
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM nodes`).Scan(&beforeNodes); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM attachments`).Scan(&beforeFiles); err != nil {
		t.Fatal(err)
	}
	want := errors.New("builder failure")
	if _, err := s.CopyDoc(ctx, req, func(map[int64]int64) ([]store.RawOp, error) { return nil, want }); !errors.Is(err, want) {
		t.Fatalf("builder: %v", err)
	}
	var nodes, files int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM nodes`).Scan(&nodes); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM attachments`).Scan(&files); err != nil {
		t.Fatal(err)
	}
	if nodes != beforeNodes || files != beforeFiles {
		t.Fatalf("partial copy: nodes=%d files=%d", nodes, files)
	}
	req.FileIDs = []int64{copiedID} // belongs to the clone, not source
	if _, err := s.CopyDoc(ctx, req, build); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("foreign attachment: %v", err)
	}

	for _, kind := range []string{"direct", "ancestor", "link", "member"} {
		t.Run("concurrent_revoke_"+kind, func(t *testing.T) {
			parent, err := s.CreateDoc(ctx, ownerWS.ID, owner.ID, nil, "父", nil)
			if err != nil {
				t.Fatal(err)
			}
			child, err := s.CreateDoc(ctx, ownerWS.ID, owner.ID, &parent.ID, "子", nil)
			if err != nil {
				t.Fatal(err)
			}
			var revoke func() error
			switch kind {
			case "direct":
				if err := s.SetShare(ctx, child.ID, guest.ID, store.RoleView); err != nil {
					t.Fatal(err)
				}
				revoke = func() error { return s.SetShare(ctx, child.ID, guest.ID, "") }
			case "ancestor":
				if err := s.SetShare(ctx, parent.ID, guest.ID, store.RoleView); err != nil {
					t.Fatal(err)
				}
				revoke = func() error { return s.SetShare(ctx, parent.ID, guest.ID, "") }
			case "link":
				token := fmt.Sprintf("copy-link-%d", child.ID)
				if err := s.SetLink(ctx, parent.ID, store.Link{Role: store.RoleView, Token: token}); err != nil {
					t.Fatal(err)
				}
				if _, err := s.JoinLink(ctx, token, guest.ID); err != nil {
					t.Fatal(err)
				}
				revoke = func() error { return s.SetLink(ctx, parent.ID, store.Link{Role: "none"}) }
			case "member":
				if _, err := pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'member')`, ownerWS.ID, guest.ID); err != nil {
					t.Fatal(err)
				}
				revoke = func() error {
					_, err := pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, ownerWS.ID, guest.ID)
					return err
				}
			}
			copyReq := store.DocCopy{SourceID: child.ID, UserID: guest.ID, WorkspaceID: guestWS.ID, Title: "并发副本"}
			entered, release := make(chan struct{}), make(chan struct{})
			copyDone := make(chan error, 1)
			go func() {
				_, err := s.CopyDoc(ctx, copyReq, func(map[int64]int64) ([]store.RawOp, error) { close(entered); <-release; return nil, nil })
				copyDone <- err
			}()
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("copy did not reach builder")
			}
			revokeStarted, revokeDone := make(chan struct{}), make(chan error, 1)
			go func() { close(revokeStarted); revokeDone <- revoke() }()
			<-revokeStarted
			// Observe PostgreSQL's lock wait, rather than merely assuming the
			// goroutine has reached its SQL statement after a delay.
			deadline := time.Now().Add(5 * time.Second)
			waiting := false
			for time.Now().Before(deadline) {
				select {
				case err := <-revokeDone:
					close(release)
					t.Fatalf("revocation completed before copy committed: %v", err)
				default:
				}
				if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND pid<>pg_backend_pid() AND wait_event_type='Lock')`, schema).Scan(&waiting); err != nil {
					close(release)
					t.Fatal(err)
				}
				if waiting {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if !waiting {
				close(release)
				t.Fatal("revocation never reached the PostgreSQL lock wait")
			}
			close(release)
			select {
			case err := <-copyDone:
				if err != nil {
					t.Fatalf("copy: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("copy did not finish")
			}
			select {
			case err := <-revokeDone:
				if err != nil {
					t.Fatalf("revoke: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("revoke did not finish")
			}
			if _, err := s.CopyDoc(ctx, copyReq, func(map[int64]int64) ([]store.RawOp, error) { return nil, nil }); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("copy after revocation: %v", err)
			}
		})
	}
}
