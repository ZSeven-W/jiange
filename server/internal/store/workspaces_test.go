package store_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type workspaceManagerTestStore interface {
	store.Store
	store.WorkspaceManagerStore
}

func exerciseWorkspaceManager(t *testing.T, st workspaceManagerTestStore) {
	t.Helper()
	ctx := context.Background()

	alice, personalWS, err := st.CreateUser(ctx, "ws-alice@example.test", "Alice", "hash")
	if err != nil {
		t.Fatal(err)
	}
	bob, bobWS, err := st.CreateUser(ctx, "ws-bob@example.test", "Bob", "hash")
	if err != nil {
		t.Fatal(err)
	}

	// Validation: invalid owner ID, missing user, empty/whitespace, >80 runes, control chars.
	if _, err := st.CreateWorkspace(ctx, 0, "Valid"); !errors.Is(err, store.ErrInvalidInput) {
		t.Fatalf("ownerID=0 expected ErrInvalidInput, got %v", err)
	}
	if _, err := st.CreateWorkspace(ctx, 999999, "Valid"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing owner expected ErrNotFound, got %v", err)
	}
	for _, bad := range []string{"", "   \t  ", strings.Repeat("空", store.MaxWorkspaceNameRunes+1), "Bad\nName", "Bad\x00Name"} {
		if _, err := st.CreateWorkspace(ctx, alice.ID, bad); !errors.Is(err, store.ErrInvalidInput) {
			t.Fatalf("bad name %q expected ErrInvalidInput, got %v", bad, err)
		}
	}

	// Exact 80-rune Unicode name with surrounding whitespace succeeds and trims cleanly.
	exact80 := strings.Repeat("研", store.MaxWorkspaceNameRunes)
	created, err := st.CreateWorkspace(ctx, alice.ID, "  "+exact80+"  ")
	if err != nil {
		t.Fatalf("create 80-rune workspace: %v", err)
	}
	if created.ID <= 0 || created.ID == personalWS.ID {
		t.Fatalf("unexpected created workspace id: %+v", created)
	}
	if created.Name != exact80 {
		t.Fatalf("expected trimmed name %q, got %q", exact80, created.Name)
	}
	if created.OwnerID != alice.ID {
		t.Fatalf("expected owner %d, got %d", alice.ID, created.OwnerID)
	}

	// Verify membership and owner role are atomically persisted.
	aliceList, err := st.Workspaces(ctx, alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(aliceList) != 2 || aliceList[0].ID != personalWS.ID || aliceList[1].ID != created.ID {
		t.Fatalf("unexpected alice workspaces: %+v", aliceList)
	}

	guard := store.RestoreGuard{UserID: alice.ID, SessionHash: []byte("ws-alice-sess")}
	if err := st.CreateSession(ctx, guard.SessionHash, alice.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	orgSnap, err := st.GetWorkspaceOrg(ctx, guard, created.ID)
	if err != nil {
		t.Fatalf("GetWorkspaceOrg: %v", err)
	}
	if orgSnap.CallerRole != store.WorkspaceRoleOwner {
		t.Fatalf("expected owner role on created workspace, got %q", orgSnap.CallerRole)
	}
	if len(orgSnap.Members) != 1 || orgSnap.Members[0].UserID != alice.ID || orgSnap.Members[0].Role != store.WorkspaceRoleOwner {
		t.Fatalf("unexpected members on created workspace: %+v", orgSnap.Members)
	}

	// Other user cannot see Alice's workspace.
	bobList, err := st.Workspaces(ctx, bob.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(bobList) != 1 || bobList[0].ID != bobWS.ID {
		t.Fatalf("unexpected bob workspaces: %+v", bobList)
	}

	// Joining another user's workspace as a member does not count against Alice's owned-workspace cap.
	if err := st.AddWorkspaceMember(ctx, bobWS.ID, alice.ID); err != nil {
		t.Fatal(err)
	}

	// Alice already owns 2 workspaces (personalWS + created); create 18 more to reach MaxOwnedWorkspaces (20).
	for i := 3; i <= store.MaxOwnedWorkspaces; i++ {
		w, err := st.CreateWorkspace(ctx, alice.ID, fmt.Sprintf("工作空间 #%d", i))
		if err != nil {
			t.Fatalf("create workspace #%d: %v", i, err)
		}
		if w.OwnerID != alice.ID {
			t.Fatalf("workspace #%d wrong owner: %+v", i, w)
		}
	}

	// 21st owned workspace must be rejected with ErrWorkspaceLimitReached (wrapping ErrConflict).
	if _, err := st.CreateWorkspace(ctx, alice.ID, "超出上限的工作空间"); !errors.Is(err, store.ErrWorkspaceLimitReached) || !errors.Is(err, store.ErrConflict) {
		t.Fatalf("expected ErrWorkspaceLimitReached/ErrConflict on 21st owned workspace, got %v", err)
	}
}

func TestWorkspaceManagerMemory(t *testing.T) {
	exerciseWorkspaceManager(t, store.NewMemory())
}

func TestWorkspaceManagerPostgres(t *testing.T) {
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
	exerciseWorkspaceManager(t, pg)
}
