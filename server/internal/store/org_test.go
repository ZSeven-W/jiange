package store_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func exerciseOrgPermissions(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	exp := time.Now().Add(time.Hour)

	owner, ws, err := st.CreateUser(ctx, "org-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	alice, _, err := st.CreateUser(ctx, "org-alice@example.test", "Alice", "hash")
	if err != nil {
		t.Fatal(err)
	}
	bob, _, err := st.CreateUser(ctx, "org-bob@example.test", "Bob", "hash")
	if err != nil {
		t.Fatal(err)
	}
	outsider, otherWS, err := st.CreateUser(ctx, "org-out@example.test", "Outsider", "hash")
	if err != nil {
		t.Fatal(err)
	}

	makeGuard := func(u store.User, tag string) store.RestoreGuard {
		g := store.RestoreGuard{UserID: u.ID, SessionHash: []byte("org-sess-" + tag)}
		if e := st.CreateSession(ctx, g.SessionHash, u.ID, exp); e != nil {
			t.Fatal(e)
		}
		return g
	}
	ownerGuard := makeGuard(owner, "owner")
	aliceGuard := makeGuard(alice, "alice")
	bobGuard := makeGuard(bob, "bob")
	outsiderGuard := makeGuard(outsider, "outsider")

	// Outsider cannot read workspace org directory.
	if _, err := st.GetWorkspaceOrg(ctx, outsiderGuard, ws.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("outsider GetWorkspaceOrg = %v, want ErrForbidden", err)
	}

	// Owner invites Alice and Bob; joining requires their consent.
	invite := func(u store.User) int64 {
		change, err := st.UpsertWorkspaceMemberGuarded(ctx, ownerGuard, ws.ID, u.Email, store.WorkspaceRoleMember)
		if err != nil || change.Status != store.MemberChangeInvited || change.Invitation == nil || change.Member != nil {
			t.Fatalf("invite %s = %+v err=%v", u.Email, change, err)
		}
		return change.Invitation.ID
	}
	aliceInvite, bobInvite := invite(alice), invite(bob)
	if _, err := st.GetWorkspaceOrg(ctx, aliceGuard, ws.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("invitee joined before accepting: %v", err)
	}
	// Unregistered email: identical outcome, nothing reveals account existence.
	ghost, err := st.UpsertWorkspaceMemberGuarded(ctx, ownerGuard, ws.ID, "  Ghost@Example.Test ", store.WorkspaceRoleAdmin)
	if err != nil || ghost.Status != store.MemberChangeInvited || ghost.Invitation == nil || ghost.Invitation.Email != "ghost@example.test" {
		t.Fatalf("unregistered invite = %+v err=%v", ghost, err)
	}
	if err := st.RespondInvitationGuarded(ctx, bobGuard, aliceInvite, true); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("bob accepting alice's invitation = %v, want ErrNotFound", err)
	}
	mine, err := st.ListMyInvitations(ctx, aliceGuard)
	if err != nil || len(mine) != 1 || mine[0].ID != aliceInvite || mine[0].WorkspaceName == "" {
		t.Fatalf("alice invitations = %+v err=%v", mine, err)
	}
	// Declining consumes the invitation without joining; a re-invite works.
	if err := st.RespondInvitationGuarded(ctx, bobGuard, bobInvite, false); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetWorkspaceOrg(ctx, bobGuard, ws.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("declined invitee joined: %v", err)
	}
	bobInvite = invite(bob)
	for _, tc := range []struct {
		g  store.RestoreGuard
		id int64
	}{{aliceGuard, aliceInvite}, {bobGuard, bobInvite}} {
		if err := st.RespondInvitationGuarded(ctx, tc.g, tc.id, true); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.RespondInvitationGuarded(ctx, aliceGuard, aliceInvite, true); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("reusing consumed invitation = %v, want ErrNotFound", err)
	}
	ownerSnap, err := st.GetWorkspaceOrg(ctx, ownerGuard, ws.ID)
	if err != nil || len(ownerSnap.Members) != 3 || len(ownerSnap.Invitations) != 1 || ownerSnap.Invitations[0].ID != ghost.Invitation.ID {
		t.Fatalf("owner snapshot after accept = %+v err=%v", ownerSnap, err)
	}
	if aliceSnap, err := st.GetWorkspaceOrg(ctx, aliceGuard, ws.ID); err != nil || len(aliceSnap.Invitations) != 0 {
		t.Fatalf("member must not see pending invitations: %+v err=%v", aliceSnap.Invitations, err)
	}
	if err := st.RevokeInvitationGuarded(ctx, aliceGuard, ws.ID, ghost.Invitation.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("member revoke = %v, want ErrForbidden", err)
	}
	if err := st.RevokeInvitationGuarded(ctx, ownerGuard, ws.ID, ghost.Invitation.ID); err != nil {
		t.Fatal(err)
	}
	// Existing member: same call changes the role directly.
	if change, err := st.UpsertWorkspaceMemberGuarded(ctx, ownerGuard, ws.ID, alice.Email, store.WorkspaceRoleMember); err != nil || change.Status != store.MemberChangeUpdated || change.Member == nil || change.Member.UserID != alice.ID {
		t.Fatalf("role update for member = %+v err=%v", change, err)
	}
	// Regular member cannot mutate org structure.
	if _, err := st.CreateDepartmentGuarded(ctx, aliceGuard, ws.ID, nil, "Denied", 0); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("member CreateDepartment = %v, want ErrForbidden", err)
	}

	// Cannot remove or demote workspace owner.
	if _, err := st.UpsertWorkspaceMemberGuarded(ctx, ownerGuard, ws.ID, owner.Email, store.WorkspaceRoleMember); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("demote owner = %v, want ErrForbidden", err)
	}

	// Build hierarchical department tree: 研发中心 -> 前端组 -> 协同引擎小组, plus 市场部.
	rnd, err := st.CreateDepartmentGuarded(ctx, ownerGuard, ws.ID, nil, "研发中心", 1)
	if err != nil {
		t.Fatal(err)
	}
	fe, err := st.CreateDepartmentGuarded(ctx, ownerGuard, ws.ID, &rnd.ID, "前端组", 1)
	if err != nil {
		t.Fatal(err)
	}
	collabDept, err := st.CreateDepartmentGuarded(ctx, ownerGuard, ws.ID, &fe.ID, "协同引擎小组", 1)
	if err != nil {
		t.Fatal(err)
	}
	mkt, err := st.CreateDepartmentGuarded(ctx, ownerGuard, ws.ID, nil, "市场部", 2)
	if err != nil {
		t.Fatal(err)
	}
	// Reject department cycle (moving root under grandchild).
	if _, err := st.UpdateDepartmentGuarded(ctx, ownerGuard, ws.ID, rnd.ID, &collabDept.ID, true, nil, nil); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("department cycle = %v, want ErrConflict", err)
	}

	// Place Alice in leaf sub-department (协同引擎小组) as non-leader (isLeader=false), Bob in 市场部.
	// Also test promoting Alice to leader and non-leader inheritance both work.
	if err := st.SetDepartmentMemberGuarded(ctx, ownerGuard, ws.ID, collabDept.ID, alice.ID, true, false); err != nil {
		t.Fatal(err)
	}
	if err := st.SetDepartmentMemberGuarded(ctx, ownerGuard, ws.ID, mkt.ID, bob.ID, true, false); err != nil {
		t.Fatal(err)
	}
	// Cannot add non-workspace member to department.
	if err := st.SetDepartmentMemberGuarded(ctx, ownerGuard, ws.ID, rnd.ID, outsider.ID, true, false); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("non-member SetDepartmentMember = %v, want ErrConflict", err)
	}

	// Create foreign department to verify cross-workspace grant rejection.
	foreignDept, err := st.CreateDepartmentGuarded(ctx, outsiderGuard, otherWS.ID, nil, "外部部门", 1)
	if err != nil {
		t.Fatal(err)
	}

	// Create folder "保密项目" + child doc "薪酬与架构" + open root doc "公开文档".
	secretFolder, err := st.CreateDriveFolder(ctx, ownerGuard, ws.ID, nil, "保密项目", false)
	if err != nil {
		t.Fatal(err)
	}
	secretDoc, err := st.CreateDriveNode(ctx, ownerGuard, ws.ID, &secretFolder.ID, "doc", "薪酬与架构", false)
	if err != nil {
		t.Fatal(err)
	}
	openDoc, err := st.CreateDriveNode(ctx, ownerGuard, ws.ID, nil, "doc", "公开文档", false)
	if err != nil {
		t.Fatal(err)
	}

	// Turn OFF inherit_parent_acl on secretFolder (Decision A1: ordinary members lose access).
	if err := st.SetNodeInheritParentACLGuarded(ctx, ownerGuard, secretFolder.ID, false); err != nil {
		t.Fatal(err)
	}
	metaFolder, err := st.GetDoc(ctx, owner.ID, secretFolder.ID)
	if err != nil || metaFolder.InheritParentACL {
		t.Fatalf("owner meta after turning off inherit: %+v err=%v", metaFolder, err)
	}
	if metaFolder.PermissionsRevision != 1 {
		t.Fatalf("expected folder permissionsRevision 1, got %d", metaFolder.PermissionsRevision)
	}
	metaChild, err := st.GetDoc(ctx, owner.ID, secretDoc.ID)
	if err != nil || metaChild.PermissionsRevision != 1 {
		t.Fatalf("child doc should bump permissionsRevision on ancestor inheritance toggle, got %+v err=%v", metaChild, err)
	}

	// Alice and Bob lose default edit access on both restricted folder and its child doc.
	for _, tc := range []struct {
		name string
		u    store.User
	}{{"alice", alice}, {"bob", bob}} {
		if _, err := st.GetDoc(ctx, tc.u.ID, secretFolder.ID); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("%s GetDoc(restricted folder) = %v, want ErrNotFound", tc.name, err)
		}
		if _, err := st.GetDoc(ctx, tc.u.ID, secretDoc.ID); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("%s GetDoc(restricted child) = %v, want ErrNotFound", tc.name, err)
		}
		list, err := st.ListDocs(ctx, tc.u.ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range list {
			if item.ID == secretFolder.ID || item.ID == secretDoc.ID {
				t.Fatalf("%s ListDocs leaked restricted node %+v", tc.name, item)
			}
		}
	}
	if _, err := st.ListDriveChildren(ctx, bobGuard, ws.ID, &secretFolder.ID, false); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("bob ListDriveChildren on restricted folder = %v, want ErrForbidden", err)
	}

	// Foreign department cannot be granted onto secretFolder.
	if err := st.SetSubjectShareGuarded(ctx, ownerGuard, secretFolder.ID, store.SubjectTypeDepartment, foreignDept.ID, store.RoleView); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-workspace subject share = %v, want ErrNotFound", err)
	}

	// Grant ancestor department 研发中心 edit access on 保密项目 -> Alice in 协同引擎小组 inherits edit!
	if err := st.SetSubjectShareGuarded(ctx, ownerGuard, secretFolder.ID, store.SubjectTypeDepartment, rnd.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if d, err := st.GetDoc(ctx, alice.ID, secretDoc.ID); err != nil || d.Role != store.RoleEdit {
		t.Fatalf("alice (sub-dept) GetDoc = %+v err=%v, want edit", d, err)
	}
	// Bob in 市场部 still cannot see it.
	if _, err := st.GetDoc(ctx, bob.ID, secretDoc.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("bob (other dept) GetDoc = %v, want ErrNotFound", err)
	}
	// SearchCandidates includes secretDoc for Alice, excludes it for Bob.
	aliceSearch, err := st.SearchCandidates(ctx, alice.ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	hasDoc := func(items []store.DocMeta, id int64) bool {
		for _, item := range items {
			if item.ID == id {
				return true
			}
		}
		return false
	}
	if !hasDoc(aliceSearch, secretDoc.ID) {
		t.Fatalf("alice SearchCandidates missing secretDoc %+v", aliceSearch)
	}
	bobSearch, err := st.SearchCandidates(ctx, bob.ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if hasDoc(bobSearch, secretDoc.ID) || hasDoc(bobSearch, secretFolder.ID) {
		t.Fatalf("bob SearchCandidates leaked restricted docs: %+v", bobSearch)
	}

	// Create user group 专项评审组 with Bob, grant view on secretFolder.
	grp, err := st.CreateUserGroupGuarded(ctx, ownerGuard, ws.ID, "专项评审组", "跨部门评审")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetUserGroupMemberGuarded(ctx, ownerGuard, ws.ID, grp.ID, bob.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := st.SetSubjectShareGuarded(ctx, ownerGuard, secretFolder.ID, store.SubjectTypeGroup, grp.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if d, err := st.GetDoc(ctx, bob.ID, secretDoc.ID); err != nil || d.Role != store.RoleView {
		t.Fatalf("bob (group view) GetDoc = %+v err=%v, want view", d, err)
	}

	// Subject-share changes advance the revision of the whole inheriting subtree.
	childBefore, err := st.GetDoc(ctx, owner.ID, secretDoc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetSubjectShareGuarded(ctx, ownerGuard, secretFolder.ID, store.SubjectTypeGroup, grp.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if childAfter, err := st.GetDoc(ctx, owner.ID, secretDoc.ID); err != nil || childAfter.PermissionsRevision != childBefore.PermissionsRevision+1 {
		t.Fatalf("child revision after subject share = %+v err=%v, want %d", childAfter, err, childBefore.PermissionsRevision+1)
	}

	// A view-only grantee cannot move documents under a restricted node.
	restrictedPage, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "受限页面", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetNodeInheritParentACLGuarded(ctx, ownerGuard, restrictedPage.ID, false); err != nil {
		t.Fatal(err)
	}
	if err := st.SetSubjectShareGuarded(ctx, ownerGuard, restrictedPage.ID, store.SubjectTypeGroup, grp.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	bobPage, err := st.CreateDoc(ctx, ws.ID, bob.ID, nil, "Bob 的页面", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.PatchManagedDocGuarded(ctx, bobGuard, bobPage.ID, store.ManagedDocPatch{Move: true, ParentID: &restrictedPage.ID}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("view-only move into restricted page = %v, want ErrNotFound", err)
	}
	if err := st.SetSubjectShareGuarded(ctx, ownerGuard, restrictedPage.ID, store.SubjectTypeGroup, grp.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err := st.PatchManagedDocGuarded(ctx, bobGuard, bobPage.ID, store.ManagedDocPatch{Move: true, ParentID: &restrictedPage.ID}); err != nil {
		t.Fatalf("edit grantee move into restricted page: %v", err)
	}
	// A manager whose manage comes only from an ancestor grant cannot turn off
	// inheritance on a child (they would lock themselves out); state is kept.
	inheritedChild, err := st.CreateDoc(ctx, ws.ID, owner.ID, &restrictedPage.ID, "继承页", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetSubjectShareGuarded(ctx, ownerGuard, restrictedPage.ID, store.SubjectTypeGroup, grp.ID, store.RoleManage); err != nil {
		t.Fatal(err)
	}
	if err := st.SetNodeInheritParentACLGuarded(ctx, bobGuard, inheritedChild.ID, false); !errors.Is(err, store.ErrWouldLoseAccess) {
		t.Fatalf("self-lockout inheritance toggle = %v, want ErrWouldLoseAccess", err)
	}
	if d, err := st.GetDoc(ctx, bob.ID, inheritedChild.ID); err != nil || d.Role != store.RoleManage || !d.InheritParentACL {
		t.Fatalf("after rejected toggle bob = %+v err=%v, want manage + inheriting", d, err)
	}
	if err := st.SetNodeInheritParentACLGuarded(ctx, ownerGuard, inheritedChild.ID, false); err != nil {
		t.Fatalf("owner may still turn off inheritance: %v", err)
	}

	// Move openDoc INTO secretFolder -> Bob's role drops from default edit to group view & permissionsRevision bumps.
	beforeMove, err := st.GetDoc(ctx, owner.ID, openDoc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.MoveDriveNode(ctx, ownerGuard, openDoc.ID, &secretFolder.ID, beforeMove.DriveRevision); err != nil {
		t.Fatal(err)
	}
	afterMoveOwner, err := st.GetDoc(ctx, owner.ID, openDoc.ID)
	if err != nil || afterMoveOwner.PermissionsRevision != beforeMove.PermissionsRevision+1 {
		t.Fatalf("expected permissionsRevision bump on move, got %+v err=%v", afterMoveOwner, err)
	}
	if d, err := st.GetDoc(ctx, bob.ID, openDoc.ID); err != nil || d.Role != store.RoleView {
		t.Fatalf("bob role after moving doc into restricted folder = %+v err=%v, want view", d, err)
	}

	// Move openDoc BACK out to root -> Bob regains workspace default edit.
	if err := st.MoveDriveNode(ctx, ownerGuard, openDoc.ID, nil, afterMoveOwner.DriveRevision); err != nil {
		t.Fatal(err)
	}
	if d, err := st.GetDoc(ctx, bob.ID, openDoc.ID); err != nil || d.Role != store.RoleEdit {
		t.Fatalf("bob role after moving doc back to root = %+v err=%v, want edit", d, err)
	}

	// Promote Bob to workspace admin -> manages even restricted folder & can call org APIs.
	if _, err := st.UpsertWorkspaceMemberGuarded(ctx, ownerGuard, ws.ID, bob.Email, store.WorkspaceRoleAdmin); err != nil {
		t.Fatal(err)
	}
	if d, err := st.GetDoc(ctx, bob.ID, secretDoc.ID); err != nil || d.Role != store.RoleManage {
		t.Fatalf("promoted admin GetDoc(restricted) = %+v err=%v, want manage", d, err)
	}

	// Deleting parent department 研发中心 cascades sub-depts and cleans subject shares.
	if err := st.DeleteDepartmentGuarded(ctx, bobGuard, ws.ID, rnd.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetDoc(ctx, alice.ID, secretDoc.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("alice still has access after department delete: %v", err)
	}
	subjects, err := st.ListSubjectShares(ctx, secretFolder.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(subjects) != 1 || subjects[0].SubjectType != store.SubjectTypeGroup {
		t.Fatalf("expected only group share remaining after dept delete, got %+v", subjects)
	}

	// Org snapshot reflects cleanup cleanly.
	snap, err := st.GetWorkspaceOrg(ctx, aliceGuard, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if snap.CallerRole != store.WorkspaceRoleMember || len(snap.Departments) != 1 || snap.Departments[0].Name != "市场部" || len(snap.Groups) != 1 {
		t.Fatalf("unexpected org snapshot: %+v", snap)
	}

	// Demote Bob back to member, delete group, and verify Bob loses access; then remove Alice from workspace.
	if _, err := st.UpsertWorkspaceMemberGuarded(ctx, ownerGuard, ws.ID, bob.Email, store.WorkspaceRoleMember); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteUserGroupGuarded(ctx, ownerGuard, ws.ID, grp.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetDoc(ctx, bob.ID, secretDoc.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("bob still has access after demote + group delete: %v", err)
	}
	// Trashed restricted nodes must not leak titles to members without access.
	secretMeta, err := st.GetDoc(ctx, owner.ID, secretDoc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.TrashDriveNode(ctx, ownerGuard, secretDoc.ID, secretMeta.DriveRevision); err != nil {
		t.Fatal(err)
	}
	if trash, err := st.ListTrash(ctx, bob.ID); err != nil || hasDoc(trash, secretDoc.ID) {
		t.Fatalf("bob ListTrash leaked restricted doc: %+v err=%v", trash, err)
	}
	if trash, err := st.ListTrash(ctx, owner.ID); err != nil || !hasDoc(trash, secretDoc.ID) {
		t.Fatalf("owner ListTrash missing restricted doc: %+v err=%v", trash, err)
	}
	if _, err := st.UpsertWorkspaceMemberGuarded(ctx, ownerGuard, ws.ID, bob.Email, "remove"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetDoc(ctx, bob.ID, openDoc.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("removed member still sees openDoc: %v", err)
	}
}

func TestMemoryOrgPermissions(t *testing.T) {
	exerciseOrgPermissions(t, store.NewMemory())
}

func TestPostgresOrgPermissions(t *testing.T) {
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
	exerciseOrgPermissions(t, pg)
}
