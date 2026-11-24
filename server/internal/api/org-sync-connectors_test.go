package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newOrgConnectorTestServer(t *testing.T, st store.Store, allowLoopback bool) (*Server, *httptest.Server, *http.Client) {
	t.Helper()
	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
		AISecret:   []byte("0123456789abcdef0123456789abcdef"),
	}
	if allowLoopback {
		s.PreviewAllow = func(netip.Addr) bool { return true }
		s.SSOAllowHTTP = true
	}
	mux := http.NewServeMux()
	// Mount pull endpoint explicitly so tests work both before and after coordinator wires api.go.
	mux.Handle("POST /api/workspaces/{wsId}/org/sync-sources/{sourceId}/pull",
		httpx.Chain(s.requireUser(http.HandlerFunc(s.pullOrgDirectorySync)), httpx.WithRequestID, httpx.RequireJSON))
	mux.Handle("/", s.Handler())

	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	return s, ts, &http.Client{Jar: jar}
}

func registerAndJoinTestMember(t *testing.T, ts *httptest.Server, owner *http.Client, wsID int64, email, name string) (store.User, *http.Client) {
	t.Helper()
	memberClient := newCommentClient()
	res := post(t, memberClient, ts.URL+"/api/auth/register", map[string]string{
		"email": email, "name": name, "password": "password123",
	})
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(res.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	invRes := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/members", ts.URL, wsID), map[string]any{
		"email": me.User.Email, "role": "member",
	})
	var invChange store.WorkspaceMemberChange
	if err := json.NewDecoder(invRes.Body).Decode(&invChange); err != nil {
		t.Fatal(err)
	}
	invRes.Body.Close()
	accRes := send(t, memberClient, http.MethodPost, fmt.Sprintf("%s/api/invitations/%d/accept", ts.URL, invChange.Invitation.ID), nil)
	accRes.Body.Close()
	if accRes.StatusCode != http.StatusNoContent {
		t.Fatalf("accept invite for %s = %d", email, accRes.StatusCode)
	}
	return me.User, memberClient
}

func registerTestOwner(t *testing.T, ts *httptest.Server, owner *http.Client, email, name string) (store.User, store.Workspace) {
	t.Helper()
	res := post(t, owner, ts.URL+"/api/auth/register", map[string]string{
		"email": email, "name": name, "password": "password123",
	})
	defer res.Body.Close()
	if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusOK {
		t.Fatalf("register owner %s: %d", email, res.StatusCode)
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

// ============================================================================
// Mock RFC 4511 LDAP v3 BER Server for End-to-End Tests
// ============================================================================

type mockLDAPEntry struct {
	DN    string
	Attrs map[string][]string
}

type mockLDAPServer struct {
	ln           net.Listener
	expectedDN   string
	expectedPass string
	ouEntries    []mockLDAPEntry
	userEntries  []mockLDAPEntry
	unbindCount  atomic.Int32
	wg           sync.WaitGroup
}

func startMockLDAPServer(t *testing.T, bindDN, bindPass string, ous, users []mockLDAPEntry) *mockLDAPServer {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &mockLDAPServer{
		ln:           ln,
		expectedDN:   bindDN,
		expectedPass: bindPass,
		ouEntries:    ous,
		userEntries:  users,
	}
	srv.wg.Add(1)
	go func() {
		defer srv.wg.Done()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			srv.wg.Add(1)
			go func(c net.Conn) {
				defer srv.wg.Done()
				defer c.Close()
				srv.handleConn(c)
			}(conn)
		}
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		srv.wg.Wait()
	})
	return srv
}

func encodeLDAPResult(appTag byte, code int, matchedDN, diag string) []byte {
	return berTLV(appTag, berConcat(
		berEnum(code),
		berOctetString(matchedDN),
		berOctetString(diag),
	))
}

func encodeLDAPSearchEntry(e mockLDAPEntry) []byte {
	var attrs [][]byte
	for k, vals := range e.Attrs {
		var valBER [][]byte
		for _, v := range vals {
			valBER = append(valBER, berOctetString(v))
		}
		attrs = append(attrs, berSequence(berOctetString(k), berTLV(berTagSet, berConcat(valBER...))))
	}
	return berTLV(ldapAppSearchResEntry, berConcat(
		berOctetString(e.DN),
		berSequence(attrs...),
	))
}

