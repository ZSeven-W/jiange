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

func checkGuardedMetadata(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "guarded-metadata-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := st.CreateUser(ctx, "guarded-metadata-editor@test.dev", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	ownerGuard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("guarded-metadata-owner")}
	editorGuard := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("guarded-metadata-editor")}
	for _, g := range []store.RestoreGuard{ownerGuard, editorGuard} {
		if err = st.CreateSession(ctx, g.SessionHash, g.UserID, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	parent, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Parent", nil)
	if err != nil {
		t.Fatal(err)
	}
	child, err := st.CreateDoc(ctx, ws.ID, owner.ID, &parent.ID, "Child", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, child.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	title := "Edited"
	if err = st.PatchDocMetadataGuarded(ctx, editorGuard, child.ID, store.DocMetadataPatch{Title: &title}); err != nil {
		t.Fatal(err)
	}
	changed, err := st.GetDocSystem(ctx, child.ID)
	if err != nil || changed.Title != title || changed.ParentID == nil || *changed.ParentID != parent.ID {
		t.Fatalf("editor title: %+v %v", changed, err)
	}
	rejected := "Must not persist"
	if err = st.PatchDocMetadataGuarded(ctx, editorGuard, child.ID, store.DocMetadataPatch{Title: &rejected, Move: true}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("editor move: %v", err)
	}
	if err = st.PatchDocMetadataGuarded(ctx, ownerGuard, parent.ID, store.DocMetadataPatch{Title: &rejected, Move: true, ParentID: &child.ID}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("cycle: %v", err)
	}
	unchanged, err := st.GetDocSystem(ctx, child.ID)
	if err != nil || unchanged.Title != title || unchanged.ParentID == nil || *unchanged.ParentID != parent.ID {
		t.Fatalf("partial update: %+v %v", unchanged, err)
	}
	expired := editorGuard
	expired.Now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if err = st.PatchDocMetadataGuarded(ctx, expired, child.ID, store.DocMetadataPatch{Title: &rejected}); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expired: %v", err)
	}
	if err = st.SetShare(ctx, child.ID, editor.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if err = st.PatchDocMetadataGuarded(ctx, editorGuard, child.ID, store.DocMetadataPatch{Title: &rejected}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("revoked edit: %v", err)
	}
	if err = st.PatchDocMetadataGuarded(ctx, ownerGuard, child.ID, store.DocMetadataPatch{Title: &rejected, Move: true}); err != nil {
		t.Fatal(err)
	}
	changed, err = st.GetDocSystem(ctx, child.ID)
	if err != nil || changed.Title != rejected || changed.ParentID != nil {
		t.Fatalf("atomic move and title: %+v %v", changed, err)
	}
	folder, err := st.CreateDriveFolder(ctx, ownerGuard, ws.ID, nil, "Drive folder", true)
	if err != nil {
		t.Fatal(err)
	}
	folderDoc, err := st.CreateDriveNode(ctx, ownerGuard, ws.ID, &folder.ID, "doc", "Inside", false)
	if err != nil {
		t.Fatal(err)
	}
	folderTitle := "Inside renamed"
	if err = st.PatchDocMetadataGuarded(ctx, ownerGuard, folderDoc.ID, store.DocMetadataPatch{Title: &folderTitle}); err != nil {
		t.Fatalf("folder document title: %v", err)
	}
	if err = st.PatchDocMetadataGuarded(ctx, ownerGuard, folderDoc.ID, store.DocMetadataPatch{Title: &rejected, Move: true}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("unversioned folder move: %v", err)
	}
	folderResult, err := st.GetDocSystem(ctx, folderDoc.ID)
	if err != nil || folderResult.Title != folderTitle || folderResult.ParentID == nil || *folderResult.ParentID != folder.ID {
		t.Fatalf("failed move changed folder document: %+v %v", folderResult, err)
	}
	if _, ok := st.(*store.Postgres); ok {
		calls := 0
		expiresAfterWrite := ownerGuard
		expiresAfterWrite.Now = func() time.Time {
			calls++
			if calls >= 3 {
				return time.Now().Add(2 * time.Hour)
			}
			return time.Now()
		}
		late := "Must roll back"
		if err = st.PatchDocMetadataGuarded(ctx, expiresAfterWrite, child.ID, store.DocMetadataPatch{Title: &late}); !errors.Is(err, store.ErrUnauthenticated) {
			t.Fatalf("expires before commit: %v", err)
		}
		current, e := st.GetDocSystem(ctx, child.ID)
		if e != nil || current.Title != rejected {
			t.Fatalf("expired transaction committed: %+v %v", current, e)
		}
	}
}

func TestMemoryGuardedMetadata(t *testing.T) { checkGuardedMetadata(t, store.NewMemory()) }

func TestPostgresGuardedMetadata(t *testing.T) {
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
	checkGuardedMetadata(t, pg)
}

func TestPostgresGuardedMetadataConcurrentRevocation(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pg, err := store.NewPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err = migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"permission", "session", "destination"} {
		t.Run(mode, func(t *testing.T) {
			owner, ws, err := pg.CreateUser(ctx, "race-"+mode+"-owner@test.dev", "Owner", "hash")
			if err != nil {
				t.Fatal(err)
			}
			editor, _, err := pg.CreateUser(ctx, "race-"+mode+"-editor@test.dev", "Editor", "hash")
			if err != nil {
				t.Fatal(err)
			}
			doc, err := pg.CreateDoc(ctx, ws.ID, owner.ID, nil, "Original", nil)
			if err != nil {
				t.Fatal(err)
			}
			role := store.RoleEdit
			if mode == "destination" {
				role = store.RoleManage
			}
			if err = pg.SetShare(ctx, doc.ID, editor.ID, role); err != nil {
				t.Fatal(err)
			}
			var destination store.DocMeta
			if mode == "destination" {
				destination, err = pg.CreateDoc(ctx, ws.ID, owner.ID, nil, "Destination", nil)
				if err != nil {
					t.Fatal(err)
				}
				if err = pg.SetShare(ctx, destination.ID, editor.ID, store.RoleView); err != nil {
					t.Fatal(err)
				}
			}
			guard := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("metadata-race-" + mode)}
			if err = pg.CreateSession(ctx, guard.SessionHash, editor.ID, time.Now().Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			tx, err := pg.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if mode == "permission" {
				_, err = tx.Exec(ctx, `DELETE FROM doc_shares WHERE doc_id=$1 AND user_id=$2`, doc.ID, editor.ID)
			} else if mode == "destination" {
				_, err = tx.Exec(ctx, `DELETE FROM doc_shares WHERE doc_id=$1 AND user_id=$2`, destination.ID, editor.ID)
			} else {
				_, err = tx.Exec(ctx, `DELETE FROM sessions WHERE token_hash=$1`, guard.SessionHash)
			}
			if err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			title := "Must not persist"
			patch := store.DocMetadataPatch{Title: &title}
			if mode == "destination" {
				patch.Move = true
				patch.ParentID = &destination.ID
			}
			go func() { result <- pg.PatchDocMetadataGuarded(ctx, guard, doc.ID, patch) }()
			if mode == "permission" || mode == "destination" {
				waitForPGBlock(t, pg, `SELECT role FROM doc_shares`)
			} else {
				waitForPGBlock(t, pg, `SELECT user_id,expires_at FROM sessions`)
			}
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			want := store.ErrForbidden
			if mode == "session" {
				want = store.ErrUnauthenticated
			}
			if err = <-result; !errors.Is(err, want) {
				t.Fatalf("write after %s revocation: %v", mode, err)
			}
			current, err := pg.GetDocSystem(ctx, doc.ID)
			if err != nil || current.Title != "Original" || current.ParentID != nil {
				t.Fatalf("revoked mutation: %+v %v", current, err)
			}
		})
	}
}

func TestPostgresMetadataAndCollaborationLockOrder(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pg, err := store.NewPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err = migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	owner, ws, err := pg.CreateUser(ctx, "lock-order-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := pg.CreateUser(ctx, "lock-order-editor@test.dev", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := pg.CreateDoc(ctx, ws.ID, owner.ID, nil, "Original", []store.RawOp{{ClientID: 1, Clock: 1, Bytes: []byte{1}}})
	if err != nil {
		t.Fatal(err)
	}
	ownerGuard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("metadata-lock-owner")}
	if err = pg.CreateSession(ctx, ownerGuard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err = pg.AppendOpsAtHead(store.WithDocumentActor(ctx, owner.ID), doc.ID, 1, []store.RawOp{{ClientID: 2, Clock: 1, Bytes: []byte{2}}}); err != nil {
		t.Fatal(err)
	}
	// Prime the empty replica index so its foreign-key check does not itself
	// wait on the node lock before the appender reaches the ordering fence.
	if _, err = pg.Pool.Exec(ctx, `INSERT INTO doc_op_range_clients(doc_id,client_id,has_opaque) VALUES($1,3,false)`, doc.ID); err != nil {
		t.Fatal(err)
	}
	tx, err := pg.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	var locked int64
	if err = tx.QueryRow(ctx, `SELECT id FROM nodes WHERE id=$1 FOR UPDATE`, doc.ID).Scan(&locked); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, e := pg.AppendOpsAtHead(store.WithDocumentActor(ctx, editor.ID), doc.ID, 2, []store.RawOp{{ClientID: 3, Clock: 1, Bytes: []byte{3}}})
		result <- e
	}()
	// The appender must wait for the node before its insert trigger can lock
	// the attribution row. Otherwise the metadata upsert below deadlocks.
	waitForPGBlock(t, pg, `SELECT id FROM nodes WHERE id=$1 FOR UPDATE`)
	if _, err = tx.Exec(ctx, `UPDATE nodes SET title='Metadata',updated_at=now() WHERE id=$1`, doc.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO document_last_modifier(doc_id,user_id,modification_revision) SELECT id,$2,modification_revision FROM nodes WHERE id=$1 ON CONFLICT (doc_id) DO UPDATE SET user_id=EXCLUDED.user_id,modification_revision=EXCLUDED.modification_revision`, doc.ID, owner.ID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-result; err != nil {
		t.Fatalf("concurrent append: %v", err)
	}
	entries, err := pg.ListDriveChildren(ctx, ownerGuard, ws.ID, nil, false)
	if err != nil || len(entries) != 1 || entries[0].LastModifierName != editor.Name {
		t.Fatalf("last committed writer: %+v %v", entries, err)
	}
}
