package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newCrossSpaceMoveTestServer(t *testing.T, st store.Store) (*Server, *httptest.Server) {
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
	mux.Handle("POST /api/drive/folders", s.requireUser(http.HandlerFunc(s.postDriveFolder)))
	mux.Handle("POST /api/drive/nodes", s.requireUser(http.HandlerFunc(s.postDriveNode)))
	mux.Handle("GET /api/drive/children", s.requireUser(http.HandlerFunc(s.listDriveChildren)))
	mux.Handle("POST /api/drive/move/{id}", s.requireUser(http.HandlerFunc(s.postDriveMove)))
	mux.Handle("POST /api/drive/cross-space-move/{id}", s.requireUser(http.HandlerFunc(s.postDriveCrossSpaceMove)))

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

func doJSONReqWithHeaders(t *testing.T, c *http.Client, method, url string, body any, headers map[string]string) *http.Response {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, r)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = res.Body.Close() })
	return res
}

func TestCrossSpaceMoveAPI(t *testing.T) {
	mem := store.NewMemory()
	_, ts := newCrossSpaceMoveTestServer(t, mem)

	aliceClient := newSSOCookieClient(false)
	bobClient := newSSOCookieClient(false)

	regAlice := post(t, aliceClient, ts.URL+"/api/auth/register", map[string]string{
		"email": "csm-alice@example.com", "name": "Alice", "password": "password123",
	})
	var aliceMe meResponse
	_ = json.NewDecoder(regAlice.Body).Decode(&aliceMe)
	wsA := aliceMe.Workspaces[0].ID

	regBob := post(t, bobClient, ts.URL+"/api/auth/register", map[string]string{
		"email": "csm-bob@example.com", "name": "Bob", "password": "password123",
	})
	var bobMe meResponse
	_ = json.NewDecoder(regBob.Body).Decode(&bobMe)
	wsB := bobMe.Workspaces[0].ID

	// Add Alice to Bob's workspace wsB.
	if err := mem.AddWorkspaceMember(t.Context(), wsB, aliceMe.User.ID); err != nil {
		t.Fatal(err)
	}

	// Create personal doc in wsA and shared folder in wsA + wsB.
	personalDocRes := doJSONReq(t, aliceClient, http.MethodPost, ts.URL+"/api/drive/nodes", map[string]any{
		"workspaceId": wsA,
		"kind":        "doc",
		"title":       "跨空间文档",
		"scope":       "personal",
	})
	if personalDocRes.StatusCode != http.StatusCreated {
		t.Fatalf("create personal doc = %d", personalDocRes.StatusCode)
	}
	var docEntry store.DriveEntry
	_ = json.NewDecoder(personalDocRes.Body).Decode(&docEntry)

	sharedFolderBRes := doJSONReq(t, aliceClient, http.MethodPost, ts.URL+"/api/drive/folders", map[string]any{
		"workspaceId": wsB,
		"title":       "空间B目标目录",
		"scope":       "shared",
	})
	if sharedFolderBRes.StatusCode != http.StatusCreated {
		t.Fatalf("create shared folder B = %d", sharedFolderBRes.StatusCode)
	}
	var folderB store.DriveEntry
	_ = json.NewDecoder(sharedFolderBRes.Body).Decode(&folderB)

	moveURL := fmt.Sprintf("%s/api/drive/cross-space-move/%d", ts.URL, docEntry.ID)

	// X-Jiange-User-Id mismatch returns 401 session_changed.
	if res := doJSONReqWithHeaders(t, aliceClient, http.MethodPost, moveURL, map[string]any{
		"targetWorkspaceId": wsA,
		"targetParentId":    nil,
		"targetPersonal":    false,
		"expected":          docEntry.Revision,
	}, map[string]string{"X-Jiange-User-Id": strconv.FormatInt(bobMe.User.ID, 10)}); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("mismatched X-Jiange-User-Id status = %d, want 401", res.StatusCode)
	}

	// Existing POST /api/drive/move/{id} remains strictly same-scope (does not silently accept cross-space).
	if res := doJSONReq(t, aliceClient, http.MethodPost, fmt.Sprintf("%s/api/drive/move/%d", ts.URL, docEntry.ID), map[string]any{
		"parentId": folderB.ID,
		"expected": docEntry.Revision,
	}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("legacy move cross-workspace status = %d, want 403", res.StatusCode)
	}

	// Move from wsA personal -> wsA shared root (targetWorkspaceId omitted / 0).
	res1 := doJSONReqWithHeaders(t, aliceClient, http.MethodPost, moveURL, map[string]any{
		"targetParentId": nil,
		"targetPersonal": false,
		"expected":       docEntry.Revision,
	}, map[string]string{"X-Jiange-User-Id": strconv.FormatInt(aliceMe.User.ID, 10)})
	if res1.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(res1.Body)
		t.Fatalf("same-ws cross-scope move status=%d body=%s", res1.StatusCode, body)
	}
	var out1 struct {
		Entry store.DriveEntry `json:"entry"`
	}
	_ = json.NewDecoder(res1.Body).Decode(&out1)
	if out1.Entry.WorkspaceID != wsA || out1.Entry.Personal || out1.Entry.Revision != docEntry.Revision+1 {
		t.Fatalf("unexpected out1: %+v", out1.Entry)
	}

	// Move from wsA shared -> wsB shared folderB.
	res2 := doJSONReqWithHeaders(t, aliceClient, http.MethodPost, moveURL, map[string]any{
		"targetWorkspaceId": wsB,
		"targetParentId":    folderB.ID,
		"targetPersonal":    false,
		"expected":          out1.Entry.Revision,
	}, map[string]string{"X-Jiange-User-Id": strconv.FormatInt(aliceMe.User.ID, 10)})
	if res2.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(res2.Body)
		t.Fatalf("cross-workspace move status=%d body=%s", res2.StatusCode, body)
	}
	var out2 struct {
		Entry store.DriveEntry `json:"entry"`
	}
	_ = json.NewDecoder(res2.Body).Decode(&out2)
	if out2.Entry.WorkspaceID != wsB || out2.Entry.Personal || out2.Entry.ParentID == nil || *out2.Entry.ParentID != folderB.ID {
		t.Fatalf("unexpected out2: %+v", out2.Entry)
	}

	// Verify audit log recorded drive.cross_space_move in wsB and wsA.
	bobGuard := store.RestoreGuard{UserID: bobMe.User.ID, SessionHash: []byte("bob-audit-check"), Now: time.Now}
	_ = mem.CreateSession(t.Context(), bobGuard.SessionHash, bobMe.User.ID, time.Now().Add(time.Hour))
	auditB, err := mem.ListAuditLogsGuarded(t.Context(), bobGuard, wsB, store.AuditLogFilter{WorkspaceID: wsB})
	if err != nil {
		t.Fatal(err)
	}
	foundAudit := false
	for _, entry := range auditB.Items {
		if entry.Action == "drive.cross_space_move" && entry.ResourceID == docEntry.ID {
			foundAudit = true
			break
		}
	}
	if !foundAudit {
		t.Fatalf("missing drive.cross_space_move audit entry in wsB: %+v", auditB.Items)
	}
}