func (m *mockLDAPServer) handleConn(conn net.Conn) {
	r := bufio.NewReader(conn)
	for {
		tag, body, err := berReadTLV(r, 1<<20)
		if err != nil || tag != berTagSequence {
			return
		}
		idTag, idVal, rest, err := berParseElement(body)
		if err != nil || idTag != berTagInteger {
			return
		}
		msgID, err := berDecodeInt(idVal)
		if err != nil {
			return
		}
		opTag, opVal, _, err := berParseElement(rest)
		if err != nil {
			return
		}
		switch opTag {
		case ldapAppBindRequest:
			// version (INT), name (OCTET STRING), simple [0] (OCTET STRING)
			_, verVal, r1, err := berParseElement(opVal)
			if err != nil {
				return
			}
			ver, _ := berDecodeInt(verVal)
			_, dnVal, r2, err := berParseElement(r1)
			if err != nil {
				return
			}
			_, pwVal, _, err := berParseElement(r2)
			if err != nil {
				return
			}
			code := 0
			diag := ""
			if ver != 3 || string(dnVal) != m.expectedDN || string(pwVal) != m.expectedPass {
				code = 49
				diag = "invalid credentials"
			}
			pkt := berSequence(berInt(msgID), encodeLDAPResult(ldapAppBindResponse, code, "", diag))
			_, _ = conn.Write(pkt)

		case ldapAppSearchRequest:
			// Skip baseObject, scope, deref, sizeLimit, timeLimit, typesOnly -> reach filter bytes
			cur := opVal
			for i := 0; i < 6; i++ {
				_, _, next, err := berParseElement(cur)
				if err != nil {
					return
				}
				cur = next
			}
			_, filterVal, _, err := berParseElement(cur)
			if err != nil {
				return
			}
			// Inspect filter payload bytes to distinguish OU search vs User search.
			var list []mockLDAPEntry
			if strings.Contains(strings.ToLower(string(filterVal)), "organizationalunit") {
				list = m.ouEntries
			} else {
				list = m.userEntries
			}
			for _, entry := range list {
				pkt := berSequence(berInt(msgID), encodeLDAPSearchEntry(entry))
				_, _ = conn.Write(pkt)
			}
			// Also emit a SearchResultReference to prove the client skips AD referrals cleanly.
			refPkt := berSequence(berInt(msgID), berTLV(ldapAppSearchResRef, berOctetString("ldap://forest.acme.test/dc=acme,dc=test")))
			_, _ = conn.Write(refPkt)

			donePkt := berSequence(berInt(msgID), encodeLDAPResult(ldapAppSearchResDone, 0, "", ""))
			_, _ = conn.Write(donePkt)

		case ldapAppUnbindRequest:
			m.unbindCount.Add(1)
			return
		}
	}
}

