package store_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func exerciseRecordCommentAttempts(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "record-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := st.CreateUser(ctx, "record-guest@example.test", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := st.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Base")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, base.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("record-comment-owner")}
	if err := st.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	rows, err := st.Records(ctx, base.ID)
	if err != nil || len(rows) < 2 {
		t.Fatalf("rows: %v %v", rows, err)
	}
	rid := rows[0].ID
	attempts := st.(store.RecordCommentAttemptStore)
	if err := attempts.RecordCommentAttemptCapability(ctx, guard, base.ID, rid); err != nil {
		t.Fatal(err)
	}
	id := "0123456789abcdef0123456789abcdef"
	comment := store.Comment{DocID: base.ID, UserID: owner.ID, Block: fmt.Sprintf("record:%d", rid), Body: "once", Mentions: []int64{guest.ID}}
	wrong := comment
	wrong.UserID = guest.ID
	if _, err := attempts.AddRecordCommentAttempt(ctx, guard, base.ID, rid, id, wrong); !errors.Is(err, store.ErrCommentAttemptAccountChanged) {
		t.Fatalf("account mismatch: %v", err)
	}
	const n = 8
	results := make(chan store.RecordCommentAttemptResult, n)
	failures := make(chan error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, e := attempts.AddRecordCommentAttempt(ctx, guard, base.ID, rid, id, comment)
			results <- result
			failures <- e
		}()
	}
	wg.Wait()
	close(results)
	close(failures)
	for e := range failures {
		if e != nil {
			t.Fatalf("retry: %v", e)
		}
	}
	var cid int64
	for result := range results {
		if result.State != "committed" || result.CommentID <= 0 {
			t.Fatalf("receipt %+v", result)
		}
		if cid != 0 && result.CommentID != cid {
			t.Fatalf("duplicate %d %d", cid, result.CommentID)
		}
		cid = result.CommentID
	}
	comments, err := st.Comments(ctx, base.ID)
	if err != nil || len(comments) != 1 {
		t.Fatalf("comments=%+v err=%v", comments, err)
	}
	notices, err := st.Notifications(ctx, guest.ID, 50)
	if err != nil || len(notices) != 1 {
		t.Fatalf("notices=%+v err=%v", notices, err)
	}
	changed := comment
	changed.Body = "changed"
	if _, err := attempts.AddRecordCommentAttempt(ctx, guard, base.ID, rid, id, changed); !errors.Is(err, store.ErrCommentAttemptMismatch) {
		t.Fatalf("changed: %v", err)
	}
	other := comment
	other.Block = fmt.Sprintf("record:%d", rows[1].ID)
	if _, err := attempts.AddRecordCommentAttempt(ctx, guard, base.ID, rows[1].ID, id, other); !errors.Is(err, store.ErrCommentAttemptMismatch) {
		t.Fatalf("other record: %v", err)
	}
	lookup, err := attempts.GetRecordCommentAttempt(ctx, guard, base.ID, rid, id)
	if err != nil || lookup.CommentID != cid || lookup.State != "committed" {
		t.Fatalf("lookup=%+v err=%v", lookup, err)
	}
	lookup, err = attempts.GetRecordCommentAttempt(ctx, guard, base.ID, rows[1].ID, id)
	if err != nil || lookup.State != "unknown" || lookup.CommentID != 0 {
		t.Fatalf("wrong row lookup=%+v err=%v", lookup, err)
	}
	guestGuard := store.RestoreGuard{UserID: guest.ID, SessionHash: []byte("record-comment-guest")}
	if err := st.CreateSession(ctx, guestGuard.SessionHash, guest.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := attempts.GetRecordCommentAttempt(ctx, guestGuard, base.ID, rid, id); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer receipt access: %v", err)
	}
	if err := st.DeleteCommentGuarded(ctx, guard, base.ID, cid); err != nil {
		t.Fatal(err)
	}
	again, err := attempts.AddRecordCommentAttempt(ctx, guard, base.ID, rid, id, comment)
	if err != nil || again.State != "deleted" || again.CommentID != cid {
		t.Fatalf("tombstone=%+v err=%v", again, err)
	}
	if err := st.DeleteRecord(ctx, base.ID, rid); err != nil {
		t.Fatal(err)
	}
	again, err = attempts.AddRecordCommentAttempt(ctx, guard, base.ID, rid, id, comment)
	if err != nil || again.State != "deleted" || again.CommentID != cid {
		t.Fatalf("deleted record retry=%+v err=%v", again, err)
	}
	if err := st.DeleteSession(ctx, guard.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err := attempts.GetRecordCommentAttempt(ctx, guard, base.ID, rid, id); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("session=%v", err)
	}
}

