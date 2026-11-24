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
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newDLPTestServer(t *testing.T, st store.Store) (*Server, *httptest.Server, *http.Client) {
	t.Helper()
	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
	}
	mux := http.NewServeMux()
	mux.Handle("POST /api/workspaces/{wsId}/dlp/check", httpx.RequireJSON(s.requireUser(http.HandlerFunc(s.checkWorkspaceDLP))))
	mux.Handle("GET /api/workspaces/{wsId}/security-policy", s.requireUser(http.HandlerFunc(s.getWorkspaceSecurityPolicy)))
	mux.Handle("PUT /api/workspaces/{wsId}/security-policy", httpx.RequireJSON(s.requireUser(http.HandlerFunc(s.putWorkspaceSecurityPolicy))))
	mux.Handle("GET /api/workspaces/{wsId}/audit-logs", s.requireUser(http.HandlerFunc(s.listWorkspaceAuditLogs)))
	mux.Handle("/", s.Handler())

	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	return s, ts, &http.Client{Jar: jar}
}

func appendDocParagraphText(t *testing.T, st store.DocStore, docID int64, text string) {
	t.Helper()
	ctx := context.Background()
	state, _, err := StateAtHead(ctx, st, docID)
	if err != nil {
		t.Fatalf("StateAtHead(%d): %v", docID, err)
	}
	para := collab.OpID{Client: 0, Clock: 2}
	var raw []store.RawOp
	for i, ch := range []rune(text) {
		op := state.InsertText(11, para, i, string(ch))
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatalf("EncodeOps: %v", err)
		}
		raw = append(raw, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
	}
	if _, err := st.AppendOps(ctx, docID, raw); err != nil {
		t.Fatalf("AppendOps(%d): %v", docID, err)
	}
}

func TestDLPEvaluateLiteralAndRegex(t *testing.T) {
	// Disabled policy returns nil.
	if got := EvaluateDLP(store.WorkspaceSecurityPolicy{
		DLPEnabled:  false,
		DLPKeywords: []string{"绝密"},
	}, "这是绝密文档"); got != nil {
		t.Fatalf("disabled policy returned %+v, want nil", got)
	}

	// Empty keywords returns nil.
	if got := EvaluateDLP(store.WorkspaceSecurityPolicy{
		DLPEnabled:  true,
		DLPKeywords: []string{},
	}, "这是绝密文档"); got != nil {
		t.Fatalf("empty keywords returned %+v, want nil", got)
	}

	// Case-insensitive literal + /regex/ + invalid/unsafe regex skipped cleanly without panicking.
	policy := store.WorkspaceSecurityPolicy{
		DLPEnabled: true,
		DLPKeywords: []string{
			"Top Secret",
			"绝密",
			`/[unclosed/`,   // invalid syntax -> skipped
			`//`,            // empty regex -> skipped
			`/(a+)+$/`,      // nested quantifier -> rejected cleanly
			`/a{999}{999}/`, // excessive repetition -> rejected cleanly
			`/^/`,               // zero-length match -> skipped
			`/\b1[3-9]\d{9}\b/`, // China mobile phone regex (word-bounded so it does not overlap ID card)
			`/\b\d{17}[\dXx]\b/`,
		},
	}
	sample := "本文件标注为 top secret 与绝密级别，联系人电话13812345678，证件号 11010519900101123X。"
	matches := EvaluateDLP(policy, sample)
	if len(matches) != 4 {
		t.Fatalf("got %d matches (%+v), want 4", len(matches), matches)
	}
	if matches[0].Rule != "Top Secret" || matches[0].Match != "top secret" || !strings.Contains(matches[0].Snippet, "top secret") {
		t.Fatalf("match[0] = %+v", matches[0])
	}
	if matches[1].Rule != "绝密" || matches[1].Match != "绝密" {
		t.Fatalf("match[1] = %+v", matches[1])
	}
	if matches[2].Rule != `/\b1[3-9]\d{9}\b/` || matches[2].Match != "13812345678" {
		t.Fatalf("match[2] = %+v", matches[2])
	}
	if matches[3].Rule != `/\b\d{17}[\dXx]\b/` || matches[3].Match != "11010519900101123X" {
		t.Fatalf("match[3] = %+v", matches[3])
	}

	// Cap matches at 20.
	many := EvaluateDLP(store.WorkspaceSecurityPolicy{
		DLPEnabled:  true,
		DLPKeywords: []string{"SECRET"},
	}, strings.Repeat("secret ", 35))
	if len(many) != 20 {
		t.Fatalf("expected match cap 20, got %d", len(many))
	}
}