func TestLDAPConnectorPullEndToEnd(t *testing.T) {
	ldapSrv := startMockLDAPServer(t,
		"cn=sync-svc,dc=acme,dc=test",
		"s3cr3t-ldap-pass",
		[]mockLDAPEntry{
			{DN: "ou=Engineering,dc=acme,dc=test", Attrs: map[string][]string{"ou": {"工程研发"}}},
			{DN: "ou=Platform,ou=Engineering,dc=acme,dc=test", Attrs: map[string][]string{"ou": {"平台内核"}}},
			{DN: "ou=Storage,ou=Platform,ou=Engineering,dc=acme,dc=test", Attrs: map[string][]string{"ou": {"存储团队"}}},
		},
		[]mockLDAPEntry{
			{
				DN: "uid=alice,ou=Storage,ou=Platform,ou=Engineering,dc=acme,dc=test",
				Attrs: map[string][]string{
					"mail": {"ldap-alice@acme.test"},
					"cn":   {"Alice LDAP"},
				},
			},
			{
				DN: "uid=bob,ou=Engineering,dc=acme,dc=test",
				Attrs: map[string][]string{
					"mail": {"ldap-bob@acme.test"},
					"cn":   {"Bob LDAP"},
				},
			},
			{
				DN: "uid=carol,ou=Platform,ou=Engineering,dc=acme,dc=test",
				Attrs: map[string][]string{
					"mail": {"ldap-carol@acme.test"},
					"cn":   {"Carol Newcomer"},
				},
			},
		},
	)

	st := store.NewMemory()
	_, ts, owner := newOrgConnectorTestServer(t, st, true)
	_, ws := registerTestOwner(t, ts, owner, "ldap-owner@acme.test", "Owner")
	alice, aliceClient := registerAndJoinTestMember(t, ts, owner, ws.ID, "ldap-alice@acme.test", "Alice")
	bob, _ := registerAndJoinTestMember(t, ts, owner, ws.ID, "ldap-bob@acme.test", "Bob")

	ldapEndpoint := "ldap://" + ldapSrv.ln.Addr().String()

	// Create LDAP source with encrypted connectorConfig.
	createRes := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources", ts.URL, ws.ID), map[string]any{
		"name":                "Corp AD / LDAP",
		"provider":            "ldap",
		"autoInviteMissing":   true,
		"pruneMissing":        true,
		"endpointUrl":         ldapEndpoint,
		"syncIntervalMinutes": 60,
		"connectorConfig": map[string]any{
			"bindDn":       "cn=sync-svc,dc=acme,dc=test",
			"bindPassword": "s3cr3t-ldap-pass",
			"baseDn":       "dc=acme,dc=test",
			"userFilter":   "(&(objectClass=inetOrgPerson)(mail=*))",
			"deptFilter":   "(objectClass=organizationalUnit)",
			"emailAttr":    "mail",
			"nameAttr":     "cn",
			"deptAttr":     "ou",
		},
	})
	var created store.OrgSyncSourceCreated
	if err := json.NewDecoder(createRes.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	createRes.Body.Close()
	if createRes.StatusCode != http.StatusCreated {
		t.Fatalf("create ldap source = %d", createRes.StatusCode)
	}
	if !created.Source.HasConnectorConfig || created.Source.EndpointURL != ldapEndpoint || created.Source.SyncIntervalMinutes != 60 {
		t.Fatalf("unexpected created ldap source: %+v", created.Source)
	}
	if strings.Contains(created.Source.ConnectorConfigHint, "s3cr3t-ldap-pass") {
		t.Fatalf("connectorConfigHint leaked plaintext password: %q", created.Source.ConnectorConfigHint)
	}

	// Update interval without re-entering password -> secret must remain intact!
	patchRes := send(t, owner, http.MethodPatch, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources/%d", ts.URL, ws.ID, created.Source.ID), map[string]any{
		"syncIntervalMinutes": 30,
	})
	var patched store.OrgSyncSourceCreated
	_ = json.NewDecoder(patchRes.Body).Decode(&patched)
	patchRes.Body.Close()
	if patchRes.StatusCode != http.StatusOK || patched.Source.SyncIntervalMinutes != 30 || !patched.Source.HasConnectorConfig {
		t.Fatalf("patch interval = %d %+v", patchRes.StatusCode, patched.Source)
	}

	// Non-admin member cannot trigger /pull.
	deniedRes := send(t, aliceClient, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources/%d/pull", ts.URL, ws.ID, created.Source.ID), map[string]any{
		"dryRun": true,
	})
	deniedRes.Body.Close()
	if deniedRes.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin pull = %d, want 403", deniedRes.StatusCode)
	}

	// Dry-run pull verifies fetched counts without mutating workspace org.
	dryRes := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources/%d/pull", ts.URL, ws.ID, created.Source.ID), map[string]any{
		"dryRun": true,
	})
	var dryBody struct {
		Run     store.OrgSyncRun `json:"run"`
		Fetched struct {
			Departments int `json:"departments"`
			Groups      int `json:"groups"`
			Members     int `json:"members"`
		} `json:"fetched"`
	}
	if err := json.NewDecoder(dryRes.Body).Decode(&dryBody); err != nil {
		t.Fatal(err)
	}
	dryRes.Body.Close()
	if dryRes.StatusCode != http.StatusOK || !dryBody.Run.DryRun || dryBody.Run.TriggerMode != store.OrgSyncTriggerPull ||
		dryBody.Fetched.Departments != 3 || dryBody.Fetched.Members != 3 ||
		dryBody.Run.DepartmentsCreated != 3 || dryBody.Run.MembersLinked != 2 || dryBody.Run.MembersInvited != 1 {
		t.Fatalf("dry-run LDAP pull = %d %+v", dryRes.StatusCode, dryBody)
	}

	// Live pull syncs departments, hierarchy, memberships, and invitations into Jiange workspace!
	liveRes := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources/%d/pull", ts.URL, ws.ID, created.Source.ID), map[string]any{
		"dryRun": false,
	})
	var liveBody struct {
		Run     store.OrgSyncRun `json:"run"`
		Fetched struct {
			Departments int `json:"departments"`
			Groups      int `json:"groups"`
			Members     int `json:"members"`
		} `json:"fetched"`
	}
	if err := json.NewDecoder(liveRes.Body).Decode(&liveBody); err != nil {
		t.Fatal(err)
	}
	liveRes.Body.Close()
	if liveRes.StatusCode != http.StatusOK || liveBody.Run.DryRun || liveBody.Run.TriggerMode != store.OrgSyncTriggerPull ||
		liveBody.Run.DepartmentsCreated != 3 || liveBody.Run.MembersLinked != 2 || liveBody.Run.MembersInvited != 1 {
		t.Fatalf("live LDAP pull = %d %+v", liveRes.StatusCode, liveBody)
	}

	// Verify actual workspace org tree via GET /api/workspaces/{wsId}/org.
	orgRes := send(t, owner, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/org", ts.URL, ws.ID), nil)
	var snap store.WorkspaceOrgSnapshot
	if err := json.NewDecoder(orgRes.Body).Decode(&snap); err != nil {
		t.Fatal(err)
	}
	orgRes.Body.Close()
	if len(snap.Departments) != 3 || len(snap.Invitations) != 1 || snap.Invitations[0].Email != "ldap-carol@acme.test" {
		t.Fatalf("unexpected org snapshot after LDAP pull: depts=%d invites=%+v", len(snap.Departments), snap.Invitations)
	}
	deptByName := map[string]store.OrgDepartment{}
	for _, d := range snap.Departments {
		deptByName[d.Name] = d
	}
	eng := deptByName["工程研发"]
	plat := deptByName["平台内核"]
	stor := deptByName["存储团队"]
	if eng.ParentID != nil || plat.ParentID == nil || *plat.ParentID != eng.ID || stor.ParentID == nil || *stor.ParentID != plat.ID {
		t.Fatalf("LDAP department hierarchy mismatch: eng=%+v plat=%+v stor=%+v", eng, plat, stor)
	}
	if len(stor.Members) != 1 || stor.Members[0].UserID != alice.ID {
		t.Fatalf("expected Alice in 存储团队, got %+v", stor.Members)
	}
	if len(eng.Members) != 1 || eng.Members[0].UserID != bob.ID {
		t.Fatalf("expected Bob in 工程研发, got %+v", eng.Members)
	}

	// Verify UnbindRequest was cleanly sent on close.
	if ldapSrv.unbindCount.Load() < 2 {
		t.Fatalf("expected LDAP UnbindRequest on close, got %d", ldapSrv.unbindCount.Load())
	}

	// Verify audit log recorded org.sync_pulled.
	auditRes := send(t, owner, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs?action=org.sync_pulled", ts.URL, ws.ID), nil)
	var auditBody store.AuditLogPage
	_ = json.NewDecoder(auditRes.Body).Decode(&auditBody)
	auditRes.Body.Close()
	if auditRes.StatusCode != http.StatusOK || len(auditBody.Items) < 2 {
		t.Fatalf("expected org.sync_pulled audit entries, got status=%d items=%d", auditRes.StatusCode, len(auditBody.Items))
	}

	// Updating wrong password causes 502 connector_pull_failed on pull.
	badPatch := send(t, owner, http.MethodPatch, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources/%d", ts.URL, ws.ID, created.Source.ID), map[string]any{
		"connectorConfig": map[string]any{
			"bindDn":       "cn=sync-svc,dc=acme,dc=test",
			"bindPassword": "wrong-password",
			"baseDn":       "dc=acme,dc=test",
		},
	})
	badPatch.Body.Close()
	badPull := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources/%d/pull", ts.URL, ws.ID, created.Source.ID), map[string]any{})
	badPull.Body.Close()
	if badPull.StatusCode != http.StatusBadGateway {
		t.Fatalf("bad LDAP credentials pull = %d, want 502", badPull.StatusCode)
	}
}

