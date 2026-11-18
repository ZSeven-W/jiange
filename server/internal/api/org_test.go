package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestOrgAndInheritanceAPI(t *testing.T) {
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

	ownerUser, ws := registerUser(owner, "api-org-owner@example.test", "Owner")
	aliceUser, _ := registerUser(aliceClient, "api-org-alice@example.test", "Alice")
	bobUser, _ := registerUser(bobClient, "api-org-bob@example.test", "Bob")

	// Invite Alice and Bob to owner's workspace.
	for _, u := range []store.User{aliceUser, bobUser} {
		res := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/members", ts.URL, ws.ID), map[string]any{
			"email": u.Email, "role": "member",
		})
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("invite %s: %d", u.Email, res.StatusCode)
		}
	}

	// Non-admin member cannot create a department (403).
	denied := send(t, aliceClient, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/departments", ts.URL, ws.ID), map[string]any{
		"name": "Unauthorized",
	})
	denied.Body.Close()
	if denied.StatusCode != http.StatusForbidden {
		t.Fatalf("member create dept status = %d, want 403", denied.StatusCode)
	}

	// Owner creates 研发中心 -> 前端组, adds Alice to 前端组.
	res := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/departments", ts.URL, ws.ID), map[string]any{
		"name": "研发中心", "sortOrder": 1,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create dept status = %d", res.StatusCode)
	}
	var rnd store.OrgDepartment
	json.NewDecoder(res.Body).Decode(&rnd)
	res.Body.Close()

	res = send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/departments", ts.URL, ws.ID), map[string]any{
		"name": "前端组", "parentId": rnd.ID, "sortOrder": 1,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create sub-dept status = %d", res.StatusCode)
	}
	var fe store.OrgDepartment
	json.NewDecoder(res.Body).Decode(&fe)
	res.Body.Close()

	res = send(t, owner, http.MethodPut, fmt.Sprintf("%s/api/workspaces/%d/departments/%d/members", ts.URL, ws.ID, fe.ID), map[string]any{
		"userId": aliceUser.ID, "present": true, "isLeader": true,
	})
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("add dept member status = %d", res.StatusCode)
	}

	// Create user group and add Bob.
	res = send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/groups", ts.URL, ws.ID), map[string]any{
		"name": "产品评审组", "description": "PRD Review",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create group status = %d", res.StatusCode)
	}
	var grp store.OrgGroup
	json.NewDecoder(res.Body).Decode(&grp)
	res.Body.Close()

	res = send(t, owner, http.MethodPut, fmt.Sprintf("%s/api/workspaces/%d/groups/%d/members", ts.URL, ws.ID, grp.ID), map[string]any{
		"userId": bobUser.ID, "present": true,
	})
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("add group member status = %d", res.StatusCode)
	}

	// Create folder + doc in shared scope.
	res = post(t, owner, ts.URL+"/api/drive/folders", map[string]any{
		"workspaceId": ws.ID, "title": "保密方案目录", "scope": "shared",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create folder status = %d", res.StatusCode)
	}
	var folder store.DriveEntry
	json.NewDecoder(res.Body).Decode(&folder)
	res.Body.Close()

	res = post(t, owner, ts.URL+"/api/drive/nodes", map[string]any{
		"workspaceId": ws.ID, "parentId": folder.ID, "kind": "doc", "title": "核心薪资保密预算", "scope": "shared",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create doc status = %d", res.StatusCode)
	}
	var docEntry store.DriveEntry
	json.NewDecoder(res.Body).Decode(&docEntry)
	res.Body.Close()

	// Account-mismatch header must reject.
	req, _ := http.NewRequest(http.MethodPut, fmt.Sprintf("%s/api/docs/%d/inheritance", ts.URL, docEntry.ID), nil)
	req.Header.Set("X-Jiange-User-Id", fmt.Sprintf("%d", aliceUser.ID))
	mismatchRes, err := owner.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	mismatchRes.Body.Close()
	if mismatchRes.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 session_changed on mismatched X-Jiange-User-Id, got %d", mismatchRes.StatusCode)
	}

	// Turn OFF inherit_parent_acl on folder.
	res = send(t, owner, http.MethodPut, fmt.Sprintf("%s/api/docs/%d/inheritance", ts.URL, folder.ID), map[string]any{
		"inheritParentAcl": false,
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("toggle inheritance status = %d", res.StatusCode)
	}
	var folderShare struct {
		InheritParentACL bool                 `json:"inheritParentAcl"`
		WorkspaceID      int64                `json:"workspaceId"`
		Subjects         []store.SubjectShare `json:"subjects"`
		Role             string               `json:"role"`
	}
	json.NewDecoder(res.Body).Decode(&folderShare)
	res.Body.Close()
	if folderShare.InheritParentACL || folderShare.WorkspaceID != ws.ID || folderShare.Role != store.RoleManage {
		t.Fatalf("unexpected share response after inheritance toggle: %+v", folderShare)
	}

	// Neither Alice nor Bob can see the folder or doc via GET /api/docs/{id}, /api/docs, or /api/search.
	checkAccess := func(client *http.Client, docID int64, wantStatus int) {
		r := cGet(t, client, fmt.Sprintf("%s/api/docs/%d", ts.URL, docID))
		r.Body.Close()
		if r.StatusCode != wantStatus {
			t.Fatalf("GET /api/docs/%d status = %d, want %d", docID, r.StatusCode, wantStatus)
		}
	}
	checkAccess(bobClient, docEntry.ID, http.StatusNotFound)
	checkAccess(aliceClient, docEntry.ID, http.StatusNotFound)

	listContains := func(client *http.Client, endpoint string, docID int64) bool {
		r := cGet(t, client, endpoint)
		defer r.Body.Close()
		if r.StatusCode != http.StatusOK {
			t.Fatalf("%s status = %d", endpoint, r.StatusCode)
		}
		var payload struct {
			Docs []store.DocMeta `json:"docs"`
		}
		json.NewDecoder(r.Body).Decode(&payload)
		for _, item := range payload.Docs {
			if item.ID == docID {
				return true
			}
		}
		return false
	}
	if listContains(bobClient, ts.URL+"/api/docs", docEntry.ID) {
		t.Fatalf("/api/docs leaked restricted doc to ungranted workspace member")
	}
	if listContains(bobClient, ts.URL+"/api/search?q=核心薪资", docEntry.ID) {
		t.Fatalf("/api/search leaked restricted doc to ungranted workspace member")
	}

	// Grant ancestor department 研发中心 edit access on folder -> Alice in 前端组 gains edit!
	res = send(t, owner, http.MethodPut, fmt.Sprintf("%s/api/docs/%d/subject-shares", ts.URL, folder.ID), map[string]any{
		"subjectType": "department", "subjectId": rnd.ID, "role": "edit",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put subject-share status = %d", res.StatusCode)
	}
	json.NewDecoder(res.Body).Decode(&folderShare)
	res.Body.Close()
	if len(folderShare.Subjects) != 1 || folderShare.Subjects[0].Name != "研发中心" || folderShare.Subjects[0].Role != "edit" {
		t.Fatalf("unexpected subjects after dept share: %+v", folderShare.Subjects)
	}

	checkAccess(aliceClient, docEntry.ID, http.StatusOK)
	checkAccess(bobClient, docEntry.ID, http.StatusNotFound)
	if !listContains(aliceClient, ts.URL+"/api/search?q=核心薪资", docEntry.ID) {
		t.Fatalf("expected Alice search to find doc granted via ancestor department")
	}

	// Grant group view to Bob -> Bob gains view, then remove group share -> Bob loses access.
	res = send(t, owner, http.MethodPut, fmt.Sprintf("%s/api/docs/%d/subject-shares", ts.URL, folder.ID), map[string]any{
		"subjectType": "group", "subjectId": grp.ID, "role": "view",
	})
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("group share status = %d", res.StatusCode)
	}
	checkAccess(bobClient, docEntry.ID, http.StatusOK)

	res = send(t, owner, http.MethodPut, fmt.Sprintf("%s/api/docs/%d/subject-shares", ts.URL, folder.ID), map[string]any{
		"subjectType": "group", "subjectId": grp.ID, "role": "",
	})
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("revoke group share status = %d", res.StatusCode)
	}
	checkAccess(bobClient, docEntry.ID, http.StatusNotFound)

	// Verify org GET returns snapshot cleanly for Alice (role=member) & Owner (role=owner).
	orgRes := cGet(t, aliceClient, fmt.Sprintf("%s/api/workspaces/%d/org", ts.URL, ws.ID))
	defer orgRes.Body.Close()
	if orgRes.StatusCode != http.StatusOK {
		t.Fatalf("getWorkspaceOrg status = %d", orgRes.StatusCode)
	}
	var snap store.WorkspaceOrgSnapshot
	json.NewDecoder(orgRes.Body).Decode(&snap)
	if snap.CallerRole != "member" || len(snap.Members) != 3 || len(snap.Departments) != 2 || len(snap.Groups) != 1 || snap.Members[0].UserID != ownerUser.ID {
		t.Fatalf("unexpected org GET payload: %+v", snap)
	}
}
