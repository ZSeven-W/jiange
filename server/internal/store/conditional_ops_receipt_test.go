package store_test

import (
	"context"
	"errors"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type conditionalOpsStore interface {
	store.Store
	store.ConditionalOpsCommitter
}

func checkConditionalOpsReceipt(t *testing.T, st conditionalOpsStore) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "conditional-receipt-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := st.CreateUser(ctx, "conditional-receipt-editor@test.dev", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "receipt", []store.RawOp{rawCreate(t, 1)})
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("conditional-receipt-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, editor.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	epoch, head, err := st.HeadVersion(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	request := "11111111111111111111111111111111"
	ops := []store.RawOp{rawCreate(t, 2), rawCreate(t, 3)}
	if _, err = st.LookupConditionalOps(ctx, guard, doc.ID, epoch, head, request, ops); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing receipt: %v", err)
	}
	if actual, err := st.Head(ctx, doc.ID); err != nil || actual != head {
		t.Fatalf("lookup changed head: %d %v", actual, err)
	}
	first, err := st.CommitConditionalOps(ctx, guard, doc.ID, epoch, head, request, ops)
	if err != nil || !reflect.DeepEqual(first, []int64{head + 1, head + 2}) {
		t.Fatalf("commit: %v %v", first, err)
	}
	if _, err = st.AppendOps(ctx, doc.ID, []store.RawOp{rawCreate(t, 4)}); err != nil {
		t.Fatal(err)
	}
	retry, err := st.CommitConditionalOps(ctx, guard, doc.ID, epoch, head, request, ops)
	if err != nil || !reflect.DeepEqual(retry, first) {
		t.Fatalf("retry after newer write: %v %v", retry, err)
	}
	lookup, err := st.LookupConditionalOps(ctx, guard, doc.ID, epoch, head, request, ops)
	if err != nil || !reflect.DeepEqual(lookup, first) {
		t.Fatalf("receipt lookup: %v %v", lookup, err)
	}
	if actual, err := st.Head(ctx, doc.ID); err != nil || actual != head+3 {
		t.Fatalf("retry changed head: %d %v", actual, err)
	}
	if _, err = st.CommitConditionalOps(ctx, guard, doc.ID, epoch, head, request, []store.RawOp{rawCreate(t, 2), rawCreate(t, 5)}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("changed request body: %v", err)
	}
	if _, err = st.LookupConditionalOps(ctx, guard, doc.ID, epoch, head, request, []store.RawOp{rawCreate(t, 2), rawCreate(t, 5)}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("changed lookup body: %v", err)
	}
	if _, err = st.CommitConditionalOps(ctx, guard, doc.ID, epoch, head+1, request, ops); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("changed base: %v", err)
	}
	other, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "other", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, other.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	otherEpoch, otherHead, err := st.HeadVersion(ctx, other.ID)
	if err != nil || otherHead != 0 {
		t.Fatalf("empty document head: %d %v", otherHead, err)
	}
	if seqs, err := st.CommitConditionalOps(ctx, guard, other.ID, otherEpoch, otherHead, request, []store.RawOp{rawCreate(t, 9)}); err != nil || !reflect.DeepEqual(seqs, []int64{1}) {
		t.Fatalf("same request on another document: %v %v", seqs, err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CommitConditionalOps(ctx, guard, doc.ID, epoch, head, request, ops); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("revoked retry: %v", err)
	}
	if _, err = st.LookupConditionalOps(ctx, guard, doc.ID, epoch, head, request, ops); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("revoked lookup: %v", err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err = st.BumpHistoryEpoch(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CommitConditionalOps(ctx, guard, doc.ID, epoch, head, request, ops); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("retry across epoch: %v", err)
	}
	epoch++
	head += 3

	// A failed batch must not leave a receipt or its earlier operations behind.
	request = "22222222222222222222222222222222"
	if _, err = st.CommitConditionalOps(ctx, guard, doc.ID, epoch, head, request, []store.RawOp{rawCreate(t, 6), rawCreate(t, 2)}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("duplicate operation: %v", err)
	}
	if actual, err := st.Head(ctx, doc.ID); err != nil || actual != head {
		t.Fatalf("partial failed batch: %d %v", actual, err)
	}
	newOps := []store.RawOp{rawCreate(t, 6)}
	if seqs, err := st.CommitConditionalOps(ctx, guard, doc.ID, epoch, head, request, newOps); err != nil || !reflect.DeepEqual(seqs, []int64{head + 1}) {
		t.Fatalf("retry after rejected batch: %v %v", seqs, err)
	}
	head++

	// Identical concurrent requests produce one durable batch and the same receipt.
	request = "33333333333333333333333333333333"
	concurrentOps := []store.RawOp{rawCreate(t, 7), rawCreate(t, 8)}
	start := make(chan struct{})
	type outcome struct {
		seqs []int64
		err  error
	}
	out := make(chan outcome, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			seqs, err := st.CommitConditionalOps(ctx, guard, doc.ID, epoch, head, request, concurrentOps)
			out <- outcome{seqs, err}
		}()
	}
	close(start)
	wg.Wait()
	close(out)
	for result := range out {
		if result.err != nil || !reflect.DeepEqual(result.seqs, []int64{head + 1, head + 2}) {
			t.Fatalf("concurrent retry: %v %v", result.seqs, result.err)
		}
	}
	head += 2
	if actual, err := st.Head(ctx, doc.ID); err != nil || actual != head {
		t.Fatalf("concurrent retry changed head: %d %v", actual, err)
	}
	request = "44444444444444444444444444444444"
	start = make(chan struct{})
	out = make(chan outcome, 2)
	variants := [][]store.RawOp{{rawCreate(t, 10)}, {rawCreate(t, 11)}}
	for i := range variants {
		wg.Add(1)
		go func(ops []store.RawOp) {
			defer wg.Done()
			<-start
			seqs, err := st.CommitConditionalOps(ctx, guard, doc.ID, epoch, head, request, ops)
			out <- outcome{seqs, err}
		}(variants[i])
	}
	close(start)
	wg.Wait()
	close(out)
	var successes, conflicts int
	for result := range out {
		if result.err == nil && reflect.DeepEqual(result.seqs, []int64{head + 1}) {
			successes++
		} else if errors.Is(result.err, store.ErrConflict) {
			conflicts++
		} else {
			t.Fatalf("concurrent different payloads: %v %v", result.seqs, result.err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("different payload outcomes: success=%d conflict=%d", successes, conflicts)
	}
	head++
	if actual, err := st.Head(ctx, doc.ID); err != nil || actual != head {
		t.Fatalf("concurrent payloads changed head: %d %v", actual, err)
	}
	if err = st.DeleteSession(ctx, guard.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CommitConditionalOps(ctx, guard, doc.ID, epoch, head-3, "33333333333333333333333333333333", concurrentOps); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("logged-out retry: %v", err)
	}
}

func TestMemoryConditionalOpsReceipt(t *testing.T) { checkConditionalOpsReceipt(t, store.NewMemory()) }

func TestPostgresConditionalOpsReceipt(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	pg, err := store.NewPostgres(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err = migrate.Up(context.Background(), pg.Pool); err != nil {
		t.Fatal(err)
	}
	checkConditionalOpsReceipt(t, pg)
}