func TestDLPCheckEndpointAndSecurityPolicyValidation(t *testing.T) {
	st := store.NewMemory()
	_, ts, ownerClient := newDLPTestServer(t, st)
	adminClient := newCookieClient()
	memberClient := newCookieClient()
	outsiderClient := newCookieClient()
	anonClient := newCookieClient()

	_, ws := registerAuditTestUser(t, ts, ownerClient, "dlp-owner@example.test", "Owner")
	admin, _ := registerAuditTestUser(t, ts, adminClient, "dlp-admin@example.test", "Admin")
	member, _ := registerAuditTestUser(t, ts, memberClient, "dlp-member@example.test", "Member")
	registerAuditTestUser(t, ts, outsiderClient, "dlp-out@example.test", "Outsider")

	joinWorkspaceAs(t, ts, ownerClient, adminClient, ws.ID, admin.Email, store.WorkspaceRoleAdmin)
	joinWorkspaceAs(t, ts, ownerClient, memberClient, ws.ID, member.Email, store.WorkspaceRoleMember)

	policyURL := fmt.Sprintf("%s/api/workspaces/%d/security-policy", ts.URL, ws.ID)
	checkURL := fmt.Sprintf("%s/api/workspaces/%d/dlp/check", ts.URL, ws.ID)

	// Security policy validation failures -> 400.
	badPayloads := []map[string]any{
		{"dlpAction": "delete"},
		{"retentionDays": -5},
		{"retentionDays": 4000},
		{"dlpKeywords": []string{"/[invalid-regex/"}},
		{"dlpKeywords": []string{"//"}},
		{"dlpKeywords": []string{"/(a+)+/"}},
	}
	for i, p := range badPayloads {
		res := send(t, ownerClient, http.MethodPut, policyURL, p)
		res.Body.Close()
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("badPayload[%d] (%v) status = %d, want 400", i, p, res.StatusCode)
		}
	}

	// Owner saves valid DLP + retention policy.
	putRes := send(t, ownerClient, http.MethodPut, policyURL, map[string]any{
		"dlpEnabled":          true,
		"dlpKeywords":         []string{" 绝密 ", "内部机密", `/1[3-9]\d{9}/`},
		"dlpAction":           "block",
		"dlpBlockPublicShare": true,
		"retentionDays":       180,
	})
	var saved store.WorkspaceSecurityPolicy
	if err := json.NewDecoder(putRes.Body).Decode(&saved); err != nil {
		t.Fatal(err)
	}
	putRes.Body.Close()
	if putRes.StatusCode != http.StatusOK {
		t.Fatalf("save policy status = %d", putRes.StatusCode)
	}
	if !saved.DLPEnabled || saved.DLPAction != "block" || !saved.DLPBlockPublicShare || saved.RetentionDays != 180 || len(saved.DLPKeywords) != 3 {
		t.Fatalf("unexpected saved policy: %+v", saved)
	}

	// Authz on /dlp/check: anon -> 401, member -> 403, outsider -> 403.
	if r := send(t, anonClient, http.MethodPost, checkURL, map[string]any{"text": "绝密"}); r.StatusCode != http.StatusUnauthorized {
		r.Body.Close()
		t.Fatalf("anon dlp/check = %d, want 401", r.StatusCode)
	}
	for name, client := range map[string]*http.Client{"member": memberClient, "outsider": outsiderClient} {
		r := send(t, client, http.MethodPost, checkURL, map[string]any{"text": "绝密"})
		r.Body.Close()
		if r.StatusCode != http.StatusForbidden {
			t.Fatalf("%s dlp/check = %d, want 403", name, r.StatusCode)
		}
	}

	// Admin tests against saved workspace policy (no keywords field sent).
	type dlpCheckResp struct {
		Matched bool       `json:"matched"`
		Action  string     `json:"action"`
		Matches []DLPMatch `json:"matches"`
	}
	hitRes := send(t, adminClient, http.MethodPost, checkURL, map[string]any{
		"text": "这是一份绝密合同，联系方式 13911112222",
	})
	var hit dlpCheckResp
	if err := json.NewDecoder(hitRes.Body).Decode(&hit); err != nil {
		t.Fatal(err)
	}
	hitRes.Body.Close()
	if hitRes.StatusCode != http.StatusOK || !hit.Matched || hit.Action != "block" || len(hit.Matches) != 2 {
		t.Fatalf("saved policy check = status:%d %+v", hitRes.StatusCode, hit)
	}

	// Clean text returns matched=false and non-nil matches [].
	cleanRes := send(t, ownerClient, http.MethodPost, checkURL, map[string]any{
		"text": "普通公开公告内容",
	})
	rawClean, _ := io.ReadAll(cleanRes.Body)
	cleanRes.Body.Close()
	if cleanRes.StatusCode != http.StatusOK || !strings.Contains(string(rawClean), `"matched":false`) || !strings.Contains(string(rawClean), `"matches":[]`) {
		t.Fatalf("clean check = status:%d body:%s", cleanRes.StatusCode, string(rawClean))
	}

	// Custom draft keywords & action override saved policy.
	draftRes := send(t, ownerClient, http.MethodPost, checkURL, map[string]any{
		"text":     "Project Apollo blueprint",
		"keywords": []string{"apollo"},
		"action":   "warn",
	})
	var draft dlpCheckResp
	if err := json.NewDecoder(draftRes.Body).Decode(&draft); err != nil {
		t.Fatal(err)
	}
	draftRes.Body.Close()
	if draftRes.StatusCode != http.StatusOK || !draft.Matched || draft.Action != "warn" || len(draft.Matches) != 1 || draft.Matches[0].Match != "Apollo" {
		t.Fatalf("draft check = status:%d %+v", draftRes.StatusCode, draft)
	}

	// Invalid action override -> 400.
	badCheck := send(t, ownerClient, http.MethodPost, checkURL, map[string]any{
		"text":   "hello",
		"action": "destroy",
	})
	badCheck.Body.Close()
	if badCheck.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad action check = %d, want 400", badCheck.StatusCode)
	}
}

