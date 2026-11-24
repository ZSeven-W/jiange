package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newWorkspaceTestServer(t *testing.T, st store.Store) (*Server, *httptest.Server) {
	t.Helper()
	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/register", s.register)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.Handle("GET /api/me", s.requireUser(http.HandlerFunc(s.me)))
	mux.Handle("GET /api/workspaces", s.requireUser(http.HandlerFunc(s.listMyWorkspaces)))
	mux.Handle("POST /api/workspaces", s.requireUser(http.HandlerFunc(s.createWorkspace)))
	mux.Handle("PATCH /api/workspaces/{wsId}", s.requireUser(http.HandlerFunc(s.renameWorkspace)))
	mux.Handle("DELETE /api/workspaces/{wsId}", s.requireUser(http.HandlerFunc(s.deleteWorkspace)))
	mux.Handle("POST /api/workspaces/{wsId}/transfer-owner", s.requireUser(http.HandlerFunc(s.transferWorkspaceOwner)))
	mux.Handle("POST /api/workspaces/{wsId}/leave", s.requireUser(http.HandlerFunc(s.leaveWorkspace)))
	mux.Handle("GET /api/workspaces/{wsId}/audit-logs", s.requireUser(http.HandlerFunc(s.listWorkspaceAuditLogs)))

	handler := httpx.Chain(mux,
		httpx.WithRequestID,
		httpx.Logger(s.Log),
		httpx.Recover(s.Log),
		httpx.SecurityHeaders,
		httpx.RequireJSON,
	)
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)
	return s, ts
}

