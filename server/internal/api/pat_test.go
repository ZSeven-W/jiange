package api

import (
	"bytes"
	"context"
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

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newPATTestServer(t *testing.T, st store.Store, now func() time.Time) (*Server, *httptest.Server, *http.Client) {
	t.Helper()
	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
		Now:        now,
	}

	// Local test auth middleware mirroring how api.go integrates authenticateBearerPAT + patHasScope.
	requireUserWithPAT := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authz := strings.TrimSpace(r.Header.Get("Authorization"))
			if authz != "" {
				u, tok, ok := s.authenticateBearerPAT(r)
				if !ok {
					httpx.Error(w, http.StatusUnauthorized, "unauthorized", "invalid personal access token")
					return
				}
				if !patHasScope(tok.Scopes, r.Method) {
					httpx.Error(w, http.StatusForbidden, "insufficient_scope", "personal access token lacks required scope")
					return
				}
				ctx := context.WithValue(r.Context(), userKey, u)
				ctx = store.WithActor(ctx, store.Actor{UserID: u.ID, Kind: "user"})
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
			s.requireUser(next).ServeHTTP(w, r)
		})
	}

	mux := http.NewServeMux()
	mux.Handle("GET /api/me", requireUserWithPAT(http.HandlerFunc(s.me)))
	mux.Handle("GET /api/docs", requireUserWithPAT(http.HandlerFunc(s.listDocs)))
	mux.Handle("POST /api/docs", httpx.RequireJSON(requireUserWithPAT(http.HandlerFunc(s.createDoc))))
	mux.Handle("DELETE /api/docs/{id}", requireUserWithPAT(http.HandlerFunc(s.trashDoc)))
	mux.Handle("GET /api/me/tokens", requireUserWithPAT(http.HandlerFunc(s.listMyPATs)))
	mux.Handle("POST /api/me/tokens", httpx.RequireJSON(requireUserWithPAT(http.HandlerFunc(s.createMyPAT))))
	mux.Handle("DELETE /api/me/tokens/{tid}", requireUserWithPAT(http.HandlerFunc(s.revokeMyPAT)))
	mux.Handle("/", s.Handler())

	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	return s, ts, &http.Client{Jar: jar}
}