func TestDLPPublicShareBlockingAndWarnMode(t *testing.T) {
	st := store.NewMemory()
	_, ts, ownerClient := newDLPTestServer(t, st)
	owner, ws := registerAuditTestUser(t, ts, ownerClient, "share-dlp@example.test", "Owner")

	// Create sensitive doc (benign title, sensitive CRDT body text) and clean doc.
	var sensitiveDoc, cleanDoc store.DocMeta
	r1 := post(t, ownerClient, ts.URL+"/api/docs", map[string]any{"title": "季度客户复盘", "workspaceId": ws.ID})
	if err := json.NewDecoder(r1.Body).Decode(&sensitiveDoc); err != nil {
		t.Fatal(err)
	}
	r1.Body.Close()
	appendDocParagraphText(t, st, sensitiveDoc.ID, "核心客户手机号 13987654321，属于绝密战略资料。")

	r2 := post(t, ownerClient, ts.URL+"/api/docs", map[string]any{"title": "公开产品手册", "workspaceId": ws.ID})
	if err := json.NewDecoder(r2.Body).Decode(&cleanDoc); err != nil {
		t.Fatal(err)
	}
	r2.Body.Close()
	appendDocParagraphText(t, st, cleanDoc.ID, "欢迎查阅最新产品功能说明。")

	policyURL := fmt.Sprintf("%s/api/workspaces/%d/security-policy", ts.URL, ws.ID)
	sensitiveLinkURL := fmt.Sprintf("%s/api/docs/%d/link", ts.URL, sensitiveDoc.ID)
	sensitiveGuardedURL := fmt.Sprintf("%s/api/docs/%d/link-guarded", ts.URL, sensitiveDoc.ID)
	cleanLinkURL := fmt.Sprintf("%s/api/docs/%d/link", ts.URL, cleanDoc.ID)

	// Enable DLP in block mode.
	res := send(t, ownerClient, http.MethodPut, policyURL, map[string]any{
		"dlpEnabled":          true,
		"dlpKeywords":         []string{"绝密", `/1[3-9]\d{9}/`},
		"dlpAction":           "block",
		"dlpBlockPublicShare": true,
	})
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("enable block DLP status = %d", res.StatusCode)
	}

	// 1. Public link ("anon") on sensitive doc via /link -> 422 dlp_blocked!
	blockRes := send(t, ownerClient, http.MethodPut, sensitiveLinkURL, map[string]any{"role": "anon"})
	var blockBody struct {
		Error   string     `json:"error"`
		Code    string     `json:"code"`
		Message string     `json:"message"`
		Matches []DLPMatch `json:"matches"`
	}
	if err := json.NewDecoder(blockRes.Body).Decode(&blockBody); err != nil {
		t.Fatal(err)
	}
	blockRes.Body.Close()
	if blockRes.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("blocked public share status = %d, want 422", blockRes.StatusCode)
	}
	if blockBody.Code != "dlp_blocked" || blockBody.Error != "dlp_blocked" || !strings.Contains(blockBody.Message, "内容命中企业数据防泄漏（DLP）敏感规则，已拦截对外公开分享") || len(blockBody.Matches) != 2 {
		t.Fatalf("unexpected 422 body: %+v", blockBody)
	}
	// Verify link was NOT enabled.
	curLink, err := st.GetLink(context.Background(), sensitiveDoc.ID)
	if err != nil || curLink.Role != "none" {
		t.Fatalf("link after block = %+v err=%v, want role=none", curLink, err)
	}

	// 2. Guarded link endpoint (/link-guarded) also blocks with 422 dlp_blocked!
	guardedReq, _ := http.NewRequest(http.MethodPut, sensitiveGuardedURL, strings.NewReader(`{"role":"anon","expectedRevision":0}`))
	guardedReq.Header.Set("Content-Type", "application/json")
	guardedReq.Header.Set("X-Jiange-User-Id", strconv.FormatInt(owner.ID, 10))
	guardedRes, err := ownerClient.Do(guardedReq)
	if err != nil {
		t.Fatal(err)
	}
	guardedRes.Body.Close()
	if guardedRes.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("guarded blocked public share status = %d, want 422", guardedRes.StatusCode)
	}

	// Verify dlp.share_blocked audit logs were recorded.
	blockedLogsRes := send(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs?action=dlp.share_blocked", ts.URL, ws.ID), nil)
	var blockedLogs store.AuditLogPage
	_ = json.NewDecoder(blockedLogsRes.Body).Decode(&blockedLogs)
	blockedLogsRes.Body.Close()
	if blockedLogsRes.StatusCode != http.StatusOK || blockedLogs.Total != 2 {
		t.Fatalf("dlp.share_blocked logs = status:%d total:%d, want 2", blockedLogsRes.StatusCode, blockedLogs.Total)
	}

	// 3. Workspace-internal link ("workspace_view") on sensitive doc is ALLOWED!
	wsLinkRes := send(t, ownerClient, http.MethodPut, sensitiveLinkURL, map[string]any{"role": store.LinkWorkspaceView})
	wsLinkRes.Body.Close()
	if wsLinkRes.StatusCode != http.StatusOK {
		t.Fatalf("workspace-only link status = %d, want 200", wsLinkRes.StatusCode)
	}

	// 4. Public link ("anon") on clean doc is ALLOWED!
	cleanLinkRes := send(t, ownerClient, http.MethodPut, cleanLinkURL, map[string]any{"role": "anon"})
	cleanLinkRes.Body.Close()
	if cleanLinkRes.StatusCode != http.StatusOK {
		t.Fatalf("clean doc public link status = %d, want 200", cleanLinkRes.StatusCode)
	}

	// 5. Switch to warn-only mode -> public link on sensitive doc is ALLOWED (200) and records dlp.share_warned!
	warnPut := send(t, ownerClient, http.MethodPut, policyURL, map[string]any{
		"dlpAction": "warn",
	})
	warnPut.Body.Close()
	if warnPut.StatusCode != http.StatusOK {
		t.Fatalf("switch to warn mode status = %d", warnPut.StatusCode)
	}
	warnShareRes := send(t, ownerClient, http.MethodPut, sensitiveLinkURL, map[string]any{"role": "anon"})
	var warnLink linkWithPassword
	if err := json.NewDecoder(warnShareRes.Body).Decode(&warnLink); err != nil {
		t.Fatal(err)
	}
	warnShareRes.Body.Close()
	if warnShareRes.StatusCode != http.StatusOK || warnLink.Role != "anon" || warnLink.Token == "" {
		t.Fatalf("warn mode public share = status:%d %+v", warnShareRes.StatusCode, warnLink)
	}

	warnLogsRes := send(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs?action=dlp.share_warned", ts.URL, ws.ID), nil)
	var warnLogs store.AuditLogPage
	_ = json.NewDecoder(warnLogsRes.Body).Decode(&warnLogs)
	warnLogsRes.Body.Close()
	if warnLogsRes.StatusCode != http.StatusOK || warnLogs.Total != 1 || warnLogs.Items[0].ResourceID != sensitiveDoc.ID {
		t.Fatalf("dlp.share_warned logs = status:%d %+v", warnLogsRes.StatusCode, warnLogs)
	}
}
