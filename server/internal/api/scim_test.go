package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newSCIMTestServer(t *testing.T, st store.Store, now func() time.Time) (*Server, *httptest.Server, *http.Client) {
	t.Helper()
	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
		Now:        now,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /scim/v2/ServiceProviderConfig", s.scimServiceProviderConfig)
	mux.HandleFunc("GET /scim/v2/Users", s.scimListUsers)
	mux.HandleFunc("POST /scim/v2/Users", s.scimCreateUser)
	mux.HandleFunc("GET /scim/v2/Users/{uid}", s.scimGetUser)
	mux.HandleFunc("PATCH /scim/v2/Users/{uid}", s.scimPatchUser)
	mux.HandleFunc("DELETE /scim/v2/Users/{uid}", s.scimDeleteUser)
	mux.HandleFunc("GET /scim/v2/Groups", s.scimListGroups)
	mux.HandleFunc("POST /scim/v2/Groups", s.scimCreateGroup)
	mux.HandleFunc("GET /scim/v2/Groups/{gid}", s.scimGetGroup)
	mux.HandleFunc("PATCH /scim/v2/Groups/{gid}", s.scimPatchGroup)
	mux.HandleFunc("DELETE /scim/v2/Groups/{gid}", s.scimDeleteGroup)
	mux.Handle("/", s.Handler())

	// Wrap with httpx.RequireJSON to verify application/scim+json passes CSRF/content-type middleware.
	ts := httptest.NewServer(httpx.RequireJSON(mux))
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	return s, ts, &http.Client{Jar: jar}
}