func TestWorkspaceAPIListCreateAuditAndLimits(t *testing.T) {
	mem := store.NewMemory()
	_, ts := newWorkspaceTestServer(t, mem)

	anonClient := newSSOCookieClient(false)
	aliceClient := newSSOCookieClient(false)
	bobClient := newSSOCookieClient(false)

	// Unauthenticated access is rejected.
	if res := doJSONReq(t, anonClient, http.MethodGet, ts.URL+"/api/workspaces", nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anon GET /api/workspaces = %d, want 401", res.StatusCode)
	}
	if res := doJSONReq(t, anonClient, http.MethodPost, ts.URL+"/api/workspaces", map[string]string{"name": "未登录空间"}); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anon POST /api/workspaces = %d, want 401", res.StatusCode)
	}

	// Register Alice and Bob.
	regAlice := post(t, aliceClient, ts.URL+"/api/auth/register", map[string]string{
		"email": "ws-api-alice@example.com", "name": "Alice", "password": "password123",
	})
	if regAlice.StatusCode != http.StatusCreated {
		t.Fatalf("register alice = %d", regAlice.StatusCode)
	}
	var aliceMe meResponse
	if err := json.NewDecoder(regAlice.Body).Decode(&aliceMe); err != nil {
		t.Fatal(err)
	}

	regBob := post(t, bobClient, ts.URL+"/api/auth/register", map[string]string{
		"email": "ws-api-bob@example.com", "name": "Bob", "password": "password123",
	})
	if regBob.StatusCode != http.StatusCreated {
		t.Fatalf("register bob = %d", regBob.StatusCode)
	}

	// Initial GET /api/workspaces returns Alice's personal workspace.
	listRes := doJSONReq(t, aliceClient, http.MethodGet, ts.URL+"/api/workspaces", nil)
	if listRes.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/workspaces = %d", listRes.StatusCode)
	}
	var listBody struct {
		Workspaces []store.Workspace `json:"workspaces"`
	}
	if err := json.NewDecoder(listRes.Body).Decode(&listBody); err != nil {
		t.Fatal(err)
	}
	if len(listBody.Workspaces) != 1 || listBody.Workspaces[0].ID != aliceMe.Workspaces[0].ID {
		t.Fatalf("unexpected initial workspaces: %+v", listBody.Workspaces)
	}

	// Validation errors return 400.
	for _, bad := range []string{"", "   ", strings.Repeat("空", store.MaxWorkspaceNameRunes+1)} {
		res := doJSONReq(t, aliceClient, http.MethodPost, ts.URL+"/api/workspaces", map[string]string{"name": bad})
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("bad name %q = %d, want 400", bad, res.StatusCode)
		}
	}

	// Creating a workspace returns 201 with trimmed name and logs workspace.create audit event.
	createRes := doJSONReq(t, aliceClient, http.MethodPost, ts.URL+"/api/workspaces", map[string]string{"name": "  研发团队空间  "})
	if createRes.StatusCode != http.StatusCreated {
		t.Fatalf("POST /api/workspaces = %d, want 201", createRes.StatusCode)
	}
	var createdBody struct {
		Workspace store.Workspace `json:"workspace"`
	}
	if err := json.NewDecoder(createRes.Body).Decode(&createdBody); err != nil {
		t.Fatal(err)
	}
	ws := createdBody.Workspace
	if ws.ID <= 0 || ws.Name != "研发团队空间" || ws.OwnerID != aliceMe.User.ID {
		t.Fatalf("unexpected created workspace: %+v", ws)
	}

	// Audit log contains workspace.create event for the new workspace.
	auditRes := doJSONReq(t, aliceClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs", ts.URL, ws.ID), nil)
	if auditRes.StatusCode != http.StatusOK {
		t.Fatalf("GET audit-logs = %d, want 200", auditRes.StatusCode)
	}
	var auditPage store.AuditLogPage
	if err := json.NewDecoder(auditRes.Body).Decode(&auditPage); err != nil {
		t.Fatal(err)
	}
	foundCreateAudit := false
	for _, entry := range auditPage.Items {
		if entry.Action == "workspace.create" && entry.ResourceType == "workspace" && entry.ResourceID == ws.ID && entry.ResourceTitle == "研发团队空间" {
			foundCreateAudit = true
			break
		}
	}
	if !foundCreateAudit {
		t.Fatalf("expected workspace.create audit entry, got %+v", auditPage.Items)
	}

	// GET /api/workspaces and GET /api/me both reflect the new workspace; Bob does not see it.
	listAfterRes := doJSONReq(t, aliceClient, http.MethodGet, ts.URL+"/api/workspaces", nil)
	var listAfter struct {
		Workspaces []store.Workspace `json:"workspaces"`
	}
	if err := json.NewDecoder(listAfterRes.Body).Decode(&listAfter); err != nil {
		t.Fatal(err)
	}
	if len(listAfter.Workspaces) != 2 || listAfter.Workspaces[1].ID != ws.ID {
		t.Fatalf("expected 2 workspaces for alice, got %+v", listAfter.Workspaces)
	}

	bobListRes := doJSONReq(t, bobClient, http.MethodGet, ts.URL+"/api/workspaces", nil)
	var bobList struct {
		Workspaces []store.Workspace `json:"workspaces"`
	}
	if err := json.NewDecoder(bobListRes.Body).Decode(&bobList); err != nil {
		t.Fatal(err)
	}
	if len(bobList.Workspaces) != 1 {
		t.Fatalf("expected bob to only see 1 workspace, got %+v", bobList.Workspaces)
	}

	// Fill up to MaxOwnedWorkspaces (20) and verify 21st returns 409 Conflict.
	for i := 3; i <= store.MaxOwnedWorkspaces; i++ {
		res := doJSONReq(t, aliceClient, http.MethodPost, ts.URL+"/api/workspaces", map[string]string{
			"name": fmt.Sprintf("项目空间 %d", i),
		})
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("create workspace #%d = %d, want 201", i, res.StatusCode)
		}
	}
	capRes := doJSONReq(t, aliceClient, http.MethodPost, ts.URL+"/api/workspaces", map[string]string{
		"name": "第21个空间",
	})
	if capRes.StatusCode != http.StatusConflict {
		t.Fatalf("21st workspace = %d, want 409", capRes.StatusCode)
	}
}

