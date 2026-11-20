package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func runWikiTreeShortcutsSuite(t *testing.T, st store.Store) {
	t.Helper()
	srv := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1,
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	newClient := func() *http.Client {
		j, _ := cookiejar.New(nil)
		return &http.Client{Jar: j}
	}
	cOwner := newClient()
	cBob := newClient()

	doJSON := func(c *http.Client, method, path string, body any, uid int64) (int, []byte) {
		t.Helper()
		var rdr io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rdr = bytesReader(b)
		}
		req, err := http.NewRequest(method, ts.URL+path, rdr)
		if err != nil {
			t.Fatal(err)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if uid > 0 {
			req.Header.Set("X-Jiange-User-Id", fmt.Sprintf("%d", uid))
		}
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		return res.StatusCode, raw
	}

	register := func(c *http.Client, email, name string) (store.User, store.Workspace) {
		code, raw := doJSON(c, http.MethodPost, "/api/auth/register", map[string]string{
			"email": email, "name": name, "password": "password123",
		}, 0)
		if code != http.StatusCreated {
			t.Fatalf("register %s: status=%d body=%s", email, code, raw)
		}
		var out struct {
			User       store.User        `json:"user"`
			Workspaces []store.Workspace `json:"workspaces"`
		}
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return out.User, out.Workspaces[0]
	}

	owner, ws := register(cOwner, "wiki-dnd-owner@test.dev", "Owner")
	bob, _ := register(cBob, "wiki-dnd-bob@test.dev", "Bob")

	// Invite and accept Bob into ws as regular workspace member.
	code, raw := doJSON(cOwner, http.MethodPost, fmt.Sprintf("/api/workspaces/%d/members", ws.ID), map[string]any{
		"email": bob.Email, "role": "member",
	}, owner.ID)
	if code != http.StatusOK {
		t.Fatalf("invite bob: %d %s", code, raw)
	}
	var ch store.WorkspaceMemberChange
	_ = json.Unmarshal(raw, &ch)
	code, raw = doJSON(cBob, http.MethodPost, fmt.Sprintf("/api/invitations/%d/accept", ch.Invitation.ID), nil, bob.ID)
	if code != http.StatusNoContent {
		t.Fatalf("accept invite: %d %s", code, raw)
	}

	// Create 3 Wiki spaces: Space A (workspace), Space B (workspace), Space C (private).
	createSpace := func(name, vis string) store.WikiSpace {
		c, b := doJSON(cOwner, http.MethodPost, fmt.Sprintf("/api/workspaces/%d/wiki-spaces", ws.ID), map[string]any{
			"name": name, "visibility": vis,
		}, owner.ID)
		if c != http.StatusCreated {
			t.Fatalf("create space %s: %d %s", name, c, b)
		}
		var sp store.WikiSpace
		_ = json.Unmarshal(b, &sp)
		return sp
	}
	spaceA := createSpace("研发主知识库", "workspace")
	spaceB := createSpace("产品设计规范库", "workspace")
	spacePriv := createSpace("高管机密知识库", "private")

	createNode := func(spaceID int64, parentID *int64, kind, title string) store.WikiNodeEntry {
		c, b := doJSON(cOwner, http.MethodPost, fmt.Sprintf("/api/wiki/spaces/%d/nodes", spaceID), map[string]any{
			"parentId": parentID, "kind": kind, "title": title,
		}, owner.ID)
		if c != http.StatusCreated {
			t.Fatalf("create node %s: %d %s", title, c, b)
		}
		var n store.WikiNodeEntry
		_ = json.Unmarshal(b, &n)
		return n
	}

	// 1. Create A, B, C, FolderF in Space A.
	nodeA := createNode(spaceA.ID, nil, "doc", "第一页 A")
	nodeB := createNode(spaceA.ID, nil, "doc", "第二页 B")
	nodeC := createNode(spaceA.ID, nil, "doc", "第三页 C")
	folderF := createNode(spaceA.ID, nil, "folder", "分组 F")

	// View-only Bob cannot reorder nodes (403).
	code, _ = doJSON(cBob, http.MethodPost, fmt.Sprintf("/api/wiki/spaces/%d/nodes/%d/reorder", spaceA.ID, nodeC.ID), map[string]any{
		"targetParentId": nil, "position": 0, "expectedRevision": nodeC.Revision,
	}, bob.ID)
	if code != http.StatusForbidden {
		t.Fatalf("bob reorder expected 403, got %d", code)
	}

	// 2. Drag nodeC to position 0 (before nodeA) -> expected root order: [nodeC, nodeA, nodeB, folderF].
	code, raw = doJSON(cOwner, http.MethodPost, fmt.Sprintf("/api/wiki/spaces/%d/nodes/%d/reorder", spaceA.ID, nodeC.ID), map[string]any{
		"targetParentId": nil, "position": 0, "expectedRevision": nodeC.Revision,
	}, owner.ID)
	if code != http.StatusOK {
		t.Fatalf("reorder nodeC to 0: %d %s", code, raw)
	}
	var movedC store.WikiNodeEntry
	_ = json.Unmarshal(raw, &movedC)
	if movedC.Revision != nodeC.Revision+1 {
		t.Fatalf("expected revision incremented, got %d", movedC.Revision)
	}

	// Stale revision conflict must return 409.
	code, _ = doJSON(cOwner, http.MethodPost, fmt.Sprintf("/api/wiki/spaces/%d/nodes/%d/reorder", spaceA.ID, nodeC.ID), map[string]any{
		"targetParentId": nil, "position": 2, "expectedRevision": nodeC.Revision,
	}, owner.ID)
	if code != http.StatusConflict {
		t.Fatalf("stale revision expected 409, got %d", code)
	}

	// Verify exact order in GET /api/wiki/spaces/{spaceA}.
	getDetail := func(c *http.Client, uid, spaceID int64) store.WikiSpaceDetail {
		sc, body := doJSON(c, http.MethodGet, fmt.Sprintf("/api/wiki/spaces/%d", spaceID), nil, uid)
		if sc != http.StatusOK {
			t.Fatalf("get space %d: %d %s", spaceID, sc, body)
		}
		var d store.WikiSpaceDetail
		_ = json.Unmarshal(body, &d)
		return d
	}
	detail := getDetail(cOwner, owner.ID, spaceA.ID)
	if len(detail.Nodes) != 4 || detail.Nodes[0].ID != nodeC.ID || detail.Nodes[1].ID != nodeA.ID || detail.Nodes[2].ID != nodeB.ID || detail.Nodes[3].ID != folderF.ID {
		t.Fatalf("unexpected root order after reorder: %+v", detail.Nodes)
	}

	// 3. Create new nodeD at root -> must append AFTER existing reordered siblings!
	nodeD := createNode(spaceA.ID, nil, "doc", "第四页 D")
	detail = getDetail(cOwner, owner.ID, spaceA.ID)
	if len(detail.Nodes) != 5 || detail.Nodes[4].ID != nodeD.ID {
		t.Fatalf("new nodeD should append at end, got %+v", detail.Nodes)
	}

	// 4. Nest nodeB inside nodeC (reparenting!), then verify cycle rejection (nodeC inside nodeB -> 409)
	// and folder-inside-doc rejection (folderF inside nodeA -> 409).
	code, raw = doJSON(cOwner, http.MethodPost, fmt.Sprintf("/api/wiki/spaces/%d/nodes/%d/reorder", spaceA.ID, nodeB.ID), map[string]any{
		"targetParentId": nodeC.ID, "position": 0, "expectedRevision": nodeB.Revision,
	}, owner.ID)
	if code != http.StatusOK {
		t.Fatalf("nest nodeB inside nodeC: %d %s", code, raw)
	}
	var movedB store.WikiNodeEntry
	_ = json.Unmarshal(raw, &movedB)
	if movedB.ParentID == nil || *movedB.ParentID != nodeC.ID {
		t.Fatalf("expected nodeB parent=%d, got %+v", nodeC.ID, movedB.ParentID)
	}

	code, _ = doJSON(cOwner, http.MethodPost, fmt.Sprintf("/api/wiki/spaces/%d/nodes/%d/reorder", spaceA.ID, nodeC.ID), map[string]any{
		"targetParentId": nodeB.ID, "position": 0, "expectedRevision": movedC.Revision,
	}, owner.ID)
	if code != http.StatusConflict {
		t.Fatalf("cycle reorder expected 409, got %d", code)
	}

	code, _ = doJSON(cOwner, http.MethodPost, fmt.Sprintf("/api/wiki/spaces/%d/nodes/%d/reorder", spaceA.ID, folderF.ID), map[string]any{
		"targetParentId": nodeA.ID, "position": 0, "expectedRevision": folderF.Revision,
	}, owner.ID)
	if code != http.StatusConflict {
		t.Fatalf("folder under doc expected 409, got %d", code)
	}

	// 5. Cross-space & Drive shortcuts!
	targetInB := createNode(spaceB.ID, nil, "doc", "设计语言 2.0 规范")
	secretInPriv := createNode(spacePriv.ID, nil, "doc", "绝密财务预测 2027")

	code, raw = doJSON(cOwner, http.MethodPost, "/api/drive/nodes", map[string]any{
		"kind": "sheet", "title": "云盘研发排期表", "scope": "shared",
	}, owner.ID)
	if code != http.StatusCreated {
		t.Fatalf("create drive sheet: %d %s", code, raw)
	}
	var driveSheet store.DriveEntry
	_ = json.Unmarshal(raw, &driveSheet)

	// Bob (view-only on Space A) cannot add shortcuts (403).
	code, _ = doJSON(cBob, http.MethodPost, fmt.Sprintf("/api/wiki/spaces/%d/shortcuts", spaceA.ID), map[string]any{
		"parentId": nil, "targetNodeId": targetInB.ID,
	}, bob.ID)
	if code != http.StatusForbidden {
		t.Fatalf("bob create shortcut expected 403, got %d", code)
	}

	// Owner adds 3 shortcuts into Space A:
	// - sc1 at root -> Space B page
	// - sc2 nested under folderF -> Drive Sheet
	// - sc3 at root -> Private Space page (invisible to Bob!)
	createShortcut := func(parentID *int64, targetID int64, title string) store.WikiShortcut {
		c, b := doJSON(cOwner, http.MethodPost, fmt.Sprintf("/api/wiki/spaces/%d/shortcuts", spaceA.ID), map[string]any{
			"parentId": parentID, "targetNodeId": targetID, "title": title,
		}, owner.ID)
		if c != http.StatusCreated {
			t.Fatalf("create shortcut target=%d: %d %s", targetID, c, b)
		}
		var sc store.WikiShortcut
		_ = json.Unmarshal(b, &sc)
		return sc
	}
	scCross := createShortcut(nil, targetInB.ID, "跨库：设计规范引用")
	scDrive := createShortcut(&folderF.ID, driveSheet.ID, "")
	scSecret := createShortcut(nil, secretInPriv.ID, "绝密直达")

	if !scCross.TargetAccessible || scCross.TargetWikiSpaceID == nil || *scCross.TargetWikiSpaceID != spaceB.ID {
		t.Fatalf("unexpected cross-space shortcut: %+v", scCross)
	}
	if !scDrive.TargetAccessible || scDrive.TargetKind != "sheet" || scDrive.TargetWikiSpaceID != nil {
		t.Fatalf("unexpected drive shortcut: %+v", scDrive)
	}

	// Duplicate shortcut under same parent returns 409.
	code, _ = doJSON(cOwner, http.MethodPost, fmt.Sprintf("/api/wiki/spaces/%d/shortcuts", spaceA.ID), map[string]any{
		"parentId": nil, "targetNodeId": targetInB.ID,
	}, owner.ID)
	if code != http.StatusConflict {
		t.Fatalf("duplicate shortcut expected 409, got %d", code)
	}

	// Live permission fencing check for Bob on GET /api/wiki/spaces/{spaceA}:
	bobDetail := getDetail(cBob, bob.ID, spaceA.ID)
	if len(bobDetail.Shortcuts) != 3 {
		t.Fatalf("expected 3 shortcut rows for bob, got %d", len(bobDetail.Shortcuts))
	}
	var sawCross, sawDrive, sawMaskedSecret bool
	for _, sc := range bobDetail.Shortcuts {
		switch sc.ID {
		case scCross.ID:
			if sc.TargetAccessible && sc.TargetTitle == "设计语言 2.0 规范" && sc.TargetWikiSpaceName == "产品设计规范库" {
				sawCross = true
			}
		case scDrive.ID:
			if sc.TargetAccessible && sc.TargetKind == "sheet" && sc.ParentID != nil && *sc.ParentID == folderF.ID {
				sawDrive = true
			}
		case scSecret.ID:
			// Must mask BOTH TargetTitle and shortcut Title when caller lacks access!
			if !sc.TargetAccessible && sc.Title == "" && sc.TargetTitle == "" && sc.TargetKind == "" && sc.TargetWikiSpaceID == nil {
				sawMaskedSecret = true
			}
		}
	}
	if !sawCross || !sawDrive || !sawMaskedSecret {
		t.Fatalf("bob shortcut fencing failed: cross=%v drive=%v maskedSecret=%v all=%+v", sawCross, sawDrive, sawMaskedSecret, bobDetail.Shortcuts)
	}

	// Bob cannot delete Owner's shortcut (403); Owner can delete it (204).
	code, _ = doJSON(cBob, http.MethodDelete, fmt.Sprintf("/api/wiki/spaces/%d/shortcuts/%d", spaceA.ID, scSecret.ID), nil, bob.ID)
	if code != http.StatusForbidden {
		t.Fatalf("bob delete shortcut expected 403, got %d", code)
	}
	code, _ = doJSON(cOwner, http.MethodDelete, fmt.Sprintf("/api/wiki/spaces/%d/shortcuts/%d", spaceA.ID, scSecret.ID), nil, owner.ID)
	if code != http.StatusNoContent {
		t.Fatalf("owner delete shortcut expected 204, got %d", code)
	}
	afterDel := getDetail(cOwner, owner.ID, spaceA.ID)
	if len(afterDel.Shortcuts) != 2 {
		t.Fatalf("expected 2 shortcuts after delete, got %d", len(afterDel.Shortcuts))
	}
}

func TestWikiTreeShortcutsMemory(t *testing.T) {
	runWikiTreeShortcutsSuite(t, store.NewMemory())
}

func TestWikiTreeShortcutsPostgres(t *testing.T) {
	dbURL := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("jiange_wiki_ts_%d", time.Now().UnixNano())}.Sanitize()
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
		admin.Close()
	}()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.ConnConfig.RuntimeParams["application_name"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	runWikiTreeShortcutsSuite(t, &store.Postgres{Pool: pool})
}
