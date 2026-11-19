package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestWikiSpacesAPI(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	aliceClient := newCommentClient()
	bobClient := newCommentClient()

	registerUser := func(client *http.Client, email, name string) (store.User, store.Workspace) {
		res := post(t, client, ts.URL+"/api/auth/register", map[string]string{
			"email": email, "name": name, "password": "password123",
		})
		defer res.Body.Close()
		if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusOK {
			t.Fatalf("register %s: %d", email, res.StatusCode)
		}
		var me struct {
			User       store.User        `json:"user"`
			Workspaces []store.Workspace `json:"workspaces"`
		}
		if err := json.NewDecoder(res.Body).Decode(&me); err != nil {
			t.Fatal(err)
		}
		return me.User, me.Workspaces[0]
	}

	_, ws := registerUser(owner, "api-wiki-owner@example.test", "Owner")
	aliceUser, _ := registerUser(aliceClient, "api-wiki-alice@example.test", "Alice")
	bobUser, _ := registerUser(bobClient, "api-wiki-bob@example.test", "Bob")

	// Invite and accept Alice & Bob into ws.
	for _, tc := range []struct {
		u store.User
		c *http.Client
	}{{aliceUser, aliceClient}, {bobUser, bobClient}} {
		res := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/members", ts.URL, ws.ID), map[string]any{
			"email": tc.u.Email, "role": "member",
		})
		var ch store.WorkspaceMemberChange
		json.NewDecoder(res.Body).Decode(&ch)
		res.Body.Close()
		if res.StatusCode != http.StatusOK || ch.Invitation == nil {
			t.Fatalf("invite %s: %d %+v", tc.u.Email, res.StatusCode, ch)
		}
		acc := send(t, tc.c, http.MethodPost, fmt.Sprintf("%s/api/invitations/%d/accept", ts.URL, ch.Invitation.ID), nil)
		acc.Body.Close()
		if acc.StatusCode != http.StatusNoContent {
			t.Fatalf("accept %s: %d", tc.u.Email, acc.StatusCode)
		}
	}

	// Create department 研发中心 -> 前端组 (Alice).
	res := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/departments", ts.URL, ws.ID), map[string]any{"name": "研发中心"})
	var rnd store.OrgDepartment
	json.NewDecoder(res.Body).Decode(&rnd)
	res.Body.Close()
	res = send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/departments", ts.URL, ws.ID), map[string]any{"name": "前端组", "parentId": rnd.ID})
	var fe store.OrgDepartment
	json.NewDecoder(res.Body).Decode(&fe)
	res.Body.Close()
	res = send(t, owner, http.MethodPut, fmt.Sprintf("%s/api/workspaces/%d/departments/%d/members", ts.URL, ws.ID, fe.ID), map[string]any{"userId": aliceUser.ID, "present": true})
	res.Body.Close()

	// Create public Wiki space + private Wiki space.
	res = send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/wiki-spaces", ts.URL, ws.ID), map[string]any{
		"name": "研发知识库", "description": "技术文档", "icon": "book", "visibility": "workspace",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create pub wiki space = %d", res.StatusCode)
	}
	var pub store.WikiSpace
	json.NewDecoder(res.Body).Decode(&pub)
	res.Body.Close()

	res = send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/wiki-spaces", ts.URL, ws.ID), map[string]any{
		"name": "高管机密库", "visibility": "private",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create priv wiki space = %d", res.StatusCode)
	}
	var priv store.WikiSpace
	json.NewDecoder(res.Body).Decode(&priv)
	res.Body.Close()

	// Grant 研发中心 edit on pub -> Alice can create pages, Bob only views.
	res = send(t, owner, http.MethodPut, fmt.Sprintf("%s/api/wiki/spaces/%d/grants", ts.URL, pub.ID), map[string]any{
		"subjectType": "department", "subjectId": rnd.ID, "role": "edit",
	})
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put wiki grant = %d", res.StatusCode)
	}

	// Bob denied creating page in pub (403); Alice succeeds (201).
	denied := send(t, bobClient, http.MethodPost, fmt.Sprintf("%s/api/wiki/spaces/%d/nodes", ts.URL, pub.ID), map[string]any{
		"kind": "doc", "title": "越权页",
	})
	denied.Body.Close()
	if denied.StatusCode != http.StatusForbidden {
		t.Fatalf("bob create wiki node = %d, want 403", denied.StatusCode)
	}
	res = send(t, aliceClient, http.MethodPost, fmt.Sprintf("%s/api/wiki/spaces/%d/nodes", ts.URL, pub.ID), map[string]any{
		"kind": "doc", "title": "系统设计总览",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("alice create wiki doc = %d", res.StatusCode)
	}
	var rootNode store.WikiNodeEntry
	json.NewDecoder(res.Body).Decode(&rootNode)
	res.Body.Close()

	// Create board child via kind="board" shorthand.
	res = send(t, aliceClient, http.MethodPost, fmt.Sprintf("%s/api/wiki/spaces/%d/nodes", ts.URL, pub.ID), map[string]any{
		"kind": "board", "parentId": rootNode.ID, "title": "架构白板",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("alice create wiki board = %d", res.StatusCode)
	}
	var boardNode store.WikiNodeEntry
	json.NewDecoder(res.Body).Decode(&boardNode)
	res.Body.Close()
	if boardNode.Kind != "doc" || boardNode.DocType != "board" {
		t.Fatalf("unexpected board node: %+v", boardNode)
	}

	// Legacy POST /api/docs under a Wiki parent must fail with 409.
	legacy := send(t, owner, http.MethodPost, ts.URL+"/api/docs", map[string]any{
		"workspaceId": ws.ID, "parentId": rootNode.ID, "title": "非法挂接",
	})
	legacy.Body.Close()
	if legacy.StatusCode != http.StatusConflict {
		t.Fatalf("legacy createDoc under wiki parent = %d, want 409", legacy.StatusCode)
	}

	// Create Drive doc and migrate into pub space.
	res = send(t, owner, http.MethodPost, ts.URL+"/api/drive/nodes", map[string]any{
		"kind": "doc", "title": "存量规范", "scope": "shared",
	})
	var driveDoc store.DriveEntry
	json.NewDecoder(res.Body).Decode(&driveDoc)
	res.Body.Close()

	res = send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/wiki/spaces/%d/import-drive", ts.URL, pub.ID), map[string]any{
		"nodeId": driveDoc.ID, "targetParentId": rootNode.ID, "expectedRevision": driveDoc.Revision,
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("import drive to wiki = %d", res.StatusCode)
	}
	var imported store.WikiNodeEntry
	json.NewDecoder(res.Body).Decode(&imported)
	res.Body.Close()

	// Cross-space move imported doc into priv space -> Bob loses access!
	res = send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/wiki/nodes/%d/move", ts.URL, imported.ID), map[string]any{
		"targetSpaceId": priv.ID, "targetParentId": nil, "expectedRevision": imported.Revision,
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("cross-space move = %d", res.StatusCode)
	}
	res.Body.Close()

	bobGet := send(t, bobClient, http.MethodGet, fmt.Sprintf("%s/api/docs/%d", ts.URL, imported.ID), nil)
	bobGet.Body.Close()
	if bobGet.StatusCode != http.StatusNotFound {
		t.Fatalf("bob get doc moved to private wiki = %d, want 404", bobGet.StatusCode)
	}

	// Bob sees pub space and its 2 nodes, and Global Search finds 系统设计总览 with wikiSpaceId.
	res = send(t, bobClient, http.MethodGet, fmt.Sprintf("%s/api/wiki/spaces/%d", ts.URL, pub.ID), nil)
	var bobDetail store.WikiSpaceDetail
	json.NewDecoder(res.Body).Decode(&bobDetail)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || len(bobDetail.Nodes) != 2 || len(bobDetail.Grants) != 0 {
		t.Fatalf("bob wiki detail = %d %+v", res.StatusCode, bobDetail)
	}
	res = send(t, bobClient, http.MethodGet, ts.URL+"/api/search?q=系统设计", nil)
	var searchRes struct {
		Docs []store.DocMeta `json:"docs"`
	}
	json.NewDecoder(res.Body).Decode(&searchRes)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || len(searchRes.Docs) != 1 || searchRes.Docs[0].WikiSpaceID == nil || *searchRes.Docs[0].WikiSpaceID != pub.ID {
		t.Fatalf("bob search wiki doc = %d %+v", res.StatusCode, searchRes.Docs)
	}
}
