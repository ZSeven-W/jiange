package api

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newAuditTestServer(t *testing.T, st store.Store, now func() time.Time) (*Server, *httptest.Server, *http.Client) {
	t.Helper()
	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
		Now:        now,
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/workspaces/{wsId}/audit-logs", s.requireUser(http.HandlerFunc(s.listWorkspaceAuditLogs)))
	mux.Handle("GET /api/workspaces/{wsId}/audit-logs/export", s.requireUser(http.HandlerFunc(s.exportWorkspaceAuditLogs)))
	mux.Handle("GET /api/workspaces/{wsId}/security-policy", s.requireUser(http.HandlerFunc(s.getWorkspaceSecurityPolicy)))
	mux.Handle("PUT /api/workspaces/{wsId}/security-policy", httpx.RequireJSON(s.requireUser(http.HandlerFunc(s.putWorkspaceSecurityPolicy))))
	mux.Handle("/", s.Handler())

	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	return s, ts, &http.Client{Jar: jar}
}

func newCookieClient() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar}
}

func registerAuditTestUser(t *testing.T, ts *httptest.Server, client *http.Client, email, name string) (store.User, store.Workspace) {
	t.Helper()
	res := post(t, client, ts.URL+"/api/auth/register", map[string]string{
		"email":    email,
		"name":     name,
		"password": "password123",
	})
	defer res.Body.Close()
	if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusOK {
		t.Fatalf("register %s: status %d", email, res.StatusCode)
	}
	var me meResponse
	if err := json.NewDecoder(res.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	return me.User, me.Workspaces[0]
}

func joinWorkspaceAs(t *testing.T, ts *httptest.Server, ownerClient, targetClient *http.Client, wsID int64, email, role string) {
	t.Helper()
	res := send(t, ownerClient, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/members", ts.URL, wsID), map[string]any{
		"email": email,
		"role":  role,
	})
	var ch store.WorkspaceMemberChange
	_ = json.NewDecoder(res.Body).Decode(&ch)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || ch.Invitation == nil {
		t.Fatalf("invite %s as %s: status=%d change=%+v", email, role, res.StatusCode, ch)
	}
	acc := send(t, targetClient, http.MethodPost, fmt.Sprintf("%s/api/invitations/%d/accept", ts.URL, ch.Invitation.ID), nil)
	acc.Body.Close()
	if acc.StatusCode != http.StatusNoContent {
		t.Fatalf("accept %s: status=%d", email, acc.StatusCode)
	}
}