func scimRequest(t *testing.T, method, rawURL, bearer string, headers map[string]string, body any) *http.Response {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, rawURL, rdr)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", scimContentType)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func scimCreatePAT(t *testing.T, ts *httptest.Server, client *http.Client, name string, scopes []string) string {
	t.Helper()
	res := post(t, client, ts.URL+"/api/me/tokens", map[string]any{
		"name":   name,
		"scopes": scopes,
	})
	defer res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		raw, _ := io.ReadAll(res.Body)
		t.Fatalf("create PAT %q status=%d body=%s", name, res.StatusCode, string(raw))
	}
	var out struct {
		RawToken string `json:"rawToken"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out.RawToken
}

func assertSCIMErrorResponse(t *testing.T, res *http.Response, wantStatus int, wantScimType string) {
	t.Helper()
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != wantStatus {
		t.Fatalf("status=%d want %d; body=%s", res.StatusCode, wantStatus, string(raw))
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, scimContentType) {
		t.Fatalf("Content-Type=%q want prefix %q", ct, scimContentType)
	}
	var errBody scimErrorResponse
	if err := json.Unmarshal(raw, &errBody); err != nil {
		t.Fatalf("invalid SCIM error JSON (%v): %s", err, string(raw))
	}
	if len(errBody.Schemas) == 0 || errBody.Schemas[0] != scimSchemaError {
		t.Fatalf("error schemas=%v want %q", errBody.Schemas, scimSchemaError)
	}
	if errBody.Status != strconv.Itoa(wantStatus) {
		t.Fatalf("error status field=%q want %q", errBody.Status, strconv.Itoa(wantStatus))
	}
	if wantScimType != "" && errBody.ScimType != wantScimType {
		t.Fatalf("scimType=%q want %q (body=%s)", errBody.ScimType, wantScimType, string(raw))
	}
}

func TestSCIMServiceProviderConfig(t *testing.T) {
	st := store.NewMemory()
	fixedNow := time.Date(2026, 11, 24, 11, 0, 0, 0, time.UTC)
	_, ts, _ := newSCIMTestServer(t, st, func() time.Time { return fixedNow })

	res := scimRequest(t, http.MethodGet, ts.URL+"/scim/v2/ServiceProviderConfig", "", nil, nil)
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status=%d want 200", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, scimContentType) {
		t.Fatalf("Content-Type=%q want %q", ct, scimContentType)
	}

	var cfg struct {
		Schemas               []string `json:"schemas"`
		Patch                 struct{ Supported bool } `json:"patch"`
		Filter                struct{ Supported bool; MaxResults int } `json:"filter"`
		AuthenticationSchemes []struct {
			Type    string `json:"type"`
			Name    string `json:"name"`
			Primary bool   `json:"primary"`
		} `json:"authenticationSchemes"`
	}
	if err := json.NewDecoder(res.Body).Decode(&cfg); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Schemas) == 0 || cfg.Schemas[0] != scimSchemaServiceProviderConfig {
		t.Fatalf("schemas=%v want %q", cfg.Schemas, scimSchemaServiceProviderConfig)
	}
	if !cfg.Patch.Supported {
		t.Fatal("expected patch.supported=true")
	}
	if !cfg.Filter.Supported || cfg.Filter.MaxResults <= 0 {
		t.Fatalf("expected filter.supported=true with positive maxResults, got %+v", cfg.Filter)
	}
	if len(cfg.AuthenticationSchemes) == 0 || cfg.AuthenticationSchemes[0].Type != "oauthbearertoken" {
		t.Fatalf("expected oauthbearertoken scheme, got %+v", cfg.AuthenticationSchemes)
	}
}

func TestSCIMAuthAndPATScopeEnforcement(t *testing.T) {
	st := store.NewMemory()
	fixedNow := time.Date(2026, 11, 24, 11, 15, 0, 0, time.UTC)
	_, ts, ownerClient := newSCIMTestServer(t, st, func() time.Time { return fixedNow })

	owner, ownerWS := patTestRegister(t, ts, ownerClient, "scim-owner@example.test", "SCIM Owner")

	memberJar, _ := cookiejar.New(nil)
	memberClient := &http.Client{Jar: memberJar}
	member, _ := patTestRegister(t, ts, memberClient, "scim-member@example.test", "Regular Member")
	if err := st.AddWorkspaceMember(t.Context(), ownerWS.ID, member.ID); err != nil {
		t.Fatal(err)
	}

	readPAT := scimCreatePAT(t, ts, ownerClient, "SCIM Read Only", []string{"read"})
	writePAT := scimCreatePAT(t, ts, ownerClient, "SCIM Write Only", []string{"write"})
	adminPAT := scimCreatePAT(t, ts, ownerClient, "SCIM Admin", []string{"admin"})
	memberAdminPAT := scimCreatePAT(t, ts, memberClient, "Member Own Admin PAT", []string{"admin"})

	// 1. Unauthenticated -> 401 SCIM error
	res := scimRequest(t, http.MethodGet, ts.URL+"/scim/v2/Users", "", nil, nil)
	assertSCIMErrorResponse(t, res, http.StatusUnauthorized, "")

	// 2. Invalid Bearer token -> 401 SCIM error
	res = scimRequest(t, http.MethodGet, ts.URL+"/scim/v2/Users", "jg_pat_invalid_token_value", nil, nil)
	assertSCIMErrorResponse(t, res, http.StatusUnauthorized, "")

	// 3. Read PAT rejected with 403 SCIM error
	res = scimRequest(t, http.MethodGet, ts.URL+"/scim/v2/Users", readPAT, nil, nil)
	assertSCIMErrorResponse(t, res, http.StatusForbidden, "")

	// 4. Write-only PAT rejected with 403 SCIM error
	res = scimRequest(t, http.MethodGet, ts.URL+"/scim/v2/Users", writePAT, nil, nil)
	assertSCIMErrorResponse(t, res, http.StatusForbidden, "")

	// 5. Regular workspace member cannot target owner's workspace even with their own admin PAT -> 403
	res = scimRequest(t, http.MethodGet, fmt.Sprintf("%s/scim/v2/Users?workspaceId=%d", ts.URL, ownerWS.ID), memberAdminPAT, nil, nil)
	assertSCIMErrorResponse(t, res, http.StatusForbidden, "")

	// 6. Owner's admin PAT accepted (default workspace resolution) -> 200
	res = scimRequest(t, http.MethodGet, ts.URL+"/scim/v2/Users", adminPAT, nil, nil)
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(res.Body)
		t.Fatalf("admin PAT GET /scim/v2/Users status=%d body=%s", res.StatusCode, string(raw))
	}
	var listResp scimListResponse
	if err := json.NewDecoder(res.Body).Decode(&listResp); err != nil {
		t.Fatal(err)
	}
	if listResp.TotalResults != 2 {
		t.Fatalf("totalResults=%d want 2 (owner + member)", listResp.TotalResults)
	}

	// 7. Workspace resolution via X-Jiange-Workspace-Id header -> 200
	hdrRes := scimRequest(t, http.MethodGet, ts.URL+"/scim/v2/Users", adminPAT, map[string]string{
		"X-Jiange-Workspace-Id": strconv.FormatInt(ownerWS.ID, 10),
	}, nil)
	hdrRes.Body.Close()
	if hdrRes.StatusCode != http.StatusOK {
		t.Fatalf("header workspace resolution status=%d want 200", hdrRes.StatusCode)
	}

	// 8. Authenticated owner session cookie accepted -> 200
	sessRes := send(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/scim/v2/Users/%d?workspaceId=%d", ts.URL, owner.ID, ownerWS.ID), nil)
	sessRes.Body.Close()
	if sessRes.StatusCode != http.StatusOK {
		t.Fatalf("session cookie GET /scim/v2/Users/{owner} status=%d want 200", sessRes.StatusCode)
	}
}

func TestSCIMUserLifecycle(t *testing.T) {
	st := store.NewMemory()
	fixedNow := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	_, ts, ownerClient := newSCIMTestServer(t, st, func() time.Time { return fixedNow })

	owner, ws := patTestRegister(t, ts, ownerClient, "owner-life@example.test", "Workspace Owner")
	adminPAT := scimCreatePAT(t, ts, ownerClient, "Okta SCIM", []string{"admin"})
	wsQuery := fmt.Sprintf("?workspaceId=%d", ws.ID)

	// 1. Provision brand new user via POST /scim/v2/Users
	createRes := scimRequest(t, http.MethodPost, ts.URL+"/scim/v2/Users"+wsQuery, adminPAT, nil, map[string]any{
		"schemas":     []string{scimSchemaUser},
		"userName":    "Alice.Provisioned@Example.Test",
		"displayName": "Alice Provisioned",
		"emails": []map[string]any{
			{"value": "Alice.Provisioned@Example.Test", "type": "work", "primary": true},
		},
		"active": true,
	})
	if createRes.StatusCode != http.StatusCreated {
		raw, _ := io.ReadAll(createRes.Body)
		t.Fatalf("POST /scim/v2/Users status=%d body=%s", createRes.StatusCode, string(raw))
	}
	if ct := createRes.Header.Get("Content-Type"); !strings.HasPrefix(ct, scimContentType) {
		t.Fatalf("Content-Type=%q want %q", ct, scimContentType)
	}
	var alice scimUserResource
	if err := json.NewDecoder(createRes.Body).Decode(&alice); err != nil {
		t.Fatal(err)
	}
	createRes.Body.Close()
	if alice.ID == "" || alice.UserName != "alice.provisioned@example.test" || alice.DisplayName != "Alice Provisioned" || !alice.Active {
		t.Fatalf("unexpected created SCIM user: %+v", alice)
	}
	if len(alice.Roles) != 1 || alice.Roles[0].Value != store.WorkspaceRoleMember {
		t.Fatalf("expected default member role, got %+v", alice.Roles)
	}
	if loc := createRes.Header.Get("Location"); loc != "/scim/v2/Users/"+alice.ID {
		t.Fatalf("Location=%q want %q", loc, "/scim/v2/Users/"+alice.ID)
	}

	// 2. Duplicate POST for same userName -> 409 uniqueness
	dupRes := scimRequest(t, http.MethodPost, ts.URL+"/scim/v2/Users"+wsQuery, adminPAT, nil, map[string]any{
		"userName": "alice.provisioned@example.test",
	})
	assertSCIMErrorResponse(t, dupRes, http.StatusConflict, "uniqueness")

	// 3. Provision second user with name.formatted and admin role
	createRes2 := scimRequest(t, http.MethodPost, ts.URL+"/scim/v2/Users"+wsQuery, adminPAT, nil, map[string]any{
		"schemas":  []string{scimSchemaUser},
		"userName": "bob.admin@example.test",
		"name":     map[string]string{"formatted": "Bob Admin"},
		"roles":    []map[string]string{{"value": "admin"}},
	})
	if createRes2.StatusCode != http.StatusCreated {
		raw, _ := io.ReadAll(createRes2.Body)
		t.Fatalf("POST bob status=%d body=%s", createRes2.StatusCode, string(raw))
	}
	var bob scimUserResource
	if err := json.NewDecoder(createRes2.Body).Decode(&bob); err != nil {
		t.Fatal(err)
	}
	createRes2.Body.Close()
	if bob.DisplayName != "Bob Admin" || len(bob.Roles) != 1 || bob.Roles[0].Value != store.WorkspaceRoleAdmin {
		t.Fatalf("unexpected bob SCIM user: %+v", bob)
	}

	// 4. GET /scim/v2/Users with case-insensitive filter
	filterURL := fmt.Sprintf("%s/scim/v2/Users?workspaceId=%d&filter=%s",
		ts.URL, ws.ID, url.QueryEscape(`userName eq "ALICE.PROVISIONED@EXAMPLE.TEST"`))
	filterRes := scimRequest(t, http.MethodGet, filterURL, adminPAT, nil, nil)
	var filtered struct {
		Schemas      []string           `json:"schemas"`
		TotalResults int                `json:"totalResults"`
		StartIndex   int                `json:"startIndex"`
		ItemsPerPage int                `json:"itemsPerPage"`
		Resources    []scimUserResource `json:"Resources"`
	}
	if err := json.NewDecoder(filterRes.Body).Decode(&filtered); err != nil {
		t.Fatal(err)
	}
	filterRes.Body.Close()
	if filterRes.StatusCode != http.StatusOK || filtered.TotalResults != 1 || len(filtered.Resources) != 1 || filtered.Resources[0].ID != alice.ID {
		t.Fatalf("filtered list mismatch: status=%d resp=%+v", filterRes.StatusCode, filtered)
	}

	// 5. GET /scim/v2/Users pagination (startIndex=2, count=1) across 3 members
	pageURL := fmt.Sprintf("%s/scim/v2/Users?workspaceId=%d&startIndex=2&count=1", ts.URL, ws.ID)
	pageRes := scimRequest(t, http.MethodGet, pageURL, adminPAT, nil, nil)
	var paged struct {
		TotalResults int                `json:"totalResults"`
		StartIndex   int                `json:"startIndex"`
		ItemsPerPage int                `json:"itemsPerPage"`
		Resources    []scimUserResource `json:"Resources"`
	}
	if err := json.NewDecoder(pageRes.Body).Decode(&paged); err != nil {
		t.Fatal(err)
	}
	pageRes.Body.Close()
	if paged.TotalResults != 3 || paged.StartIndex != 2 || paged.ItemsPerPage != 1 || len(paged.Resources) != 1 {
		t.Fatalf("pagination mismatch: %+v", paged)
	}

	// 6. GET /scim/v2/Users/{uid} existing and non-existent
	getRes := scimRequest(t, http.MethodGet, ts.URL+"/scim/v2/Users/"+alice.ID+wsQuery, adminPAT, nil, nil)
	var fetched scimUserResource
	if err := json.NewDecoder(getRes.Body).Decode(&fetched); err != nil {
		t.Fatal(err)
	}
	getRes.Body.Close()
	if getRes.StatusCode != http.StatusOK || fetched.UserName != alice.UserName {
		t.Fatalf("GET user mismatch: status=%d user=%+v", getRes.StatusCode, fetched)
	}

	missingRes := scimRequest(t, http.MethodGet, ts.URL+"/scim/v2/Users/999999"+wsQuery, adminPAT, nil, nil)
	assertSCIMErrorResponse(t, missingRes, http.StatusNotFound, "")

	// 7. PATCH /scim/v2/Users/{uid} role upgrade (member -> admin)
	rolePatchRes := scimRequest(t, http.MethodPatch, ts.URL+"/scim/v2/Users/"+alice.ID+wsQuery, adminPAT, nil, map[string]any{
		"schemas": []string{scimSchemaPatchOp},
		"Operations": []map[string]any{
			{"op": "Replace", "path": "roles", "value": []map[string]string{{"value": "admin"}}},
		},
	})
	var patchedAlice scimUserResource
	if err := json.NewDecoder(rolePatchRes.Body).Decode(&patchedAlice); err != nil {
		t.Fatal(err)
	}
	rolePatchRes.Body.Close()
	if rolePatchRes.StatusCode != http.StatusOK || len(patchedAlice.Roles) != 1 || patchedAlice.Roles[0].Value != store.WorkspaceRoleAdmin {
		t.Fatalf("role patch failed: status=%d user=%+v", rolePatchRes.StatusCode, patchedAlice)
	}

	// 8. PATCH /scim/v2/Users/{owner} active=false and DELETE /scim/v2/Users/{owner} MUST be rejected (cannot remove workspace owner!)
	ownerDeact := scimRequest(t, http.MethodPatch, fmt.Sprintf("%s/scim/v2/Users/%d%s", ts.URL, owner.ID, wsQuery), adminPAT, nil, map[string]any{
		"schemas": []string{scimSchemaPatchOp},
		"Operations": []map[string]any{
			{"op": "replace", "value": map[string]any{"active": false}},
		},
	})
	assertSCIMErrorResponse(t, ownerDeact, http.StatusForbidden, "mutability")

	ownerDel := scimRequest(t, http.MethodDelete, fmt.Sprintf("%s/scim/v2/Users/%d%s", ts.URL, owner.ID, wsQuery), adminPAT, nil, nil)
	assertSCIMErrorResponse(t, ownerDel, http.StatusForbidden, "mutability")

	// 8b. Provisioning an existing Jiange user from another workspace links them into this workspace (201)
	extJar, _ := cookiejar.New(nil)
	extClient := &http.Client{Jar: extJar}
	extUser, _ := patTestRegister(t, ts, extClient, "existing-ext@example.test", "Existing External")
	linkRes := scimRequest(t, http.MethodPost, ts.URL+"/scim/v2/Users"+wsQuery, adminPAT, nil, map[string]any{
		"userName": extUser.Email,
	})
	var linked scimUserResource
	if err := json.NewDecoder(linkRes.Body).Decode(&linked); err != nil {
		t.Fatal(err)
	}
	linkRes.Body.Close()
	if linkRes.StatusCode != http.StatusCreated || linked.ID != strconv.FormatInt(extUser.ID, 10) {
		t.Fatalf("link existing user failed: status=%d user=%+v", linkRes.StatusCode, linked)
	}

	// 9. PATCH /scim/v2/Users/{alice} active=false (Okta pathless style) deprovisions from workspace
	deactRes := scimRequest(t, http.MethodPatch, ts.URL+"/scim/v2/Users/"+alice.ID+wsQuery, adminPAT, nil, map[string]any{
		"schemas": []string{scimSchemaPatchOp},
		"Operations": []map[string]any{
			{"op": "replace", "value": map[string]any{"active": false}},
		},
	})
	var deactAlice scimUserResource
	if err := json.NewDecoder(deactRes.Body).Decode(&deactAlice); err != nil {
		t.Fatal(err)
	}
	deactRes.Body.Close()
	if deactRes.StatusCode != http.StatusOK || deactAlice.Active {
		t.Fatalf("deactivate patch failed: status=%d user=%+v", deactRes.StatusCode, deactAlice)
	}

	// Alice is now removed from workspace -> GET returns 404
	afterDeact := scimRequest(t, http.MethodGet, ts.URL+"/scim/v2/Users/"+alice.ID+wsQuery, adminPAT, nil, nil)
	assertSCIMErrorResponse(t, afterDeact, http.StatusNotFound, "")

	// 10. DELETE /scim/v2/Users/{bob} deprovisions bob -> 204
	delRes := scimRequest(t, http.MethodDelete, ts.URL+"/scim/v2/Users/"+bob.ID+wsQuery, adminPAT, nil, nil)
	delRes.Body.Close()
	if delRes.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE bob status=%d want 204", delRes.StatusCode)
	}
	afterDel := scimRequest(t, http.MethodGet, ts.URL+"/scim/v2/Users/"+bob.ID+wsQuery, adminPAT, nil, nil)
	assertSCIMErrorResponse(t, afterDel, http.StatusNotFound, "")

	// 11. Verify audit log recorded scim.user_provision, scim.user_update, scim.user_deprovision
	auditRes := send(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs", ts.URL, ws.ID), nil)
	var auditPage store.AuditLogPage
	if err := json.NewDecoder(auditRes.Body).Decode(&auditPage); err != nil {
		t.Fatal(err)
	}
	auditRes.Body.Close()
	seen := map[string]bool{}
	for _, item := range auditPage.Items {
		seen[item.Action] = true
	}
	for _, want := range []string{"scim.user_provision", "scim.user_update", "scim.user_deprovision"} {
		if !seen[want] {
			t.Fatalf("missing expected audit event %q; saw actions=%v", want, seen)
		}
	}
}

func TestSCIMGroupLifecycle(t *testing.T) {
	st := store.NewMemory()
	fixedNow := time.Date(2026, 11, 24, 13, 0, 0, 0, time.UTC)
	_, ts, ownerClient := newSCIMTestServer(t, st, func() time.Time { return fixedNow })

	_, ws := patTestRegister(t, ts, ownerClient, "owner-grp@example.test", "Group Owner")
	adminPAT := scimCreatePAT(t, ts, ownerClient, "Azure AD SCIM", []string{"admin"})
	wsQuery := fmt.Sprintf("?workspaceId=%d", ws.ID)

	// Provision two users for group membership tests.
	provision := func(email, name string) scimUserResource {
		t.Helper()
		res := scimRequest(t, http.MethodPost, ts.URL+"/scim/v2/Users"+wsQuery, adminPAT, nil, map[string]any{
			"userName":    email,
			"displayName": name,
		})
		defer res.Body.Close()
		if res.StatusCode != http.StatusCreated {
			raw, _ := io.ReadAll(res.Body)
			t.Fatalf("provision %s status=%d body=%s", email, res.StatusCode, string(raw))
		}
		var u scimUserResource
		if err := json.NewDecoder(res.Body).Decode(&u); err != nil {
			t.Fatal(err)
		}
		return u
	}
	u1 := provision("eng1@example.test", "Eng One")
	u2 := provision("eng2@example.test", "Eng Two")

	// 1. POST /scim/v2/Groups with initial member u1
	createRes := scimRequest(t, http.MethodPost, ts.URL+"/scim/v2/Groups"+wsQuery, adminPAT, nil, map[string]any{
		"schemas":     []string{scimSchemaGroup},
		"displayName": "Engineering",
		"members": []map[string]string{
			{"value": u1.ID},
		},
	})
	if createRes.StatusCode != http.StatusCreated {
		raw, _ := io.ReadAll(createRes.Body)
		t.Fatalf("POST /scim/v2/Groups status=%d body=%s", createRes.StatusCode, string(raw))
	}
	var grp scimGroupResource
	if err := json.NewDecoder(createRes.Body).Decode(&grp); err != nil {
		t.Fatal(err)
	}
	createRes.Body.Close()
	if grp.ID == "" || grp.DisplayName != "Engineering" || len(grp.Members) != 1 || grp.Members[0].Value != u1.ID {
		t.Fatalf("unexpected created group: %+v", grp)
	}

	// 2. GET /scim/v2/Groups with displayName filter
	listRes := scimRequest(t, http.MethodGet,
		fmt.Sprintf("%s/scim/v2/Groups?workspaceId=%d&filter=%s", ts.URL, ws.ID, url.QueryEscape(`displayName eq "engineering"`)),
		adminPAT, nil, nil)
	var listBody struct {
		TotalResults int                 `json:"totalResults"`
		Resources    []scimGroupResource `json:"Resources"`
	}
	if err := json.NewDecoder(listRes.Body).Decode(&listBody); err != nil {
		t.Fatal(err)
	}
	listRes.Body.Close()
	if listRes.StatusCode != http.StatusOK || listBody.TotalResults != 1 || listBody.Resources[0].ID != grp.ID {
		t.Fatalf("GET /scim/v2/Groups filter mismatch: %+v", listBody)
	}

	// 3. PATCH /scim/v2/Groups/{gid}: rename + add u2 + remove u1 (RFC 7644 filter path)
	patchRes := scimRequest(t, http.MethodPatch, ts.URL+"/scim/v2/Groups/"+grp.ID+wsQuery, adminPAT, nil, map[string]any{
		"schemas": []string{scimSchemaPatchOp},
		"Operations": []map[string]any{
			{"op": "replace", "path": "displayName", "value": "Platform Engineering"},
			{"op": "add", "path": "members", "value": []map[string]string{{"value": u2.ID}}},
			{"op": "remove", "path": fmt.Sprintf(`members[value eq "%s"]`, u1.ID)},
		},
	})
	var patchedGrp scimGroupResource
	if err := json.NewDecoder(patchRes.Body).Decode(&patchedGrp); err != nil {
		t.Fatal(err)
	}
	patchRes.Body.Close()
	if patchRes.StatusCode != http.StatusOK || patchedGrp.DisplayName != "Platform Engineering" {
		t.Fatalf("PATCH group failed: status=%d grp=%+v", patchRes.StatusCode, patchedGrp)
	}
	if len(patchedGrp.Members) != 1 || patchedGrp.Members[0].Value != u2.ID {
		t.Fatalf("expected only u2 (%s) in group, got %+v", u2.ID, patchedGrp.Members)
	}

	// Verify u2's SCIM User resource shows group membership
	u2Res := scimRequest(t, http.MethodGet, ts.URL+"/scim/v2/Users/"+u2.ID+wsQuery, adminPAT, nil, nil)
	var u2Fetched scimUserResource
	if err := json.NewDecoder(u2Res.Body).Decode(&u2Fetched); err != nil {
		t.Fatal(err)
	}
	u2Res.Body.Close()
	if len(u2Fetched.Groups) != 1 || u2Fetched.Groups[0].Value != grp.ID || u2Fetched.Groups[0].Display != "Platform Engineering" {
		t.Fatalf("expected u2.Groups to contain Platform Engineering, got %+v", u2Fetched.Groups)
	}

	// 4. PATCH /scim/v2/Groups/{gid}: remove u2 via Azure AD value array
	remRes := scimRequest(t, http.MethodPatch, ts.URL+"/scim/v2/Groups/"+grp.ID+wsQuery, adminPAT, nil, map[string]any{
		"schemas": []string{scimSchemaPatchOp},
		"Operations": []map[string]any{
			{"op": "remove", "path": "members", "value": []map[string]string{{"value": u2.ID}}},
		},
	})
	var emptyGrp scimGroupResource
	if err := json.NewDecoder(remRes.Body).Decode(&emptyGrp); err != nil {
		t.Fatal(err)
	}
	remRes.Body.Close()
	if remRes.StatusCode != http.StatusOK || len(emptyGrp.Members) != 0 {
		t.Fatalf("expected empty members after Azure AD remove, got status=%d grp=%+v", remRes.StatusCode, emptyGrp)
	}

	// 5. DELETE /scim/v2/Groups/{gid} -> 204
	delRes := scimRequest(t, http.MethodDelete, ts.URL+"/scim/v2/Groups/"+grp.ID+wsQuery, adminPAT, nil, nil)
	delRes.Body.Close()
	if delRes.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE group status=%d want 204", delRes.StatusCode)
	}

	// Verify deleted group returns 404
	afterDel := scimRequest(t, http.MethodGet, ts.URL+"/scim/v2/Groups/"+grp.ID+wsQuery, adminPAT, nil, nil)
	assertSCIMErrorResponse(t, afterDel, http.StatusNotFound, "")
}
