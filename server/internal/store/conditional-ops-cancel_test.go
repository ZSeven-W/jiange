package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
)

type cancelTestStore interface {
	Store
	ConditionalOpsCommitter
	ConditionalTitleOpsCommitter
	ConditionalOpsStatusReader
	ConditionalOpsCanceller
}

func cancelTestOp(t *testing.T, client int64) RawOp {
	t.Helper()
	op := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: uint64(client), Clock: 1}, Parent: collab.Root, Pos: "V", Type: "paragraph"}
	raw, err := collab.EncodeOps([]collab.Op{op})
	if err != nil {
		t.Fatal(err)
	}
	return RawOp{ClientID: client, Clock: 1, Bytes: raw}
}
func checkConditionalCancellation(t *testing.T, st, committer cancelTestStore) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "cancel-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := st.CreateUser(ctx, "cancel-editor@test.dev", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	other, _, err := st.CreateUser(ctx, "cancel-other@test.dev", "Other", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "原名称", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, RoleEdit); err != nil {
		t.Fatal(err)
	}
	guard := RestoreGuard{UserID: editor.ID, SessionHash: []byte("cancel-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, editor.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	client, err := st.AllocClient(ctx, editor.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := st.AllocClient(ctx, other.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	epoch, head, err := st.HeadVersion(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	req := "11111111111111111111111111111111"
	ops := []RawOp{cancelTestOp(t, client)}
	digest, err := conditionalDigest(epoch, head, req, ops)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.CancelConditionalOps(ctx, guard, doc.ID, epoch, head+1, 1, client, req, digest); !errors.Is(err, ErrConflict) {
		t.Fatalf("future base head: %v", err)
	}
	if _, err = st.CancelConditionalOps(ctx, guard, doc.ID, epoch, head, 1, foreign, req, digest); !errors.Is(err, ErrForbidden) {
		t.Fatalf("foreign author: %v", err)
	}
	status, err := st.CancelConditionalOps(ctx, guard, doc.ID, epoch, head, 1, client, req, digest)
	if err != nil || status.State != "cancelled" || status.ClientID != client || status.Digest == "" {
		t.Fatalf("cancel: %+v %v", status, err)
	}
	again, err := st.CancelConditionalOps(ctx, guard, doc.ID, epoch, head, 1, client, req, digest)
	if err != nil || again.State != "cancelled" {
		t.Fatalf("retry cancel: %+v %v", again, err)
	}
	tampered := digest
	tampered[0] ^= 1
	if _, err = st.CancelConditionalOps(ctx, guard, doc.ID, epoch, head, 1, client, req, tampered); !errors.Is(err, ErrConflict) {
		t.Fatalf("tampered cancel: %v", err)
	}
	if _, err = st.CommitConditionalOps(ctx, guard, doc.ID, epoch, head, req, ops); !errors.Is(err, ErrConflict) {
		t.Fatalf("late commit: %v", err)
	}
	if _, err = st.CommitConditionalTitleOps(ctx, guard, doc.ID, epoch, head, req, ops, "原名称", "不应写入"); !errors.Is(err, ErrConflict) {
		t.Fatalf("late title commit: %v", err)
	}
	status, err = st.ConditionalOpsStatus(ctx, guard, doc.ID, req)
	if err != nil || status.State != "cancelled" {
		t.Fatalf("status: %+v %v", status, err)
	}
	meta, err := st.GetDocSystem(ctx, doc.ID)
	if err != nil || meta.Title != "原名称" {
		t.Fatalf("name changed: %+v %v", meta, err)
	}
	// Whichever transaction acquires the head lock first determines the only outcome.
	for i := 0; i < 20; i++ {
		id, err := st.AllocClient(ctx, editor.ID, doc.ID)
		if err != nil {
			t.Fatal(err)
		}
		ep, h, err := st.HeadVersion(ctx, doc.ID)
		if err != nil {
			t.Fatal(err)
		}
		key := fmt.Sprintf("%032x", i+2)
		batch := []RawOp{cancelTestOp(t, id)}
		sum, err := conditionalDigest(ep, h, key, batch)
		if err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		var cancelResult ConditionalOpsStatus
		var cancelErr, commitErr error
		var seqs []int64
		go func() {
			defer wg.Done()
			<-start
			cancelResult, cancelErr = st.CancelConditionalOps(ctx, guard, doc.ID, ep, h, 1, id, key, sum)
		}()
		go func() {
			defer wg.Done()
			<-start
			seqs, commitErr = committer.CommitConditionalOps(ctx, guard, doc.ID, ep, h, key, batch)
		}()
		close(start)
		wg.Wait()
		if cancelErr != nil {
			t.Fatalf("race cancellation: %v", cancelErr)
		}
		switch cancelResult.State {
		case "cancelled":
			if !errors.Is(commitErr, ErrConflict) || len(seqs) != 0 {
				t.Fatalf("cancelled yet committed: %v %v", seqs, commitErr)
			}
		case "committed":
			if commitErr != nil || len(seqs) != 1 {
				t.Fatalf("committed without receipt: %v %v", seqs, commitErr)
			}
		default:
			t.Fatalf("race status %q", cancelResult.State)
		}
		actual, err := st.ConditionalOpsStatus(ctx, guard, doc.ID, key)
		if err != nil || actual.State != cancelResult.State {
			t.Fatalf("race status mismatch %+v %v", actual, err)
		}
	}
	fresh, err := st.AllocClient(ctx, editor.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	ep, h, _ := st.HeadVersion(ctx, doc.ID)
	key := "ffffffffffffffffffffffffffffffff"
	batch := []RawOp{cancelTestOp(t, fresh)}
	sum, _ := conditionalDigest(ep, h, key, batch)
	if err = st.SetShare(ctx, doc.ID, editor.ID, RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CancelConditionalOps(ctx, guard, doc.ID, ep, h, 1, fresh, key, sum); !errors.Is(err, ErrForbidden) {
		t.Fatalf("revoked edit: %v", err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, RoleEdit); err != nil {
		t.Fatal(err)
	}
	expired := guard
	expired.Now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if _, err = st.CancelConditionalOps(ctx, expired, doc.ID, ep, h, 1, fresh, key, sum); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expired session: %v", err)
	}
	if status, err = st.ConditionalOpsStatus(ctx, guard, doc.ID, key); err != nil || status.State != "unknown" {
		t.Fatalf("failed cancellation persisted: %+v %v", status, err)
	}
	if err = st.BumpHistoryEpoch(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CancelConditionalOps(ctx, guard, doc.ID, ep, h, 1, fresh, key, sum); !errors.Is(err, ErrConflict) {
		t.Fatalf("old epoch: %v", err)
	}
	if status, err = st.ConditionalOpsStatus(ctx, guard, doc.ID, req); err != nil || status.State != "history_changed" {
		t.Fatalf("cancelled old epoch: %+v %v", status, err)
	}
}
func TestMemoryConditionalCancellation(t *testing.T) {
	st := NewMemory()
	checkConditionalCancellation(t, st, st)
}
func TestPostgresConditionalCancellation(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	pg, err := NewPostgres(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err = migrate.Up(context.Background(), pg.Pool); err != nil {
		t.Fatal(err)
	}
	other, err := NewPostgres(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	checkConditionalCancellation(t, pg, other)
}
