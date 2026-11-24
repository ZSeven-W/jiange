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

func exerciseWorkspaceLifecycle(t *testing.T, st workspaceManagerTestStore) {
	t.Helper()
	ctx := context.Background()

	alice, alicePersonal, err := st.CreateUser(ctx, "life-alice@example.test", "Alice", "hash")
	if err != nil {
		t.Fatal(err)
	}
	bob, bobPersonal, err := st.CreateUser(ctx, "life-bob@example.test", "Bob", "hash")
	if err != nil {
		t.Fatal(err)
	}
	carol, _, err := st.CreateUser(ctx, "life-carol@example.test", "Carol", "hash")
	if err != nil {
		t.Fatal(err)
	}

	aliceGuard := store.RestoreGuard{UserID: alice.ID, SessionHash: []byte("life-alice-sess")}
	if err := st.CreateSession(ctx, aliceGuard.SessionHash, alice.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	bobGuard := store.RestoreGuard{UserID: bob.ID, SessionHash: []byte("life-bob-sess")}
	if err := st.CreateSession(ctx, bobGuard.SessionHash, bob.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	teamWS, err := st.CreateWorkspace(ctx, alice.ID, "核心研发空间")
	if err != nil {
		t.Fatal(err)
	}
	// Create a third workspace after teamWS to ensure deleting teamWS keeps later IDs intact.
	afterWS, err := st.CreateWorkspace(ctx, alice.ID, "后续保留空间")
	if err != nil {
		t.Fatal(err)
	}

	// Add Bob as member and Carol as admin of teamWS.
	if err := st.AddWorkspaceMember(ctx, teamWS.ID, bob.ID); err != nil {
		t.Fatal(err)
	}
	if err := st.AddWorkspaceMember(ctx, teamWS.ID, carol.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertWorkspaceMemberGuarded(ctx, aliceGuard, teamWS.ID, carol.Email, store.WorkspaceRoleAdmin); err != nil {
		t.Fatal(err)
	}

	// --- RenameWorkspace ---
	if _, err := st.RenameWorkspace(ctx, 0, teamWS.ID, "Valid"); !errors.Is(err, store.ErrInvalidInput) {
		t.Fatalf("rename actor=0 want ErrInvalidInput, got %v", err)
	}
	if _, err := st.RenameWorkspace(ctx, alice.ID, 0, "Valid"); !errors.Is(err, store.ErrInvalidInput) {
		t.Fatalf("rename ws=0 want ErrInvalidInput, got %v", err)
	}
	for _, bad := range []string{"", "   ", strings.Repeat("名", store.MaxWorkspaceNameRunes+1), "Bad\nName"} {
		if _, err := st.RenameWorkspace(ctx, alice.ID, teamWS.ID, bad); !errors.Is(err, store.ErrInvalidInput) {
			t.Fatalf("rename bad %q want ErrInvalidInput, got %v", bad, err)
		}
	}
	if _, err := st.RenameWorkspace(ctx, alice.ID, 999999, "Missing"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("rename missing ws want ErrNotFound, got %v", err)
	}
	// Regular member cannot rename.
	if _, err := st.RenameWorkspace(ctx, bob.ID, teamWS.ID, "Bob Renamed"); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("member rename want ErrForbidden, got %v", err)
	}
	// Admin CAN rename and trims whitespace.
	renamedByAdmin, err := st.RenameWorkspace(ctx, carol.ID, teamWS.ID, "  管理员重命名空间  ")
	if err != nil {
		t.Fatalf("admin rename: %v", err)
	}
	if renamedByAdmin.ID != teamWS.ID || renamedByAdmin.Name != "管理员重命名空间" || renamedByAdmin.OwnerID != alice.ID {
		t.Fatalf("unexpected renamed workspace: %+v", renamedByAdmin)
	}
	// Owner CAN rename up to MaxWorkspaceNameRunes.
	maxName := strings.Repeat("空", store.MaxWorkspaceNameRunes)
	renamedByOwner, err := st.RenameWorkspace(ctx, alice.ID, teamWS.ID, " "+maxName+" ")
	if err != nil || renamedByOwner.Name != maxName {
		t.Fatalf("owner rename max runes: ws=%+v err=%v", renamedByOwner, err)
	}

	// --- TransferWorkspaceOwner ---
	if err := st.TransferWorkspaceOwner(ctx, alice.ID, teamWS.ID, alice.ID); !errors.Is(err, store.ErrInvalidInput) {
		t.Fatalf("transfer to self want ErrInvalidInput, got %v", err)
	}
	if err := st.TransferWorkspaceOwner(ctx, alice.ID, 999999, bob.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("transfer missing ws want ErrNotFound, got %v", err)
	}
	// Admin cannot transfer ownership.
	if err := st.TransferWorkspaceOwner(ctx, carol.ID, teamWS.ID, bob.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("admin transfer want ErrForbidden, got %v", err)
	}
	// Cannot transfer to a non-member (Bob is not in afterWS).
	if err := st.TransferWorkspaceOwner(ctx, alice.ID, afterWS.ID, bob.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("transfer to non-member want ErrNotFound, got %v", err)
	}
	// Owner transfers teamWS to Bob -> Bob becomes owner, Alice becomes admin.
	if err := st.TransferWorkspaceOwner(ctx, alice.ID, teamWS.ID, bob.ID); err != nil {
		t.Fatalf("transfer owner to bob: %v", err)
	}
	orgAfterTransfer, err := st.GetWorkspaceOrg(ctx, bobGuard, teamWS.ID)
	if err != nil {
		t.Fatalf("GetWorkspaceOrg after transfer: %v", err)
	}
	if orgAfterTransfer.CallerRole != store.WorkspaceRoleOwner {
		t.Fatalf("expected bob role owner, got %q", orgAfterTransfer.CallerRole)
	}
	roles := map[int64]string{}
	for _, mem := range orgAfterTransfer.Members {
		roles[mem.UserID] = mem.Role
	}
	if roles[bob.ID] != store.WorkspaceRoleOwner || roles[alice.ID] != store.WorkspaceRoleAdmin || roles[carol.ID] != store.WorkspaceRoleAdmin {
		t.Fatalf("unexpected roles after transfer: %+v", roles)
	}
	bobWorkspaces, err := st.Workspaces(ctx, bob.ID)
	if err != nil {
		t.Fatal(err)
	}
	foundOwnedTeam := false
	for _, w := range bobWorkspaces {
		if w.ID == teamWS.ID && w.OwnerID == bob.ID {
			foundOwnedTeam = true
		}
	}
	if !foundOwnedTeam {
		t.Fatalf("expected workspaces.owner_id updated to bob (%d), got %+v", bob.ID, bobWorkspaces)
	}
	// Old owner (now admin) can still rename, but cannot delete or transfer ownership.
	if _, err := st.RenameWorkspace(ctx, alice.ID, teamWS.ID, "交接后的研发空间"); err != nil {
		t.Fatalf("demoted admin rename: %v", err)
	}
	if err := st.TransferWorkspaceOwner(ctx, alice.ID, teamWS.ID, carol.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("demoted admin transfer want ErrForbidden, got %v", err)
	}
	if err := st.DeleteWorkspace(ctx, alice.ID, teamWS.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("demoted admin delete want ErrForbidden, got %v", err)
	}

	// --- LeaveWorkspace ---
	if err := st.LeaveWorkspace(ctx, 0, teamWS.ID); !errors.Is(err, store.ErrInvalidInput) {
		t.Fatalf("leave actor=0 want ErrInvalidInput, got %v", err)
	}
	if err := st.LeaveWorkspace(ctx, alice.ID, 999999); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("leave missing ws want ErrNotFound, got %v", err)
	}
	// Bob (new owner) cannot leave teamWS.
	if err := st.LeaveWorkspace(ctx, bob.ID, teamWS.ID); !errors.Is(err, store.ErrOwnerCannotLeave) || !errors.Is(err, store.ErrConflict) {
		t.Fatalf("owner leave want ErrOwnerCannotLeave, got %v", err)
	}
	// Non-member (Bob on afterWS) cannot leave.
	if err := st.LeaveWorkspace(ctx, bob.ID, afterWS.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("non-member leave want ErrForbidden, got %v", err)
	}
	// Carol (admin with 2 workspaces) leaves teamWS cleanly.
	if err := st.LeaveWorkspace(ctx, carol.ID, teamWS.ID); err != nil {
		t.Fatalf("carol leave teamWS: %v", err)
	}
	carolList, err := st.Workspaces(ctx, carol.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(carolList) != 1 || carolList[0].ID == teamWS.ID {
		t.Fatalf("expected carol removed from teamWS, got %+v", carolList)
	}
	// Verify ErrLastWorkspace on LeaveWorkspace: add Alice to bobPersonal, transfer bobPersonal to Alice,
	// delete Bob's teamWS so Bob ONLY has bobPersonal as admin -> Bob cannot leave his last workspace.
	if err := st.AddWorkspaceMember(ctx, bobPersonal.ID, alice.ID); err != nil {
		t.Fatal(err)
	}
	if err := st.TransferWorkspaceOwner(ctx, bob.ID, bobPersonal.ID, alice.ID); err != nil {
		t.Fatal(err)
	}

	// --- DeleteWorkspace ---
	// Non-owner cannot delete.
	if err := st.DeleteWorkspace(ctx, alice.ID, teamWS.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("non-owner delete want ErrForbidden, got %v", err)
	}
	// Create a doc inside teamWS to verify cascading/purging on delete.
	docInTeam, err := st.CreateDoc(ctx, teamWS.ID, bob.ID, nil, "将被删除的文档", nil)
	if err != nil {
		t.Fatal(err)
	}
	// Bob currently belongs to bobPersonal (admin) and teamWS (owner), so Bob CAN delete teamWS.
	if err := st.DeleteWorkspace(ctx, bob.ID, teamWS.ID); err != nil {
		t.Fatalf("bob delete teamWS: %v", err)
	}
	// Deleted workspace is gone from both Bob's and Alice's lists; subsequent ops return ErrNotFound.
	if _, err := st.RenameWorkspace(ctx, bob.ID, teamWS.ID, "Ghost"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("rename deleted ws want ErrNotFound, got %v", err)
	}
	if err := st.DeleteWorkspace(ctx, bob.ID, teamWS.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete deleted ws want ErrNotFound, got %v", err)
	}
	if err := st.LeaveWorkspace(ctx, alice.ID, teamWS.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("leave deleted ws want ErrNotFound, got %v", err)
	}
	bobDocs, err := st.ListDocs(ctx, bob.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range bobDocs {
		if d.ID == docInTeam.ID {
			t.Fatalf("expected doc %d in deleted workspace to be removed, still in ListDocs", docInTeam.ID)
		}
	}

	// Bob now has ONLY 1 workspace (bobPersonal, where Bob is admin) -> LeaveWorkspace must reject with ErrLastWorkspace.
	if err := st.LeaveWorkspace(ctx, bob.ID, bobPersonal.ID); !errors.Is(err, store.ErrLastWorkspace) || !errors.Is(err, store.ErrConflict) {
		t.Fatalf("leave last workspace want ErrLastWorkspace, got %v", err)
	}

	// Carol has ONLY 1 workspace (her personal workspace, owned by Carol) -> DeleteWorkspace must reject with ErrLastWorkspace.
	if err := st.DeleteWorkspace(ctx, carol.ID, carolList[0].ID); !errors.Is(err, store.ErrLastWorkspace) || !errors.Is(err, store.ErrConflict) {
		t.Fatalf("delete last workspace want ErrLastWorkspace, got %v", err)
	}

	// Alice's workspaces created before AND after deleted teamWS remain completely intact.
	aliceList, err := st.Workspaces(ctx, alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	wantIDs := map[int64]bool{alicePersonal.ID: true, afterWS.ID: true, bobPersonal.ID: true}
	if len(aliceList) != len(wantIDs) {
		t.Fatalf("unexpected alice workspaces after delete: %+v", aliceList)
	}
	for _, w := range aliceList {
		if !wantIDs[w.ID] {
			t.Fatalf("unexpected workspace in alice list: %+v", w)
		}
	}
	// Verify afterWS (ID > deleted teamWS.ID) can still be renamed cleanly.
	if _, err := st.RenameWorkspace(ctx, alice.ID, afterWS.ID, "后续空间仍可编辑"); err != nil {
		t.Fatalf("rename workspace after deleted slot: %v", err)
	}
}

func TestWorkspaceManagerMemory(t *testing.T) {
	exerciseWorkspaceManager(t, store.NewMemory())
}

func TestWorkspaceLifecycleMemory(t *testing.T) {
	exerciseWorkspaceLifecycle(t, store.NewMemory())
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
	exerciseWorkspaceLifecycle(t, pg)
}
