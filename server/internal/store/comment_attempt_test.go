package store_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func exerciseCommentAttempts(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	_, doc, owner, guest, guard := guardedSharingFixture(t, st)
	if err := st.SetShare(ctx, doc.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	key := "0123456789abcdef0123456789abcdef"
	c := store.Comment{DocID: doc.ID, UserID: owner.ID, Body: "一次提交", Mentions: []int64{guest.ID}}
	wrongAccount := c
	wrongAccount.UserID = guest.ID
	if _, err := st.AddCommentAttemptGuarded(ctx, guard, key, wrongAccount); !errors.Is(err, store.ErrCommentAttemptAccountChanged) {
		t.Fatalf("write with wrong account: %v", err)
	}
	if _, err := st.GetCommentAttemptGuarded(ctx, guard, guest.ID, -1, key); !errors.Is(err, store.ErrCommentAttemptAccountChanged) {
		t.Fatalf("query with wrong account: %v", err)
	}
	if _, err := st.CommentAttemptCapabilityGuarded(ctx, guard, guest.ID, -1); !errors.Is(err, store.ErrCommentAttemptAccountChanged) {
		t.Fatalf("capability with wrong account: %v", err)
	}
	const n = 12
	ids := make(chan int64, n)
	errs := make(chan error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := st.AddCommentAttemptGuarded(ctx, guard, key, c)
			if err == nil && (r.State != "committed" || r.Comment == nil || r.MutationID != key) {
				err = errors.New("invalid receipt")
			}
			ids <- r.CommentID
			errs <- err
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent attempt: %v", err)
		}
	}
	var first int64
	for id := range ids {
		if first == 0 {
			first = id
		}
		if id != first {
			t.Fatalf("attempt created distinct IDs: %d vs %d", first, id)
		}
	}
	all, err := st.Comments(ctx, doc.ID)
	if err != nil || len(all) != 1 {
		t.Fatalf("comments: %+v %v", all, err)
	}
	notes, err := st.Notifications(ctx, guest.ID, 50)
	if err != nil || len(notes) != 1 {
		t.Fatalf("notifications: %+v %v", notes, err)
	}
	guestGuard := store.RestoreGuard{UserID: guest.ID, SessionHash: []byte("attempt-receipt-guest")}
	if err := st.CreateSession(ctx, guestGuard.SessionHash, guest.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	other, err := st.GetCommentAttemptGuarded(ctx, guestGuard, guest.ID, doc.ID, key)
	if err != nil || other.State != "unknown" || other.CommentID != 0 {
		t.Fatalf("another reader's receipt: %+v %v", other, err)
	}
	lookup, err := st.GetCommentAttemptGuarded(ctx, guard, owner.ID, doc.ID, key)
	if err != nil || lookup.State != "committed" || lookup.CommentID != first || lookup.Comment != nil {
		t.Fatalf("own receipt lookup: %+v %v", lookup, err)
	}
	changed := c
	changed.Body = "different"
	if _, err = st.AddCommentAttemptGuarded(ctx, guard, key, changed); !errors.Is(err, store.ErrCommentAttemptMismatch) {
		t.Fatalf("different payload: %v", err)
	}
	if err = st.DeleteCommentGuarded(ctx, guard, doc.ID, first); err != nil {
		t.Fatal(err)
	}
	tomb, err := st.AddCommentAttemptGuarded(ctx, guard, key, c)
	if err != nil || tomb.State != "deleted" || tomb.Comment != nil || tomb.CommentID != first {
		t.Fatalf("tombstone: %+v %v", tomb, err)
	}
	all, err = st.Comments(ctx, doc.ID)
	if err != nil || len(all) != 0 {
		t.Fatalf("deleted retry resurrected: %+v %v", all, err)
	}
	if _, err = st.AddCommentAttemptGuarded(ctx, guard, "bad", c); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("bad id: %v", err)
	}
	if err = st.DeleteSession(ctx, guard.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = st.AddCommentAttemptGuarded(ctx, guard, key, c); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("session revoke: %v", err)
	}
}

