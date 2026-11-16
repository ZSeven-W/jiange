package store_test

import (
	"context"
	"encoding/hex"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type conditionalStatusStore interface {
	store.Store
	store.ConditionalOpsCommitter
	store.ConditionalOpsStatusReader
}

func checkConditionalOpsStatus(t *testing.T, st conditionalStatusStore) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "conditional-status-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := st.CreateUser(ctx, "conditional-status-editor@test.dev", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "status", nil)
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("conditional-status-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, editor.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	request := "abcdef0123456789abcdef0123456789"
	epoch, head, _ := st.HeadVersion(ctx, doc.ID)
	unknown, err := st.ConditionalOpsStatus(ctx, guard, doc.ID, request)
	if err != nil || unknown.State != "unknown" || unknown.CurrentEpoch != epoch || unknown.CurrentHead != head {
		t.Fatalf("unknown: %+v %v", unknown, err)
	}
	if _, err = st.CommitConditionalOps(ctx, guard, doc.ID, epoch, head, request, []store.RawOp{rawCreate(t, 7)}); err != nil {
		t.Fatal(err)
	}
	status, err := st.ConditionalOpsStatus(ctx, guard, doc.ID, request)
	if err != nil || status.State != "committed" || status.DocID != doc.ID || status.UserID != editor.ID || status.RequestID != request || status.Epoch != epoch || status.BaseHead != 0 || status.First != 1 || status.Count != 1 || status.CurrentHead != 1 {
		t.Fatalf("committed: %+v %v", status, err)
	}
	if digest, e := hex.DecodeString(status.Digest); e != nil || len(digest) != 32 {
		t.Fatalf("digest: %q %v", status.Digest, e)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if status, err = st.ConditionalOpsStatus(ctx, guard, doc.ID, request); err != nil || status.State != "committed" {
		t.Fatalf("view-only lookup: %+v %v", status, err)
	}
	if err = st.BumpHistoryEpoch(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	if status, err = st.ConditionalOpsStatus(ctx, guard, doc.ID, request); err != nil || status.State != "history_changed" || status.CurrentEpoch == status.Epoch {
		t.Fatalf("changed epoch: %+v %v", status, err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = st.ConditionalOpsStatus(ctx, guard, doc.ID, request); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("revoked lookup: %v", err)
	}
	if err = st.DeleteSession(ctx, guard.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = st.ConditionalOpsStatus(ctx, guard, doc.ID, request); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("logged-out lookup: %v", err)
	}
}

func TestMemoryConditionalOpsStatus(t *testing.T) { checkConditionalOpsStatus(t, store.NewMemory()) }

func TestPostgresConditionalOpsStatus(t *testing.T) {
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
	checkConditionalOpsStatus(t, pg)
}
