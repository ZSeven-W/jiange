package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newSSOTestServer(t *testing.T, st store.Store, configure func(*Server)) (*Server, *httptest.Server) {
	t.Helper()
	s := &Server{
		Store:        st,
		Log:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL:   time.Hour,
		Iterations:   1000,
		SSOAllowHTTP: true,
	}
	if configure != nil {
		configure(s)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/register", s.register)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.Handle("GET /api/me", s.requireUser(http.HandlerFunc(s.me)))
	mux.Handle("GET /api/workspaces/{wsId}/org", s.requireUser(http.HandlerFunc(s.getWorkspaceOrg)))

	// Wire SSO endpoints locally so tests verify full API surface before api.go wiring.
	mux.HandleFunc("GET /api/auth/sso/providers", s.listPublicSSOProviders)
	mux.HandleFunc("GET /api/auth/sso/{slug}/start", s.startSSO)
	mux.HandleFunc("GET /api/auth/sso/{slug}/callback", s.callbackSSO)
	mux.Handle("GET /api/workspaces/{wsId}/sso/providers", s.requireUser(http.HandlerFunc(s.listWorkspaceSSOProviders)))
	mux.Handle("POST /api/workspaces/{wsId}/sso/providers", s.requireUser(http.HandlerFunc(s.createWorkspaceSSOProvider)))
	mux.Handle("PATCH /api/workspaces/{wsId}/sso/providers/{pid}", s.requireUser(http.HandlerFunc(s.updateWorkspaceSSOProvider)))
	mux.Handle("DELETE /api/workspaces/{wsId}/sso/providers/{pid}", s.requireUser(http.HandlerFunc(s.deleteWorkspaceSSOProvider)))
	mux.Handle("POST /api/workspaces/{wsId}/sso/discover", s.requireUser(http.HandlerFunc(s.discoverSSOProvider)))

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

func makeFakeJWT(claims map[string]any) string {
	hdr := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	bodyBytes, _ := json.Marshal(claims)
	body := base64.RawURLEncoding.EncodeToString(bodyBytes)
	sig := base64.RawURLEncoding.EncodeToString([]byte("fake-sig"))
	return hdr + "." + body + "." + sig
}

type fakeOIDCServer struct {
	server *httptest.Server

	mu                 sync.Mutex
	expectedClientID   string
	expectedSecret     string
	expectedChallenge  string
	nextSub            string
	nextEmail          string
	nextName           string
	nextNonce          string
	idTokenEmailInBody bool
	userinfoCalls      int
	tokenCalls         int
}

func newFakeOIDCServer(t *testing.T, clientID, clientSecret string) *fakeOIDCServer {
	t.Helper()
	f := &fakeOIDCServer{
		expectedClientID: clientID,
		expectedSecret:   clientSecret,
	}
	var ts *httptest.Server
	ts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"issuer":                 ts.URL,
				"authorization_endpoint": ts.URL + "/oauth2/authorize",
				"token_endpoint":         ts.URL + "/oauth2/token",
				"userinfo_endpoint":      ts.URL + "/oauth2/userinfo",
				"scopes_supported":       []string{"openid", "email", "profile", "offline_access"},
			})
		case "/oauth2/token":
			if err := r.ParseForm(); err != nil {
				http.Error(w, "bad form", http.StatusBadRequest)
				return
			}
			f.mu.Lock()
			f.tokenCalls++
			wantCID := f.expectedClientID
			wantSecret := f.expectedSecret
			wantChallenge := f.expectedChallenge
			sub := f.nextSub
			email := f.nextEmail
			name := f.nextName
			nonce := f.nextNonce
			includeEmail := f.idTokenEmailInBody
			f.mu.Unlock()

			if r.FormValue("grant_type") != "authorization_code" || r.FormValue("code") == "" {
				http.Error(w, "invalid grant", http.StatusBadRequest)
				return
			}
			if r.FormValue("client_id") != wantCID || r.FormValue("client_secret") != wantSecret {
				http.Error(w, "invalid client credentials", http.StatusUnauthorized)
				return
			}
			verifier := r.FormValue("code_verifier")
			if wantChallenge != "" {
				sum := sha256.Sum256([]byte(verifier))
				gotChallenge := base64.RawURLEncoding.EncodeToString(sum[:])
				if gotChallenge != wantChallenge {
					http.Error(w, "pkce mismatch", http.StatusBadRequest)
					return
				}
			}

			claims := map[string]any{
				"sub":   sub,
				"nonce": nonce,
				"exp":   time.Now().Add(time.Hour).Unix(),
			}
			if includeEmail {
				claims["email"] = email
				claims["name"] = name
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "tok-" + sub,
				"token_type":   "Bearer",
				"id_token":     makeFakeJWT(claims),
			})
		case "/oauth2/userinfo":
			f.mu.Lock()
			f.userinfoCalls++
			sub := f.nextSub
			email := f.nextEmail
			name := f.nextName
			f.mu.Unlock()

			if r.Header.Get("Authorization") != "Bearer tok-"+sub {
				http.Error(w, "bad token", http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sub":   sub,
				"email": email,
				"name":  name,
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(ts.Close)
	f.server = ts
	return f
}

func newSSOCookieClient(noRedirect bool) *http.Client {
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	if noRedirect {
		c.CheckRedirect = func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}
	}
	return c
}

