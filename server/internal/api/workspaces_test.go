package api

import (
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
