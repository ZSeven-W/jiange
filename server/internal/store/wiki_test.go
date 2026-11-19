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

func exerciseWikiSpaces(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	exp := time.Now().Add(time.Hour)

	owner, ws, err := st.CreateUser(ctx, "wiki-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	alice, _, err := st.CreateUser(ctx, "wiki-alice@example.test", "Alice", "hash")
	if err != nil {
		t.Fatal(err)
	}
	bob, _, err := st.CreateUser(ctx, "wiki-bob@example.test", "Bob", "hash")
	if err != nil {
		t.Fatal(err)
	}
	outsider, _, err := st.CreateUser(ctx, "wiki-out@example.test", "Outsider", "hash")
	if err != nil {
		t.Fatal(err)
	}

	makeGuard := func(u store.User, tag string) store.RestoreGuard {
		g := store.RestoreGuard{UserID: u.ID, SessionHash: []byte("wiki-sess-" + tag)}
		if e := st.CreateSession(ctx, g.SessionHash, u.ID, exp); e != nil {
			t.Fatal(e)
		}
		return g
	}
	ownerGuard := makeGuard(owner, "owner")
	aliceGuard := makeGuard(alice, "alice")
	bobGuard := makeGuard(bob, "bob")
	outsiderGuard := makeGuard(outsider, "outsider")

	// Invite and accept Alice & Bob as regular workspace members.
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

	// Org tree: 研发中心 -> 前端组 (Alice), 市场部 (Bob), and user group 评审组 (Bob).
	rnd, err := st.CreateDepartmentGuarded(ctx, ownerGuard, ws.ID, nil, "研发中心", 1)
	if err != nil {
		t.Fatal(err)
	}
	fe, err := st.CreateDepartmentGuarded(ctx, ownerGuard, ws.ID, &rnd.ID, "前端组", 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetDepartmentMemberGuarded(ctx, ownerGuard, ws.ID, fe.ID, alice.ID, true, false); err != nil {
		t.Fatal(err)
	}
	grp, err := st.CreateUserGroupGuarded(ctx, ownerGuard, ws.ID, "评审组", "跨部门")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetUserGroupMemberGuarded(ctx, ownerGuard, ws.ID, grp.ID, bob.ID, true); err != nil {
		t.Fatal(err)
	}

	// Create two spaces: public workspace-visible space and private space.
	pubSpace, err := st.CreateWikiSpaceGuarded(ctx, ownerGuard, ws.ID, "产品与研发知识库", "核心文档", "book", store.WikiVisibilityWorkspace)
	if err != nil {
		t.Fatal(err)
	}
	privSpace, err := st.CreateWikiSpaceGuarded(ctx, ownerGuard, ws.ID, "高管战略空间", "内部保密", "lock", store.WikiVisibilityPrivate)
	if err != nil {
		t.Fatal(err)
	}

	// Outsider cannot list workspace spaces.
	if _, err := st.ListWikiSpaces(ctx, outsiderGuard, ws.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("outsider ListWikiSpaces = %v, want ErrForbidden", err)
	}

	// Bob sees only pubSpace (view), not privSpace.
	bobSpaces, err := st.ListWikiSpaces(ctx, bobGuard, ws.ID)
	if err != nil || len(bobSpaces) != 1 || bobSpaces[0].ID != pubSpace.ID || bobSpaces[0].CallerRole != store.RoleView {
		t.Fatalf("bob ListWikiSpaces = %+v err=%v, want [pubSpace view]", bobSpaces, err)
	}
	if _, err := st.GetWikiSpaceDetail(ctx, bobGuard, privSpace.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("bob GetWikiSpaceDetail(private) = %v, want ErrNotFound", err)
	}

	// Grant ancestor department 研发中心 edit on pubSpace -> Alice (in 前端组) gets edit!
	grants, err := st.SetWikiSpaceGrantGuarded(ctx, ownerGuard, pubSpace.ID, store.SubjectTypeDepartment, rnd.ID, store.RoleEdit)
	if err != nil || len(grants) != 1 {
		t.Fatalf("SetWikiSpaceGrant(dept) = %+v err=%v", grants, err)
	}
	aliceDetail, err := st.GetWikiSpaceDetail(ctx, aliceGuard, pubSpace.ID)
	if err != nil || aliceDetail.Space.CallerRole != store.RoleEdit || len(aliceDetail.Grants) != 0 {
		t.Fatalf("alice detail = %+v err=%v, want edit + empty grants", aliceDetail, err)
	}

	// Bob (view) cannot create a root page in pubSpace; Alice (edit) can.
	if _, err := st.CreateWikiNodeGuarded(ctx, bobGuard, pubSpace.ID, nil, "doc", "", "拒绝页"); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("bob CreateWikiNode = %v, want ErrForbidden", err)
	}
	rootDoc, err := st.CreateWikiNodeGuarded(ctx, aliceGuard, pubSpace.ID, nil, "doc", "", "架构总览")
	if err != nil || rootDoc.WikiSpaceID != pubSpace.ID {
		t.Fatalf("alice CreateWikiNode(doc) = %+v err=%v", rootDoc, err)
	}
	// Nested child pages under a doc: doc, board, sheet, base, slides all succeed!
	childDoc, err := st.CreateWikiNodeGuarded(ctx, aliceGuard, pubSpace.ID, &rootDoc.ID, "doc", "", "接口规范")
	if err != nil || childDoc.ParentID == nil || *childDoc.ParentID != rootDoc.ID {
		t.Fatalf("CreateWikiNode(child doc) = %+v err=%v", childDoc, err)
	}
	if _, err := st.CreateWikiNodeGuarded(ctx, aliceGuard, pubSpace.ID, &rootDoc.ID, "doc", "board", "系统架构图"); err != nil {
		t.Fatalf("CreateWikiNode(board) = %v", err)
	}
	if _, err := st.CreateWikiNodeGuarded(ctx, aliceGuard, pubSpace.ID, &rootDoc.ID, "sheet", "", "排期表"); err != nil {
		t.Fatalf("CreateWikiNode(sheet) = %v", err)
	}
	if _, err := st.CreateWikiNodeGuarded(ctx, aliceGuard, pubSpace.ID, &rootDoc.ID, "base", "", "需求池"); err != nil {
		t.Fatalf("CreateWikiNode(base) = %v", err)
	}
	if _, err := st.CreateWikiNodeGuarded(ctx, aliceGuard, pubSpace.ID, &rootDoc.ID, "slides", "", "评审演示"); err != nil {
		t.Fatalf("CreateWikiNode(slides) = %v", err)
	}

	// Folder under doc must be rejected (0034 fence invariant); folder at root + subfolder under folder succeed.
	if _, err := st.CreateWikiNodeGuarded(ctx, ownerGuard, pubSpace.ID, &rootDoc.ID, "folder", "", "非法目录"); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("folder under doc = %v, want ErrConflict", err)
	}
	wikiFolder, err := st.CreateWikiNodeGuarded(ctx, ownerGuard, pubSpace.ID, nil, "folder", "", "规范目录")
	if err != nil {
		t.Fatalf("root folder = %v", err)
	}
	if _, err := st.CreateWikiNodeGuarded(ctx, ownerGuard, pubSpace.ID, &wikiFolder.ID, "folder", "", "子目录"); err != nil {
		t.Fatalf("subfolder = %v", err)
	}

	// Decision A2: Wiki pages DO NOT appear in Drive listings, DO appear in Recent & Search!
	driveChildren, err := st.ListDriveChildren(ctx, ownerGuard, ws.ID, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range driveChildren {
		if entry.ID == rootDoc.ID || entry.ID == wikiFolder.ID {
			t.Fatalf("ListDriveChildren leaked wiki node %+v", entry)
		}
	}
	if err := st.RecordVisit(ctx, bob.ID, rootDoc.ID, time.Now()); err != nil {
		t.Fatalf("bob RecordVisit(wiki doc) = %v", err)
	}
	recent, err := st.RecentDocs(ctx, bob.ID, 20)
	if err != nil || len(recent) == 0 || recent[0].ID != rootDoc.ID || recent[0].WikiSpaceID == nil || *recent[0].WikiSpaceID != pubSpace.ID || recent[0].WikiSpaceName != pubSpace.Name {
		t.Fatalf("bob RecentDocs = %+v err=%v", recent, err)
	}
	candidates, err := st.SearchCandidates(ctx, bob.ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	foundInSearch := false
	for _, c := range candidates {
		if c.ID == rootDoc.ID && c.WikiSpaceID != nil && *c.WikiSpaceID == pubSpace.ID {
			foundInSearch = true
		}
	}
	if !foundInSearch {
		t.Fatalf("bob SearchCandidates missing wiki doc %d: %+v", rootDoc.ID, candidates)
	}

	// Subpage inherit_parent_acl = false inside Wiki space: stops space view/edit, preserves space manage + explicit grants.
	secretPage, err := st.CreateWikiNodeGuarded(ctx, ownerGuard, pubSpace.ID, &rootDoc.ID, "doc", "", "核心密钥说明")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetNodeInheritParentACLGuarded(ctx, ownerGuard, secretPage.ID, false); err != nil {
		t.Fatal(err)
	}
	// Both Bob (space view) and Alice (space edit) lose access to secretPage!
	if _, err := st.GetDoc(ctx, bob.ID, secretPage.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("bob GetDoc(restricted wiki page) = %v, want ErrNotFound", err)
	}
	if _, err := st.GetDoc(ctx, alice.ID, secretPage.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("alice GetDoc(restricted wiki page) = %v, want ErrNotFound", err)
	}
	// Owner (space manage) still manages secretPage.
	if d, err := st.GetDoc(ctx, owner.ID, secretPage.ID); err != nil || d.Role != store.RoleManage {
		t.Fatalf("owner GetDoc(restricted wiki page) = %+v err=%v", d, err)
	}
	// Grant 前端组 view on secretPage -> Alice regains view; Bob still denied.
	if err := st.SetSubjectShareGuarded(ctx, ownerGuard, secretPage.ID, store.SubjectTypeDepartment, fe.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if d, err := st.GetDoc(ctx, alice.ID, secretPage.ID); err != nil || d.Role != store.RoleView {
		t.Fatalf("alice GetDoc(secretPage after fe grant) = %+v err=%v", d, err)
	}
	if _, err := st.GetDoc(ctx, bob.ID, secretPage.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("bob still should not see secretPage: %v", err)
	}

	// Drive-to-Wiki migration: create a Drive folder + child doc, migrate into pubSpace!
	driveFolder, err := st.CreateDriveFolder(ctx, ownerGuard, ws.ID, nil, "存量云盘目录", false)
	if err != nil {
		t.Fatal(err)
	}
	driveDoc, err := st.CreateDriveNode(ctx, ownerGuard, ws.ID, &driveFolder.ID, "doc", "存量云盘规范", false)
	if err != nil {
		t.Fatal(err)
	}
	// Cannot move a Wiki node with MoveDriveNode.
	if err := st.MoveDriveNode(ctx, ownerGuard, rootDoc.ID, &driveFolder.ID, rootDoc.Revision); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("MoveDriveNode on wiki node = %v, want ErrForbidden", err)
	}
	imported, err := st.ImportDriveNodeToWikiGuarded(ctx, ownerGuard, driveFolder.ID, pubSpace.ID, &wikiFolder.ID, driveFolder.Revision)
	if err != nil || imported.WikiSpaceID != pubSpace.ID || imported.ParentID == nil || *imported.ParentID != wikiFolder.ID {
		t.Fatalf("ImportDriveNodeToWiki = %+v err=%v", imported, err)
	}
	// Migrated child doc now belongs to pubSpace and is no longer in Drive root.
	migratedChild, err := st.GetDoc(ctx, bob.ID, driveDoc.ID)
	if err != nil || migratedChild.WikiSpaceID == nil || *migratedChild.WikiSpaceID != pubSpace.ID || migratedChild.Role != store.RoleView {
		t.Fatalf("migrated child for bob = %+v err=%v, want pubSpace view", migratedChild, err)
	}
	driveAfter, err := st.ListDriveChildren(ctx, ownerGuard, ws.ID, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range driveAfter {
		if entry.ID == driveFolder.ID {
			t.Fatalf("migrated folder still listed in Drive: %+v", entry)
		}
	}

	// Cross-space subtree move: move imported folder from pubSpace into privSpace -> Bob loses access to driveDoc!
	moved, err := st.MoveWikiNodeGuarded(ctx, ownerGuard, imported.ID, privSpace.ID, nil, imported.Revision)
	if err != nil || moved.WikiSpaceID != privSpace.ID || moved.ParentID != nil {
		t.Fatalf("cross-space MoveWikiNode = %+v err=%v", moved, err)
	}
	if _, err := st.GetDoc(ctx, bob.ID, driveDoc.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("bob still sees doc after cross-space move to private space: %v", err)
	}
	// Grant group 评审组 edit on privSpace -> Bob regains edit on privSpace and driveDoc!
	if _, err := st.SetWikiSpaceGrantGuarded(ctx, ownerGuard, privSpace.ID, store.SubjectTypeGroup, grp.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if d, err := st.GetDoc(ctx, bob.ID, driveDoc.ID); err != nil || d.Role != store.RoleEdit {
		t.Fatalf("bob GetDoc after privSpace group grant = %+v err=%v", d, err)
	}

	// Deleting group 评审组 cleans wiki_space_grants -> Bob loses privSpace access!
	if err := st.DeleteUserGroupGuarded(ctx, ownerGuard, ws.ID, grp.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetDoc(ctx, bob.ID, driveDoc.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("bob still sees privSpace doc after group delete: %v", err)
	}

	// Delete privSpace cascades its nodes cleanly.
	if _, err := st.DeleteWikiSpaceGuarded(ctx, ownerGuard, privSpace.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetWikiSpaceDetail(ctx, ownerGuard, privSpace.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted space still exists: %v", err)
	}
}

func TestMemoryWikiSpaces(t *testing.T) {
	exerciseWikiSpaces(t, store.NewMemory())
}

func TestPostgresWikiSpaces(t *testing.T) {
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
	exerciseWikiSpaces(t, pg)
}