func doJSONReq(t *testing.T, c *http.Client, method, target string, body any) *http.Response {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, target, rdr)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestSSOEndToEndOIDCFlowAndAdminCRUD(t *testing.T) {
	oidc := newFakeOIDCServer(t, "jiange-client", "super-secret-xyz9")
	mem := store.NewMemory()
	now := time.Now().Truncate(time.Second)

	_, ts := newSSOTestServer(t, mem, func(s *Server) {
		s.Now = func() time.Time { return now }
		s.SSOTransport = oidc.server.Client().Transport
		s.AISecret = AISecretFromEnv("prod-master-key")
	})

	ownerClient := newSSOCookieClient(false)
	memberClient := newSSOCookieClient(false)

	// Register workspace owner and a regular member.
	regRes := post(t, ownerClient, ts.URL+"/api/auth/register", map[string]string{
		"email": "owner@corp.example.com", "name": "Owner", "password": "password123",
	})
	var ownerMe meResponse
	_ = json.NewDecoder(regRes.Body).Decode(&ownerMe)
	wsID := ownerMe.Workspaces[0].ID

	regMem := post(t, memberClient, ts.URL+"/api/auth/register", map[string]string{
		"email": "regular@corp.example.com", "name": "Regular", "password": "password123",
	})
	var memMe meResponse
	_ = json.NewDecoder(regMem.Body).Decode(&memMe)
	if err := mem.AddWorkspaceMember(t.Context(), wsID, memMe.User.ID); err != nil {
		t.Fatal(err)
	}

	wsBase := fmt.Sprintf("%s/api/workspaces/%d/sso", ts.URL, wsID)

	// 1. Non-admin member gets 403 on list, discover, create.
	if res := doJSONReq(t, memberClient, http.MethodGet, wsBase+"/providers", nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("member list status = %d, want 403", res.StatusCode)
	}
	if res := doJSONReq(t, memberClient, http.MethodPost, wsBase+"/discover", map[string]string{"issuerUrl": oidc.server.URL}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("member discover status = %d, want 403", res.StatusCode)
	}
	if res := doJSONReq(t, memberClient, http.MethodPost, wsBase+"/providers", map[string]any{
		"slug": "nope", "name": "Nope", "authUrl": oidc.server.URL + "/a", "tokenUrl": oidc.server.URL + "/t", "clientId": "c",
	}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("member create status = %d, want 403", res.StatusCode)
	}

	// 2. Owner runs OIDC discovery.
	discRes := doJSONReq(t, ownerClient, http.MethodPost, wsBase+"/discover", map[string]string{
		"issuerUrl": oidc.server.URL,
	})
	if discRes.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(discRes.Body)
		t.Fatalf("discover status=%d body=%s", discRes.StatusCode, raw)
	}
	var disc struct {
		IssuerURL   string `json:"issuerUrl"`
		AuthURL     string `json:"authUrl"`
		TokenURL    string `json:"tokenUrl"`
		UserinfoURL string `json:"userinfoUrl"`
		Scopes      string `json:"scopes"`
	}
	_ = json.NewDecoder(discRes.Body).Decode(&disc)
	if disc.IssuerURL != oidc.server.URL || disc.AuthURL != oidc.server.URL+"/oauth2/authorize" ||
		disc.TokenURL != oidc.server.URL+"/oauth2/token" || disc.UserinfoURL != oidc.server.URL+"/oauth2/userinfo" ||
		disc.Scopes != "openid email profile" {
		t.Fatalf("unexpected discovery output: %+v", disc)
	}

	// 3. Owner creates SSO provider using discovered endpoints.
	createRes := doJSONReq(t, ownerClient, http.MethodPost, wsBase+"/providers", map[string]any{
		"slug":           "acme-oidc",
		"name":           "Acme SSO",
		"providerType":   "oidc",
		"enabled":        true,
		"issuerUrl":      disc.IssuerURL,
		"authUrl":        disc.AuthURL,
		"tokenUrl":       disc.TokenURL,
		"userinfoUrl":    disc.UserinfoURL,
		"clientId":       "jiange-client",
		"clientSecret":   "super-secret-xyz9",
		"scopes":         disc.Scopes,
		"autoCreateUser": true,
		"defaultRole":    "member",
		"allowedDomains": "corp.example.com",
	})
	rawCreated, _ := io.ReadAll(createRes.Body)
	if createRes.StatusCode != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", createRes.StatusCode, rawCreated)
	}
	if strings.Contains(string(rawCreated), "super-secret-xyz9") {
		t.Fatalf("create response leaked raw clientSecret: %s", rawCreated)
	}
	var created store.SSOProvider
	_ = json.Unmarshal(rawCreated, &created)
	if !created.HasClientSecret || created.SecretHint != "xyz9" || created.Slug != "acme-oidc" {
		t.Fatalf("unexpected created provider: %+v", created)
	}

	// Public provider list exposes ONLY enabled provider minimal fields.
	pubRes, err := http.Get(ts.URL + "/api/auth/sso/providers")
	if err != nil {
		t.Fatal(err)
	}
	pubRaw, _ := io.ReadAll(pubRes.Body)
	if pubRes.StatusCode != http.StatusOK || strings.Contains(string(pubRaw), "jiange-client") || strings.Contains(string(pubRaw), "xyz9") {
		t.Fatalf("public providers status=%d body=%s", pubRes.StatusCode, pubRaw)
	}
	var pubOut struct {
		Providers []store.PublicSSOProvider `json:"providers"`
	}
	_ = json.Unmarshal(pubRaw, &pubOut)
	if len(pubOut.Providers) != 1 || pubOut.Providers[0].Slug != "acme-oidc" || pubOut.Providers[0].Name != "Acme SSO" {
		t.Fatalf("unexpected public providers: %+v", pubOut.Providers)
	}

	// 4. End-to-end OIDC login for a brand new user (PKCE + id_token nonce + userinfo enrichment + JIT provision).
	ssoClient := newSSOCookieClient(true)
	startRes, err := ssoClient.Get(ts.URL + "/api/auth/sso/acme-oidc/start?mode=json&redirect=/%23/org")
	if err != nil {
		t.Fatal(err)
	}
	if startRes.StatusCode != http.StatusOK {
		t.Fatalf("start mode=json status=%d", startRes.StatusCode)
	}
	var startBody struct {
		AuthorizeURL string `json:"authorizeUrl"`
		State        string `json:"state"`
	}
	_ = json.NewDecoder(startRes.Body).Decode(&startBody)
	authU, err := url.Parse(startBody.AuthorizeURL)
	if err != nil {
		t.Fatal(err)
	}
	aq := authU.Query()
	if aq.Get("response_type") != "code" || aq.Get("client_id") != "jiange-client" ||
		aq.Get("code_challenge_method") != "S256" || aq.Get("code_challenge") == "" ||
		aq.Get("nonce") == "" || aq.Get("state") != startBody.State {
		t.Fatalf("missing OIDC authorize params: %s", startBody.AuthorizeURL)
	}
	if !strings.HasSuffix(aq.Get("redirect_uri"), "/api/auth/sso/acme-oidc/callback") {
		t.Fatalf("unexpected redirect_uri: %q", aq.Get("redirect_uri"))
	}

	oidc.mu.Lock()
	oidc.expectedChallenge = aq.Get("code_challenge")
	oidc.nextSub = "oidc-sub-alice"
	oidc.nextEmail = "alice@corp.example.com"
	oidc.nextName = "Alice Chen"
	oidc.nextNonce = aq.Get("nonce")
	oidc.idTokenEmailInBody = false // Force userinfo endpoint fetch to populate email & name.
	oidc.mu.Unlock()

	cbURL := fmt.Sprintf("%s/api/auth/sso/acme-oidc/callback?code=auth-code-1&state=%s", ts.URL, url.QueryEscape(startBody.State))
	cbRes, err := ssoClient.Get(cbURL)
	if err != nil {
		t.Fatal(err)
	}
	if cbRes.StatusCode != http.StatusFound || cbRes.Header.Get("Location") != "/#/org" {
		t.Fatalf("callback status=%d loc=%q", cbRes.StatusCode, cbRes.Header.Get("Location"))
	}
	oidc.mu.Lock()
	uiCalls := oidc.userinfoCalls
	oidc.mu.Unlock()
	if uiCalls != 1 {
		t.Fatalf("expected userinfo endpoint to be called once, got %d", uiCalls)
	}

	// Verify session cookie authenticates the JIT-provisioned user and they joined the workspace.
	meRes, err := ssoClient.Get(ts.URL + "/api/me")
	if err != nil {
		t.Fatal(err)
	}
	if meRes.StatusCode != http.StatusOK {
		t.Fatalf("me after SSO status=%d", meRes.StatusCode)
	}
	var aliceMe meResponse
	_ = json.NewDecoder(meRes.Body).Decode(&aliceMe)
	if aliceMe.User.Email != "alice@corp.example.com" || aliceMe.User.Name != "Alice Chen" || len(aliceMe.Workspaces) != 2 {
		t.Fatalf("unexpected JIT user /api/me: %+v", aliceMe)
	}

	// 5. State replay is rejected cleanly.
	replayClient := newSSOCookieClient(true)
	replayRes, err := replayClient.Get(cbURL)
	if err != nil {
		t.Fatal(err)
	}
	if replayRes.StatusCode != http.StatusFound || !strings.Contains(replayRes.Header.Get("Location"), "sso_error=invalid_state") {
		t.Fatalf("replay status=%d loc=%q", replayRes.StatusCode, replayRes.Header.Get("Location"))
	}

	// 6. Domain allowlist blocks disallowed email domain.
	start2, _ := replayClient.Get(ts.URL + "/api/auth/sso/acme-oidc/start?mode=json")
	var sb2 struct {
		AuthorizeURL string `json:"authorizeUrl"`
		State        string `json:"state"`
	}
	_ = json.NewDecoder(start2.Body).Decode(&sb2)
	u2, _ := url.Parse(sb2.AuthorizeURL)
	oidc.mu.Lock()
	oidc.expectedChallenge = u2.Query().Get("code_challenge")
	oidc.nextSub = "oidc-sub-eve"
	oidc.nextEmail = "eve@external.example.org"
	oidc.nextName = "Eve"
	oidc.nextNonce = u2.Query().Get("nonce")
	oidc.idTokenEmailInBody = true
	oidc.mu.Unlock()

	domRes, _ := replayClient.Get(fmt.Sprintf("%s/api/auth/sso/acme-oidc/callback?code=c2&state=%s", ts.URL, url.QueryEscape(sb2.State)))
	if domRes.StatusCode != http.StatusFound || !strings.Contains(domRes.Header.Get("Location"), "sso_error=domain_not_allowed") {
		t.Fatalf("domain block status=%d loc=%q", domRes.StatusCode, domRes.Header.Get("Location"))
	}

	// 7. Nonce mismatch in id_token is rejected.
	start3, _ := replayClient.Get(ts.URL + "/api/auth/sso/acme-oidc/start?mode=json")
	var sb3 struct {
		AuthorizeURL string `json:"authorizeUrl"`
		State        string `json:"state"`
	}
	_ = json.NewDecoder(start3.Body).Decode(&sb3)
	u3, _ := url.Parse(sb3.AuthorizeURL)
	oidc.mu.Lock()
	oidc.expectedChallenge = u3.Query().Get("code_challenge")
	oidc.nextSub = "oidc-sub-bob"
	oidc.nextEmail = "bob@corp.example.com"
	oidc.nextName = "Bob"
	oidc.nextNonce = "wrong-nonce"
	oidc.idTokenEmailInBody = true
	oidc.mu.Unlock()

	nonceRes, _ := replayClient.Get(fmt.Sprintf("%s/api/auth/sso/acme-oidc/callback?code=c3&state=%s", ts.URL, url.QueryEscape(sb3.State)))
	if nonceRes.StatusCode != http.StatusFound || !strings.Contains(nonceRes.Header.Get("Location"), "sso_error=nonce_mismatch") {
		t.Fatalf("nonce mismatch status=%d loc=%q", nonceRes.StatusCode, nonceRes.Header.Get("Location"))
	}

	// 8. IdP ?error=access_denied redirects cleanly.
	errRes, _ := replayClient.Get(ts.URL + "/api/auth/sso/acme-oidc/callback?error=access_denied")
	if errRes.StatusCode != http.StatusFound || errRes.Header.Get("Location") != "/#/?sso_error=access_denied" {
		t.Fatalf("idp error status=%d loc=%q", errRes.StatusCode, errRes.Header.Get("Location"))
	}

	// 9. Expired state rejected after 10 minutes.
	start4, _ := replayClient.Get(ts.URL + "/api/auth/sso/acme-oidc/start?mode=json")
	var sb4 struct {
		State string `json:"state"`
	}
	_ = json.NewDecoder(start4.Body).Decode(&sb4)
	now = now.Add(11 * time.Minute)
	expRes, _ := replayClient.Get(fmt.Sprintf("%s/api/auth/sso/acme-oidc/callback?code=c4&state=%s", ts.URL, url.QueryEscape(sb4.State)))
	if expRes.StatusCode != http.StatusFound || !strings.Contains(expRes.Header.Get("Location"), "sso_error=invalid_state") {
		t.Fatalf("expired state status=%d loc=%q", expRes.StatusCode, expRes.Header.Get("Location"))
	}

	// 10. Browser 302 redirect mode on /start + unsafe redirect sanitization + X-Forwarded-Proto.
	reqStart, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/auth/sso/acme-oidc/start?redirect=https://evil.example", nil)
	reqStart.Header.Set("X-Forwarded-Proto", "https")
	reqStart.Header.Set("X-Forwarded-Host", "docs.acme.test")
	redirRes, err := replayClient.Do(reqStart)
	if err != nil {
		t.Fatal(err)
	}
	if redirRes.StatusCode != http.StatusFound {
		t.Fatalf("browser /start status=%d, want 302", redirRes.StatusCode)
	}
	locU, _ := url.Parse(redirRes.Header.Get("Location"))
	if locU.Query().Get("redirect_uri") != "https://docs.acme.test/api/auth/sso/acme-oidc/callback" {
		t.Fatalf("forwarded redirect_uri = %q", locU.Query().Get("redirect_uri"))
	}

	// 11. Disable autoCreateUser via PATCH -> unknown user gets user_not_provisioned.
	patchRes := doJSONReq(t, ownerClient, http.MethodPatch, fmt.Sprintf("%s/providers/%d", wsBase, created.ID), map[string]any{
		"autoCreateUser": false,
	})
	if patchRes.StatusCode != http.StatusOK {
		t.Fatalf("patch status=%d", patchRes.StatusCode)
	}
	start5, _ := replayClient.Get(ts.URL + "/api/auth/sso/acme-oidc/start?mode=json")
	var sb5 struct {
		AuthorizeURL string `json:"authorizeUrl"`
		State        string `json:"state"`
	}
	_ = json.NewDecoder(start5.Body).Decode(&sb5)
	u5, _ := url.Parse(sb5.AuthorizeURL)
	oidc.mu.Lock()
	oidc.expectedChallenge = u5.Query().Get("code_challenge")
	oidc.nextSub = "oidc-sub-newguy"
	oidc.nextEmail = "newguy@corp.example.com"
	oidc.nextName = "New Guy"
	oidc.nextNonce = u5.Query().Get("nonce")
	oidc.idTokenEmailInBody = true
	oidc.mu.Unlock()
	noJitRes, _ := replayClient.Get(fmt.Sprintf("%s/api/auth/sso/acme-oidc/callback?code=c5&state=%s", ts.URL, url.QueryEscape(sb5.State)))
	if noJitRes.StatusCode != http.StatusFound || !strings.Contains(noJitRes.Header.Get("Location"), "sso_error=user_not_provisioned") {
		t.Fatalf("no-jit status=%d loc=%q", noJitRes.StatusCode, noJitRes.Header.Get("Location"))
	}

	// 12. Delete provider -> public list becomes empty.
	delRes := doJSONReq(t, ownerClient, http.MethodDelete, fmt.Sprintf("%s/providers/%d", wsBase, created.ID), nil)
	if delRes.StatusCode != http.StatusNoContent {
		t.Fatalf("delete status=%d, want 204", delRes.StatusCode)
	}
	pubRes2, _ := http.Get(ts.URL + "/api/auth/sso/providers")
	var pubOut2 struct {
		Providers []store.PublicSSOProvider `json:"providers"`
	}
	_ = json.NewDecoder(pubRes2.Body).Decode(&pubOut2)
	if len(pubOut2.Providers) != 0 {
		t.Fatalf("expected 0 public providers after delete, got %+v", pubOut2.Providers)
	}
}

