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

func checkDocumentModifier(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "modifier-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := st.CreateUser(ctx, "modifier-editor@example.test", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	ownerGuard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("modifier-owner-session")}
	editorGuard := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("modifier-editor-session")}
	for _, guard := range []store.RestoreGuard{ownerGuard, editorGuard} {
		if err = st.CreateSession(ctx, guard.SessionHash, guard.UserID, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	doc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Document", []store.RawOp{{ClientID: 1, Clock: 1, Bytes: []byte{1}}})
	if err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	modifier := func() string {
		t.Helper()
		entries, err := st.ListDriveChildren(ctx, ownerGuard, ws.ID, nil, false)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if entry.ID == doc.ID {
				return entry.LastModifierName
			}
		}
		t.Fatal("document not listed")
		return ""
	}
	if got := modifier(); got != "" {
		t.Fatalf("initial writer was guessed: %q", got)
	}
	op := store.RawOp{ClientID: 2, Clock: 1, Bytes: []byte{2}}
	if _, err = st.AppendOpsAtHead(store.WithDocumentActor(ctx, editor.ID), doc.ID, 1, []store.RawOp{op}); err != nil {
		t.Fatal(err)
	}
	if got := modifier(); got != editor.Name {
		t.Fatalf("editor: %q", got)
	}
	// Duplicate retries from another user and stale-head failures must not
	// change attribution or the document's update time.
	if seq, e := st.AppendOpsAtHead(store.WithDocumentActor(ctx, owner.ID), doc.ID, 2, []store.RawOp{op}); e != nil || len(seq) != 1 || seq[0] != 0 {
		t.Fatalf("duplicate: %v %v", seq, e)
	}
	if _, e := st.AppendOpsAtHead(store.WithDocumentActor(ctx, owner.ID), doc.ID, 1, []store.RawOp{{ClientID: 3, Clock: 1, Bytes: []byte{3}}}); !errors.Is(e, store.ErrConflict) {
		t.Fatalf("stale head: %v", e)
	}
	if got := modifier(); got != editor.Name {
		t.Fatalf("retry changed modifier: %q", got)
	}
	renamed, err := st.RenameDriveNode(ctx, ownerGuard, doc.ID, "Renamed", doc.DriveRevision)
	if err != nil {
		t.Fatal(err)
	}
	if renamed.LastModifierName != owner.Name || modifier() != owner.Name {
		t.Fatalf("guarded rename modifier: %+v", renamed)
	}
	if _, err = st.UpdateTitle(ctx, doc.ID, "Unattributed change"); err != nil {
		t.Fatal(err)
	}
	if got := modifier(); got != "" {
		t.Fatalf("unattributed update retained stale modifier: %q", got)
	}
	if _, err = st.AppendRestoreOps(ctx, editorGuard, doc.ID, 2, []store.RawOp{{ClientID: 4, Clock: 1, Bytes: []byte{4}}}); err != nil {
		t.Fatal(err)
	}
	if got := modifier(); got != editor.Name {
		t.Fatalf("restore editor: %q", got)
	}
	if _, err = st.AppendOps(ctx, doc.ID, []store.RawOp{{ClientID: 5, Clock: 1, Bytes: []byte{5}}}); err != nil {
		t.Fatal(err)
	}
	if got := modifier(); got != "" {
		t.Fatalf("unattributed writer retained stale modifier: %q", got)
	}
}

func TestMemoryDocumentModifier(t *testing.T) { checkDocumentModifier(t, store.NewMemory()) }

func TestPostgresDocumentModifier(t *testing.T) {
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
	checkDocumentModifier(t, pg)
}

func TestPostgresModifierRevisionFence(t *testing.T) {
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
	owner, ws, err := pg.CreateUser(ctx, "modifier-fence@example.test", "Fence", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("modifier-fence-session")}
	if err = pg.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	doc, err := pg.CreateDoc(ctx, ws.ID, owner.ID, nil, "Fence document", []store.RawOp{{ClientID: 1, Clock: 1, Bytes: []byte{1}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pg.AppendOpsAtHead(store.WithDocumentActor(ctx, owner.ID), doc.ID, 1, []store.RawOp{{ClientID: 2, Clock: 1, Bytes: []byte{2}}}); err != nil {
		t.Fatal(err)
	}
	// A legacy writer can issue an update without changing the timestamp.
	// The revision trigger must still invalidate the previous attribution.
	if _, err = pg.Pool.Exec(ctx, `UPDATE nodes SET updated_at=updated_at WHERE id=$1`, doc.ID); err != nil {
		t.Fatal(err)
	}
	entries, err := pg.ListDriveChildren(ctx, guard, ws.ID, nil, false)
	if err != nil || len(entries) != 1 || entries[0].LastModifierName != "" {
		t.Fatalf("stale attribution survived unchanged timestamp: %+v %v", entries, err)
	}
	if _, err = pg.AppendOpsAtHead(store.WithDocumentActor(ctx, owner.ID), doc.ID, 2, []store.RawOp{{ClientID: 3, Clock: 1, Bytes: []byte{3}}}); err != nil {
		t.Fatal(err)
	}
	entries, err = pg.ListDriveChildren(ctx, guard, ws.ID, nil, false)
	if err != nil || len(entries) != 1 || entries[0].LastModifierName != owner.Name {
		t.Fatalf("expected fresh attribution: %+v %v", entries, err)
	}
	// Simulate an old writer that adds an op and head directly, without
	// touching the node or its updated_at at all.
	tx, err := pg.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE doc_heads SET seq=seq+1 WHERE doc_id=$1`, doc.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO doc_ops(doc_id,seq,client_id,clock,op) VALUES($1,4,4,1,$2)`, doc.ID, []byte{4}); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO doc_op_ranges(doc_id,seq,client_id,clock,end_clock,decoded) VALUES($1,4,4,1,1,false)`, doc.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO doc_op_range_clients(doc_id,client_id,has_opaque) VALUES($1,4,true)`, doc.ID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	entries, err = pg.ListDriveChildren(ctx, guard, ws.ID, nil, false)
	if err != nil || len(entries) != 1 || entries[0].LastModifierName != "" {
		t.Fatalf("legacy operation retained stale attribution: %+v %v", entries, err)
	}
}