func TestAuditLogHelpersAndIPExtraction(t *testing.T) {
	st := store.NewMemory()
	fixedNow := time.Date(2026, 11, 24, 8, 30, 0, 0, time.UTC)
	srv, ts, ownerClient := newAuditTestServer(t, st, func() time.Time { return fixedNow })
	owner, ws := registerAuditTestUser(t, ts, ownerClient, "helper-owner@example.test", "Helper Owner")

	// recordAudit extracts authenticated user, X-Forwarded-For first hop, and User-Agent.
	req := httptest.NewRequest(http.MethodPost, "/api/docs", nil)
	req.Header.Set("X-Forwarded-For", "203.0.113.9:51234, 10.0.0.2")
	req.Header.Set("User-Agent", "JiangeTest/1.0")
	req = req.WithContext(context.WithValue(req.Context(), userKey, owner))
	srv.recordAudit(req, ws.ID, "doc.create", "doc", 42, "系统设计", map[string]any{"kind": "doc"})

	// recordAuthAudit falls back to RemoteAddr when X-Forwarded-For is absent.
	authReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	authReq.RemoteAddr = "198.51.100.7:44321"
	authReq.Header.Set("User-Agent", "AuthAgent/2.0")
	srv.recordAuthAudit(authReq, ws.ID, owner.ID, owner.Name, owner.Email, "auth.sso_login", map[string]any{"provider": "okta"})

	res := send(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs", ts.URL, ws.ID), nil)
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d", res.StatusCode)
	}
	var page store.AuditLogPage
	if err := json.NewDecoder(res.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 || len(page.Items) != 2 {
		t.Fatalf("got total=%d len=%d, want 2", page.Total, len(page.Items))
	}
	// Newest first (same timestamp -> tie broken by id DESC): auth.sso_login then doc.create.
	if page.Items[0].Action != "auth.sso_login" || page.Items[0].IPAddress != "198.51.100.7" || page.Items[0].ResourceType != "auth" {
		t.Fatalf("auth entry = %+v", page.Items[0])
	}
	if page.Items[1].Action != "doc.create" || page.Items[1].IPAddress != "203.0.113.9" || page.Items[1].ActorEmail != owner.Email || page.Items[1].ResourceID != 42 {
		t.Fatalf("doc entry = %+v", page.Items[1])
	}
}

func TestAuditLogAPIListAndFilter(t *testing.T) {
	st := store.NewMemory()
	t0 := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	now := t0
	_, ts, ownerClient := newAuditTestServer(t, st, func() time.Time { return now })
	adminClient := newCookieClient()
	memberClient := newCookieClient()
	outsiderClient := newCookieClient()
	anonClient := newCookieClient()

	owner, ws := registerAuditTestUser(t, ts, ownerClient, "api-audit-owner@example.test", "Owner")
	admin, _ := registerAuditTestUser(t, ts, adminClient, "api-audit-admin@example.test", "Admin")
	member, _ := registerAuditTestUser(t, ts, memberClient, "api-audit-member@example.test", "Member")
	registerAuditTestUser(t, ts, outsiderClient, "api-audit-out@example.test", "Outsider")

	joinWorkspaceAs(t, ts, ownerClient, adminClient, ws.ID, admin.Email, store.WorkspaceRoleAdmin)
	joinWorkspaceAs(t, ts, ownerClient, memberClient, ws.ID, member.Email, store.WorkspaceRoleMember)

	ctx := context.Background()
	seed := []store.AuditLogEntry{
		{WorkspaceID: ws.ID, ActorID: owner.ID, ActorName: "Owner", ActorEmail: owner.Email, Action: "auth.login", ResourceType: "auth", ResourceTitle: "Web", IPAddress: "10.1.1.1", CreatedAt: t0},
		{WorkspaceID: ws.ID, ActorID: admin.ID, ActorName: "Admin", ActorEmail: admin.Email, Action: "doc.create", ResourceType: "doc", ResourceID: 11, ResourceTitle: "年度财务计划", IPAddress: "10.1.1.2", CreatedAt: t0.Add(time.Hour)},
		{WorkspaceID: ws.ID, ActorID: member.ID, ActorName: "Member", ActorEmail: member.Email, Action: "share.update", ResourceType: "doc", ResourceID: 11, ResourceTitle: "年度财务计划", IPAddress: "10.1.1.3", CreatedAt: t0.Add(2 * time.Hour)},
	}
	for _, e := range seed {
		if err := st.AppendAuditLog(ctx, e); err != nil {
			t.Fatal(err)
		}
	}

	// Unauthenticated -> 401
	res := send(t, anonClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs", ts.URL, ws.ID), nil)
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anon status = %d, want 401", res.StatusCode)
	}

	// Regular member & outsider -> 403
	for name, client := range map[string]*http.Client{"member": memberClient, "outsider": outsiderClient} {
		r := send(t, client, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs", ts.URL, ws.ID), nil)
		r.Body.Close()
		if r.StatusCode != http.StatusForbidden {
			t.Fatalf("%s list audit logs status = %d, want 403", name, r.StatusCode)
		}
	}

	// Mismatched X-Jiange-User-Id header -> 401
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs", ts.URL, ws.ID), nil)
	req.Header.Set("X-Jiange-User-Id", fmt.Sprintf("%d", member.ID))
	mismatchRes, err := ownerClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	mismatchRes.Body.Close()
	if mismatchRes.StatusCode != http.StatusUnauthorized {
		t.Fatalf("user mismatch status = %d, want 401", mismatchRes.StatusCode)
	}

	// Invalid query parameters -> 400
	for _, qs := range []string{"actorId=abc", "from=not-a-date", "to=99/99", "limit=-5", "offset=-1"} {
		bad := send(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs?%s", ts.URL, ws.ID, qs), nil)
		bad.Body.Close()
		if bad.StatusCode != http.StatusBadRequest {
			t.Fatalf("invalid query %q status = %d, want 400", qs, bad.StatusCode)
		}
	}

	// Admin queries with filters & pagination.
	qURL := fmt.Sprintf("%s/api/workspaces/%d/audit-logs?resourceType=doc&q=%s&limit=1&offset=0", ts.URL, ws.ID, "财务")
	res = send(t, adminClient, http.MethodGet, qURL, nil)
	var page store.AuditLogPage
	if err := json.NewDecoder(res.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK || page.Total != 2 || len(page.Items) != 1 || page.Items[0].Action != "share.update" {
		t.Fatalf("filtered page = status:%d %+v", res.StatusCode, page)
	}

	// Date-only from/to filtering.
	dateURL := fmt.Sprintf("%s/api/workspaces/%d/audit-logs?from=2026-11-20&to=2026-11-20&actorId=%d", ts.URL, ws.ID, admin.ID)
	res = send(t, ownerClient, http.MethodGet, dateURL, nil)
	var datePage store.AuditLogPage
	_ = json.NewDecoder(res.Body).Decode(&datePage)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || datePage.Total != 1 || datePage.Items[0].Action != "doc.create" {
		t.Fatalf("date+actor page = status:%d %+v", res.StatusCode, datePage)
	}
}

func TestAuditLogAPIExportCSVAndFormulaNeutralization(t *testing.T) {
	st := store.NewMemory()
	_, ts, ownerClient := newAuditTestServer(t, st, nil)
	memberClient := newCookieClient()

	owner, ws := registerAuditTestUser(t, ts, ownerClient, "csv-owner@example.test", "Owner")
	member, _ := registerAuditTestUser(t, ts, memberClient, "csv-member@example.test", "Member")
	joinWorkspaceAs(t, ts, ownerClient, memberClient, ws.ID, member.Email, store.WorkspaceRoleMember)

	ctx := context.Background()
	formulaEntries := []store.AuditLogEntry{
		{
			WorkspaceID:   ws.ID,
			ActorID:       owner.ID,
			ActorName:     "=CMD|' /C calc'!A0",
			ActorEmail:    owner.Email,
			Action:        "doc.create",
			ResourceType:  "doc",
			ResourceID:    1,
			ResourceTitle: "+SUM(A1:A2)",
			IPAddress:     "10.0.0.1",
			UserAgent:     "-2+3+cmd",
			Detail:        json.RawMessage(`{"formula":"ok"}`),
		},
		{
			WorkspaceID:   ws.ID,
			ActorID:       owner.ID,
			ActorName:     "@attacker",
			ActorEmail:    owner.Email,
			Action:        "doc.delete",
			ResourceType:  "doc",
			ResourceID:    2,
			ResourceTitle: "  =HYPERLINK(\"http://evil\")",
			IPAddress:     "10.0.0.2",
			UserAgent:     "NormalAgent",
		},
	}
	for _, e := range formulaEntries {
		if err := st.AppendAuditLog(ctx, e); err != nil {
			t.Fatal(err)
		}
	}

	// Regular member cannot export (403) and does not create audit.export record.
	denied := send(t, memberClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs/export", ts.URL, ws.ID), nil)
	denied.Body.Close()
	if denied.StatusCode != http.StatusForbidden {
		t.Fatalf("member export status = %d, want 403", denied.StatusCode)
	}

	// Owner exports CSV filtered to doc events (excluding setup's org.member_update audit row).
	expRes := send(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs/export?resourceType=doc", ts.URL, ws.ID), nil)
	body, err := io.ReadAll(expRes.Body)
	expRes.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if expRes.StatusCode != http.StatusOK {
		t.Fatalf("export status = %d", expRes.StatusCode)
	}
	if ct := expRes.Header.Get("Content-Type"); ct != "text/csv; charset=utf-8" {
		t.Fatalf("Content-Type = %q", ct)
	}
	wantDisp := fmt.Sprintf(`attachment; filename="audit-logs-ws-%d.csv"`, ws.ID)
	if disp := expRes.Header.Get("Content-Disposition"); disp != wantDisp {
		t.Fatalf("Content-Disposition = %q, want %q", disp, wantDisp)
	}
	// Verify UTF-8 BOM.
	if !bytes.HasPrefix(body, []byte{0xEF, 0xBB, 0xBF}) {
		t.Fatalf("exported CSV missing UTF-8 BOM")
	}

	rows, err := csv.NewReader(bytes.NewReader(body[3:])).ReadAll()
	if err != nil {
		t.Fatalf("parse exported CSV: %v", err)
	}
	if len(rows) != 3 { // header + 2 rows
		t.Fatalf("csv rows = %d, want 3", len(rows))
	}
	// Row 1 is doc.delete (newest), Row 2 is doc.create.
	if !strings.HasPrefix(rows[1][3], "'@attacker") {
		t.Fatalf("expected @ prefix neutralized, got %q", rows[1][3])
	}
	if !strings.HasPrefix(rows[1][8], "'=HYPERLINK") {
		t.Fatalf("expected =HYPERLINK formula neutralized, got %q", rows[1][8])
	}
	// Directly verify sanitizeAuditCSVCell also neutralizes leading whitespace before formula chars.
	if got := sanitizeAuditCSVCell("  =HYPERLINK(\"http://evil\")"); got != "'  =HYPERLINK(\"http://evil\")" {
		t.Fatalf("sanitizeAuditCSVCell leading space = %q", got)
	}
	if rows[2][3] != "'=CMD|' /C calc'!A0" {
		t.Fatalf("expected = formula neutralized, got %q", rows[2][3])
	}
	if rows[2][8] != "'+SUM(A1:A2)" {
		t.Fatalf("expected + formula neutralized, got %q", rows[2][8])
	}
	if rows[2][10] != "'-2+3+cmd" {
		t.Fatalf("expected - formula neutralized, got %q", rows[2][10])
	}

	// Exporting must append an audit.export record!
	after := send(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs?action=audit.export", ts.URL, ws.ID), nil)
	var page store.AuditLogPage
	_ = json.NewDecoder(after.Body).Decode(&page)
	after.Body.Close()
	if after.StatusCode != http.StatusOK || page.Total != 1 || page.Items[0].Action != "audit.export" {
		t.Fatalf("expected audit.export record after export, got status=%d page=%+v", after.StatusCode, page)
	}
}

func TestWorkspaceSecurityPolicyAPI(t *testing.T) {
	st := store.NewMemory()
	_, ts, ownerClient := newAuditTestServer(t, st, nil)
	adminClient := newCookieClient()
	memberClient := newCookieClient()
	outsiderClient := newCookieClient()

	owner, ws := registerAuditTestUser(t, ts, ownerClient, "pol-owner@example.test", "Owner")
	admin, _ := registerAuditTestUser(t, ts, adminClient, "pol-admin@example.test", "Admin")
	member, _ := registerAuditTestUser(t, ts, memberClient, "pol-member@example.test", "Member")
	registerAuditTestUser(t, ts, outsiderClient, "pol-out@example.test", "Outsider")

	joinWorkspaceAs(t, ts, ownerClient, adminClient, ws.ID, admin.Email, store.WorkspaceRoleAdmin)
	joinWorkspaceAs(t, ts, ownerClient, memberClient, ws.ID, member.Email, store.WorkspaceRoleMember)

	// Member reads default policy -> 200.
	res := send(t, memberClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/security-policy", ts.URL, ws.ID), nil)
	var defPol store.WorkspaceSecurityPolicy
	_ = json.NewDecoder(res.Body).Decode(&defPol)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || defPol.WatermarkEnabled || !defPol.WatermarkShowUser || !defPol.WatermarkShowEmail || !defPol.WatermarkShowDate || defPol.WatermarkOpacity != store.DefaultWatermarkOpacity {
		t.Fatalf("default policy = status:%d %+v", res.StatusCode, defPol)
	}

	// Outsider cannot read -> 403.
	outRes := send(t, outsiderClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/security-policy", ts.URL, ws.ID), nil)
	outRes.Body.Close()
	if outRes.StatusCode != http.StatusForbidden {
		t.Fatalf("outsider get policy = %d, want 403", outRes.StatusCode)
	}

	// Member cannot update -> 403.
	memPut := send(t, memberClient, http.MethodPut, fmt.Sprintf("%s/api/workspaces/%d/security-policy", ts.URL, ws.ID), map[string]any{
		"watermarkEnabled": true,
	})
	memPut.Body.Close()
	if memPut.StatusCode != http.StatusForbidden {
		t.Fatalf("member put policy = %d, want 403", memPut.StatusCode)
	}

	// Owner updates policy with out-of-bounds values -> clamped + audit event recorded.
	longText := strings.Repeat("绝密资料", 25) // 100 runes -> clamped to 80
	putRes := send(t, ownerClient, http.MethodPut, fmt.Sprintf("%s/api/workspaces/%d/security-policy", ts.URL, ws.ID), map[string]any{
		"watermarkEnabled":   true,
		"watermarkText":      longText,
		"watermarkShowUser":  true,
		"watermarkShowEmail": false,
		"watermarkShowDate":  true,
		"watermarkOpacity":   0.95,
	})
	var updated store.WorkspaceSecurityPolicy
	_ = json.NewDecoder(putRes.Body).Decode(&updated)
	putRes.Body.Close()
	if putRes.StatusCode != http.StatusOK {
		t.Fatalf("owner put policy = %d", putRes.StatusCode)
	}
	if !updated.WatermarkEnabled || updated.WatermarkShowEmail || updated.WatermarkOpacity != store.MaxWatermarkOpacity || utf8.RuneCountInString(updated.WatermarkText) != store.MaxWatermarkTextRunes || updated.UpdatedBy != owner.ID {
		t.Fatalf("unexpected updated policy: %+v", updated)
	}

	// Admin can also update policy (clamping low opacity to 0.02).
	adminPut := send(t, adminClient, http.MethodPut, fmt.Sprintf("%s/api/workspaces/%d/security-policy", ts.URL, ws.ID), map[string]any{
		"watermarkOpacity": 0.001,
	})
	var updated2 store.WorkspaceSecurityPolicy
	_ = json.NewDecoder(adminPut.Body).Decode(&updated2)
	adminPut.Body.Close()
	if adminPut.StatusCode != http.StatusOK || updated2.WatermarkOpacity != store.MinWatermarkOpacity || updated2.UpdatedBy != admin.ID {
		t.Fatalf("admin put policy = status:%d %+v", adminPut.StatusCode, updated2)
	}

	// Member sees persisted updates.
	getAfter := send(t, memberClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/security-policy", ts.URL, ws.ID), nil)
	var readBack store.WorkspaceSecurityPolicy
	_ = json.NewDecoder(getAfter.Body).Decode(&readBack)
	getAfter.Body.Close()
	if getAfter.StatusCode != http.StatusOK || !readBack.WatermarkEnabled || readBack.WatermarkOpacity != store.MinWatermarkOpacity {
		t.Fatalf("member readBack = status:%d %+v", getAfter.StatusCode, readBack)
	}

	// Audit log contains 2 org.watermark_update events!
	logsRes := send(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs?action=org.watermark_update", ts.URL, ws.ID), nil)
	var logsPage store.AuditLogPage
	_ = json.NewDecoder(logsRes.Body).Decode(&logsPage)
	logsRes.Body.Close()
	if logsRes.StatusCode != http.StatusOK || logsPage.Total != 2 {
		t.Fatalf("watermark audit logs = status:%d %+v", logsRes.StatusCode, logsPage)
	}
}
