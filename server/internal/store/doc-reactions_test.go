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

func exerciseDocReactions(t *testing.T, st store.Store) {
	t.Helper()
	rs, ok := st.(store.DocReactionsStore)
	if !ok {
		t.Fatalf("store %T does not implement DocReactionsStore", st)
	}
	ctx := context.Background()

	owner, ws, err := st.CreateUser(ctx, "rx-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	viewer, _, err := st.CreateUser(ctx, "rx-viewer@example.test", "Viewer", "hash")
	if err != nil {
		t.Fatal(err)
	}
	outsider, _, err := st.CreateUser(ctx, "rx-outsider@example.test", "Outsider", "hash")
	if err != nil {
		t.Fatal(err)
	}

	exp := time.Now().Add(time.Hour)
	ownerGuard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("rx-owner-sess")}
	viewerGuard := store.RestoreGuard{UserID: viewer.ID, SessionHash: []byte("rx-viewer-sess")}
	outsiderGuard := store.RestoreGuard{UserID: outsider.ID, SessionHash: []byte("rx-outsider-sess")}
	for _, g := range []store.RestoreGuard{ownerGuard, viewerGuard, outsiderGuard} {
		if err := st.CreateSession(ctx, g.SessionHash, g.UserID, exp); err != nil {
			t.Fatal(err)
		}
	}

	parent, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Parent Doc", nil)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, owner.ID, &parent.ID, "Child Doc", nil)
	if err != nil {
		t.Fatal(err)
	}

	// Default state: empty reactions (non-nil slice), viewerCount clamped to 1.
	snap, err := rs.DocReactions(ctx, owner.ID, doc.ID)
	if err != nil {
		t.Fatalf("initial DocReactions: %v", err)
	}
	if snap.Reactions == nil || len(snap.Reactions) != 0 || snap.ViewerCount != 1 {
		t.Fatalf("unexpected initial snapshot: %+v", snap)
	}

	// Non-existent doc -> ErrNotFound.
	if _, err := rs.DocReactions(ctx, owner.ID, 999999); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing doc read: got %v, want ErrNotFound", err)
	}
	if _, err := rs.ToggleDocReactionGuarded(ctx, ownerGuard, 999999, "👍", nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing doc toggle: got %v, want ErrNotFound", err)
	}

	// Outsider without share -> ErrForbidden.
	if _, err := rs.DocReactions(ctx, outsider.ID, doc.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("outsider read: got %v, want ErrForbidden", err)
	}
	if _, err := rs.ToggleDocReactionGuarded(ctx, outsiderGuard, doc.ID, "👍", nil); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("outsider toggle: got %v, want ErrForbidden", err)
	}

	// Invalid emoji -> ErrInvalidReaction.
	for _, bad := range []string{"", "hello", "💀", "💡"} {
		if _, err := rs.ToggleDocReactionGuarded(ctx, ownerGuard, doc.ID, bad, nil); !errors.Is(err, store.ErrInvalidReaction) {
			t.Fatalf("bad emoji %q: got %v, want ErrInvalidReaction", bad, err)
		}
	}

	// Share doc with viewer (RoleView) and verify distinct viewerCount via recent_visits.
	if err := st.SetShare(ctx, doc.ID, viewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	t0 := time.Now().Add(-time.Minute)
	if err := st.RecordVisit(ctx, owner.ID, doc.ID, t0); err != nil {
		t.Fatal(err)
	}
	if err := st.RecordVisit(ctx, owner.ID, doc.ID, t0.Add(10*time.Second)); err != nil {
		t.Fatal(err)
	}
	snap, err = rs.DocReactions(ctx, viewer.ID, doc.ID)
	if err != nil || snap.ViewerCount != 1 {
		t.Fatalf("same user repeated visit: snap=%+v err=%v", snap, err)
	}
	if err := st.RecordVisit(ctx, viewer.ID, doc.ID, t0.Add(20*time.Second)); err != nil {
		t.Fatal(err)
	}
	snap, err = rs.DocReactions(ctx, owner.ID, doc.ID)
	if err != nil || snap.ViewerCount != 2 {
		t.Fatalf("two distinct viewers: snap=%+v err=%v", snap, err)
	}

	// Viewer with RoleView can react; reactions are returned in DocReactionEmojis palette order.
	snap, err = rs.ToggleDocReactionGuarded(ctx, viewerGuard, doc.ID, "🙏", nil)
	if err != nil {
		t.Fatalf("viewer toggle 🙏: %v", err)
	}
	if len(snap.Reactions) != 1 || snap.Reactions[0] != (store.DocReactionItem{Emoji: "🙏", Count: 1, Reacted: true}) || snap.ViewerCount != 2 {
		t.Fatalf("after viewer 🙏: %+v", snap)
	}

	snap, err = rs.ToggleDocReactionGuarded(ctx, viewerGuard, doc.ID, "👍", nil)
	if err != nil {
		t.Fatalf("viewer toggle 👍: %v", err)
	}
	if len(snap.Reactions) != 2 || snap.Reactions[0].Emoji != "👍" || snap.Reactions[1].Emoji != "🙏" {
		t.Fatalf("palette order expected [👍, 🙏], got %+v", snap.Reactions)
	}

	// Owner sees viewer's reactions with Reacted=false.
	snap, err = rs.DocReactions(ctx, owner.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Reactions) != 2 || snap.Reactions[0] != (store.DocReactionItem{Emoji: "👍", Count: 1, Reacted: false}) || snap.Reactions[1] != (store.DocReactionItem{Emoji: "🙏", Count: 1, Reacted: false}) {
		t.Fatalf("owner read before reacting: %+v", snap.Reactions)
	}

	// Owner toggles 👍 (multi-user aggregation) and ❤️ (palette insertion between 👍 and 🙏).
	snap, err = rs.ToggleDocReactionGuarded(ctx, ownerGuard, doc.ID, "👍", nil)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Reactions[0] != (store.DocReactionItem{Emoji: "👍", Count: 2, Reacted: true}) {
		t.Fatalf("after owner 👍: %+v", snap.Reactions)
	}
	snap, err = rs.ToggleDocReactionGuarded(ctx, ownerGuard, doc.ID, "❤️", nil)
	if err != nil {
		t.Fatal(err)
	}
	wantOrder := []store.DocReactionItem{
		{Emoji: "👍", Count: 2, Reacted: true},
		{Emoji: "❤️", Count: 1, Reacted: true},
		{Emoji: "🙏", Count: 1, Reacted: false},
	}
	if len(snap.Reactions) != len(wantOrder) {
		t.Fatalf("got %+v, want %+v", snap.Reactions, wantOrder)
	}
	for i := range wantOrder {
		if snap.Reactions[i] != wantOrder[i] {
			t.Fatalf("index %d: got %+v, want %+v", i, snap.Reactions[i], wantOrder[i])
		}
	}

	// Explicit on=true is idempotent; explicit on=false removes only caller's reaction.
	snap, err = rs.ToggleDocReactionGuarded(ctx, ownerGuard, doc.ID, "👍", boolPtr(true))
	if err != nil || snap.Reactions[0].Count != 2 || !snap.Reactions[0].Reacted {
		t.Fatalf("idempotent on=true: snap=%+v err=%v", snap, err)
	}
	snap, err = rs.ToggleDocReactionGuarded(ctx, ownerGuard, doc.ID, "👍", boolPtr(false))
	if err != nil || snap.Reactions[0] != (store.DocReactionItem{Emoji: "👍", Count: 1, Reacted: false}) {
		t.Fatalf("explicit on=false: snap=%+v err=%v", snap, err)
	}
	snap, err = rs.ToggleDocReactionGuarded(ctx, ownerGuard, doc.ID, "👍", boolPtr(false))
	if err != nil || snap.Reactions[0] != (store.DocReactionItem{Emoji: "👍", Count: 1, Reacted: false}) {
		t.Fatalf("idempotent on=false: snap=%+v err=%v", snap, err)
	}

	// Toggling own sole reaction off omits the zero-count emoji.
	snap, err = rs.ToggleDocReactionGuarded(ctx, ownerGuard, doc.ID, "❤️", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Reactions) != 2 || snap.Reactions[0].Emoji != "👍" || snap.Reactions[1].Emoji != "🙏" {
		t.Fatalf("zero-count ❤️ should be omitted: %+v", snap.Reactions)
	}

	// Session guard checks: expired, mid-write expiry, mismatched user, deleted session.
	expiredGuard := ownerGuard
	expiredGuard.Now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if _, err := rs.ToggleDocReactionGuarded(ctx, expiredGuard, doc.ID, "🔥", nil); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expired guard: got %v, want ErrUnauthenticated", err)
	}

	calls := 0
	expiresMidWrite := ownerGuard
	expiresMidWrite.Now = func() time.Time {
		calls++
		if calls >= 2 {
			return time.Now().Add(2 * time.Hour)
		}
		return time.Now()
	}
	if _, err := rs.ToggleDocReactionGuarded(ctx, expiresMidWrite, doc.ID, "🔥", nil); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("mid-write expiry: got %v, want ErrUnauthenticated", err)
	}
	afterExpiry, err := rs.DocReactions(ctx, owner.ID, doc.ID)
	if err != nil || len(afterExpiry.Reactions) != 2 {
		t.Fatalf("mid-write expiry mutated state: %+v %v", afterExpiry, err)
	}

	wrongUserGuard := store.RestoreGuard{UserID: owner.ID, SessionHash: viewerGuard.SessionHash}
	if _, err := rs.ToggleDocReactionGuarded(ctx, wrongUserGuard, doc.ID, "🔥", nil); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("mismatched session user: got %v, want ErrUnauthenticated", err)
	}

	// Revoking viewer's share denies read and toggle.
	if err := st.SetShare(ctx, doc.ID, viewer.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := rs.DocReactions(ctx, viewer.ID, doc.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("revoked viewer read: got %v, want ErrForbidden", err)
	}
	if _, err := rs.ToggleDocReactionGuarded(ctx, viewerGuard, doc.ID, "👍", nil); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("revoked viewer toggle: got %v, want ErrForbidden", err)
	}

	// Deleted session returns ErrUnauthenticated.
	if err := st.DeleteSession(ctx, viewerGuard.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err := rs.ToggleDocReactionGuarded(ctx, viewerGuard, doc.ID, "👍", nil); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("logged-out toggle: got %v, want ErrUnauthenticated", err)
	}

	// Trashed doc is inaccessible; restoring preserves reactions.
	if err := st.Trash(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := rs.DocReactions(ctx, owner.ID, doc.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("trashed doc read: got %v, want ErrNotFound", err)
	}
	if _, err := rs.ToggleDocReactionGuarded(ctx, ownerGuard, doc.ID, "👍", nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("trashed doc toggle: got %v, want ErrNotFound", err)
	}
	if err := st.Restore(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	restored, err := rs.DocReactions(ctx, owner.ID, doc.ID)
	if err != nil || len(restored.Reactions) != 2 {
		t.Fatalf("restored doc reactions lost: %+v err=%v", restored, err)
	}

	// Trashing parent hides child doc reactions.
	if err := st.Trash(ctx, parent.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := rs.DocReactions(ctx, owner.ID, doc.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("trashed parent read: got %v, want ErrNotFound", err)
	}
	if _, err := rs.ToggleDocReactionGuarded(ctx, ownerGuard, doc.ID, "👍", nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("trashed parent toggle: got %v, want ErrNotFound", err)
	}
}

func TestMemoryDocReactions(t *testing.T) {
	mem := store.NewMemory()
	exerciseDocReactions(t, mem)

	// Also verify purged doc returns ErrNotFound on Memory.
	ctx := context.Background()
	u, ws, err := mem.CreateUser(ctx, "rx-purge@example.test", "Purger", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: u.ID, SessionHash: []byte("rx-purge-sess")}
	if err := mem.CreateSession(ctx, guard.SessionHash, u.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	d, err := mem.CreateDoc(ctx, ws.ID, u.ID, nil, "To Purge", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := mem.TrashDriveNode(ctx, guard, d.ID, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := mem.PurgeDriveNode(ctx, guard, d.ID, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := mem.DocReactions(ctx, u.ID, d.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("purged doc read: got %v, want ErrNotFound", err)
	}
	if _, err := mem.ToggleDocReactionGuarded(ctx, guard, d.ID, "👍", nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("purged doc toggle: got %v, want ErrNotFound", err)
	}
}

func TestPostgresDocReactions(t *testing.T) {
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
	if _, err := pg.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	exerciseDocReactions(t, pg)
}
