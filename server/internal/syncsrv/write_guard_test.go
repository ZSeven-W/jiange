package syncsrv

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

type beforeGuardedAppend struct {
	store.DocStore
	once   sync.Once
	before func(store.RestoreGuard) error
	result chan error
}

func (s *beforeGuardedAppend) AppendOpsAtHeadGuarded(ctx context.Context, guard store.RestoreGuard, doc, head int64, ops []store.RawOp) ([]int64, error) {
	s.once.Do(func() { s.result <- s.before(guard) })
	return s.DocStore.AppendOpsAtHeadGuarded(ctx, guard, doc, head, ops)
}

func TestSyncWriteRejectsRevocationAtCommitBoundary(t *testing.T) {
	for _, event := range []string{"permission", "session"} {
		t.Run(event, func(t *testing.T) {
			ctx := context.Background()
			st := store.NewMemory()
			e := newEnv(t, st, 1000)
			doc := e.newDoc()
			// User 2 is outside the workspace and relies on an explicit grant.
			if err := st.SetShare(ctx, doc, e.users[2].ID, store.RoleEdit); err != nil {
				t.Fatal(err)
			}
			wrapped := &beforeGuardedAppend{DocStore: st, result: make(chan error, 1)}
			wrapped.before = func(guard store.RestoreGuard) error {
				if event == "session" {
					return st.DeleteSession(ctx, guard.SessionHash)
				}
				return st.SetShare(ctx, doc, e.users[2].ID, "")
			}
			e.hub.Store = wrapped
			owner, editor := e.client(0, doc), e.client(2, doc)
			before, err := st.Head(ctx, doc)
			if err != nil {
				t.Fatal(err)
			}
			editor.edit(typeAt("must not commit", func(n int) int { return n }))
			if err := <-wrapped.result; err != nil {
				t.Fatal(err)
			}
			select {
			case <-editor.done:
			case <-time.After(5 * time.Second):
				t.Fatal("revoked editor remained connected")
			}
			after, err := st.Head(ctx, doc)
			if err != nil || after != before {
				t.Fatalf("revoked operation persisted: %d -> %d, %v", before, after, err)
			}
			if isClosed(owner.done) {
				t.Fatal("other collaborator was disconnected")
			}
			owner.edit(typeAt("owner edit", func(n int) int { return n }))
			converge(t, st, doc, owner)
			if isClosed(owner.done) {
				t.Fatal("owner disconnected after valid edit")
			}
		})
	}
}

func TestHubRejectsMissingWriteGuard(t *testing.T) {
	// Serve must not allow production callers to create an unguarded socket.
	for _, guard := range []store.RestoreGuard{{}, {UserID: 1}, {UserID: 2, SessionHash: []byte("wrong-user")}} {
		w := httptest.NewRecorder()
		(&Hub{}).Serve(w, httptest.NewRequest(http.MethodGet, "/sync", nil), store.User{ID: 1}, nil, guard)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("unguarded handshake: %d", w.Code)
		}
	}
}