func patTestRegister(t *testing.T, ts *httptest.Server, client *http.Client, email, name string) (store.User, store.Workspace) {
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

func patBearerRequest(t *testing.T, method, url, bearer string, body any) *http.Response {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestPATHasScope(t *testing.T) {
	cases := []struct {
		scopes []string
		method string
		want   bool
	}{
		{[]string{"read"}, http.MethodGet, true},
		{[]string{"read"}, http.MethodHead, true},
		{[]string{"read"}, http.MethodOptions, true},
		{[]string{"read"}, http.MethodPost, false},
		{[]string{"read"}, http.MethodPut, false},
		{[]string{"read"}, http.MethodPatch, false},
		{[]string{"read"}, http.MethodDelete, false},
		{[]string{"write"}, http.MethodGet, true},
		{[]string{"write"}, http.MethodPost, true},
		{[]string{"write"}, http.MethodDelete, true},
		{[]string{"admin"}, http.MethodGet, true},
		{[]string{"admin"}, http.MethodPost, true},
		{[]string{"admin"}, http.MethodDelete, true},
		{[]string{"read", "write"}, http.MethodPatch, true},
		{nil, http.MethodGet, false},
		{[]string{}, http.MethodPost, false},
		{[]string{"unknown"}, http.MethodGet, false},
	}
	for _, tc := range cases {
		if got := patHasScope(tc.scopes, tc.method); got != tc.want {
			t.Errorf("patHasScope(%v, %q) = %v, want %v", tc.scopes, tc.method, got, tc.want)
		}
	}
}

func TestPATCRUDValidationAndAudit(t *testing.T) {
	st := store.NewMemory()
	fixedNow := time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)
	_, ts, aliceClient := newPATTestServer(t, st, func() time.Time { return fixedNow })
	bobJar, _ := cookiejar.New(nil)
	bobClient := &http.Client{Jar: bobJar}
	anonClient := &http.Client{}

	alice, aliceWS := patTestRegister(t, ts, aliceClient, "pat-api-alice@example.test", "Alice")
	patTestRegister(t, ts, bobClient, "pat-api-bob@example.test", "Bob")

	// Unauthenticated requests -> 401.
	for _, tc := range []struct {
		method string
		path   string
		body   any
	}{
		{http.MethodGet, "/api/me/tokens", nil},
		{http.MethodPost, "/api/me/tokens", map[string]any{"name": "Anon"}},
		{http.MethodDelete, "/api/me/tokens/1", nil},
	} {
		res := send(t, anonClient, tc.method, ts.URL+tc.path, tc.body)
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s %s unauth status = %d, want 401", tc.method, tc.path, res.StatusCode)
		}
	}

	// Validation errors -> 400.
	badPayloads := []map[string]any{
		{"name": ""},
		{"name": "   "},
		{"name": strings.Repeat("a", 81)},
		{"name": "Empty Scopes", "scopes": []string{}},
		{"name": "Invalid Scope", "scopes": []string{"read", "root"}},
		{"name": "Negative Expiry", "expiresInDays": -1},
		{"name": "Too Long Expiry", "expiresInDays": 366},
	}
	for i, payload := range badPayloads {
		res := post(t, aliceClient, ts.URL+"/api/me/tokens", payload)
		res.Body.Close()
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("bad payload #%d (%v): status = %d, want 400", i, payload, res.StatusCode)
		}
	}

	// Create PAT with default scopes and never-expires (expiresInDays omitted).
	res1 := post(t, aliceClient, ts.URL+"/api/me/tokens", map[string]any{
		"name": "Default Script",
	})
	if res1.StatusCode != http.StatusCreated {
		t.Fatalf("create default PAT status = %d, want 201", res1.StatusCode)
	}
	if cc := res1.Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", cc)
	}
	var created1 struct {
		Token    store.PersonalAccessToken `json:"token"`
		RawToken string                    `json:"rawToken"`
	}
	if err := json.NewDecoder(res1.Body).Decode(&created1); err != nil {
		t.Fatal(err)
	}
	res1.Body.Close()

	if !strings.HasPrefix(created1.RawToken, "jg_pat_") || len(created1.RawToken) != 50 {
		t.Fatalf("rawToken = %q (len=%d), want jg_pat_ + 43 base64url chars (len=50)", created1.RawToken, len(created1.RawToken))
	}
	if created1.Token.TokenPrefix != created1.RawToken[:14] {
		t.Fatalf("tokenPrefix = %q, want %q", created1.Token.TokenPrefix, created1.RawToken[:14])
	}
	if created1.Token.ExpiresAt != nil {
		t.Fatalf("default expiresAt = %v, want nil", created1.Token.ExpiresAt)
	}
	if len(created1.Token.Scopes) != 2 || created1.Token.Scopes[0] != "read" || created1.Token.Scopes[1] != "write" {
		t.Fatalf("default scopes = %v, want [read write]", created1.Token.Scopes)
	}

	// Create PAT with explicit scopes & 30-day expiry.
	res2 := post(t, aliceClient, ts.URL+"/api/me/tokens", map[string]any{
		"name":          "Readonly CI",
		"scopes":        []string{"read"},
		"expiresInDays": 30,
	})
	if res2.StatusCode != http.StatusCreated {
		t.Fatalf("create 30d PAT status = %d, want 201", res2.StatusCode)
	}
	var created2 struct {
		Token    store.PersonalAccessToken `json:"token"`
		RawToken string                    `json:"rawToken"`
	}
	if err := json.NewDecoder(res2.Body).Decode(&created2); err != nil {
		t.Fatal(err)
	}
	res2.Body.Close()
	wantExp := fixedNow.Add(30 * 24 * time.Hour)
	if created2.Token.ExpiresAt == nil || !created2.Token.ExpiresAt.Equal(wantExp) {
		t.Fatalf("expiresAt = %v, want %v", created2.Token.ExpiresAt, wantExp)
	}

	// List endpoint returns newest-first and never includes rawToken.
	listRes := send(t, aliceClient, http.MethodGet, ts.URL+"/api/me/tokens", nil)
	listRaw, _ := io.ReadAll(listRes.Body)
	listRes.Body.Close()
	if listRes.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d, want 200", listRes.StatusCode)
	}
	if strings.Contains(string(listRaw), created1.RawToken) || strings.Contains(string(listRaw), created2.RawToken) {
		t.Fatalf("list response leaked raw token: %s", string(listRaw))
	}
	var listed struct {
		Tokens []store.PersonalAccessToken `json:"tokens"`
	}
	if err := json.Unmarshal(listRaw, &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Tokens) != 2 || listed.Tokens[0].ID != created2.Token.ID || listed.Tokens[1].ID != created1.Token.ID {
		t.Fatalf("listed tokens = %+v", listed.Tokens)
	}

	// Bob sees 0 tokens and cannot revoke Alice's token.
	bobListRes := send(t, bobClient, http.MethodGet, ts.URL+"/api/me/tokens", nil)
	var bobListed struct {
		Tokens []store.PersonalAccessToken `json:"tokens"`
	}
	_ = json.NewDecoder(bobListRes.Body).Decode(&bobListed)
	bobListRes.Body.Close()
	if len(bobListed.Tokens) != 0 {
		t.Fatalf("bob saw %+v, want empty", bobListed.Tokens)
	}
	crossRevoke := send(t, bobClient, http.MethodDelete, fmt.Sprintf("%s/api/me/tokens/%d", ts.URL, created1.Token.ID), nil)
	crossRevoke.Body.Close()
	if crossRevoke.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-user revoke status = %d, want 404", crossRevoke.StatusCode)
	}

	// Invalid ID -> 400.
	badID := send(t, aliceClient, http.MethodDelete, ts.URL+"/api/me/tokens/not-a-number", nil)
	badID.Body.Close()
	if badID.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid id status = %d, want 400", badID.StatusCode)
	}

	// Alice revokes created1 -> 204.
	revRes := send(t, aliceClient, http.MethodDelete, fmt.Sprintf("%s/api/me/tokens/%d", ts.URL, created1.Token.ID), nil)
	revRes.Body.Close()
	if revRes.StatusCode != http.StatusNoContent {
		t.Fatalf("owner revoke status = %d, want 204", revRes.StatusCode)
	}

	// Verify audit logs recorded both pat.create and pat.revoke without leaking rawToken.
	auditRes := send(t, aliceClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs", ts.URL, aliceWS.ID), nil)
	var auditPage store.AuditLogPage
	if err := json.NewDecoder(auditRes.Body).Decode(&auditPage); err != nil {
		t.Fatal(err)
	}
	auditRes.Body.Close()
	var sawCreate, sawRevoke bool
	for _, entry := range auditPage.Items {
		if strings.Contains(string(entry.Detail), created1.RawToken) || strings.Contains(string(entry.Detail), created2.RawToken) {
			t.Fatalf("audit detail leaked rawToken: %s", string(entry.Detail))
		}
		if entry.Action == "pat.create" && entry.ResourceType == "user" && entry.ResourceID == alice.ID {
			sawCreate = true
		}
		if entry.Action == "pat.revoke" && entry.ResourceType == "user" && entry.ResourceID == alice.ID {
			sawRevoke = true
		}
	}
	if !sawCreate || !sawRevoke {
		t.Fatalf("missing expected audit entries: sawCreate=%v sawRevoke=%v items=%+v", sawCreate, sawRevoke, auditPage.Items)
	}
}

