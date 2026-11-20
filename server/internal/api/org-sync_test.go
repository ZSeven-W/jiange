package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestOrgDirectorySyncAPI(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	aliceClient := newCommentClient()

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

	_, ws := registerUser(owner, "api-sync-owner@example.test", "Owner")
	alice, _ := registerUser(aliceClient, "api-sync-alice@example.test", "Alice")

	// Invite Alice and accept so she is a regular workspace member.
	invRes := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/members", ts.URL, ws.ID), map[string]any{
		"email": alice.Email, "role": "member",
	})
	var invChange store.WorkspaceMemberChange
	json.NewDecoder(invRes.Body).Decode(&invChange)
	invRes.Body.Close()
	accRes := send(t, aliceClient, http.MethodPost, fmt.Sprintf("%s/api/invitations/%d/accept", ts.URL, invChange.Invitation.ID), nil)
	accRes.Body.Close()
	if accRes.StatusCode != http.StatusNoContent {
		t.Fatalf("accept invite = %d", accRes.StatusCode)
	}

	// Non-admin member gets 403 on sync-sources endpoints.
	denied := send(t, aliceClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources", ts.URL, ws.ID), nil)
	denied.Body.Close()
	if denied.StatusCode != http.StatusForbidden {
		t.Fatalf("member GET sync-sources = %d, want 403", denied.StatusCode)
	}

	// Owner creates a SCIM sync source.
	createRes := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources", ts.URL, ws.ID), map[string]any{
		"name":              "Okta SCIM 2.0",
		"provider":          "scim",
		"autoInviteMissing": true,
		"pruneMissing":      true,
	})
	var created store.OrgSyncSourceCreated
	json.NewDecoder(createRes.Body).Decode(&created)
	createRes.Body.Close()
	if createRes.StatusCode != http.StatusCreated || created.Token == "" || created.Source.Provider != "scim" {
		t.Fatalf("create sync source = %d %+v", createRes.StatusCode, created)
	}

	// GET sync-sources lists metadata without leaking raw token.
	listRes := send(t, owner, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources", ts.URL, ws.ID), nil)
	var listBody struct {
		Sources []store.OrgSyncSource `json:"sources"`
		Runs    []store.OrgSyncRun    `json:"runs"`
	}
	json.NewDecoder(listRes.Body).Decode(&listBody)
	listRes.Body.Close()
	if listRes.StatusCode != http.StatusOK || len(listBody.Sources) != 1 || listBody.Sources[0].TokenPrefix == "" {
		t.Fatalf("list sync sources = %d %+v", listRes.StatusCode, listBody)
	}

	// Cycle payload via admin /run returns 409 with Chinese message.
	badRes := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources/%d/run", ts.URL, ws.ID, created.Source.ID), map[string]any{
		"departments": []map[string]any{
			{"externalId": "a", "parentExternalId": "b", "name": "A"},
			{"externalId": "b", "parentExternalId": "a", "name": "B"},
		},
	})
	var badErr struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	json.NewDecoder(badRes.Body).Decode(&badErr)
	badRes.Body.Close()
	if badRes.StatusCode != http.StatusConflict || badErr.Message == "" {
		t.Fatalf("cycle run = %d %+v, want 409", badRes.StatusCode, badErr)
	}

	// Dry-run via admin /run returns 200 with diff preview.
	dryRes := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources/%d/run", ts.URL, ws.ID, created.Source.ID), map[string]any{
		"dryRun": true,
		"departments": []map[string]any{
			{"externalId": "d-root", "name": "产品研发"},
		},
		"members": []map[string]any{
			{"email": alice.Email, "departmentExternalIds": []string{"d-root"}},
		},
	})
	var dryRun store.OrgSyncRun
	json.NewDecoder(dryRes.Body).Decode(&dryRun)
	dryRes.Body.Close()
	if dryRes.StatusCode != http.StatusOK || !dryRun.DryRun || dryRun.DepartmentsCreated != 1 {
		t.Fatalf("dry run = %d %+v", dryRes.StatusCode, dryRun)
	}

	// Bearer push without token -> 401; bad token -> 401.
	pushHTTP := func(token, contentType string, body any) *http.Response {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/org/sync/push", bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", contentType)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	noTok := pushHTTP("", "application/json", map[string]any{})
	noTok.Body.Close()
	if noTok.StatusCode != http.StatusUnauthorized {
		t.Fatalf("push without token = %d, want 401", noTok.StatusCode)
	}
	badTok := pushHTTP("jg_sync_wrong", "application/json", map[string]any{})
	badTok.Body.Close()
	if badTok.StatusCode != http.StatusUnauthorized {
		t.Fatalf("push with bad token = %d, want 401", badTok.StatusCode)
	}

	// Real SCIM 2.0 ListResponse with application/scim+json Content-Type!
	scimBody := map[string]any{
		"schemas": []string{"urn:ietf:params:scim:api:messages:2.0:ListResponse"},
		"Resources": []map[string]any{
			{
				"schemas":     []string{"urn:ietf:params:scim:schemas:core:2.0:User", "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"},
				"id":          "u-alice",
				"userName":    alice.Email,
				"displayName": "Alice",
				"active":      true,
				"emails":      []map[string]any{{"value": alice.Email, "primary": true}},
				"urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": map[string]any{
					"department": "产品研发/云文档组",
				},
			},
			{
				"schemas":     []string{"urn:ietf:params:scim:schemas:core:2.0:User"},
				"id":          "u-new",
				"userName":    "scim-invitee@example.test",
				"displayName": "New Hire",
				"active":      true,
				"emails":      []map[string]any{{"value": "scim-invitee@example.test", "primary": true}},
			},
			{
				"schemas":     []string{"urn:ietf:params:scim:schemas:core:2.0:Group"},
				"id":          "g-docs",
				"displayName": "云文档评审团",
				"members":     []map[string]any{{"value": "u-alice"}},
			},
		},
	}
	scimResp := pushHTTP(created.Token, "application/scim+json", scimBody)
	var scimRun store.OrgSyncRun
	json.NewDecoder(scimResp.Body).Decode(&scimRun)
	scimResp.Body.Close()
	if scimResp.StatusCode != http.StatusOK || scimRun.TriggerMode != store.OrgSyncTriggerSCIM || scimRun.DepartmentsCreated != 2 || scimRun.GroupsCreated != 1 || scimRun.MembersLinked != 1 || scimRun.MembersInvited != 1 {
		t.Fatalf("SCIM push = %d %+v", scimResp.StatusCode, scimRun)
	}

	// Disable source -> push returns 403; rotate token -> old fails, new succeeds.
	disRes := send(t, owner, http.MethodPatch, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources/%d", ts.URL, ws.ID, created.Source.ID), map[string]any{
		"enabled": false,
	})
	disRes.Body.Close()
	if disRes.StatusCode != http.StatusOK {
		t.Fatalf("disable source = %d", disRes.StatusCode)
	}
	disPush := pushHTTP(created.Token, "application/json", map[string]any{})
	disPush.Body.Close()
	if disPush.StatusCode != http.StatusForbidden {
		t.Fatalf("push disabled source = %d, want 403", disPush.StatusCode)
	}

	rotRes := send(t, owner, http.MethodPatch, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources/%d", ts.URL, ws.ID, created.Source.ID), map[string]any{
		"enabled":     true,
		"rotateToken": true,
	})
	var rotated store.OrgSyncSourceCreated
	json.NewDecoder(rotRes.Body).Decode(&rotated)
	rotRes.Body.Close()
	if rotRes.StatusCode != http.StatusOK || rotated.Token == "" || rotated.Token == created.Token {
		t.Fatalf("rotate source = %d %+v", rotRes.StatusCode, rotated)
	}
	oldPush := pushHTTP(created.Token, "application/json", map[string]any{})
	oldPush.Body.Close()
	if oldPush.StatusCode != http.StatusUnauthorized {
		t.Fatalf("old token push = %d, want 401", oldPush.StatusCode)
	}
	newPush := pushHTTP(rotated.Token, "application/scim+json", scimBody)
	newPush.Body.Close()
	if newPush.StatusCode != http.StatusOK {
		t.Fatalf("new token push = %d, want 200", newPush.StatusCode)
	}
}
