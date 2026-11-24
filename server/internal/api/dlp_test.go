package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/textproto"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newDLPTestServer(t *testing.T, st store.Store) (*Server, *httptest.Server, *http.Client) {
	t.Helper()
	s := &Server{
		Store:      st,
		Blobs:      blob.NewMemory(),
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
	}
	mux := http.NewServeMux()
	mux.Handle("POST /api/workspaces/{wsId}/dlp/check", httpx.RequireJSON(s.requireUser(http.HandlerFunc(s.checkWorkspaceDLP))))
	mux.Handle("POST /api/workspaces/{wsId}/retention/run", httpx.RequireJSON(s.requireUser(http.HandlerFunc(s.runWorkspaceRetention))))
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
			`/[unclosed/`,       // invalid syntax -> skipped
			`//`,                // empty regex -> skipped
			`/(a+)+$/`,          // nested quantifier -> rejected cleanly
			`/a{999}{999}/`,     // excessive repetition -> rejected cleanly
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

func TestDLPSheetScanning(t *testing.T) {
	st := store.NewMemory()
	_, ts, ownerClient := newDLPTestServer(t, st)
	owner, ws := registerAuditTestUser(t, ts, ownerClient, "sheet-dlp@example.test", "Sheet Owner")

	createSheet := func(title string) store.DriveEntry {
		t.Helper()
		body, _ := json.Marshal(map[string]any{
			"workspaceId": ws.ID,
			"kind":        "sheet",
			"title":       title,
		})
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/drive/nodes", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(owner.ID, 10))
		res, err := ownerClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusCreated {
			raw, _ := io.ReadAll(res.Body)
			t.Fatalf("create sheet %q status=%d body=%s", title, res.StatusCode, raw)
		}
		var entry store.DriveEntry
		if err := json.NewDecoder(res.Body).Decode(&entry); err != nil {
			t.Fatal(err)
		}
		return entry
	}

	sensitiveSheet := createSheet("财务核算表")
	cleanSheet := createSheet("公开排班表")

	// Fetch workbook metadata and write a sensitive cell value into sensitiveSheet.
	getReq, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/api/sheets/%d", ts.URL, sensitiveSheet.ID), nil)
	getReq.Header.Set("X-Jiange-User-Id", strconv.FormatInt(owner.ID, 10))
	getReq.Header.Set("X-Jiange-Sheet-Version", sheetProtocolVersion)
	getRes, err := ownerClient.Do(getReq)
	if err != nil {
		t.Fatal(err)
	}
	var snap store.SheetSnapshot
	if err := json.NewDecoder(getRes.Body).Decode(&snap); err != nil {
		t.Fatal(err)
	}
	getRes.Body.Close()
	if getRes.StatusCode != http.StatusOK || len(snap.Sheets) == 0 {
		t.Fatalf("get sheet status=%d sheets=%d", getRes.StatusCode, len(snap.Sheets))
	}

	wsSheet := snap.Sheets[0]
	rawVal := "绝密薪酬明细 13812345678"
	cellBody, _ := json.Marshal(store.SheetCellBatch{
		MutationID:  "0123456789abcdef0123456789abcdef",
		WorksheetID: wsSheet.ID,
		Cells: []store.SheetCellWrite{
			{
				RowID:            wsSheet.Rows[0].ID,
				ColumnID:         wsSheet.Columns[0].ID,
				ExpectedRevision: 0,
				Raw:              &rawVal,
			},
		},
	})
	writeReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/sheets/%d/cells", ts.URL, sensitiveSheet.ID), bytes.NewReader(cellBody))
	writeReq.Header.Set("Content-Type", "application/json")
	writeReq.Header.Set("X-Jiange-User-Id", strconv.FormatInt(owner.ID, 10))
	writeReq.Header.Set("X-Jiange-Sheet-Version", sheetProtocolVersion)
	writeRes, err := ownerClient.Do(writeReq)
	if err != nil {
		t.Fatal(err)
	}
	writeRes.Body.Close()
	if writeRes.StatusCode != http.StatusOK {
		t.Fatalf("writeSheetCells status=%d", writeRes.StatusCode)
	}

	// Enable workspace DLP in block mode.
	policyURL := fmt.Sprintf("%s/api/workspaces/%d/security-policy", ts.URL, ws.ID)
	polRes := send(t, ownerClient, http.MethodPut, policyURL, map[string]any{
		"dlpEnabled":          true,
		"dlpKeywords":         []string{"绝密", `/1[3-9]\d{9}/`},
		"dlpAction":           "block",
		"dlpBlockPublicShare": true,
	})
	polRes.Body.Close()
	if polRes.StatusCode != http.StatusOK {
		t.Fatalf("enable DLP status=%d", polRes.StatusCode)
	}

	// Public external link (role="view") on sensitiveSheet must be blocked with 422 dlp_blocked matching both rules!
	blockRes := send(t, ownerClient, http.MethodPut, fmt.Sprintf("%s/api/docs/%d/link", ts.URL, sensitiveSheet.ID), map[string]any{"role": store.RoleView})
	var blockBody struct {
		Code    string     `json:"code"`
		Error   string     `json:"error"`
		Matches []DLPMatch `json:"matches"`
	}
	if err := json.NewDecoder(blockRes.Body).Decode(&blockBody); err != nil {
		t.Fatal(err)
	}
	blockRes.Body.Close()
	if blockRes.StatusCode != http.StatusUnprocessableEntity || blockBody.Code != "dlp_blocked" || len(blockBody.Matches) != 2 {
		t.Fatalf("sheet public share block = status:%d body:%+v", blockRes.StatusCode, blockBody)
	}

	// Clean sheet public link succeeds.
	cleanRes := send(t, ownerClient, http.MethodPut, fmt.Sprintf("%s/api/docs/%d/link", ts.URL, cleanSheet.ID), map[string]any{"role": store.RoleView})
	cleanRes.Body.Close()
	if cleanRes.StatusCode != http.StatusOK {
		t.Fatalf("clean sheet public share status=%d, want 200", cleanRes.StatusCode)
	}

	// Adding a worksheet with a sensitive title on cleanSheet also triggers DLP!
	addWsBody, _ := json.Marshal(map[string]any{"title": "绝密季度汇总"})
	addWsReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/sheets/%d/worksheets", ts.URL, cleanSheet.ID), bytes.NewReader(addWsBody))
	addWsReq.Header.Set("Content-Type", "application/json")
	addWsReq.Header.Set("X-Jiange-User-Id", strconv.FormatInt(owner.ID, 10))
	addWsReq.Header.Set("X-Jiange-Sheet-Version", sheetProtocolVersion)
	addWsRes, err := ownerClient.Do(addWsReq)
	if err != nil {
		t.Fatal(err)
	}
	addWsRes.Body.Close()
	if addWsRes.StatusCode != http.StatusCreated {
		t.Fatalf("create sensitive worksheet status=%d", addWsRes.StatusCode)
	}
	titleBlockRes := send(t, ownerClient, http.MethodPut, fmt.Sprintf("%s/api/docs/%d/link", ts.URL, cleanSheet.ID), map[string]any{"role": store.RoleEdit})
	titleBlockRes.Body.Close()
	if titleBlockRes.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("sensitive worksheet title share status=%d, want 422", titleBlockRes.StatusCode)
	}
}

