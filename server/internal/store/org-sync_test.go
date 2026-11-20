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

func exerciseOrgDirectorySync(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	exp := time.Now().Add(time.Hour)

	owner, ws, err := st.CreateUser(ctx, "sync-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	alice, _, err := st.CreateUser(ctx, "sync-alice@example.test", "Alice", "hash")
	if err != nil {
		t.Fatal(err)
	}
	bob, _, err := st.CreateUser(ctx, "sync-bob@example.test", "Bob", "hash")
	if err != nil {
		t.Fatal(err)
	}
	outsider, _, err := st.CreateUser(ctx, "sync-outsider@example.test", "Outsider", "hash")
	if err != nil {
		t.Fatal(err)
	}

	makeGuard := func(u store.User, tag string) store.RestoreGuard {
		g := store.RestoreGuard{UserID: u.ID, SessionHash: []byte("sync-sess-" + tag)}
		if e := st.CreateSession(ctx, g.SessionHash, u.ID, exp); e != nil {
			t.Fatal(e)
		}
		return g
	}
	ownerGuard := makeGuard(owner, "owner")
	aliceGuard := makeGuard(alice, "alice")
	bobGuard := makeGuard(bob, "bob")

	// Bring Alice and Bob into the workspace via normal invitation flow; leave Outsider outside.
	for _, tc := range []struct {
		u store.User
		g store.RestoreGuard
	}{{alice, aliceGuard}, {bob, bobGuard}} {
		ch, err := st.UpsertWorkspaceMemberGuarded(ctx, ownerGuard, ws.ID, tc.u.Email, store.WorkspaceRoleMember)
		if err != nil || ch.Invitation == nil {
			t.Fatalf("invite %s: %+v err=%v", tc.u.Email, ch, err)
		}
		if err := st.RespondInvitationGuarded(ctx, tc.g, ch.Invitation.ID, true); err != nil {
			t.Fatal(err)
		}
	}

	// Create manual department and manual group that external sync must never delete.
	manualDept, err := st.CreateDepartmentGuarded(ctx, ownerGuard, ws.ID, nil, "手工保留部", 99)
	if err != nil {
		t.Fatal(err)
	}
	manualGroup, err := st.CreateUserGroupGuarded(ctx, ownerGuard, ws.ID, "手工保留组", "manual")
	if err != nil {
		t.Fatal(err)
	}

	// Non-admin member cannot list or create sync sources.
	if _, _, err := st.ListOrgSyncState(ctx, aliceGuard, ws.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("member ListOrgSyncState = %v, want ErrForbidden", err)
	}
	if _, err := st.CreateOrgSyncSourceGuarded(ctx, aliceGuard, ws.ID, "Denied", store.OrgSyncProviderSCIM, true, true); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("member CreateOrgSyncSource = %v, want ErrForbidden", err)
	}

	// Owner creates a SCIM sync source.
	created, err := st.CreateOrgSyncSourceGuarded(ctx, ownerGuard, ws.ID, "企业 SCIM 目录", store.OrgSyncProviderSCIM, true, true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(created.Token, "jg_sync_") || created.Source.TokenPrefix == "" {
		t.Fatalf("unexpected created source token: %+v", created)
	}
	srcID := created.Source.ID
	rawToken := created.Token

	// Invalid payload (cycle) must fail with ErrConflict and descriptive message.
	badRun, err := st.RunOrgDirectorySyncGuarded(ctx, ownerGuard, ws.ID, srcID, store.OrgDirectorySyncPayload{
		Departments: []store.OrgSyncDeptInput{
			{ExternalID: "d-a", ParentExternalID: "d-b", Name: "A"},
			{ExternalID: "d-b", ParentExternalID: "d-a", Name: "B"},
		},
	})
	if !errors.Is(err, store.ErrConflict) || badRun.ErrorMessage == "" {
		t.Fatalf("cycle payload = (%+v, %v), want ErrConflict with message", badRun, err)
	}

	initialPayload := store.OrgDirectorySyncPayload{
		Departments: []store.OrgSyncDeptInput{
			{ExternalID: "ext-eng", Name: "工程研发", SortOrder: 1},
			{ExternalID: "ext-plat", ParentExternalID: "ext-eng", Name: "平台团队", SortOrder: 1},
			{ExternalID: "ext-store", ParentExternalID: "ext-plat", Name: "存储内核", SortOrder: 1},
			{ExternalID: "ext-temp", ParentExternalID: "ext-eng", Name: "临时项目组", SortOrder: 2},
		},
		Groups: []store.OrgSyncGroupInput{
			{ExternalID: "grp-arch", Name: "核心架构组", Description: "Architecture"},
			{ExternalID: "grp-sec", Name: "安全审计组", Description: "Security"},
		},
		Members: []store.OrgSyncMemberInput{
			// Attempting to demote owner must be silently skipped (owner stays owner).
			{Email: owner.Email, Role: store.WorkspaceRoleMember, DepartmentExternalIDs: []string{"ext-eng"}},
			{
				Email:                       alice.Email,
				Role:                        store.WorkspaceRoleMember,
				DepartmentExternalIDs:       []string{"ext-store"},
				LeaderDepartmentExternalIDs: []string{"ext-store"},
				GroupExternalIDs:            []string{"grp-arch"},
			},
			{
				Email:                 bob.Email,
				Role:                  store.WorkspaceRoleAdmin,
				DepartmentExternalIDs: []string{"ext-temp"},
				GroupExternalIDs:      []string{"grp-sec"},
			},
			// Non-member registered user & unregistered email must both become invitations (never auto-joined!).
			{Email: outsider.Email, Role: store.WorkspaceRoleMember, DepartmentExternalIDs: []string{"ext-eng"}},
			{Email: "newcomer@example.test", Role: store.WorkspaceRoleMember, DepartmentExternalIDs: []string{"ext-plat"}},
		},
	}

	// 1. Dry-run must compute diff without mutating org or creating invitations.
	dryPayload := initialPayload
	dryPayload.DryRun = true
	dryRun, err := st.RunOrgDirectorySyncGuarded(ctx, ownerGuard, ws.ID, srcID, dryPayload)
	if err != nil {
		t.Fatalf("dry run err: %v", err)
	}
	if !dryRun.DryRun || dryRun.Status != "ok" || dryRun.DepartmentsCreated != 4 || dryRun.GroupsCreated != 2 || dryRun.MembersLinked != 3 || dryRun.MembersInvited != 2 {
		t.Fatalf("unexpected dry run counts: %+v", dryRun)
	}
	snapBefore, err := st.GetWorkspaceOrg(ctx, ownerGuard, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapBefore.Departments) != 1 || len(snapBefore.Groups) != 1 || len(snapBefore.Invitations) != 0 {
		t.Fatalf("dry run mutated state: depts=%d groups=%d invites=%d", len(snapBefore.Departments), len(snapBefore.Groups), len(snapBefore.Invitations))
	}

	// 2. Live sync applies departments, groups, memberships, and invitations.
	liveRun, err := st.RunOrgDirectorySyncGuarded(ctx, ownerGuard, ws.ID, srcID, initialPayload)
	if err != nil {
		t.Fatalf("live run err: %v", err)
	}
	if liveRun.DryRun || liveRun.Status != "ok" || liveRun.DepartmentsCreated != 4 || liveRun.GroupsCreated != 2 || liveRun.MembersLinked != 3 || liveRun.MembersInvited != 2 {
		t.Fatalf("unexpected live run counts: %+v", liveRun)
	}
	snap, err := st.GetWorkspaceOrg(ctx, ownerGuard, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Departments) != 5 || len(snap.Groups) != 3 || len(snap.Members) != 3 || len(snap.Invitations) != 2 {
		t.Fatalf("unexpected org snapshot after live sync: depts=%d groups=%d members=%d invites=%d",
			len(snap.Departments), len(snap.Groups), len(snap.Members), len(snap.Invitations))
	}
	// Verify owner remained owner, bob promoted to admin, outsider NOT auto-joined.
	roles := map[int64]string{}
	for _, m := range snap.Members {
		roles[m.UserID] = m.Role
	}
	if roles[owner.ID] != store.WorkspaceRoleOwner || roles[bob.ID] != store.WorkspaceRoleAdmin || roles[outsider.ID] != "" {
		t.Fatalf("unexpected roles after sync: %+v", roles)
	}
	// Find synced 工程研发 & 存储内核 departments and verify Alice is leader of 存储内核.
	deptByExt := map[string]store.OrgDepartment{}
	for _, d := range snap.Departments {
		if d.ExternalID != "" {
			deptByExt[d.ExternalID] = d
		}
	}
	engDept, ok := deptByExt["ext-eng"]
	if !ok || engDept.SyncSourceID == nil || *engDept.SyncSourceID != srcID {
		t.Fatalf("missing synced ext-eng dept: %+v", engDept)
	}
	storeDept := deptByExt["ext-store"]
	if len(storeDept.Members) != 1 || storeDept.Members[0].UserID != alice.ID || !storeDept.Members[0].IsLeader {
		t.Fatalf("expected Alice as leader of 存储内核: %+v", storeDept.Members)
	}

	// Verify department-inherited document access works immediately on synced hierarchy!
	secretDoc, err := st.CreateDriveNode(ctx, ownerGuard, ws.ID, nil, "doc", "同步部门保密文档", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetNodeInheritParentACLGuarded(ctx, ownerGuard, secretDoc.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetDoc(ctx, alice.ID, secretDoc.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("alice accessed restricted doc before grant: %v", err)
	}
	if err := st.SetSubjectShareGuarded(ctx, ownerGuard, secretDoc.ID, store.SubjectTypeDepartment, engDept.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	docForAlice, err := st.GetDoc(ctx, alice.ID, secretDoc.ID)
	if err != nil || docForAlice.Role != store.RoleEdit {
		t.Fatalf("alice expected edit role via synced ancestor dept ext-eng, got doc=%+v err=%v", docForAlice, err)
	}

	// 3. Idempotent re-sync produces zero changes.
	noopRun, err := st.RunOrgDirectorySyncGuarded(ctx, ownerGuard, ws.ID, srcID, initialPayload)
	if err != nil {
		t.Fatalf("idempotent run err: %v", err)
	}
	if noopRun.DepartmentsCreated != 0 || noopRun.DepartmentsUpdated != 0 || noopRun.DepartmentsRemoved != 0 ||
		noopRun.GroupsCreated != 0 || noopRun.GroupsUpdated != 0 || noopRun.GroupsRemoved != 0 ||
		noopRun.MembersInvited != 0 || noopRun.MembershipsUpdated != 0 {
		t.Fatalf("expected idempotent 0-diff run, got: %+v", noopRun)
	}

	// 4. Bearer token push: rename/reparent + prune ext-temp & grp-sec while preserving manual dept/group!
	pushPayload := store.OrgDirectorySyncPayload{
		Departments: []store.OrgSyncDeptInput{
			{ExternalID: "ext-eng", Name: "大工程研发中心", SortOrder: 1},
			{ExternalID: "ext-plat", ParentExternalID: "ext-eng", Name: "平台架构部", SortOrder: 1},
			// Reparent ext-store directly under ext-eng.
			{ExternalID: "ext-store", ParentExternalID: "ext-eng", Name: "存储内核", SortOrder: 2},
		},
		Groups: []store.OrgSyncGroupInput{
			{ExternalID: "grp-arch", Name: "核心架构委员会", Description: "Updated"},
		},
		Members: []store.OrgSyncMemberInput{
			// Remove Alice from synced departments -> Alice must lose ext-eng inherited access!
			{Email: bob.Email, Role: store.WorkspaceRoleMember, DepartmentExternalIDs: []string{"ext-store"}, GroupExternalIDs: []string{"grp-arch"}},
		},
	}
	pushRun, err := st.PushOrgDirectorySyncByToken(ctx, store.HashOrgSyncToken(rawToken), store.OrgSyncTriggerSCIM, pushPayload)
	if err != nil {
		t.Fatalf("token push err: %v", err)
	}
	if pushRun.TriggerMode != store.OrgSyncTriggerSCIM || pushRun.DepartmentsUpdated != 3 || pushRun.DepartmentsRemoved != 1 || pushRun.GroupsUpdated != 1 || pushRun.GroupsRemoved != 1 {
		t.Fatalf("unexpected push run: %+v", pushRun)
	}
	// Alice lost ext-eng access; Bob gained ext-eng access via ext-store -> ext-eng!
	if _, err := st.GetDoc(ctx, alice.ID, secretDoc.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("alice retained access after removed from synced dept: %v", err)
	}
	docForBob, err := st.GetDoc(ctx, bob.ID, secretDoc.ID)
	if err != nil || docForBob.Role != store.RoleEdit {
		t.Fatalf("bob expected edit access after sync into ext-store, got doc=%+v err=%v", docForBob, err)
	}
	// Manual department & manual group must remain untouched!
	snapAfterPrune, err := st.GetWorkspaceOrg(ctx, ownerGuard, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	foundManualDept, foundManualGroup := false, false
	for _, d := range snapAfterPrune.Departments {
		if d.ID == manualDept.ID && d.Name == "手工保留部" {
			foundManualDept = true
		}
	}
	for _, g := range snapAfterPrune.Groups {
		if g.ID == manualGroup.ID && g.Name == "手工保留组" {
			foundManualGroup = true
		}
	}
	if !foundManualDept || !foundManualGroup {
		t.Fatalf("manual dept/group lost after prune: dept=%v group=%v", foundManualDept, foundManualGroup)
	}

	// 5. Disable source -> push returns ErrForbidden; rotate token -> old token fails, new token succeeds.
	disabled := false
	if _, err := st.UpdateOrgSyncSourceGuarded(ctx, ownerGuard, ws.ID, srcID, store.OrgSyncSourcePatch{Enabled: &disabled}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PushOrgDirectorySyncByToken(ctx, store.HashOrgSyncToken(rawToken), store.OrgSyncTriggerPush, pushPayload); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("disabled source push = %v, want ErrForbidden", err)
	}
	enabled := true
	rotated, err := st.UpdateOrgSyncSourceGuarded(ctx, ownerGuard, ws.ID, srcID, store.OrgSyncSourcePatch{Enabled: &enabled, RotateToken: true})
	if err != nil || rotated.Token == "" || rotated.Token == rawToken {
		t.Fatalf("rotate token failed: %+v err=%v", rotated, err)
	}
	if _, err := st.PushOrgDirectorySyncByToken(ctx, store.HashOrgSyncToken(rawToken), store.OrgSyncTriggerPush, pushPayload); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("old token after rotation = %v, want ErrUnauthenticated", err)
	}
	if _, err := st.PushOrgDirectorySyncByToken(ctx, store.HashOrgSyncToken(rotated.Token), store.OrgSyncTriggerPush, pushPayload); err != nil {
		t.Fatalf("new rotated token push failed: %v", err)
	}

	// 6. ListOrgSyncState returns sources and audit runs; Delete detaches source cleanly.
	sources, runs, err := st.ListOrgSyncState(ctx, ownerGuard, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(sources) != 1 || sources[0].LastStatus != "ok" || len(runs) < 4 {
		t.Fatalf("unexpected sync state: sources=%+v runs=%d", sources, len(runs))
	}
	if err := st.DeleteOrgSyncSourceGuarded(ctx, ownerGuard, ws.ID, srcID); err != nil {
		t.Fatal(err)
	}
	sourcesAfter, _, err := st.ListOrgSyncState(ctx, ownerGuard, ws.ID)
	if err != nil || len(sourcesAfter) != 0 {
		t.Fatalf("expected 0 sources after delete, got %d err=%v", len(sourcesAfter), err)
	}
}

func TestMemoryOrgDirectorySync(t *testing.T) {
	exerciseOrgDirectorySync(t, store.NewMemory())
}

func TestPostgresOrgDirectorySync(t *testing.T) {
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
	exerciseOrgDirectorySync(t, pg)
}

// TestPostgresOrgACLClosureAndLargeSpacePerf verifies the 0080 materialized
// closure tables under reparent/inheritance mutations and benchmarks ListDocs
// across 2,000 documents in a 5-level folder tree + 4-level department hierarchy,
// asserting exact authorization counts and zero Recursive Union in EXPLAIN.
func TestPostgresOrgACLClosureAndLargeSpacePerf(t *testing.T) {
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

	exp := time.Now().Add(time.Hour)
	owner, ws, err := pg.CreateUser(ctx, "perf-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	alice, _, err := pg.CreateUser(ctx, "perf-alice@example.test", "Alice", "hash")
	if err != nil {
		t.Fatal(err)
	}
	bob, _, err := pg.CreateUser(ctx, "perf-bob@example.test", "Bob", "hash")
	if err != nil {
		t.Fatal(err)
	}
	makeGuard := func(u store.User, tag string) store.RestoreGuard {
		g := store.RestoreGuard{UserID: u.ID, SessionHash: []byte("perf-sess-" + tag)}
		if e := pg.CreateSession(ctx, g.SessionHash, u.ID, exp); e != nil {
			t.Fatal(e)
		}
		return g
	}
	ownerGuard := makeGuard(owner, "owner")
	aliceGuard := makeGuard(alice, "alice")
	bobGuard := makeGuard(bob, "bob")

	for _, tc := range []struct {
		u store.User
		g store.RestoreGuard
	}{{alice, aliceGuard}, {bob, bobGuard}} {
		ch, err := pg.UpsertWorkspaceMemberGuarded(ctx, ownerGuard, ws.ID, tc.u.Email, store.WorkspaceRoleMember)
		if err != nil {
			t.Fatal(err)
		}
		if err := pg.RespondInvitationGuarded(ctx, tc.g, ch.Invitation.ID, true); err != nil {
			t.Fatal(err)
		}
	}

	// Build 4-level department tree + sibling branch to test reparenting trigger.
	d0, err := pg.CreateDepartmentGuarded(ctx, ownerGuard, ws.ID, nil, "集团总部", 1)
	if err != nil {
		t.Fatal(err)
	}
	d1, err := pg.CreateDepartmentGuarded(ctx, ownerGuard, ws.ID, &d0.ID, "研发中心", 1)
	if err != nil {
		t.Fatal(err)
	}
	d2, err := pg.CreateDepartmentGuarded(ctx, ownerGuard, ws.ID, &d1.ID, "文档引擎部", 1)
	if err != nil {
		t.Fatal(err)
	}
	d3, err := pg.CreateDepartmentGuarded(ctx, ownerGuard, ws.ID, &d2.ID, "权限存储组", 1)
	if err != nil {
		t.Fatal(err)
	}
	dOther, err := pg.CreateDepartmentGuarded(ctx, ownerGuard, ws.ID, nil, "行政部", 2)
	if err != nil {
		t.Fatal(err)
	}
	if err := pg.SetDepartmentMemberGuarded(ctx, ownerGuard, ws.ID, d3.ID, alice.ID, true, false); err != nil {
		t.Fatal(err)
	}

	// Build a 5-level folder tree:
	// - openRoot -> openL2 -> openL3 (contains 1,600 workspace-open docs)
	// - secretRoot (inherit_parent_acl=false)
	//   -> deptSharedFolder (shared with d1=研发中心 -> contains 200 docs visible to Alice via d3->d2->d1)
	//   -> privateFolder (no shares -> contains 200 docs hidden from Alice & Bob)
	openRoot, err := pg.CreateDriveFolder(ctx, ownerGuard, ws.ID, nil, "公开知识区", false)
	if err != nil {
		t.Fatal(err)
	}
	openL2, err := pg.CreateDriveFolder(ctx, ownerGuard, ws.ID, &openRoot.ID, "产品方案", false)
	if err != nil {
		t.Fatal(err)
	}
	openL3, err := pg.CreateDriveFolder(ctx, ownerGuard, ws.ID, &openL2.ID, "季度文档", false)
	if err != nil {
		t.Fatal(err)
	}

	secretRoot, err := pg.CreateDriveFolder(ctx, ownerGuard, ws.ID, nil, "保密空间", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := pg.SetNodeInheritParentACLGuarded(ctx, ownerGuard, secretRoot.ID, false); err != nil {
		t.Fatal(err)
	}
	deptSharedFolder, err := pg.CreateDriveFolder(ctx, ownerGuard, ws.ID, &secretRoot.ID, "研发保密目录", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := pg.SetSubjectShareGuarded(ctx, ownerGuard, deptSharedFolder.ID, store.SubjectTypeDepartment, d1.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	deptSharedLeaf, err := pg.CreateDriveFolder(ctx, ownerGuard, ws.ID, &deptSharedFolder.ID, "底层设计", false)
	if err != nil {
		t.Fatal(err)
	}
	privateFolder, err := pg.CreateDriveFolder(ctx, ownerGuard, ws.ID, &secretRoot.ID, "高管机密", false)
	if err != nil {
		t.Fatal(err)
	}

	// Bulk insert 2,000 docs (1,600 open + 200 dept-shared + 200 private) through SQL
	// so the nodes_acl_closure_sync trigger fires on every row.
	// Timestamp private newest (+2m), dept-shared next (+1m), open oldest so ListDocs (LIMIT 500,
	// ORDER BY updated_at DESC) must filter out private/unauthorized rows first!
	if _, err := pg.Pool.Exec(ctx, `
		INSERT INTO nodes (workspace_id, parent_id, kind, title, sort_key, creator_id, inherit_parent_acl, drive_revision, updated_at)
		SELECT $1, $2, 'doc', '公开文档 #' || gs, 'a' || lpad(gs::text, 6, '0'), $3, true, 1, now() - interval '1 minute' FROM generate_series(1, 1600) gs
	`, ws.ID, openL3.ID, owner.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pg.Pool.Exec(ctx, `
		INSERT INTO nodes (workspace_id, parent_id, kind, title, sort_key, creator_id, inherit_parent_acl, drive_revision, updated_at)
		SELECT $1, $2, 'doc', '研发保密 #' || gs, 'b' || lpad(gs::text, 6, '0'), $3, true, 1, now() + interval '1 minute' FROM generate_series(1, 200) gs
	`, ws.ID, deptSharedLeaf.ID, owner.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pg.Pool.Exec(ctx, `
		INSERT INTO nodes (workspace_id, parent_id, kind, title, sort_key, creator_id, inherit_parent_acl, drive_revision, updated_at)
		SELECT $1, $2, 'doc', '机密文档 #' || gs, 'c' || lpad(gs::text, 6, '0'), $3, true, 1, now() + interval '2 minutes' FROM generate_series(1, 200) gs
	`, ws.ID, privateFolder.ID, owner.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pg.Pool.Exec(ctx, `ANALYZE nodes, node_acl_state, node_acl_ancestors, org_department_closure, node_subject_shares`); err != nil {
		t.Fatal(err)
	}

	countPrefix := func(docs []store.DocMeta, prefix string) int {
		n := 0
		for _, d := range docs {
			if d.WorkspaceID == ws.ID && strings.HasPrefix(d.Title, prefix) {
				n++
			}
		}
		return n
	}

	// Verify exact ListDocs filtering (LIMIT 500) & measure latency across 2,000 docs.
	t0 := time.Now()
	aliceDocs, err := pg.ListDocs(ctx, alice.ID)
	aliceDur := time.Since(t0)
	if err != nil {
		t.Fatal(err)
	}
	if gotPriv, gotDept, gotOpen := countPrefix(aliceDocs, "机密文档 #"), countPrefix(aliceDocs, "研发保密 #"), countPrefix(aliceDocs, "公开文档 #"); gotPriv != 0 || gotDept != 200 || gotOpen != 295 || len(aliceDocs) != 500 {
		t.Fatalf("alice ListDocs breakdown = priv:%d dept:%d open:%d (total %d), want 0/200/295 (500)", gotPriv, gotDept, gotOpen, len(aliceDocs))
	}

	t1 := time.Now()
	bobDocs, err := pg.ListDocs(ctx, bob.ID)
	bobDur := time.Since(t1)
	if err != nil {
		t.Fatal(err)
	}
	if gotPriv, gotDept, gotOpen := countPrefix(bobDocs, "机密文档 #"), countPrefix(bobDocs, "研发保密 #"), countPrefix(bobDocs, "公开文档 #"); gotPriv != 0 || gotDept != 0 || gotOpen != 497 || len(bobDocs) != 500 {
		t.Fatalf("bob ListDocs breakdown = priv:%d dept:%d open:%d (total %d), want 0/0/497 (500)", gotPriv, gotDept, gotOpen, len(bobDocs))
	}

	ownerDocs, err := pg.ListDocs(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	if gotPriv, gotDept, gotOpen := countPrefix(ownerDocs, "机密文档 #"), countPrefix(ownerDocs, "研发保密 #"), countPrefix(ownerDocs, "公开文档 #"); gotPriv != 200 || gotDept != 200 || gotOpen != 93 || len(ownerDocs) != 500 {
		t.Fatalf("owner ListDocs breakdown = priv:%d dept:%d open:%d (total %d), want 200/200/93 (500)", gotPriv, gotDept, gotOpen, len(ownerDocs))
	}

	// Also verify ListDriveChildren on deptSharedLeaf (200 docs for Alice, ErrForbidden for Bob).
	t2 := time.Now()
	aliceChildren, err := pg.ListDriveChildren(ctx, aliceGuard, ws.ID, &deptSharedLeaf.ID, false)
	driveDur := time.Since(t2)
	if err != nil || len(aliceChildren) != 200 {
		t.Fatalf("alice ListDriveChildren(deptSharedLeaf) = %d err=%v, want 200", len(aliceChildren), err)
	}
	if _, err := pg.ListDriveChildren(ctx, bobGuard, ws.ID, &deptSharedLeaf.ID, false); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("bob ListDriveChildren(deptSharedLeaf) = %v, want ErrForbidden", err)
	}

	// Verify department reparenting trigger: move d2 (文档引擎部, containing d3 -> Alice) under dOther (行政部).
	// Alice must immediately lose access to all 200 研发保密 docs!
	if _, err := pg.UpdateDepartmentGuarded(ctx, ownerGuard, ws.ID, d2.ID, &dOther.ID, true, nil, nil); err != nil {
		t.Fatal(err)
	}
	aliceAfterReparent, err := pg.ListDocs(ctx, alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	if gotDept := countPrefix(aliceAfterReparent, "研发保密 #"); gotDept != 0 {
		t.Fatalf("alice 研发保密 docs after dept reparent = %d, want 0", gotDept)
	}
	// Move d2 back under d1 -> Alice regains all 200 docs!
	if _, err := pg.UpdateDepartmentGuarded(ctx, ownerGuard, ws.ID, d2.ID, &d1.ID, true, nil, nil); err != nil {
		t.Fatal(err)
	}
	aliceAfterRestore, err := pg.ListDocs(ctx, alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	if gotDept := countPrefix(aliceAfterRestore, "研发保密 #"); gotDept != 200 {
		t.Fatalf("alice 研发保密 docs after dept restore = %d, want 200", gotDept)
	}

	// Verify node inheritance toggle trigger: set openL2 inherit_parent_acl=false -> Bob loses all 1,600 公开文档!
	if err := pg.SetNodeInheritParentACLGuarded(ctx, ownerGuard, openL2.ID, false); err != nil {
		t.Fatal(err)
	}
	bobAfterRestrict, err := pg.ListDocs(ctx, bob.ID)
	if err != nil {
		t.Fatal(err)
	}
	if gotOpen := countPrefix(bobAfterRestrict, "公开文档 #"); gotOpen != 0 {
		t.Fatalf("bob 公开文档 after restricting openL2 = %d, want 0", gotOpen)
	}
	// Restore openL2 inherit_parent_acl=true -> Bob regains 公开文档!
	if err := pg.SetNodeInheritParentACLGuarded(ctx, ownerGuard, openL2.ID, true); err != nil {
		t.Fatal(err)
	}
	bobAfterReopen, err := pg.ListDocs(ctx, bob.ID)
	if err != nil {
		t.Fatal(err)
	}
	if gotOpen := countPrefix(bobAfterReopen, "公开文档 #"); gotOpen != 497 {
		t.Fatalf("bob 公开文档 after reopening openL2 = %d, want 497", gotOpen)
	}

	// Verify EXPLAIN (ANALYZE, FORMAT TEXT) on the ListDocs SQL has ZERO Recursive Union!
	explainSQL := `EXPLAIN (ANALYZE, FORMAT TEXT)
		SELECT n.id, n.title, n.updated_at
		FROM nodes n
		LEFT JOIN workspace_members m ON m.workspace_id = n.workspace_id AND m.user_id = $1
		LEFT JOIN node_acl_state nas ON nas.node_id = n.id
		WHERE n.workspace_id = $2 AND n.kind IN ('doc','base','sheet','slides','survey') AND n.deleted_at IS NULL
		  AND (
		    (n.personal AND n.creator_id = $1)
		    OR (NOT n.personal AND m.role IN ('owner','admin'))
		    OR (NOT n.personal AND n.creator_id = $1 AND m.user_id IS NOT NULL)
		    OR (NOT n.personal AND m.user_id IS NOT NULL AND n.wiki_space_id IS NULL AND COALESCE(nas.inherits_ws, n.inherit_parent_acl))
		    OR (
		      NOT n.personal AND m.user_id IS NOT NULL AND EXISTS (
		        SELECT 1 FROM node_acl_ancestors na
		        JOIN node_subject_shares ss ON ss.doc_id = na.ancestor_id
		        WHERE na.node_id = n.id
		          AND (
		            (ss.subject_type = 'department' AND EXISTS (
		              SELECT 1 FROM org_department_members dm
		              JOIN org_department_closure dc ON dc.descendant_id = dm.department_id
		              WHERE dm.user_id = $1 AND dc.workspace_id = n.workspace_id AND dc.ancestor_id = ss.subject_id
		            ))
		            OR (ss.subject_type = 'group' AND EXISTS (
		              SELECT 1 FROM org_group_members gm
		              JOIN org_groups g ON g.id = gm.group_id
		              WHERE gm.user_id = $1 AND g.workspace_id = n.workspace_id AND gm.group_id = ss.subject_id
		            ))
		          )
		      )
		    )
		  )
		ORDER BY n.updated_at DESC`
	rows, err := pg.Pool.Query(ctx, explainSQL, alice.ID, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var planLines []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatal(err)
		}
		planLines = append(planLines, line)
	}
	planText := strings.Join(planLines, "\n")
	if strings.Contains(planText, "Recursive Union") {
		t.Fatalf("EXPLAIN still contains Recursive Union:\n%s", planText)
	}
	t.Logf("Large-space ListDocs(2000 docs, 5-level folders, 4-level depts): alice=%v bob=%v driveChildren(200)=%v\n%s",
		aliceDur, bobDur, driveDur, fmt.Sprintf("Plan tail: %s", planLines[len(planLines)-1]))
}
