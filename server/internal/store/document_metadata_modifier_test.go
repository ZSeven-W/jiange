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

func checkMetadataModifier(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "metadata-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := st.CreateUser(ctx, "metadata-editor@example.test", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	ownerGuard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("metadata-owner-session")}
	editorGuard := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("metadata-editor-session")}
	for _, guard := range []store.RestoreGuard{ownerGuard, editorGuard} {
		if err = st.CreateSession(ctx, guard.SessionHash, guard.UserID, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	doc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Metadata", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	modifier := func() string {
		t.Helper()
		entries, e := st.ListDriveChildren(ctx, ownerGuard, ws.ID, nil, false)
		if e != nil {
			t.Fatal(e)
		}
		for _, entry := range entries {
			if entry.ID == doc.ID {
				return entry.LastModifierName
			}
		}
		t.Fatal("document missing")
		return ""
	}
	if _, err = st.SetDocIconGuarded(ctx, editorGuard, doc.ID, "😀", 0); err != nil {
		t.Fatal(err)
	}
	if got := modifier(); got != editor.Name {
		t.Fatalf("icon modifier: %q", got)
	}
	if _, err = st.SetDocCoverGuarded(ctx, ownerGuard, doc.ID, store.DocCover{Kind: "builtin", Asset: "misty-lake", Position: 0.5}, 0); err != nil {
		t.Fatal(err)
	}
	if got := modifier(); got != owner.Name {
		t.Fatalf("cover modifier: %q", got)
	}
	if _, err = st.SetDocIconGuarded(ctx, editorGuard, doc.ID, "🚀", 0); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale icon: %v", err)
	}
	if got := modifier(); got != owner.Name {
		t.Fatalf("stale write changed modifier: %q", got)
	}
	expired := editorGuard
	expired.Now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if _, err = st.SetDocIconGuarded(ctx, expired, doc.ID, "🚀", 1); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expired icon: %v", err)
	}
	if got := modifier(); got != owner.Name {
		t.Fatalf("expired write changed modifier: %q", got)
	}
	calls := 0
	expiresDuringWrite := editorGuard
	expiresDuringWrite.Now = func() time.Time {
		calls++
		if calls >= 2 {
			return time.Now().Add(2 * time.Hour)
		}
		return time.Now()
	}
	if _, err = st.SetDocIconGuarded(ctx, expiresDuringWrite, doc.ID, "🚀", 1); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("session expires during icon update: %v", err)
	}
	if got := modifier(); got != owner.Name {
		t.Fatalf("rolled back write changed modifier: %q", got)
	}
	if _, err = st.SetDocIconGuarded(ctx, editorGuard, doc.ID, "🚀", 1); err != nil {
		t.Fatal(err)
	}
	if err = st.PatchManagedDocGuarded(ctx, ownerGuard, doc.ID, store.ManagedDocPatch{CopyProtected: true}); err != nil {
		t.Fatal(err)
	}
	if got := modifier(); got != editor.Name {
		t.Fatalf("permissions-only change changed modifier: %q", got)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = st.SetDocCoverGuarded(ctx, editorGuard, doc.ID, store.DocCover{Kind: "none", Position: 0.5}, 1); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("revoked cover: %v", err)
	}
	if got := modifier(); got != editor.Name {
		t.Fatalf("revoked write changed modifier: %q", got)
	}
	title := "Managed title"
	if err = st.PatchManagedDocGuarded(ctx, ownerGuard, doc.ID, store.ManagedDocPatch{Title: &title, CopyProtected: true}); err != nil {
		t.Fatal(err)
	}
	if got := modifier(); got != owner.Name {
		t.Fatalf("guarded title modifier: %q", got)
	}
	if err = st.MoveDriveNode(ctx, ownerGuard, doc.ID, nil, doc.DriveRevision); err != nil {
		t.Fatal(err)
	}
	if got := modifier(); got != owner.Name {
		t.Fatalf("guarded move modifier: %q", got)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if _, err = st.UpdateTitle(store.WithDocumentActor(ctx, editor.ID), doc.ID, "Editor title"); err != nil {
		t.Fatal(err)
	}
	if got := modifier(); got != editor.Name {
		t.Fatalf("authenticated title modifier: %q", got)
	}
	if err = st.Move(store.WithDocumentActor(ctx, owner.ID), doc.ID, nil); err != nil {
		t.Fatal(err)
	}
	if got := modifier(); got != owner.Name {
		t.Fatalf("authenticated move modifier: %q", got)
	}
}

func TestMemoryMetadataModifier(t *testing.T) { checkMetadataModifier(t, store.NewMemory()) }

func TestPostgresMetadataModifier(t *testing.T) {
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
	checkMetadataModifier(t, pg)
}