func TestMemoryCommentAttempts(t *testing.T)   { exerciseCommentAttempts(t, store.NewMemory()) }
func TestPostgresCommentAttempts(t *testing.T) { exerciseCommentAttempts(t, atomicPostgres(t)) }

func exerciseAttemptRetryAfterCommentPermissionRevoked(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	_, doc, owner, guest, ownerGuard := guardedSharingFixture(t, st)
	if err := st.SetShare(ctx, doc.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	guestGuard := store.RestoreGuard{UserID: guest.ID, SessionHash: []byte("attempt-guest")}
	if err := st.CreateSession(ctx, guestGuard.SessionHash, guest.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	c := store.Comment{DocID: doc.ID, UserID: guest.ID, Body: "sent"}
	key := "fedcba9876543210fedcba9876543210"
	initial, err := st.AddCommentAttemptGuarded(ctx, guestGuard, key, c)
	if err != nil {
		t.Fatal(err)
	}
	meta, err := st.GetDoc(ctx, owner.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	edit := store.RoleEdit
	rev := meta.PermissionsRevision
	if err = st.PatchManagedDocGuarded(ctx, ownerGuard, doc.ID, store.ManagedDocPatch{CommentMinRole: &edit, ExpectedPermissionsRevision: &rev}); err != nil {
		t.Fatal(err)
	}
	retry, err := st.AddCommentAttemptGuarded(ctx, guestGuard, key, c)
	if err != nil || retry.CommentID != initial.CommentID {
		t.Fatalf("existing receipt: %+v %v", retry, err)
	}
	if _, err = st.AddCommentAttemptGuarded(ctx, guestGuard, "abcdef0123456789abcdef0123456789", c); !errors.Is(err, store.ErrCommentPermissionDenied) {
		t.Fatalf("new attempt after revoke: %v", err)
	}
	if err = st.SetShare(ctx, doc.ID, guest.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = st.AddCommentAttemptGuarded(ctx, guestGuard, key, c); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("doc revoke: %v", err)
	}
}

func TestMemoryAttemptRetryAfterCommentPermissionRevoked(t *testing.T) {
	exerciseAttemptRetryAfterCommentPermissionRevoked(t, store.NewMemory())
}

func TestPostgresAttemptRetryAfterCommentPermissionRevoked(t *testing.T) {
	exerciseAttemptRetryAfterCommentPermissionRevoked(t, atomicPostgres(t))
}

func TestPostgresCommentAttemptReceiptFailureRollsBack(t *testing.T) {
	st := atomicPostgres(t)
	ctx := context.Background()
	_, doc, owner, guest, guard := guardedSharingFixture(t, st)
	if err := st.SetShare(ctx, doc.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	_, err := st.Pool.Exec(ctx, `CREATE FUNCTION fail_attempt_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt failure'; END $$; CREATE TRIGGER fail_attempt_receipt BEFORE INSERT ON comment_attempt_receipts FOR EACH ROW EXECUTE FUNCTION fail_attempt_receipt()`)
	if err != nil {
		t.Fatal(err)
	}
	key := "0123456789abcdef0123456789abcdef"
	c := store.Comment{DocID: doc.ID, UserID: owner.ID, Body: "must roll back", Mentions: []int64{guest.ID}}
	if _, err = st.AddCommentAttemptGuarded(ctx, guard, key, c); err == nil {
		t.Fatal("receipt failure accepted")
	}
	comments, err := st.Comments(ctx, doc.ID)
	if err != nil || len(comments) != 0 {
		t.Fatalf("partial comment: %+v %v", comments, err)
	}
	notices, err := st.Notifications(ctx, guest.ID, 50)
	if err != nil || len(notices) != 0 {
		t.Fatalf("partial notifications: %+v %v", notices, err)
	}
	if _, err = st.Pool.Exec(ctx, `DROP TRIGGER fail_attempt_receipt ON comment_attempt_receipts`); err != nil {
		t.Fatal(err)
	}
	result, err := st.AddCommentAttemptGuarded(ctx, guard, key, c)
	if err != nil || result.State != "committed" {
		t.Fatalf("retry after rollback: %+v %v", result, err)
	}
}