func TestWorkspaceAPILifecycleRenameTransferLeaveDelete(t *testing.T) {
	mem := store.NewMemory()
	_, ts := newWorkspaceTestServer(t, mem)
	ctx := context.Background()

	anonClient := newSSOCookieClient(false)
	aliceClient := newSSOCookieClient(false)
	bobClient := newSSOCookieClient(false)
	carolClient := newSSOCookieClient(false)

	// Unauthenticated requests are rejected with 401.
	for _, tc := range []struct {
		method string
		path   string
		body   any
	}{
		{http.MethodPatch, "/api/workspaces/1", map[string]string{"name": "x"}},
		{http.MethodDelete, "/api/workspaces/1", nil},
		{http.MethodPost, "/api/workspaces/1/transfer-owner", map[string]int64{"targetUserId": 2}},
		{http.MethodPost, "/api/workspaces/1/leave", nil},
	} {
		if res := doJSONReq(t, anonClient, tc.method, ts.URL+tc.path, tc.body); res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("anon %s %s = %d, want 401", tc.method, tc.path, res.StatusCode)
		}
	}

	register := func(client *http.Client, email, name string) meResponse {
		res := post(t, client, ts.URL+"/api/auth/register", map[string]string{
			"email": email, "name": name, "password": "password123",
		})
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("register %s = %d", email, res.StatusCode)
		}
		var out meResponse
		if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	aliceMe := register(aliceClient, "ws-life-alice@example.com", "Alice")
	bobMe := register(bobClient, "ws-life-bob@example.com", "Bob")
	carolMe := register(carolClient, "ws-life-carol@example.com", "Carol")

	// Alice creates a team workspace.
	createRes := doJSONReq(t, aliceClient, http.MethodPost, ts.URL+"/api/workspaces", map[string]string{"name": "协作空间"})
	if createRes.StatusCode != http.StatusCreated {
		t.Fatalf("create team ws = %d", createRes.StatusCode)
	}
	var createdBody struct {
		Workspace store.Workspace `json:"workspace"`
	}
	if err := json.NewDecoder(createRes.Body).Decode(&createdBody); err != nil {
		t.Fatal(err)
	}
	teamWS := createdBody.Workspace

	// Add Bob (member) and Carol (admin) to teamWS.
	if err := mem.AddWorkspaceMember(ctx, teamWS.ID, bobMe.User.ID); err != nil {
		t.Fatal(err)
	}
	if err := mem.AddWorkspaceMember(ctx, teamWS.ID, carolMe.User.ID); err != nil {
		t.Fatal(err)
	}
	aliceGuard := store.RestoreGuard{UserID: aliceMe.User.ID, SessionHash: []byte("api-life-alice-guard")}
	if err := mem.CreateSession(ctx, aliceGuard.SessionHash, aliceMe.User.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := mem.UpsertWorkspaceMemberGuarded(ctx, aliceGuard, teamWS.ID, carolMe.User.Email, store.WorkspaceRoleAdmin); err != nil {
		t.Fatal(err)
	}

	hasAudit := func(client *http.Client, wsID int64, action string) bool {
		res := doJSONReq(t, client, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs?action=%s", ts.URL, wsID, action), nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("GET audit-logs ws=%d action=%s = %d", wsID, action, res.StatusCode)
		}
		var page store.AuditLogPage
		if err := json.NewDecoder(res.Body).Decode(&page); err != nil {
			t.Fatal(err)
		}
		for _, item := range page.Items {
			if item.Action == action {
				return true
			}
		}
		return false
	}

	// --- Rename ---
	if res := doJSONReq(t, aliceClient, http.MethodPatch, ts.URL+"/api/workspaces/bad", map[string]string{"name": "ok"}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid wsId rename = %d, want 400", res.StatusCode)
	}
	if res := doJSONReq(t, aliceClient, http.MethodPatch, fmt.Sprintf("%s/api/workspaces/%d", ts.URL, teamWS.ID), map[string]string{"name": "   "}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty rename = %d, want 400", res.StatusCode)
	}
	if res := doJSONReq(t, bobClient, http.MethodPatch, fmt.Sprintf("%s/api/workspaces/%d", ts.URL, teamWS.ID), map[string]string{"name": "Bob Rename"}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("member rename = %d, want 403", res.StatusCode)
	}
	// Admin Carol renames teamWS.
	renameRes := doJSONReq(t, carolClient, http.MethodPatch, fmt.Sprintf("%s/api/workspaces/%d", ts.URL, teamWS.ID), map[string]string{"name": "  研发新名称  "})
	if renameRes.StatusCode != http.StatusOK {
		t.Fatalf("admin rename = %d, want 200", renameRes.StatusCode)
	}
	var renamedBody struct {
		Workspace store.Workspace `json:"workspace"`
	}
	if err := json.NewDecoder(renameRes.Body).Decode(&renamedBody); err != nil {
		t.Fatal(err)
	}
	if renamedBody.Workspace.Name != "研发新名称" || renamedBody.Workspace.ID != teamWS.ID {
		t.Fatalf("unexpected renamed workspace: %+v", renamedBody.Workspace)
	}
	if !hasAudit(aliceClient, teamWS.ID, "workspace.renamed") {
		t.Fatalf("expected workspace.renamed audit entry")
	}

	// --- Transfer Owner ---
	if res := doJSONReq(t, aliceClient, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/transfer-owner", ts.URL, teamWS.ID), map[string]int64{"targetUserId": aliceMe.User.ID}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("self transfer = %d, want 400", res.StatusCode)
	}
	if res := doJSONReq(t, carolClient, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/transfer-owner", ts.URL, teamWS.ID), map[string]int64{"targetUserId": bobMe.User.ID}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("admin transfer = %d, want 403", res.StatusCode)
	}
	if res := doJSONReq(t, aliceClient, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/transfer-owner", ts.URL, aliceMe.Workspaces[0].ID), map[string]int64{"targetUserId": bobMe.User.ID}); res.StatusCode != http.StatusNotFound {
		t.Fatalf("transfer to non-member = %d, want 404", res.StatusCode)
	}
	transferRes := doJSONReq(t, aliceClient, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/transfer-owner", ts.URL, teamWS.ID), map[string]int64{"targetUserId": bobMe.User.ID})
	if transferRes.StatusCode != http.StatusOK {
		t.Fatalf("owner transfer = %d, want 200", transferRes.StatusCode)
	}
	if !hasAudit(bobClient, teamWS.ID, "workspace.owner_transferred") {
		t.Fatalf("expected workspace.owner_transferred audit entry")
	}

	// --- Leave ---
	// New owner Bob cannot leave teamWS.
	if res := doJSONReq(t, bobClient, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/leave", ts.URL, teamWS.ID), nil); res.StatusCode != http.StatusConflict {
		t.Fatalf("owner leave = %d, want 409", res.StatusCode)
	}
	// Previous owner Alice (now admin) leaves teamWS cleanly.
	if res := doJSONReq(t, aliceClient, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/leave", ts.URL, teamWS.ID), nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("demoted admin leave = %d, want 204", res.StatusCode)
	}
	if !hasAudit(bobClient, teamWS.ID, "workspace.member_left") {
		t.Fatalf("expected workspace.member_left audit entry on ws %d", teamWS.ID)
	}
	// Alice can no longer access or leave teamWS.
	if res := doJSONReq(t, aliceClient, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/leave", ts.URL, teamWS.ID), nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-member leave = %d, want 403", res.StatusCode)
	}

	// --- Delete ---
	// Carol (admin, not owner) cannot delete teamWS.
	if res := doJSONReq(t, carolClient, http.MethodDelete, fmt.Sprintf("%s/api/workspaces/%d", ts.URL, teamWS.ID), nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("admin delete = %d, want 403", res.StatusCode)
	}
	// Alice only has 1 workspace left -> cannot delete her last workspace.
	if res := doJSONReq(t, aliceClient, http.MethodDelete, fmt.Sprintf("%s/api/workspaces/%d", ts.URL, aliceMe.Workspaces[0].ID), nil); res.StatusCode != http.StatusConflict {
		t.Fatalf("delete last workspace = %d, want 409", res.StatusCode)
	}
	// Bob owns both bobPersonal and teamWS -> deletes teamWS cleanly.
	if res := doJSONReq(t, bobClient, http.MethodDelete, fmt.Sprintf("%s/api/workspaces/%d", ts.URL, teamWS.ID), nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("owner delete teamWS = %d, want 204", res.StatusCode)
	}
	// Audit log for workspace.deleted is recorded on Bob's remaining personal workspace.
	if !hasAudit(bobClient, bobMe.Workspaces[0].ID, "workspace.deleted") {
		t.Fatalf("expected workspace.deleted audit entry on remaining workspace %d", bobMe.Workspaces[0].ID)
	}
	// Deleted workspace returns 404 on subsequent rename/delete.
	if res := doJSONReq(t, bobClient, http.MethodPatch, fmt.Sprintf("%s/api/workspaces/%d", ts.URL, teamWS.ID), map[string]string{"name": "Ghost"}); res.StatusCode != http.StatusNotFound {
		t.Fatalf("rename deleted ws = %d, want 404", res.StatusCode)
	}
	if res := doJSONReq(t, bobClient, http.MethodDelete, fmt.Sprintf("%s/api/workspaces/%d", ts.URL, teamWS.ID), nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("delete deleted ws = %d, want 404", res.StatusCode)
	}
	// Bob's GET /api/workspaces now returns only his personal workspace.
	bobListRes := doJSONReq(t, bobClient, http.MethodGet, ts.URL+"/api/workspaces", nil)
	var bobList struct {
		Workspaces []store.Workspace `json:"workspaces"`
	}
	if err := json.NewDecoder(bobListRes.Body).Decode(&bobList); err != nil {
		t.Fatal(err)
	}
	if len(bobList.Workspaces) != 1 || bobList.Workspaces[0].ID != bobMe.Workspaces[0].ID {
		t.Fatalf("unexpected bob workspaces after delete: %+v", bobList.Workspaces)
	}
}
