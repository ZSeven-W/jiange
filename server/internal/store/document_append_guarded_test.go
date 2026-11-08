package store_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func checkGuardedAppend(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "append-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := st.CreateUser(ctx, "append-editor@test.dev", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Document", []store.RawOp{{ClientID: 1, Clock: 1, Bytes: []byte{1}}})
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("append-guard-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, editor.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	op := store.RawOp{ClientID: 2, Clock: 1, Bytes: []byte{2}}
	if seqs, err := st.AppendOpsAtHeadGuarded(ctx, guard, doc.ID, 1, []store.RawOp{op}); err != nil || len(seqs) != 1 || seqs[0] != 2 {
		t.Fatalf("valid append: %v %v", seqs, err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = st.AppendOpsAtHeadGuarded(ctx, guard, doc.ID, 2, []store.RawOp{op}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("revoked duplicate: %v", err)
	}
	if _, err = st.AppendOpsAtHeadGuarded(ctx, guard, doc.ID, 2, []store.RawOp{{ClientID: 3, Clock: 1, Bytes: []byte{3}}}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("revoked append: %v", err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	calls := 0
	expiresDuringWrite := guard
	expiresDuringWrite.Now = func() time.Time {
		calls++
		if calls >= 2 {
			return time.Now().Add(2 * time.Hour)
		}
		return time.Now()
	}
	if _, err = st.AppendOpsAtHeadGuarded(ctx, expiresDuringWrite, doc.ID, 2, []store.RawOp{{ClientID: 3, Clock: 1, Bytes: []byte{3}}}); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expired while writing: %v", err)
	}
	if head, err := st.Head(ctx, doc.ID); err != nil || head != 2 {
		t.Fatalf("rejected operation changed head: %d %v", head, err)
	}
	if err = st.DeleteSession(ctx, guard.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = st.AppendOpsAtHeadGuarded(ctx, guard, doc.ID, 2, []store.RawOp{op}); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("logged-out duplicate: %v", err)
	}
}

func TestMemoryGuardedAppend(t *testing.T) { checkGuardedAppend(t, store.NewMemory()) }

func TestPostgresGuardedAppend(t *testing.T) {
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
	if _, err = migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	checkGuardedAppend(t, pg)
}

func TestPostgresGuardedAppendConcurrentRevocation(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	pg, err := store.NewPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err = migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"permission", "session", "ancestor", "membership"} {
		t.Run(mode, func(t *testing.T) {
			owner, ws, err := pg.CreateUser(ctx, "append-race-"+mode+"-owner@test.dev", "Owner", "hash")
			if err != nil {
				t.Fatal(err)
			}
			editor, _, err := pg.CreateUser(ctx, "append-race-"+mode+"-editor@test.dev", "Editor", "hash")
			if err != nil {
				t.Fatal(err)
			}
			parent, err := pg.CreateDoc(ctx, ws.ID, owner.ID, nil, "Parent", []store.RawOp{{ClientID: 1, Clock: 1, Bytes: []byte{1}}})
			if err != nil {
				t.Fatal(err)
			}
			doc := parent
			if mode == "ancestor" {
				doc, err = pg.CreateDoc(ctx, ws.ID, owner.ID, &parent.ID, "Child", []store.RawOp{{ClientID: 1, Clock: 1, Bytes: []byte{1}}})
				if err != nil {
					t.Fatal(err)
				}
			}
			if mode == "membership" {
				err = pg.AddWorkspaceMember(ctx, ws.ID, editor.ID)
			} else {
				err = pg.SetShare(ctx, parent.ID, editor.ID, store.RoleEdit)
			}
			if err != nil {
				t.Fatal(err)
			}
			guard := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("append-race-" + mode)}
			if err = pg.CreateSession(ctx, guard.SessionHash, editor.ID, time.Now().Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			tx, err := pg.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			switch mode {
			case "session":
				_, err = tx.Exec(ctx, `DELETE FROM sessions WHERE token_hash=$1`, guard.SessionHash)
			case "membership":
				_, err = tx.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, ws.ID, editor.ID)
			default:
				_, err = tx.Exec(ctx, `DELETE FROM doc_shares WHERE doc_id=$1 AND user_id=$2`, parent.ID, editor.ID)
			}
			if err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() {
				_, e := pg.AppendOpsAtHeadGuarded(ctx, guard, doc.ID, 1, []store.RawOp{{ClientID: 4, Clock: 1, Bytes: []byte{4}}})
				result <- e
			}()
			switch mode {
			case "session":
				waitForPGBlock(t, pg, `SELECT user_id,expires_at FROM sessions`)
			case "membership":
				waitForPGBlock(t, pg, `SELECT role FROM workspace_members`)
			default:
				waitForPGBlock(t, pg, `SELECT role FROM doc_shares`)
			}
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			want := store.ErrForbidden
			if mode == "session" {
				want = store.ErrUnauthenticated
			}
			if err = <-result; !errors.Is(err, want) {
				t.Fatalf("append after %s revoked: %v", mode, err)
			}
			if head, err := pg.Head(ctx, doc.ID); err != nil || head != 1 {
				t.Fatalf("revoked operation changed head: %d %v", head, err)
			}
		})
	}
}