func TestSSODevFallbackSecretAndSSRFBlock(t *testing.T) {
	oidc := newFakeOIDCServer(t, "dev-client", "dev-secret-5566")
	mem := store.NewMemory()

	// Note: AISecret is nil (dev fallback key) and SSOTransport is nil (real SSRF dialer active).
	_, ts := newSSOTestServer(t, mem, func(s *Server) {
		s.AISecret = nil
		s.SSOTransport = nil
		s.SSOAllowHTTP = true
	})

	ownerClient := newSSOCookieClient(false)
	regRes := post(t, ownerClient, ts.URL+"/api/auth/register", map[string]string{
		"email": "dev@example.com", "name": "Dev", "password": "password123",
	})
	var me meResponse
	_ = json.NewDecoder(regRes.Body).Decode(&me)
	wsBase := fmt.Sprintf("%s/api/workspaces/%d/sso", ts.URL, me.Workspaces[0].ID)

	// Saving a provider works cleanly without AISecret using deterministic dev key.
	createRes := doJSONReq(t, ownerClient, http.MethodPost, wsBase+"/providers", map[string]any{
		"slug":         "dev-oidc",
		"name":         "Dev OIDC",
		"providerType": "oidc",
		"authUrl":      "https://idp.example.com/authorize",
		"tokenUrl":     "https://idp.example.com/token",
		"clientId":     "dev-client",
		"clientSecret": "dev-secret-5566",
	})
	if createRes.StatusCode != http.StatusCreated {
		raw, _ := io.ReadAll(createRes.Body)
		t.Fatalf("dev create status=%d body=%s", createRes.StatusCode, raw)
	}
	saved, err := mem.GetSSOProviderBySlug(t.Context(), "dev-oidc")
	if err != nil || bytes.Contains(saved.ClientSecretEnc, []byte("dev-secret-5566")) {
		t.Fatalf("secret not sealed properly: %+v err=%v", saved, err)
	}

	// SSRF protection blocks discovery against loopback 127.0.0.1 when SSOTransport is nil.
	discRes := doJSONReq(t, ownerClient, http.MethodPost, wsBase+"/discover", map[string]string{
		"issuerUrl": oidc.server.URL,
	})
	if discRes.StatusCode != http.StatusBadRequest {
		raw, _ := io.ReadAll(discRes.Body)
		t.Fatalf("expected SSRF 400 on loopback, got %d body=%s", discRes.StatusCode, raw)
	}
}