func TestPATBearerAuthenticationAndScopeEnforcement(t *testing.T) {
	st := store.NewMemory()
	currentNow := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	srv, ts, aliceClient := newPATTestServer(t, st, func() time.Time { return currentNow })
	alice, aliceWS := patTestRegister(t, ts, aliceClient, "pat-bearer@example.test", "Bearer Alice")

	createToken := func(name string, scopes []string, days *int) (store.PersonalAccessToken, string) {
		t.Helper()
		payload := map[string]any{"name": name, "scopes": scopes}
		if days != nil {
			payload["expiresInDays"] = *days
		}
		res := post(t, aliceClient, ts.URL+"/api/me/tokens", payload)
		defer res.Body.Close()
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("create %s: status %d", name, res.StatusCode)
		}
		var out struct {
			Token    store.PersonalAccessToken `json:"token"`
			RawToken string                    `json:"rawToken"`
		}
		if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out.Token, out.RawToken
	}

	days7 := 7
	roMeta, roRaw := createToken("ReadOnly PAT", []string{"read"}, &days7)
	rwMeta, rwRaw := createToken("Write PAT", []string{"write"}, nil)

	// Invalid / non-PAT Authorization headers fail authenticateBearerPAT directly.
	for _, hdr := range []string{"", "Basic dXNlcjpwYXNz", "Bearer not_a_pat", "Bearer jg_pat_", "Bearer jg_pat_nonexistent"} {
		req := httptest.NewRequest(http.MethodGet, "/api/me", nil)
		if hdr != "" {
			req.Header.Set("Authorization", hdr)
		}
		if _, _, ok := srv.authenticateBearerPAT(req); ok {
			t.Fatalf("expected header %q to fail authenticateBearerPAT", hdr)
		}
	}

	// Read-only PAT: GET /api/me succeeds (200) and updates lastUsedAt.
	currentNow = currentNow.Add(15 * time.Minute)
	meRes := patBearerRequest(t, http.MethodGet, ts.URL+"/api/me", roRaw, nil)
	var me meResponse
	if err := json.NewDecoder(meRes.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	meRes.Body.Close()
	if meRes.StatusCode != http.StatusOK || me.User.ID != alice.ID {
		t.Fatalf("GET /api/me with read PAT: status=%d user=%+v", meRes.StatusCode, me.User)
	}

	// Verify lastUsedAt updated for roMeta.
	listRes := send(t, aliceClient, http.MethodGet, ts.URL+"/api/me/tokens", nil)
	var listed struct {
		Tokens []store.PersonalAccessToken `json:"tokens"`
	}
	_ = json.NewDecoder(listRes.Body).Decode(&listed)
	listRes.Body.Close()
	foundRO := false
	for _, tok := range listed.Tokens {
		if tok.ID == roMeta.ID {
			foundRO = true
			if tok.LastUsedAt == nil || !tok.LastUsedAt.Equal(currentNow) {
				t.Fatalf("lastUsedAt = %v, want %v", tok.LastUsedAt, currentNow)
			}
		}
	}
	if !foundRO {
		t.Fatal("read-only token missing from list")
	}

	// Read-only PAT: GET /api/docs succeeds (200).
	docsRes := patBearerRequest(t, http.MethodGet, fmt.Sprintf("%s/api/docs?workspaceId=%d", ts.URL, aliceWS.ID), roRaw, nil)
	docsRes.Body.Close()
	if docsRes.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/docs with read PAT: status=%d, want 200", docsRes.StatusCode)
	}

	// Read-only PAT: POST /api/docs is blocked with 403 Forbidden!
	postBlocked := patBearerRequest(t, http.MethodPost, ts.URL+"/api/docs", roRaw, map[string]any{
		"workspaceId": aliceWS.ID,
		"title":       "Blocked by Read Scope",
	})
	postBlocked.Body.Close()
	if postBlocked.StatusCode != http.StatusForbidden {
		t.Fatalf("POST /api/docs with read-only PAT: status=%d, want 403", postBlocked.StatusCode)
	}

	// Write PAT: POST /api/docs succeeds (201), then read-only PAT DELETE is blocked (403), then write PAT DELETE succeeds (204).
	postOK := patBearerRequest(t, http.MethodPost, ts.URL+"/api/docs", rwRaw, map[string]any{
		"workspaceId": aliceWS.ID,
		"title":       "Created via Write PAT",
	})
	var doc struct {
		ID int64 `json:"id"`
	}
	if err := json.NewDecoder(postOK.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	postOK.Body.Close()
	if postOK.StatusCode != http.StatusCreated || doc.ID == 0 {
		t.Fatalf("POST /api/docs with write PAT: status=%d doc=%+v", postOK.StatusCode, doc)
	}

	delBlocked := patBearerRequest(t, http.MethodDelete, fmt.Sprintf("%s/api/docs/%d", ts.URL, doc.ID), roRaw, nil)
	delBlocked.Body.Close()
	if delBlocked.StatusCode != http.StatusForbidden {
		t.Fatalf("DELETE /api/docs with read-only PAT: status=%d, want 403", delBlocked.StatusCode)
	}

	delOK := patBearerRequest(t, http.MethodDelete, fmt.Sprintf("%s/api/docs/%d", ts.URL, doc.ID), rwRaw, nil)
	delOK.Body.Close()
	if delOK.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /api/docs with write PAT: status=%d, want 204", delOK.StatusCode)
	}

	// Revoking write PAT immediately rejects subsequent Bearer calls with 401.
	rev := send(t, aliceClient, http.MethodDelete, fmt.Sprintf("%s/api/me/tokens/%d", ts.URL, rwMeta.ID), nil)
	rev.Body.Close()
	if rev.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke write PAT status=%d", rev.StatusCode)
	}
	afterRevoke := patBearerRequest(t, http.MethodGet, ts.URL+"/api/me", rwRaw, nil)
	afterRevoke.Body.Close()
	if afterRevoke.StatusCode != http.StatusUnauthorized {
		t.Fatalf("revoked PAT status=%d, want 401", afterRevoke.StatusCode)
	}

	// Advancing clock past 7-day expiry rejects read-only PAT with 401.
	currentNow = currentNow.Add(8 * 24 * time.Hour)
	afterExpiry := patBearerRequest(t, http.MethodGet, ts.URL+"/api/me", roRaw, nil)
	afterExpiry.Body.Close()
	if afterExpiry.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expired PAT status=%d, want 401", afterExpiry.StatusCode)
	}
}

func TestPATQuotaLimitReturnsConflict(t *testing.T) {
	st := store.NewMemory()
	fixedNow := time.Date(2026, 11, 24, 15, 0, 0, 0, time.UTC)
	_, ts, client := newPATTestServer(t, st, func() time.Time { return fixedNow })
	patTestRegister(t, ts, client, "pat-quota@example.test", "Quota User")

	for i := 1; i <= store.MaxActivePATsPerUser; i++ {
		res := post(t, client, ts.URL+"/api/me/tokens", map[string]any{
			"name":   fmt.Sprintf("Token %d", i),
			"scopes": []string{"read"},
		})
		res.Body.Close()
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("token #%d status=%d, want 201", i, res.StatusCode)
		}
	}

	overflow := post(t, client, ts.URL+"/api/me/tokens", map[string]any{
		"name":   "Overflow Token",
		"scopes": []string{"read"},
	})
	overflow.Body.Close()
	if overflow.StatusCode != http.StatusConflict {
		t.Fatalf("51st token status=%d, want 409", overflow.StatusCode)
	}
}
