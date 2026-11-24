package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestSharePasswordStore(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()

	owner, ws, err := st.CreateUser(ctx, "lp-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := st.CreateUser(ctx, "lp-editor@example.test", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	manager, _, err := st.CreateUser(ctx, "lp-manager@example.test", "Manager", "hash")
	if err != nil {
		t.Fatal(err)
	}
	outsider, _, err := st.CreateUser(ctx, "lp-outsider@example.test", "Outsider", "hash")
	if err != nil {
		t.Fatal(err)
	}

	parent, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Parent", nil)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, owner.ID, &parent.ID, "Child", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, doc.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, parent.ID, manager.ID, store.RoleManage); err != nil {
		t.Fatal(err)
	}

	mkGuard := func(uid int64, tok string, exp time.Time) store.RestoreGuard {
		h := []byte(tok)
		if err := st.CreateSession(ctx, h, uid, exp); err != nil {
			t.Fatal(err)
		}
		return store.RestoreGuard{UserID: uid, SessionHash: h}
	}

	now := time.Now()
	ownerGuard := mkGuard(owner.ID, "sess-owner", now.Add(time.Hour))
	editorGuard := mkGuard(editor.ID, "sess-editor", now.Add(time.Hour))
	managerGuard := mkGuard(manager.ID, "sess-manager", now.Add(time.Hour))
	outsiderGuard := mkGuard(outsider.ID, "sess-outsider", now.Add(time.Hour))

	// 1. Unset returns empty hash and nil error.
	if got, err := st.GetLinkPasswordHash(ctx, doc.ID); err != nil || got != "" {
		t.Fatalf("initial hash: got=%q err=%v", got, err)
	}

	// 2. Owner sets password hash -> persisted.
	if err := st.SetLinkPasswordGuarded(ctx, ownerGuard, doc.ID, "pbkdf2-sha256$100$salt1$hash1"); err != nil {
		t.Fatalf("owner set: %v", err)
	}
	if got, err := st.GetLinkPasswordHash(ctx, doc.ID); err != nil || got != "pbkdf2-sha256$100$salt1$hash1" {
		t.Fatalf("after set: got=%q err=%v", got, err)
	}

	// 3. Inherited manager updates password hash -> upserted.
	if err := st.SetLinkPasswordGuarded(ctx, managerGuard, doc.ID, "pbkdf2-sha256$100$salt2$hash2"); err != nil {
		t.Fatalf("inherited manager update: %v", err)
	}
	if got, err := st.GetLinkPasswordHash(ctx, doc.ID); err != nil || got != "pbkdf2-sha256$100$salt2$hash2" {
		t.Fatalf("after update: got=%q err=%v", got, err)
	}

	// 4. Non-managers (editor, outsider) receive ErrForbidden and state stays untouched.
	if err := st.SetLinkPasswordGuarded(ctx, editorGuard, doc.ID, "hacked"); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("editor set: want ErrForbidden got %v", err)
	}
	if err := st.SetLinkPasswordGuarded(ctx, outsiderGuard, doc.ID, "hacked"); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("outsider set: want ErrForbidden got %v", err)
	}
	// Nonexistent doc also fails with ErrForbidden.
	if err := st.SetLinkPasswordGuarded(ctx, ownerGuard, 999999, "hacked"); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("missing doc set: want ErrForbidden got %v", err)
	}
	if got, err := st.GetLinkPasswordHash(ctx, doc.ID); err != nil || got != "pbkdf2-sha256$100$salt2$hash2" {
		t.Fatalf("forbidden writes changed hash: got=%q err=%v", got, err)
	}

	// 5. Invalid / expired / logged-out session returns ErrUnauthenticated.
	badSess := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("no-such-session")}
	if err := st.SetLinkPasswordGuarded(ctx, badSess, doc.ID, "nope"); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("unknown session: want ErrUnauthenticated got %v", err)
	}
	expiredGuard := ownerGuard
	expiredGuard.Now = func() time.Time { return now.Add(2 * time.Hour) }
	if err := st.SetLinkPasswordGuarded(ctx, expiredGuard, doc.ID, "nope"); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expired session: want ErrUnauthenticated got %v", err)
	}
	wrongUserGuard := store.RestoreGuard{UserID: editor.ID, SessionHash: ownerGuard.SessionHash}
	if err := st.SetLinkPasswordGuarded(ctx, wrongUserGuard, doc.ID, "nope"); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("mismatched session user: want ErrUnauthenticated got %v", err)
	}

	// 6. Downgrading inherited manager revokes ability to clear password.
	if err := st.SetShare(ctx, parent.ID, manager.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if err := st.SetLinkPasswordGuarded(ctx, managerGuard, doc.ID, ""); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("downgraded manager clear: want ErrForbidden got %v", err)
	}

	// 7. Owner clears password -> GetLinkPasswordHash returns "".
	if err := st.SetLinkPasswordGuarded(ctx, ownerGuard, doc.ID, ""); err != nil {
		t.Fatalf("owner clear: %v", err)
	}
	if got, err := st.GetLinkPasswordHash(ctx, doc.ID); err != nil || got != "" {
		t.Fatalf("after clear: got=%q err=%v", got, err)
	}
}