func TestWeComConnectorPullEndToEnd(t *testing.T) {
	mockWeCom := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/cgi-bin/gettoken":
			if r.URL.Query().Get("corpid") != "ww-acme-001" || r.URL.Query().Get("corpsecret") != "wecom-secret-xyz" {
				_ = json.NewEncoder(w).Encode(map[string]any{"errcode": 40001, "errmsg": "invalid credential"})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"errcode": 0, "errmsg": "ok", "access_token": "tok-wecom-123", "expires_in": 7200})
		case "/cgi-bin/department/list":
			if r.URL.Query().Get("access_token") != "tok-wecom-123" {
				_ = json.NewEncoder(w).Encode(map[string]any{"errcode": 42001, "errmsg": "bad token"})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"errcode": 0,
				"errmsg":  "ok",
				"department": []map[string]any{
					{"id": 1, "name": "总公司", "parentid": 0, "order": 1},
					{"id": 2, "name": "研发中心", "parentid": 1, "order": 2},
					{"id": 3, "name": "产品部", "parentid": 1, "order": 3},
				},
			})
		case "/cgi-bin/user/list":
			if r.URL.Query().Get("access_token") != "tok-wecom-123" || r.URL.Query().Get("department_id") != "1" || r.URL.Query().Get("fetch_child") != "1" {
				_ = json.NewEncoder(w).Encode(map[string]any{"errcode": 40003, "errmsg": "bad params"})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"errcode": 0,
				"errmsg":  "ok",
				"userlist": []map[string]any{
					{
						"userid":            "u-alice",
						"name":              "林晓",
						"email":             "wecom-alice@acme.test",
						"department":        []int{2},
						"is_leader_in_dept": []int{1},
						"status":            1,
					},
					{
						"userid":     "u-bob",
						"name":       "陈明",
						"biz_mail":   "wecom-bob@acme.test",
						"department": []int{3},
						"status":     1,
					},
					{
						"userid":     "u-disabled",
						"name":       "已停用员工",
						"email":      "disabled@acme.test",
						"department": []int{2},
						"status":     2,
					},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(mockWeCom.Close)

	st := store.NewMemory()
	_, ts, owner := newOrgConnectorTestServer(t, st, true)
	_, ws := registerTestOwner(t, ts, owner, "wecom-owner@acme.test", "Owner")
	alice, _ := registerAndJoinTestMember(t, ts, owner, ws.ID, "wecom-alice@acme.test", "Alice")

	createRes := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources", ts.URL, ws.ID), map[string]any{
		"name":              "企业微信通讯录",
		"provider":          "wecom",
		"autoInviteMissing": true,
		"pruneMissing":      false,
	})
	var created store.OrgSyncSourceCreated
	_ = json.NewDecoder(createRes.Body).Decode(&created)
	createRes.Body.Close()

	// Save WeCom connector credentials via PATCH.
	patchRes := send(t, owner, http.MethodPatch, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources/%d", ts.URL, ws.ID, created.Source.ID), map[string]any{
		"endpointUrl":         mockWeCom.URL,
		"syncIntervalMinutes": 60,
		"connectorConfig": map[string]any{
			"corpId":     "ww-acme-001",
			"corpSecret": "wecom-secret-xyz",
			"rootDeptId": 1,
		},
	})
	var patched store.OrgSyncSourceCreated
	_ = json.NewDecoder(patchRes.Body).Decode(&patched)
	patchRes.Body.Close()
	if patchRes.StatusCode != http.StatusOK || !patched.Source.HasConnectorConfig || strings.Contains(patched.Source.ConnectorConfigHint, "wecom-secret-xyz") {
		t.Fatalf("patch WeCom connector = %d %+v", patchRes.StatusCode, patched.Source)
	}

	// Execute live pull!
	pullRes := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources/%d/pull", ts.URL, ws.ID, created.Source.ID), map[string]any{
		"dryRun": false,
	})
	var pullBody struct {
		Run     store.OrgSyncRun `json:"run"`
		Fetched struct {
			Departments int `json:"departments"`
			Groups      int `json:"groups"`
			Members     int `json:"members"`
		} `json:"fetched"`
	}
	if err := json.NewDecoder(pullRes.Body).Decode(&pullBody); err != nil {
		t.Fatal(err)
	}
	pullRes.Body.Close()
	if pullRes.StatusCode != http.StatusOK ||
		pullBody.Run.TriggerMode != store.OrgSyncTriggerPull ||
		pullBody.Fetched.Departments != 3 || pullBody.Fetched.Members != 2 ||
		pullBody.Run.DepartmentsCreated != 3 || pullBody.Run.MembersLinked != 1 || pullBody.Run.MembersInvited != 1 {
		t.Fatalf("WeCom pull = %d %+v", pullRes.StatusCode, pullBody)
	}

	// Verify Alice is leader of 研发中心 and disabled user was skipped.
	orgRes := send(t, owner, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/org", ts.URL, ws.ID), nil)
	var snap store.WorkspaceOrgSnapshot
	_ = json.NewDecoder(orgRes.Body).Decode(&snap)
	orgRes.Body.Close()
	var foundAliceLeader bool
	for _, d := range snap.Departments {
		if d.Name == "研发中心" && len(d.Members) == 1 && d.Members[0].UserID == alice.ID && d.Members[0].IsLeader {
			foundAliceLeader = true
		}
	}
	if !foundAliceLeader {
		t.Fatalf("expected Alice as leader of 研发中心, got %+v", snap.Departments)
	}
	if len(snap.Invitations) != 1 || snap.Invitations[0].Email != "wecom-bob@acme.test" {
		t.Fatalf("expected only wecom-bob invited (disabled skipped), got %+v", snap.Invitations)
	}
}