func TestDLPExportCSVAndPublicFileEnforcement(t *testing.T) {
	st := store.NewMemory()
	_, ts, ownerClient := newDLPTestServer(t, st)
	_, ws := registerAuditTestUser(t, ts, ownerClient, "export-dlp@example.test", "Export Owner")

	// 1. Create a Base and add a sensitive record.
	var baseDoc store.DocMeta
	bRes := post(t, ownerClient, ts.URL+"/api/bases", map[string]any{"title": "客户跟进表", "workspaceId": ws.ID})
	if err := json.NewDecoder(bRes.Body).Decode(&baseDoc); err != nil {
		t.Fatal(err)
	}
	bRes.Body.Close()
	if bRes.StatusCode != http.StatusCreated {
		t.Fatalf("create base status=%d", bRes.StatusCode)
	}
	fields, err := st.Fields(context.Background(), baseDoc.ID)
	if err != nil || len(fields) == 0 {
		t.Fatalf("base fields = %+v err=%v", fields, err)
	}
	recRes := post(t, ownerClient, fmt.Sprintf("%s/api/bases/%d/records", ts.URL, baseDoc.ID), map[string]any{
		"cells": map[string]any{
			strconv.FormatInt(fields[0].ID, 10): "绝密并购标的客户名单",
		},
	})
	recRes.Body.Close()
	if recRes.StatusCode != http.StatusCreated {
		t.Fatalf("create sensitive record status=%d", recRes.StatusCode)
	}

	// 2. Create a Doc with an attachment and enable anon link BEFORE enabling DLP.
	var attachDoc store.DocMeta
	dRes := post(t, ownerClient, ts.URL+"/api/docs", map[string]any{"title": "对外方案说明", "workspaceId": ws.ID})
	if err := json.NewDecoder(dRes.Body).Decode(&attachDoc); err != nil {
		t.Fatal(err)
	}
	dRes.Body.Close()
	var mp bytes.Buffer
	mw := multipart.NewWriter(&mp)
	hdr := textproto.MIMEHeader{}
	hdr.Set("Content-Disposition", `form-data; name="file"; filename="spec.txt"`)
	hdr.Set("Content-Type", "text/plain")
	fw, _ := mw.CreatePart(hdr)
	_, _ = fw.Write([]byte("attachment-payload-bytes"))
	_ = mw.Close()
	upReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/docs/%d/files", ts.URL, attachDoc.ID), &mp)
	upReq.Header.Set("Content-Type", mw.FormDataContentType())
	upReq.Header.Set("X-Jiange-Upload", "1")
	upRes, err := ownerClient.Do(upReq)
	if err != nil {
		t.Fatal(err)
	}
	var uploadedFile store.FileMeta
	if err := json.NewDecoder(upRes.Body).Decode(&uploadedFile); err != nil {
		t.Fatal(err)
	}
	upRes.Body.Close()
	if upRes.StatusCode != http.StatusCreated {
		t.Fatalf("upload file status=%d", upRes.StatusCode)
	}
	referenceTestFile(t, st, attachDoc.ID, uploadedFile.ID, "file")
	appendDocParagraphText(t, st, attachDoc.ID, "附件对应绝密项目报价，禁止外传。")

	linkRes := send(t, ownerClient, http.MethodPut, fmt.Sprintf("%s/api/docs/%d/link", ts.URL, attachDoc.ID), map[string]any{"role": "anon"})
	var linkInfo linkWithPassword
	if err := json.NewDecoder(linkRes.Body).Decode(&linkInfo); err != nil {
		t.Fatal(err)
	}
	linkRes.Body.Close()
	if linkRes.StatusCode != http.StatusOK || linkInfo.Token == "" {
		t.Fatalf("enable anon link before DLP: status=%d %+v", linkRes.StatusCode, linkInfo)
	}

	// Enable DLP in BLOCK mode.
	policyURL := fmt.Sprintf("%s/api/workspaces/%d/security-policy", ts.URL, ws.ID)
	polRes := send(t, ownerClient, http.MethodPut, policyURL, map[string]any{
		"dlpEnabled":  true,
		"dlpKeywords": []string{"绝密"},
		"dlpAction":   "block",
	})
	polRes.Body.Close()
	if polRes.StatusCode != http.StatusOK {
		t.Fatalf("enable DLP block status=%d", polRes.StatusCode)
	}

	// CSV export must be blocked with 422 dlp_blocked.
	csvBlockRes, err := ownerClient.Get(fmt.Sprintf("%s/api/bases/%d/export", ts.URL, baseDoc.ID))
	if err != nil {
		t.Fatal(err)
	}
	var csvBlockBody struct {
		Code    string     `json:"code"`
		Error   string     `json:"error"`
		Message string     `json:"message"`
		Matches []DLPMatch `json:"matches"`
	}
	_ = json.NewDecoder(csvBlockRes.Body).Decode(&csvBlockBody)
	csvBlockRes.Body.Close()
	if csvBlockRes.StatusCode != http.StatusUnprocessableEntity ||
		csvBlockBody.Code != "dlp_blocked" ||
		csvBlockBody.Error != "dlp_blocked" ||
		!strings.Contains(csvBlockBody.Message, "已拦截导出/下载") ||
		len(csvBlockBody.Matches) == 0 {
		t.Fatalf("CSV export block = status:%d body:%+v", csvBlockRes.StatusCode, csvBlockBody)
	}

	// Anonymous public file download must be blocked with 422 dlp_blocked.
	guest := newCookieClient()
	pubFileURL := fmt.Sprintf("%s/api/public/%s/files/%d", ts.URL, linkInfo.Token, uploadedFile.ID)
	pubBlockRes, err := guest.Get(pubFileURL)
	if err != nil {
		t.Fatal(err)
	}
	var pubBlockBody struct {
		Code    string     `json:"code"`
		Error   string     `json:"error"`
		Message string     `json:"message"`
		Matches []DLPMatch `json:"matches"`
	}
	_ = json.NewDecoder(pubBlockRes.Body).Decode(&pubBlockBody)
	pubBlockRes.Body.Close()
	if pubBlockRes.StatusCode != http.StatusUnprocessableEntity ||
		pubBlockBody.Code != "dlp_blocked" ||
		len(pubBlockBody.Matches) == 0 {
		t.Fatalf("public file download block = status:%d body:%+v", pubBlockRes.StatusCode, pubBlockBody)
	}

	// Verify 2 dlp.export_blocked audit entries with exact channels.
	blockedLogsRes := send(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs?action=dlp.export_blocked", ts.URL, ws.ID), nil)
	var blockedLogs store.AuditLogPage
	_ = json.NewDecoder(blockedLogsRes.Body).Decode(&blockedLogs)
	blockedLogsRes.Body.Close()
	if blockedLogsRes.StatusCode != http.StatusOK || blockedLogs.Total != 2 {
		t.Fatalf("dlp.export_blocked logs = status:%d total:%d", blockedLogsRes.StatusCode, blockedLogs.Total)
	}
	seenChannels := map[string]bool{}
	for _, item := range blockedLogs.Items {
		var d map[string]any
		_ = json.Unmarshal(item.Detail, &d)
		if ch, ok := d["channel"].(string); ok {
			seenChannels[ch] = true
		}
	}
	if !seenChannels["csv_export"] || !seenChannels["public_file_download"] {
		t.Fatalf("expected both csv_export and public_file_download channels in audit logs, got %+v", seenChannels)
	}

	// Switch DLP to WARN mode -> both CSV export and public file download succeed and record dlp.export_warned.
	warnPol := send(t, ownerClient, http.MethodPut, policyURL, map[string]any{"dlpAction": "warn"})
	warnPol.Body.Close()
	if warnPol.StatusCode != http.StatusOK {
		t.Fatalf("switch DLP warn status=%d", warnPol.StatusCode)
	}

	csvWarnRes, err := ownerClient.Get(fmt.Sprintf("%s/api/bases/%d/export", ts.URL, baseDoc.ID))
	if err != nil {
		t.Fatal(err)
	}
	csvRaw, _ := io.ReadAll(csvWarnRes.Body)
	csvWarnRes.Body.Close()
	if csvWarnRes.StatusCode != http.StatusOK || !strings.Contains(string(csvRaw), "绝密并购标的客户名单") {
		t.Fatalf("CSV warn export = status:%d body:%s", csvWarnRes.StatusCode, string(csvRaw))
	}

	pubWarnRes, err := guest.Get(pubFileURL)
	if err != nil {
		t.Fatal(err)
	}
	pubRaw, _ := io.ReadAll(pubWarnRes.Body)
	pubWarnRes.Body.Close()
	if pubWarnRes.StatusCode != http.StatusOK || string(pubRaw) != "attachment-payload-bytes" {
		t.Fatalf("public file warn download = status:%d body:%q", pubWarnRes.StatusCode, string(pubRaw))
	}

	warnLogsRes := send(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs?action=dlp.export_warned", ts.URL, ws.ID), nil)
	var warnLogs store.AuditLogPage
	_ = json.NewDecoder(warnLogsRes.Body).Decode(&warnLogs)
	warnLogsRes.Body.Close()
	if warnLogsRes.StatusCode != http.StatusOK || warnLogs.Total != 2 {
		t.Fatalf("dlp.export_warned logs = status:%d total:%d, want 2", warnLogsRes.StatusCode, warnLogs.Total)
	}
}

func TestRetentionSweeperAndManualEndpoint(t *testing.T) {
	st := store.NewMemory()
	_, ts, ownerClient := newDLPTestServer(t, st)
	adminClient := newCookieClient()
	memberClient := newCookieClient()
	outsiderClient := newCookieClient()
	anonClient := newCookieClient()

	owner, ws := registerAuditTestUser(t, ts, ownerClient, "ret-owner@example.test", "Ret Owner")
	admin, _ := registerAuditTestUser(t, ts, adminClient, "ret-admin@example.test", "Ret Admin")
	member, _ := registerAuditTestUser(t, ts, memberClient, "ret-member@example.test", "Ret Member")
	outsider, otherWS := registerAuditTestUser(t, ts, outsiderClient, "ret-out@example.test", "Ret Outsider")

	joinWorkspaceAs(t, ts, ownerClient, adminClient, ws.ID, admin.Email, store.WorkspaceRoleAdmin)
	joinWorkspaceAs(t, ts, ownerClient, memberClient, ws.ID, member.Email, store.WorkspaceRoleMember)

	// Enable 30-day retention on ws; leave otherWS at 0 (disabled).
	policyURL := fmt.Sprintf("%s/api/workspaces/%d/security-policy", ts.URL, ws.ID)
	polRes := send(t, ownerClient, http.MethodPut, policyURL, map[string]any{"retentionDays": 30})
	polRes.Body.Close()
	if polRes.StatusCode != http.StatusOK {
		t.Fatalf("set retentionDays status=%d", polRes.StatusCode)
	}

	now := time.Now().UTC()
	oldTime := now.Add(-60 * 24 * time.Hour)
	freshTime := now.Add(-5 * 24 * time.Hour)

	// Seed expired + fresh audit logs in ws, plus expired log in otherWS.
	for _, entry := range []store.AuditLogEntry{
		{WorkspaceID: ws.ID, ActorID: owner.ID, Action: "doc.view", ResourceTitle: "Old 1", CreatedAt: oldTime},
		{WorkspaceID: ws.ID, ActorID: owner.ID, Action: "doc.view", ResourceTitle: "Old 2", CreatedAt: oldTime.Add(time.Minute)},
		{WorkspaceID: ws.ID, ActorID: owner.ID, Action: "doc.view", ResourceTitle: "Fresh 1", CreatedAt: freshTime},
		{WorkspaceID: otherWS.ID, ActorID: outsider.ID, Action: "doc.view", ResourceTitle: "Other Old", CreatedAt: oldTime},
	} {
		if err := st.AppendAuditLog(context.Background(), entry); err != nil {
			t.Fatal(err)
		}
	}

	// Create and trash one expired doc and one fresh doc in ws.
	createAndTrashDoc := func(client *http.Client, wsID int64, title string, deletedAt time.Time) int64 {
		t.Helper()
		var d store.DocMeta
		r := post(t, client, ts.URL+"/api/docs", map[string]any{"title": title, "workspaceId": wsID})
		_ = json.NewDecoder(r.Body).Decode(&d)
		r.Body.Close()
		if err := st.Trash(context.Background(), d.ID); err != nil {
			t.Fatal(err)
		}
		st.SetMemoryNodeDeletedAt(d.ID, deletedAt)
		return d.ID
	}
	expiredDocID := createAndTrashDoc(ownerClient, ws.ID, "Expired Trash Doc", oldTime)
	freshDocID := createAndTrashDoc(ownerClient, ws.ID, "Fresh Trash Doc", freshTime)
	otherExpiredDocID := createAndTrashDoc(outsiderClient, otherWS.ID, "Other WS Trash Doc", oldTime)

	// 1. Background sweeper purges expired items in ws only and writes retention.purged audit log.
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	statsList, err := SweepRetentionPolicies(context.Background(), st, logger)
	if err != nil {
		t.Fatalf("SweepRetentionPolicies: %v", err)
	}
	if len(statsList) != 1 || statsList[0].WorkspaceID != ws.ID || statsList[0].RetentionDays != 30 ||
		statsList[0].PurgedAuditLogs != 2 || statsList[0].PurgedTrashNodes != 1 {
		t.Fatalf("unexpected sweep stats: %+v", statsList)
	}

	// Verify expiredDocID purged, freshDocID kept, otherExpiredDocID untouched.
	trashAfterSweep, err := st.ListTrash(context.Background(), owner.ID)
	if err != nil || len(trashAfterSweep) != 1 || trashAfterSweep[0].ID != freshDocID {
		t.Fatalf("ws trash after sweep = %+v err=%v, want only %d (expired=%d)", trashAfterSweep, err, freshDocID, expiredDocID)
	}
	otherTrash, err := st.ListTrash(context.Background(), outsider.ID)
	if err != nil || len(otherTrash) != 1 || otherTrash[0].ID != otherExpiredDocID {
		t.Fatalf("otherWS trash after sweep = %+v err=%v, want untouched %d", otherTrash, err, otherExpiredDocID)
	}

	// Verify retention.purged audit log recorded once.
	retLogsRes := send(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs?action=retention.purged", ts.URL, ws.ID), nil)
	var retLogs store.AuditLogPage
	_ = json.NewDecoder(retLogsRes.Body).Decode(&retLogs)
	retLogsRes.Body.Close()
	if retLogsRes.StatusCode != http.StatusOK || retLogs.Total != 1 {
		t.Fatalf("retention.purged after sweep = status:%d total:%d, want 1", retLogsRes.StatusCode, retLogs.Total)
	}

	// Re-running sweeper when nothing is expired must not emit another retention.purged log.
	statsList2, err := SweepRetentionPolicies(context.Background(), st, logger)
	if err != nil || len(statsList2) != 1 || statsList2[0].PurgedAuditLogs != 0 || statsList2[0].PurgedTrashNodes != 0 {
		t.Fatalf("second sweep = %+v err=%v", statsList2, err)
	}
	retLogsRes2 := send(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs?action=retention.purged", ts.URL, ws.ID), nil)
	var retLogs2 store.AuditLogPage
	_ = json.NewDecoder(retLogsRes2.Body).Decode(&retLogs2)
	retLogsRes2.Body.Close()
	if retLogs2.Total != 1 {
		t.Fatalf("retention.purged after no-op sweep = %d, want still 1", retLogs2.Total)
	}

	// 2. Manual HTTP endpoint POST /api/workspaces/{wsId}/retention/run
	runURL := fmt.Sprintf("%s/api/workspaces/%d/retention/run", ts.URL, ws.ID)
	otherRunURL := fmt.Sprintf("%s/api/workspaces/%d/retention/run", ts.URL, otherWS.ID)

	// Authz: anon -> 401, member -> 403, outsider -> 403.
	if r := send(t, anonClient, http.MethodPost, runURL, map[string]any{}); r.StatusCode != http.StatusUnauthorized {
		r.Body.Close()
		t.Fatalf("anon retention/run = %d, want 401", r.StatusCode)
	}
	for name, cl := range map[string]*http.Client{"member": memberClient, "outsider": outsiderClient} {
		r := send(t, cl, http.MethodPost, runURL, map[string]any{})
		r.Body.Close()
		if r.StatusCode != http.StatusForbidden {
			t.Fatalf("%s retention/run = %d, want 403", name, r.StatusCode)
		}
	}

	// Workspace with retentionDays == 0 -> 400 retention_disabled.
	disRes := send(t, outsiderClient, http.MethodPost, otherRunURL, map[string]any{})
	disRaw, _ := io.ReadAll(disRes.Body)
	disRes.Body.Close()
	if disRes.StatusCode != http.StatusBadRequest || !strings.Contains(string(disRaw), "retention_disabled") {
		t.Fatalf("disabled retention/run = status:%d body:%s, want 400 retention_disabled", disRes.StatusCode, string(disRaw))
	}

	// Seed one more expired audit log and expired trash doc, then run manually as admin!
	if err := st.AppendAuditLog(context.Background(), store.AuditLogEntry{
		WorkspaceID: ws.ID, ActorID: owner.ID, Action: "doc.view", ResourceTitle: "Manual Expired Log", CreatedAt: oldTime,
	}); err != nil {
		t.Fatal(err)
	}
	_ = createAndTrashDoc(ownerClient, ws.ID, "Manual Expired Trash", oldTime)

	manualRes := send(t, adminClient, http.MethodPost, runURL, map[string]any{})
	var manualStats store.RetentionPurgeStats
	if err := json.NewDecoder(manualRes.Body).Decode(&manualStats); err != nil {
		t.Fatal(err)
	}
	manualRes.Body.Close()
	if manualRes.StatusCode != http.StatusOK {
		t.Fatalf("manual retention/run status=%d, want 200", manualRes.StatusCode)
	}
	if manualStats.WorkspaceID != ws.ID || manualStats.RetentionDays != 30 ||
		manualStats.PurgedAuditLogs != 1 || manualStats.PurgedTrashNodes != 1 || manualStats.RanAt.IsZero() {
		t.Fatalf("unexpected manual retention stats: %+v", manualStats)
	}

	// Manual run also recorded retention.purged audit log (now 2 total).
	retLogsRes3 := send(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs?action=retention.purged", ts.URL, ws.ID), nil)
	var retLogs3 store.AuditLogPage
	_ = json.NewDecoder(retLogsRes3.Body).Decode(&retLogs3)
	retLogsRes3.Body.Close()
	if retLogs3.Total != 2 {
		t.Fatalf("retention.purged after manual run = %d, want 2", retLogs3.Total)
	}
}
