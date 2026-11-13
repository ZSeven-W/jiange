package store_test

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type versionAppendStore interface {
	store.Store
	store.VersionGuardedAppender
}

func rawCreate(t *testing.T, client uint64) store.RawOp {
	t.Helper()
	op := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: client, Clock: 1}, Parent: collab.Root, Pos: "V", Type: "paragraph"}
	encoded, err := collab.EncodeOps([]collab.Op{op})
	if err != nil {
		t.Fatal(err)
	}
	return store.RawOp{ClientID: int64(client), Clock: 1, Bytes: encoded}
}

func checkVersionGuardedAppend(t *testing.T, st versionAppendStore) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "version-fence-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := st.CreateUser(ctx, "version-fence-editor@test.dev", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "fence", []store.RawOp{rawCreate(t, 1)})
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("version-fence-session")}
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
	result, err := st.AppendOpsAtVersionGuarded(ctx, guard, doc.ID, epoch, head, []store.RawOp{rawCreate(t, 2)})
	if err != nil || len(result) != 1 || result[0] != head+1 {
		t.Fatalf("valid append: %v %v", result, err)
	}
	head++
	if _, err = st.AppendOpsAtVersionGuarded(ctx, guard, doc.ID, epoch, head-1, []store.RawOp{rawCreate(t, 3)}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale head: %v", err)
	}
	if err = st.BumpHistoryEpoch(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = st.AppendOpsAtVersionGuarded(ctx, guard, doc.ID, epoch, head, []store.RawOp{rawCreate(t, 3)}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("same head, stale epoch: %v", err)
	}
	epoch++
	if _, err = st.AppendOpsAtVersionGuarded(ctx, guard, doc.ID, epoch, head, []store.RawOp{rawCreate(t, 3), rawCreate(t, 2)}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("duplicate batch: %v", err)
	}
	if actual, err := st.Head(ctx, doc.ID); err != nil || actual != head {
		t.Fatalf("partial append: %d %v", actual, err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = st.AppendOpsAtVersionGuarded(ctx, guard, doc.ID, epoch, head, []store.RawOp{rawCreate(t, 3)}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("revoked access: %v", err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	calls := 0
	expiring := guard
	expiring.Now = func() time.Time {
		calls++
		if calls > 1 {
			return time.Now().Add(2 * time.Hour)
		}
		return time.Now()
	}
	if _, err = st.AppendOpsAtVersionGuarded(ctx, expiring, doc.ID, epoch, head, []store.RawOp{rawCreate(t, 3)}); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expired during append: %v", err)
	}
	if actual, err := st.Head(ctx, doc.ID); err != nil || actual != head {
		t.Fatalf("expired append changed head: %d %v", actual, err)
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	errorsSeen := make(chan error, 2)
	ops := []store.RawOp{rawCreate(t, 4), rawCreate(t, 5)}
	for i := range ops {
		wg.Add(1)
		go func(op store.RawOp) {
			defer wg.Done()
			<-start
			_, e := st.AppendOpsAtVersionGuarded(ctx, guard, doc.ID, epoch, head, []store.RawOp{op})
			errorsSeen <- e
		}(ops[i])
	}
	close(start)
	wg.Wait()
	close(errorsSeen)
	var success, conflict int
	for err := range errorsSeen {
		if err == nil {
			success++
		} else if errors.Is(err, store.ErrConflict) {
			conflict++
		} else {
			t.Fatalf("concurrent append: %v", err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("concurrent outcomes: success=%d conflict=%d", success, conflict)
	}
	if actual, err := st.Head(ctx, doc.ID); err != nil || actual != head+1 {
		t.Fatalf("concurrent head: %d %v", actual, err)
	}
	head++
	ordinary, conditional := rawCreate(t, 6), rawCreate(t, 7)
	start = make(chan struct{})
	results := make(chan struct {
		conditional bool
		err         error
	}, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		_, e := st.AppendOps(ctx, doc.ID, []store.RawOp{ordinary})
		results <- struct {
			conditional bool
			err         error
		}{false, e}
	}()
	go func() {
		defer wg.Done()
		<-start
		_, e := st.AppendOpsAtVersionGuarded(ctx, guard, doc.ID, epoch, head, []store.RawOp{conditional})
		results <- struct {
			conditional bool
			err         error
		}{true, e}
	}()
	close(start)
	wg.Wait()
	close(results)
	var conditionalOK bool
	for result := range results {
		if !result.conditional && result.err != nil {
			t.Fatalf("ordinary append: %v", result.err)
		}
		if result.conditional {
			if result.err == nil {
				conditionalOK = true
			} else if !errors.Is(result.err, store.ErrConflict) {
				t.Fatalf("conditional append: %v", result.err)
			}
		}
	}
	if conditionalOK {
		head += 2
	} else {
		head++
	}
	if actual, err := st.Head(ctx, doc.ID); err != nil || actual != head {
		t.Fatalf("ordinary race head: %d want %d %v", actual, head, err)
	}

	start = make(chan struct{})
	results = make(chan struct {
		conditional bool
		err         error
	}, 2)
	op := rawCreate(t, 8)
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		e := st.DeleteSession(ctx, guard.SessionHash)
		results <- struct {
			conditional bool
			err         error
		}{false, e}
	}()
	go func() {
		defer wg.Done()
		<-start
		_, e := st.AppendOpsAtVersionGuarded(ctx, guard, doc.ID, epoch, head, []store.RawOp{op})
		results <- struct {
			conditional bool
			err         error
		}{true, e}
	}()
	close(start)
	wg.Wait()
	close(results)
	conditionalOK = false
	for result := range results {
		if !result.conditional && result.err != nil {
			t.Fatalf("delete session: %v", result.err)
		}
		if result.conditional {
			if result.err == nil {
				conditionalOK = true
			} else if !errors.Is(result.err, store.ErrUnauthenticated) {
				t.Fatalf("session race: %v", result.err)
			}
		}
	}
	if conditionalOK {
		head++
	}
	if actual, err := st.Head(ctx, doc.ID); err != nil || actual != head {
		t.Fatalf("session race head: %d want %d %v", actual, head, err)
	}
	if _, err = st.AppendOpsAtVersionGuarded(ctx, guard, doc.ID, epoch, head, []store.RawOp{rawCreate(t, 9)}); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("logged-out session: %v", err)
	}
}

func TestMemoryVersionGuardedAppend(t *testing.T) { checkVersionGuardedAppend(t, store.NewMemory()) }

func TestPostgresVersionGuardedAppend(t *testing.T) {
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
	checkVersionGuardedAppend(t, pg)
}