func TestDingTalkConnectorPullEndToEnd(t *testing.T) {
	mockDing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/gettoken":
			if r.URL.Query().Get("appkey") != "ding-key-01" || r.URL.Query().Get("appsecret") != "ding-secret-99" {
				_ = json.NewEncoder(w).Encode(map[string]any{"errcode": 40001, "errmsg": "bad appkey"})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"errcode": 0, "errmsg": "ok", "access_token": "tok-ding-456"})
		case "/topapi/v2/department/listsub":
			var req struct {
				DeptID int64 `json:"dept_id"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			switch req.DeptID {
			case 1:
				_ = json.NewEncoder(w).Encode(map[string]any{
					"errcode": 0,
					"result": []map[string]any{
						{"dept_id": 10, "name": "技术中心", "parent_id": 1},
						{"dept_id": 20, "name": "运营部", "parent_id": 1},
					},
				})
			case 10:
				// Include a cycle back-reference to dept 1 to prove BFS cycle guard works!
				_ = json.NewEncoder(w).Encode(map[string]any{
					"errcode": 0,
					"result": []map[string]any{
						{"dept_id": 11, "name": "基础架构组", "parent_id": 10},
					},
				})
			default:
				_ = json.NewEncoder(w).Encode(map[string]any{"errcode": 0, "result": []any{}})
			}
		case "/topapi/v2/user/list":
			var req struct {
				DeptID int64 `json:"dept_id"`
				Cursor int64 `json:"cursor"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			switch {
			case req.DeptID == 10 && req.Cursor == 0:
				// Page 1 -> has_more = true
				_ = json.NewEncoder(w).Encode(map[string]any{
					"errcode": 0,
					"result": map[string]any{
						"has_more":    true,
						"next_cursor": 100,
						"list": []map[string]any{
							{"userid": "d1", "name": "Alice", "email": "ding-alice@acme.test", "dept_id_list": []int{10, 11}, "leader": true},
						},
					},
				})
			case req.DeptID == 10 && req.Cursor == 100:
				// Page 2 -> has_more = false
				_ = json.NewEncoder(w).Encode(map[string]any{
					"errcode": 0,
					"result": map[string]any{
						"has_more":    false,
						"next_cursor": 0,
						"list": []map[string]any{
							{"userid": "d2", "name": "Bob", "org_email": "ding-bob@acme.test", "dept_id_list": []int{10}},
						},
					},
				})
			case req.DeptID == 20 && req.Cursor == 0:
				// Duplicate Alice also in dept 20 -> must deduplicate cleanly!
				_ = json.NewEncoder(w).Encode(map[string]any{
					"errcode": 0,
					"result": map[string]any{
						"has_more":    false,
						"next_cursor": 0,
						"list": []map[string]any{
							{"userid": "d1", "name": "Alice", "email": "ding-alice@acme.test", "dept_id_list": []int{20}},
						},
					},
				})
			default:
				_ = json.NewEncoder(w).Encode(map[string]any{
					"errcode": 0,
					"result":  map[string]any{"has_more": false, "next_cursor": 0, "list": []any{}},
				})
			}
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(mockDing.Close)

	st := store.NewMemory()
	_, ts, owner := newOrgConnectorTestServer(t, st, true)
	_, ws := registerTestOwner(t, ts, owner, "ding-owner@acme.test", "Owner")
	alice, _ := registerAndJoinTestMember(t, ts, owner, ws.ID, "ding-alice@acme.test", "Alice")

	createRes := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources", ts.URL, ws.ID), map[string]any{
		"name":              "钉钉组织架构",
		"provider":          "dingtalk",
		"autoInviteMissing": true,
		"endpointUrl":       mockDing.URL,
		"connectorConfig": map[string]any{
			"appKey":     "ding-key-01",
			"appSecret":  "ding-secret-99",
			"rootDeptId": 1,
		},
	})
	var created store.OrgSyncSourceCreated
	_ = json.NewDecoder(createRes.Body).Decode(&created)
	createRes.Body.Close()
	if createRes.StatusCode != http.StatusCreated || !created.Source.HasConnectorConfig {
		t.Fatalf("create DingTalk source = %d %+v", createRes.StatusCode, created.Source)
	}

	pullRes := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources/%d/pull", ts.URL, ws.ID, created.Source.ID), map[string]any{})
	var pullBody struct {
		Run     store.OrgSyncRun `json:"run"`
		Fetched struct {
			Departments int `json:"departments"`
			Groups      int `json:"groups"`
			Members     int `json:"members"`
		} `json:"fetched"`
	}
	if err := json.NewDecoder(pullRes.Body).Decode(&pullBody); err != nil {
		t.Fatal(err)
	}
	pullRes.Body.Close()
	if pullRes.StatusCode != http.StatusOK ||
		pullBody.Fetched.Departments != 3 || pullBody.Fetched.Members != 2 ||
		pullBody.Run.DepartmentsCreated != 3 || pullBody.Run.MembersLinked != 1 || pullBody.Run.MembersInvited != 1 {
		t.Fatalf("DingTalk pull = %d %+v", pullRes.StatusCode, pullBody)
	}

	// Verify Alice belongs to all 3 departments (deduped across pages & departments) and 基础架构组 is child of 技术中心.
	orgRes := send(t, owner, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/org", ts.URL, ws.ID), nil)
	var snap store.WorkspaceOrgSnapshot
	_ = json.NewDecoder(orgRes.Body).Decode(&snap)
	orgRes.Body.Close()
	deptByName := map[string]store.OrgDepartment{}
	aliceDeptCount := 0
	for _, d := range snap.Departments {
		deptByName[d.Name] = d
		for _, m := range d.Members {
			if m.UserID == alice.ID {
				aliceDeptCount++
			}
		}
	}
	if deptByName["基础架构组"].ParentID == nil || *deptByName["基础架构组"].ParentID != deptByName["技术中心"].ID {
		t.Fatalf("DingTalk hierarchy mismatch: %+v", deptByName)
	}
	if aliceDeptCount != 3 {
		t.Fatalf("expected Alice in all 3 departments (10, 11, 20), got %d", aliceDeptCount)
	}
}

