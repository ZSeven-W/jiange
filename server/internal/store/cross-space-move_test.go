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

func exerciseCrossSpaceMove(t *testing.T, st store.Store) {
	t.Helper()
	cs, ok := st.(store.CrossSpaceMoveStore)
	if !ok {
		t.Fatalf("store does not implement CrossSpaceMoveStore")
	}
	ctx := context.Background()

	owner, wsA, err := st.CreateUser(ctx, "csm-owner@example.test", "CSM Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	peer, wsB, err := st.CreateUser(ctx, "csm-peer@example.test", "CSM Peer", "hash")
	if err != nil {
		t.Fatal(err)
	}
	outsider, wsC, err := st.CreateUser(ctx, "csm-outsider@example.test", "CSM Outsider", "hash")
	if err != nil {
		t.Fatal(err)
	}
	// Owner is a member of wsB, but NOT wsC. Peer is a member of wsA.
	if err := st.AddWorkspaceMember(ctx, wsB.ID, owner.ID); err != nil {
		t.Fatal(err)
	}
	if err := st.AddWorkspaceMember(ctx, wsA.ID, peer.ID); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC()
	ownerGuard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("csm-owner-sess"), Now: func() time.Time { return now }}
	peerGuard := store.RestoreGuard{UserID: peer.ID, SessionHash: []byte("csm-peer-sess"), Now: func() time.Time { return now }}
	if err := st.CreateSession(ctx, ownerGuard.SessionHash, owner.ID, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateSession(ctx, peerGuard.SessionHash, peer.ID, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	// Build a personal subtree in wsA: personalFolder -> childFolder -> doc + base + sheet + slides + file.
	personalFolder, err := st.CreateDriveFolder(ctx, ownerGuard, wsA.ID, nil, "我的项目", true)
	if err != nil {
		t.Fatal(err)
	}
	childFolder, err := st.CreateDriveFolder(ctx, ownerGuard, wsA.ID, &personalFolder.ID, "子目录", true)
	if err != nil {
		t.Fatal(err)
	}
	docNode, err := st.CreateDriveNode(ctx, ownerGuard, wsA.ID, &childFolder.ID, "doc", "产品方案", true)
	if err != nil {
		t.Fatal(err)
	}
	baseNode, err := st.CreateDriveNode(ctx, ownerGuard, wsA.ID, &childFolder.ID, "base", "排期多维表", true)
	if err != nil {
		t.Fatal(err)
	}
	sheetNode, err := st.CreateDriveNode(ctx, ownerGuard, wsA.ID, &childFolder.ID, "sheet", "预算表格", true)
	if err != nil {
		t.Fatal(err)
	}
	slidesNode, err := st.CreateDriveNode(ctx, ownerGuard, wsA.ID, &childFolder.ID, "slides", "汇报幻灯片", true)
	if err != nil {
		t.Fatal(err)
	}
	fileNode, err := st.CreateDriveFile(ctx, ownerGuard, wsA.ID, &childFolder.ID, store.FileMeta{
		Name: "spec.pdf", Mime: "application/pdf", Size: 128, ObjectKey: "csm-spec-key",
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	sharedTargetA, err := st.CreateDriveFolder(ctx, ownerGuard, wsA.ID, nil, "团队共享目录", false)
	if err != nil {
		t.Fatal(err)
	}
	sharedTargetB, err := st.CreateDriveFolder(ctx, ownerGuard, wsB.ID, nil, "空间B共享目录", false)
	if err != nil {
		t.Fatal(err)
	}

	// Existing MoveDriveNode STILL forbids cross-scope move!
	if err := st.MoveDriveNode(ctx, ownerGuard, personalFolder.ID, &sharedTargetA.ID, personalFolder.Revision); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("MoveDriveNode cross-scope err = %v, want ErrForbidden", err)
	}

	// Unauthorized actor (peer has no manage role on owner's personalFolder) rejected.
	if _, err := cs.CrossSpaceMoveNode(ctx, peer.ID, personalFolder.ID, wsA.ID, &sharedTargetA.ID, false, personalFolder.Revision); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("peer move personal folder err = %v, want ErrForbidden", err)
	}
	// Moving into workspace where actor is NOT a member (wsC) rejected.
	if _, err := cs.CrossSpaceMoveNode(ctx, owner.ID, personalFolder.ID, wsC.ID, nil, false, personalFolder.Revision); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("move to non-member wsC err = %v, want ErrForbidden", err)
	}
	// Outsider moving into wsB rejected.
	if _, err := cs.CrossSpaceMoveNode(ctx, outsider.ID, personalFolder.ID, wsB.ID, nil, false, personalFolder.Revision); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("outsider move err = %v, want ErrForbidden", err)
	}
	// Stale expectedDriveRevision rejected with ErrConflict.
	if _, err := cs.CrossSpaceMoveNode(ctx, owner.ID, personalFolder.ID, 0, &sharedTargetA.ID, false, personalFolder.Revision+99); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale revision err = %v, want ErrConflict", err)
	}
	// Cycle guard: moving personalFolder into itself or its descendant childFolder rejected.
	if _, err := cs.CrossSpaceMoveNode(ctx, owner.ID, personalFolder.ID, wsA.ID, &personalFolder.ID, true, personalFolder.Revision); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("self parent err = %v, want ErrConflict", err)
	}
	if _, err := cs.CrossSpaceMoveNode(ctx, owner.ID, personalFolder.ID, wsA.ID, &childFolder.ID, true, personalFolder.Revision); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("descendant cycle err = %v, want ErrConflict", err)
	}
	// Mismatched targetPersonal vs targetParent's personal scope rejected.
	if _, err := cs.CrossSpaceMoveNode(ctx, owner.ID, personalFolder.ID, wsA.ID, &sharedTargetA.ID, true, personalFolder.Revision); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("targetPersonal mismatch err = %v, want ErrConflict", err)
	}
	// Non-folder targetParent rejected.
	if _, err := cs.CrossSpaceMoveNode(ctx, owner.ID, personalFolder.ID, wsA.ID, &docNode.ID, true, personalFolder.Revision); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("non-folder parent err = %v, want ErrConflict", err)
	}

	// 1. Same-workspace cross-scope move (targetWorkspaceID == 0 defaults to wsA): personal -> shared folder.
	movedA, err := cs.CrossSpaceMoveNode(ctx, owner.ID, personalFolder.ID, 0, &sharedTargetA.ID, false, personalFolder.Revision)
	if err != nil {
		t.Fatalf("personal -> shared move: %v", err)
	}
	if movedA.WorkspaceID != wsA.ID || movedA.Personal || movedA.ParentID == nil || *movedA.ParentID != sharedTargetA.ID || movedA.Revision != personalFolder.Revision+1 {
		t.Fatalf("unexpected movedA: %+v", movedA)
	}
	// Peer (member of wsA) can now see personalFolder AND every descendant type inside sharedTargetA!
	childrenA, err := st.ListDriveChildren(ctx, peerGuard, wsA.ID, &sharedTargetA.ID, false)
	if err != nil || len(childrenA) != 1 || childrenA[0].ID != personalFolder.ID || childrenA[0].Personal {
		t.Fatalf("peer shared children = %+v err=%v", childrenA, err)
	}
	subChildrenA, err := st.ListDriveChildren(ctx, peerGuard, wsA.ID, &childFolder.ID, false)
	if err != nil || len(subChildrenA) != 5 {
		t.Fatalf("expected all 5 descendant types visible in shared scope, got %d (%+v) err=%v", len(subChildrenA), subChildrenA, err)
	}
	for _, entry := range subChildrenA {
		if entry.Personal || entry.WorkspaceID != wsA.ID {
			t.Fatalf("descendant %d still personal or wrong ws: %+v", entry.ID, entry)
		}
	}

	// 2. Cross-workspace move: wsA shared -> wsB sharedTargetB (entire subtree moves to wsB!).
	movedB, err := cs.CrossSpaceMoveNode(ctx, owner.ID, personalFolder.ID, wsB.ID, &sharedTargetB.ID, false, movedA.Revision)
	if err != nil {
		t.Fatalf("wsA -> wsB cross-workspace move: %v", err)
	}
	if movedB.WorkspaceID != wsB.ID || movedB.Personal || movedB.ParentID == nil || *movedB.ParentID != sharedTargetB.ID || movedB.Revision != movedA.Revision+1 {
		t.Fatalf("unexpected movedB: %+v", movedB)
	}
	// Verify every descendant moved to wsB and is no longer listed in wsA.
	wsARemaining, err := st.ListDriveChildren(ctx, ownerGuard, wsA.ID, &sharedTargetA.ID, false)
	if err != nil || len(wsARemaining) != 0 {
		t.Fatalf("wsA should be empty after cross-workspace move, got %+v err=%v", wsARemaining, err)
	}
	for _, id := range []int64{personalFolder.ID, childFolder.ID, docNode.ID, baseNode.ID, sheetNode.ID, slidesNode.ID, fileNode.ID} {
		meta, err := st.GetDocSystem(ctx, id)
		if err != nil {
			t.Fatalf("GetDocSystem(%d): %v", id, err)
		}
		if meta.WorkspaceID != wsB.ID {
			t.Fatalf("node %d workspace = %d, want %d", id, meta.WorkspaceID, wsB.ID)
		}
		if meta.WikiSpaceID != nil {
			t.Fatalf("node %d wiki_space_id not cleared: %v", id, *meta.WikiSpaceID)
		}
	}
	// Peer (member of wsB) can list the moved subtree inside wsB.
	wsBChildren, err := st.ListDriveChildren(ctx, ownerGuard, wsB.ID, &childFolder.ID, false)
	if err != nil || len(wsBChildren) != 5 {
		t.Fatalf("wsB subtree children = %d err=%v", len(wsBChildren), err)
	}

	// 3. Move back to root personal space inside wsB (targetParentID = nil, targetPersonal = true).
	movedPersonalB, err := cs.CrossSpaceMoveNode(ctx, owner.ID, personalFolder.ID, wsB.ID, nil, true, movedB.Revision)
	if err != nil {
		t.Fatalf("wsB shared -> wsB personal root: %v", err)
	}
	if movedPersonalB.WorkspaceID != wsB.ID || !movedPersonalB.Personal || movedPersonalB.ParentID != nil {
		t.Fatalf("unexpected movedPersonalB: %+v", movedPersonalB)
	}
	// Peer (wsB owner, NOT creator of personalFolder) cannot see owner's personal folder in wsB.
	peerPersonalB, err := st.ListDriveChildren(ctx, peerGuard, wsB.ID, nil, true)
	if err != nil || len(peerPersonalB) != 0 {
		t.Fatalf("peer saw owner personal folder in wsB: %+v err=%v", peerPersonalB, err)
	}
	ownerPersonalB, err := st.ListDriveChildren(ctx, ownerGuard, wsB.ID, nil, true)
	if err != nil || len(ownerPersonalB) != 1 || ownerPersonalB[0].ID != personalFolder.ID {
		t.Fatalf("owner personal root in wsB = %+v err=%v", ownerPersonalB, err)
	}
}

func TestCrossSpaceMoveMemory(t *testing.T) {
	exerciseCrossSpaceMove(t, store.NewMemory())
}

func TestCrossSpaceMovePostgres(t *testing.T) {
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
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	exerciseCrossSpaceMove(t, pg)
}