func TestPostgresRecordCommentNotificationFailureRollsBack(t *testing.T) {
	st := atomicPostgres(t)
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "record-notice-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := st.CreateUser(ctx, "record-notice-guest@example.test", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := st.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Base")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, base.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("record-notice-session")}
	if err := st.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	rows, err := st.Records(ctx, base.ID)
	if err != nil || len(rows) == 0 {
		t.Fatal("missing rows", err)
	}
	rid := rows[0].ID
	id := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	c := store.Comment{DocID: base.ID, UserID: owner.ID, Block: fmt.Sprintf("record:%d", rid), Body: "notice rollback", Mentions: []int64{guest.ID}}
	if _, err := st.Pool.Exec(ctx, `CREATE FUNCTION fail_record_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected notice failure'; END $$; CREATE TRIGGER fail_record_notice BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION fail_record_notice()`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddRecordCommentAttempt(ctx, guard, base.ID, rid, id, c); err == nil {
		t.Fatal("notification failure must abort the write")
	}
	comments, err := st.Comments(ctx, base.ID)
	if err != nil || len(comments) != 0 {
		t.Fatalf("comments=%+v err=%v", comments, err)
	}
	status, err := st.GetRecordCommentAttempt(ctx, guard, base.ID, rid, id)
	if err != nil || status.State != "unknown" {
		t.Fatalf("receipt=%+v err=%v", status, err)
	}
	if _, err := st.Pool.Exec(ctx, `DROP TRIGGER fail_record_notice ON notifications`); err != nil {
		t.Fatal(err)
	}
	if result, err := st.AddRecordCommentAttempt(ctx, guard, base.ID, rid, id, c); err != nil || result.State != "committed" {
		t.Fatalf("retry=%+v err=%v", result, err)
	}
}

func TestMemoryRecordCommentAttempts(t *testing.T) {
	exerciseRecordCommentAttempts(t, store.NewMemory())
}
func TestPostgresRecordCommentAttempts(t *testing.T) {
	exerciseRecordCommentAttempts(t, atomicPostgres(t))
}

func TestPostgresRecordCommentReceiptFailureRollsBack(t *testing.T) {
	st := atomicPostgres(t)
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "record-rollback@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := st.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Base")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("record-comment-rollback")}
	if err := st.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	rows, err := st.Records(ctx, base.ID)
	if err != nil || len(rows) == 0 {
		t.Fatal("missing rows", err)
	}
	rid := rows[0].ID
	id := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	c := store.Comment{DocID: base.ID, UserID: owner.ID, Block: fmt.Sprintf("record:%d", rid), Body: "must roll back"}
	if _, err := st.Pool.Exec(ctx, `CREATE FUNCTION fail_record_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$; CREATE TRIGGER fail_record_receipt BEFORE INSERT ON record_comment_attempt_receipts FOR EACH ROW EXECUTE FUNCTION fail_record_receipt()`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddRecordCommentAttempt(ctx, guard, base.ID, rid, id, c); err == nil {
		t.Fatal("receipt failure must abort the write")
	}
	comments, err := st.Comments(ctx, base.ID)
	if err != nil || len(comments) != 0 {
		t.Fatalf("comments=%+v err=%v", comments, err)
	}
	if _, err := st.Pool.Exec(ctx, `DROP TRIGGER fail_record_receipt ON record_comment_attempt_receipts`); err != nil {
		t.Fatal(err)
	}
	result, err := st.AddRecordCommentAttempt(ctx, guard, base.ID, rid, id, c)
	if err != nil || result.State != "committed" || result.CommentID <= 0 {
		t.Fatalf("retry=%+v err=%v", result, err)
	}
}