func TestScheduledOrgSyncSweeper(t *testing.T) {
	var hits atomic.Int32
	mockWeCom := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/cgi-bin/gettoken":
			hits.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"errcode": 0, "access_token": "tok-sched"})
		case "/cgi-bin/department/list":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"errcode":    0,
				"department": []map[string]any{{"id": 100, "name": "定时拉取部", "parentid": 0}},
			})
		case "/cgi-bin/user/list":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"errcode": 0,
				"userlist": []map[string]any{
					{"userid": "u1", "name": "Alice", "email": "sched-alice@acme.test", "department": []int{100}, "status": 1},
				},
			})
		}
	}))
	t.Cleanup(mockWeCom.Close)

	origAllow := orgConnectorTestAllowAddr
	origHTTP := orgConnectorTestAllowHTTP
	origNow := orgSyncSweeperNow
	orgConnectorTestAllowAddr = func(netip.Addr) bool { return true }
	orgConnectorTestAllowHTTP = true
	t.Cleanup(func() {
		orgConnectorTestAllowAddr = origAllow
		orgConnectorTestAllowHTTP = origHTTP
		orgSyncSweeperNow = origNow
	})

	now := time.Date(2026, 11, 24, 15, 0, 0, 0, time.UTC)
	orgSyncSweeperNow = func() time.Time { return now }

	st := store.NewMemory()
	secret := []byte("0123456789abcdef0123456789abcdef")
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "sched-owner@acme.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	alice, _, err := st.CreateUser(ctx, "sched-alice@acme.test", "Alice", "hash")
	if err != nil {
		t.Fatal(err)
	}
	_ = st.AddWorkspaceMember(ctx, ws.ID, alice.ID)
	guard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("sched-sess")}
	_ = st.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour))

	makeSource := func(name string, interval int, enabled bool, lastAuto *time.Time) int64 {
		created, err := st.CreateOrgSyncSourceGuarded(ctx, guard, ws.ID, name, store.OrgSyncProviderWeCom, true, false)
		if err != nil {
			t.Fatal(err)
		}
		enc, err := sealOrgConnectorConfig(orgConnectorSecretKey(secret), ws.ID, created.Source.ID, OrgConnectorConfig{
			EndpointURL: mockWeCom.URL,
			CorpID:      "ww-sched",
			CorpSecret:  "sec-sched",
			RootDeptID:  1,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := st.UpdateOrgSyncConnector(ctx, guard, ws.ID, created.Source.ID, mockWeCom.URL, enc, "corp=ww-sched", interval); err != nil {
			t.Fatal(err)
		}
		if !enabled {
			f := false
			_, _ = st.UpdateOrgSyncSourceGuarded(ctx, guard, ws.ID, created.Source.ID, store.OrgSyncSourcePatch{Enabled: &f})
		}
		if lastAuto != nil {
			_ = st.MarkOrgSyncAutoSyncAt(ctx, created.Source.ID, *lastAuto)
		}
		return created.Source.ID
	}

	dueID := makeSource("Due Source", 30, true, nil)
	recent := now.Add(-10 * time.Minute)
	_ = makeSource("Not Due Source", 60, true, &recent)
	_ = makeSource("Disabled Source", 30, false, nil)

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	count := SweepScheduledOrgSyncs(ctx, st, secret, log)
	if count != 1 || hits.Load() != 1 {
		t.Fatalf("SweepScheduledOrgSyncs = %d (hits=%d), want 1", count, hits.Load())
	}

	// Verify scheduled run recorded and department created!
	_, runs, err := st.ListOrgSyncState(ctx, guard, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || runs[0].SourceID != dueID || runs[0].TriggerMode != store.OrgSyncTriggerScheduled || runs[0].DepartmentsCreated != 1 || runs[0].MembersLinked != 1 {
		t.Fatalf("unexpected scheduled run: %+v", runs)
	}

	// Re-running 5 minutes later skips all sources.
	now = now.Add(5 * time.Minute)
	if again := SweepScheduledOrgSyncs(ctx, st, secret, log); again != 0 {
		t.Fatalf("expected 0 synced 5m later, got %d", again)
	}

	// Re-running 31 minutes after first run triggers dueID again.
	now = now.Add(26 * time.Minute)
	if third := SweepScheduledOrgSyncs(ctx, st, secret, log); third != 1 {
		t.Fatalf("expected 1 synced after interval elapsed, got %d", third)
	}
}

func TestOrgConnectorSSRFBlocked(t *testing.T) {
	st := store.NewMemory()
	// allowLoopback = false -> production SSRF protections active!
	_, ts, owner := newOrgConnectorTestServer(t, st, false)
	_, ws := registerTestOwner(t, ts, owner, "ssrf-owner@acme.test", "Owner")

	cases := []struct {
		name     string
		provider string
		endpoint string
		cfg      map[string]any
	}{
		{
			name:     "wecom-metadata-http",
			provider: "wecom",
			endpoint: "http://169.254.169.254/latest/meta-data",
			cfg:      map[string]any{"corpId": "ww1", "corpSecret": "sec1"},
		},
		{
			name:     "wecom-loopback-https",
			provider: "wecom",
			endpoint: "https://127.0.0.1:8443",
			cfg:      map[string]any{"corpId": "ww1", "corpSecret": "sec1"},
		},
		{
			name:     "dingtalk-private-ip",
			provider: "dingtalk",
			endpoint: "https://10.0.0.1",
			cfg:      map[string]any{"appKey": "k1", "appSecret": "s1"},
		},
		{
			name:     "ldap-metadata-ip",
			provider: "ldap",
			endpoint: "ldap://169.254.169.254:389",
			cfg:      map[string]any{"baseDn": "dc=acme,dc=test"},
		},
		{
			name:     "ldap-loopback-ip",
			provider: "ldap",
			endpoint: "ldap://127.0.0.1:389",
			cfg:      map[string]any{"baseDn": "dc=acme,dc=test"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/org/sync-sources", ts.URL, ws.ID), map[string]any{
				"name":            tc.name,
				"provider":        tc.provider,
				"endpointUrl":     tc.endpoint,
				"connectorConfig": tc.cfg,
			})
			res.Body.Close()
			if res.StatusCode != http.StatusBadRequest {
				t.Fatalf("%s: status = %d, want 400", tc.name, res.StatusCode)
			}
		})
	}
}
