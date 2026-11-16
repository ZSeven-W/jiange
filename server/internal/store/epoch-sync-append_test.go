package store_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func checkSyncEpochFence(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	user, ws, err := st.CreateUser(ctx, fmt.Sprintf("epoch-sync-%d@test.dev", time.Now().UnixNano()), "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, user.ID, nil, "epoch", []store.RawOp{rawCreate(t, 1)})
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: user.ID, SessionHash: []byte(fmt.Sprintf("epoch-sync-%d", time.Now().UnixNano()))}
	if err = st.CreateSession(ctx, guard.SessionHash, user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	epoch, head, err := st.HeadVersion(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	op := rawCreate(t, 2)
	old := store.WithDocumentEpoch(ctx, epoch)
	if seq, err := st.AppendOpsAtHeadGuarded(old, guard, doc.ID, head, []store.RawOp{op}); err != nil || len(seq) != 1 || seq[0] != head+1 {
		t.Fatalf("valid: %v %v", seq, err)
	}
	head++
	if err := st.BumpHistoryEpoch(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	for _, batch := range [][]store.RawOp{{rawCreate(t, 3)}, {op}, nil} {
		if _, err := st.AppendOpsAtHeadGuarded(old, guard, doc.ID, head, batch); !errors.Is(err, store.ErrHistoryChanged) {
			t.Fatalf("stale epoch was accepted: %v", err)
		}
	}
	if got, err := st.Head(ctx, doc.ID); err != nil || got != head {
		t.Fatalf("stale append changed head: %d %v", got, err)
	}
	next := store.WithDocumentEpoch(ctx, epoch+1)
	if seq, err := st.AppendOpsAtHeadGuarded(next, guard, doc.ID, head, []store.RawOp{op}); err != nil || len(seq) != 1 || seq[0] != 0 {
		t.Fatalf("exact duplicate at new epoch: %v %v", seq, err)
	}
	if seq, err := st.AppendOpsAtHeadGuarded(next, guard, doc.ID, head, []store.RawOp{rawCreate(t, 3)}); err != nil || seq[0] != head+1 {
		t.Fatalf("current epoch: %v %v", seq, err)
	}
}
func TestMemorySyncEpochFence(t *testing.T) { checkSyncEpochFence(t, store.NewMemory()) }
func TestPostgresSyncEpochFence(t *testing.T) {
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
	checkSyncEpochFence(t, pg)
}
