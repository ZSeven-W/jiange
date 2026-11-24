package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newMFATestServer(t *testing.T, st store.Store, configure func(*Server)) (*Server, *httptest.Server, *time.Time, *sync.Mutex) {
	t.Helper()
	var clockMu sync.Mutex
	now := time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)

	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
		Now: func() time.Time {
			clockMu.Lock()
			defer clockMu.Unlock()
			return now
		},
	}
	if configure != nil {
		configure(s)
	}

	// Local ServeMux wiring mirrors api.go + the 1-line maybeStartMFAChallenge hook in login.
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/register", s.register)
	mux.HandleFunc("POST /api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		var c credentials
		if !httpx.Decode(w, r, &c) {
			return
		}
		u, err := s.Store.UserByEmail(r.Context(), strings.TrimSpace(c.Email))
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			s.fail(w, r, err)
			return
		}
		ok := false
		if err == nil {
			ok, _ = auth.VerifyPassword(c.Password, u.PasswordHash)
		}
		if !ok {
			httpx.Error(w, http.StatusUnauthorized, "invalid_credentials", "wrong email or password")
			return
		}
		if s.maybeStartMFAChallenge(w, r, u) {
			return
		}
		if !s.startSession(w, r, u.ID) {
			return
		}
		ws, err := s.Store.Workspaces(r.Context(), u.ID)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		var auditWS int64
		if len(ws) > 0 {
			auditWS = ws[0].ID
		}
		s.recordAuthAudit(r, auditWS, u.ID, u.Name, u.Email, "auth.login", map[string]any{"method": "password"})
		httpx.JSON(w, http.StatusOK, meResponse{u, ws})
	})
	mux.HandleFunc("POST /api/auth/logout", s.logout)
	mux.HandleFunc("POST /api/auth/mfa/verify", s.verifyMFALogin)
	mux.Handle("GET /api/me", s.requireUser(http.HandlerFunc(s.me)))
	mux.Handle("GET /api/me/mfa", s.requireUser(http.HandlerFunc(s.getMyMFA)))
	mux.Handle("POST /api/me/mfa/setup", s.requireUser(http.HandlerFunc(s.setupMyMFA)))
	mux.Handle("POST /api/me/mfa/enable", s.requireUser(http.HandlerFunc(s.enableMyMFA)))
	mux.Handle("POST /api/me/mfa/disable", s.requireUser(http.HandlerFunc(s.disableMyMFA)))
	mux.Handle("GET /api/workspaces/{wsId}/security-policy", s.requireUser(http.HandlerFunc(s.getWorkspaceSecurityPolicy)))
	mux.Handle("PUT /api/workspaces/{wsId}/security-policy", s.requireUser(http.HandlerFunc(s.putWorkspaceSecurityPolicy)))
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
	return s, ts, &now, &clockMu
}

func mfaJSONRequest(t *testing.T, client *http.Client, method, url string, payload any) (*http.Response, []byte) {
	t.Helper()
	var body io.Reader
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatal(err)
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp, raw
}

func TestMFASealOpenSecretAAD(t *testing.T) {
	s := &Server{AISecret: []byte("0123456789abcdef0123456789abcdef")}
	key := s.mfaSecretKey()
	secret, err := auth.GenerateTOTPSecret()
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := sealMFASecret(key, 42, secret)
	if err != nil {
		t.Fatalf("sealMFASecret: %v", err)
	}
	opened, err := openMFASecret(key, 42, sealed)
	if err != nil || opened != secret {
		t.Fatalf("openMFASecret = (%q, %v), want %q", opened, err, secret)
	}
	// Wrong userID AAD must fail decryption.
	if _, err := openMFASecret(key, 99, sealed); err == nil {
		t.Fatal("expected AAD mismatch error when opening with another userID")
	}
	// Dev fallback key works when AISecret is unset.
	devServer := &Server{}
	devSealed, err := sealMFASecret(devServer.mfaSecretKey(), 7, secret)
	if err != nil {
		t.Fatalf("dev seal: %v", err)
	}
	devOpened, err := openMFASecret(devServer.mfaSecretKey(), 7, devSealed)
	if err != nil || devOpened != secret {
		t.Fatalf("dev open = (%q, %v), want %q", devOpened, err, secret)
	}
}

func TestMFAEndToEndFlow(t *testing.T) {
	st := store.NewMemory()
	s, ts, nowPtr, clockMu := newMFATestServer(t, st, func(srv *Server) {
		srv.AISecret = []byte("test-ai-secret-32-bytes-01234567")
	})

	getNow := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return *nowPtr
	}
	advance := func(d time.Duration) {
		clockMu.Lock()
		*nowPtr = nowPtr.Add(d)
		clockMu.Unlock()
	}

	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}

	// 1. Register user and verify initial MFA status is disabled.
	resp, raw := mfaJSONRequest(t, client, "POST", ts.URL+"/api/auth/register", map[string]any{
		"email":    "alice@example.com",
		"name":     "Alice",
		"password": "super-secret-password",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register status = %d, body = %s", resp.StatusCode, raw)
	}
	var regMe meResponse
	if err := json.Unmarshal(raw, &regMe); err != nil {
		t.Fatal(err)
	}

	resp, raw = mfaJSONRequest(t, client, "GET", ts.URL+"/api/me/mfa", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("getMyMFA status = %d, body = %s", resp.StatusCode, raw)
	}
	var stResp mfaStatusResponse
	if err := json.Unmarshal(raw, &stResp); err != nil {
		t.Fatal(err)
	}
	if stResp.Enabled || stResp.RecoveryCodesRemaining != 0 || stResp.EnabledAt != nil {
		t.Fatalf("unexpected initial MFA status: %+v", stResp)
	}

	// 2. Enabling before setup must return 400.
	resp, _ = mfaJSONRequest(t, client, "POST", ts.URL+"/api/me/mfa/enable", map[string]any{"code": "123456"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("enable before setup status = %d, want 400", resp.StatusCode)
	}

	// 3. Setup MFA returns secret + otpauth URI, still disabled until verified.
	resp, raw = mfaJSONRequest(t, client, "POST", ts.URL+"/api/me/mfa/setup", map[string]any{})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("setupMyMFA status = %d, body = %s", resp.StatusCode, raw)
	}
	var setupResp mfaSetupResponse
	if err := json.Unmarshal(raw, &setupResp); err != nil {
		t.Fatal(err)
	}
	if len(setupResp.Secret) != 32 || !strings.HasPrefix(setupResp.OtpAuthURI, "otpauth://totp/Jiange:alice@example.com?secret="+setupResp.Secret) {
		t.Fatalf("unexpected setup response: %+v", setupResp)
	}

	// Pending setup must NOT trigger MFA challenge on login yet.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/auth/login", nil)
	if s.maybeStartMFAChallenge(rec, req, regMe.User) {
		t.Fatal("maybeStartMFAChallenge should return false while MFA setup is still pending")
	}

	// 4. Enable with wrong code fails (400).
	resp, _ = mfaJSONRequest(t, client, "POST", ts.URL+"/api/me/mfa/enable", map[string]any{"code": "000000"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("enable with wrong code status = %d, want 400", resp.StatusCode)
	}

	// 5. Enable with valid TOTP succeeds and returns 8 one-time recovery codes.
	validCode, err := auth.TOTPCode(setupResp.Secret, getNow())
	if err != nil {
		t.Fatal(err)
	}
	resp, raw = mfaJSONRequest(t, client, "POST", ts.URL+"/api/me/mfa/enable", map[string]any{"code": validCode})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("enableMyMFA status = %d, body = %s", resp.StatusCode, raw)
	}
	var enableResp mfaEnableResponse
	if err := json.Unmarshal(raw, &enableResp); err != nil {
		t.Fatal(err)
	}
	if !enableResp.Enabled || len(enableResp.RecoveryCodes) != 8 || enableResp.RecoveryCodesRemaining != 8 || enableResp.EnabledAt == nil {
		t.Fatalf("unexpected enable response: %+v", enableResp)
	}

	// Re-calling setup while enabled returns 409.
	resp, _ = mfaJSONRequest(t, client, "POST", ts.URL+"/api/me/mfa/setup", map[string]any{})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("setup while enabled status = %d, want 409", resp.StatusCode)
	}

	// GET /api/me/mfa reflects enabled=true and 8 remaining recovery codes.
	resp, raw = mfaJSONRequest(t, client, "GET", ts.URL+"/api/me/mfa", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("getMyMFA after enable status = %d", resp.StatusCode)
	}
	if err := json.Unmarshal(raw, &stResp); err != nil {
		t.Fatal(err)
	}
	if !stResp.Enabled || stResp.RecoveryCodesRemaining != 8 || stResp.EnabledAt == nil {
		t.Fatalf("unexpected enabled MFA status: %+v", stResp)
	}

	// 6. Fresh unauthenticated client logs in -> gets mfaRequired challenge (NO session cookie!).
	loginJar, _ := cookiejar.New(nil)
	loginClient := &http.Client{Jar: loginJar}
	resp, raw = mfaJSONRequest(t, loginClient, "POST", ts.URL+"/api/auth/login", map[string]any{
		"email":    "alice@example.com",
		"password": "super-secret-password",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login status = %d, body = %s", resp.StatusCode, raw)
	}
	var challenge mfaChallengeResponse
	if err := json.Unmarshal(raw, &challenge); err != nil {
		t.Fatal(err)
	}
	if !challenge.MFARequired || challenge.MFAToken == "" || challenge.Email != "alice@example.com" {
		t.Fatalf("unexpected MFA challenge: %+v", challenge)
	}
	// Must NOT be logged in yet.
	resp, _ = mfaJSONRequest(t, loginClient, "GET", ts.URL+"/api/me", nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("GET /api/me before MFA verify = %d, want 401", resp.StatusCode)
	}

	// 7. Wrong code returns 401 WITHOUT immediately burning the challenge token, allowing retry.
	resp, _ = mfaJSONRequest(t, loginClient, "POST", ts.URL+"/api/auth/mfa/verify", map[string]any{
		"mfaToken": challenge.MFAToken,
		"code":     "999999",
	})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("verify with wrong code status = %d, want 401", resp.StatusCode)
	}

	// Retry with valid TOTP succeeds, issues session cookie, and returns meResponse.
	advance(30 * time.Second)
	code2, err := auth.TOTPCode(setupResp.Secret, getNow())
	if err != nil {
		t.Fatal(err)
	}
	resp, raw = mfaJSONRequest(t, loginClient, "POST", ts.URL+"/api/auth/mfa/verify", map[string]any{
		"mfaToken": challenge.MFAToken,
		"code":     code2,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("verifyMFALogin TOTP status = %d, body = %s", resp.StatusCode, raw)
	}
	var verifiedMe meResponse
	if err := json.Unmarshal(raw, &verifiedMe); err != nil {
		t.Fatal(err)
	}
	if verifiedMe.User.ID != regMe.User.ID || len(verifiedMe.Workspaces) != 1 {
		t.Fatalf("unexpected verified meResponse: %+v", verifiedMe)
	}
	// Session cookie is now active.
	resp, _ = mfaJSONRequest(t, loginClient, "GET", ts.URL+"/api/me", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/me after MFA verify = %d, want 200", resp.StatusCode)
	}

	// Replaying the consumed mfaToken must fail with 401.
	resp, _ = mfaJSONRequest(t, loginClient, "POST", ts.URL+"/api/auth/mfa/verify", map[string]any{
		"mfaToken": challenge.MFAToken,
		"code":     code2,
	})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("replayed mfaToken status = %d, want 401", resp.StatusCode)
	}

	// 8. Login using a one-time recovery code: works once, decrements remaining count, and cannot be reused.
	recoveryJar, _ := cookiejar.New(nil)
	recoveryClient := &http.Client{Jar: recoveryJar}
	resp, raw = mfaJSONRequest(t, recoveryClient, "POST", ts.URL+"/api/auth/login", map[string]any{
		"email":    "alice@example.com",
		"password": "super-secret-password",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("second login status = %d", resp.StatusCode)
	}
	var ch2 mfaChallengeResponse
	if err := json.Unmarshal(raw, &ch2); err != nil {
		t.Fatal(err)
	}
	usedRecovery := enableResp.RecoveryCodes[0]
	resp, raw = mfaJSONRequest(t, recoveryClient, "POST", ts.URL+"/api/auth/mfa/verify", map[string]any{
		"mfaToken": ch2.MFAToken,
		"code":     strings.ToLower(usedRecovery),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("verifyMFALogin recovery code status = %d, body = %s", resp.StatusCode, raw)
	}

	// Recovery code remaining count should now be 7.
	resp, raw = mfaJSONRequest(t, recoveryClient, "GET", ts.URL+"/api/me/mfa", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("getMyMFA after recovery = %d", resp.StatusCode)
	}
	if err := json.Unmarshal(raw, &stResp); err != nil {
		t.Fatal(err)
	}
	if stResp.RecoveryCodesRemaining != 7 {
		t.Fatalf("RecoveryCodesRemaining = %d, want 7", stResp.RecoveryCodesRemaining)
	}

	// Attempting to reuse the same recovery code on a new challenge must fail.
	resp, raw = mfaJSONRequest(t, &http.Client{}, "POST", ts.URL+"/api/auth/login", map[string]any{
		"email":    "alice@example.com",
		"password": "super-secret-password",
	})
	var ch3 mfaChallengeResponse
	if err := json.Unmarshal(raw, &ch3); err != nil {
		t.Fatal(err)
	}
	resp, _ = mfaJSONRequest(t, &http.Client{}, "POST", ts.URL+"/api/auth/mfa/verify", map[string]any{
		"mfaToken": ch3.MFAToken,
		"code":     usedRecovery,
	})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("reused recovery code status = %d, want 401", resp.StatusCode)
	}

	// 9. Expired challenge must fail with 401.
	advance(6 * time.Minute)
	freshCode, err := auth.TOTPCode(setupResp.Secret, getNow())
	if err != nil {
		t.Fatal(err)
	}
	resp, _ = mfaJSONRequest(t, &http.Client{}, "POST", ts.URL+"/api/auth/mfa/verify", map[string]any{
		"mfaToken": ch3.MFAToken,
		"code":     freshCode,
	})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expired challenge status = %d, want 401", resp.StatusCode)
	}

	// 10. Disable MFA requires valid password or valid TOTP/recovery code.
	resp, _ = mfaJSONRequest(t, client, "POST", ts.URL+"/api/me/mfa/disable", map[string]any{})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("disable with empty payload status = %d, want 400", resp.StatusCode)
	}
	resp, _ = mfaJSONRequest(t, client, "POST", ts.URL+"/api/me/mfa/disable", map[string]any{
		"password": "wrong-password",
	})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("disable with wrong password status = %d, want 401", resp.StatusCode)
	}
	resp, raw = mfaJSONRequest(t, client, "POST", ts.URL+"/api/me/mfa/disable", map[string]any{
		"password": "super-secret-password",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("disable with valid password status = %d, body = %s", resp.StatusCode, raw)
	}
	var disableResp mfaDisableResponse
	if err := json.Unmarshal(raw, &disableResp); err != nil {
		t.Fatal(err)
	}
	if disableResp.Enabled {
		t.Fatal("expected enabled=false after disable")
	}

	// 11. After disabling MFA, password login returns meResponse directly (no MFA challenge).
	postDisableJar, _ := cookiejar.New(nil)
	postDisableClient := &http.Client{Jar: postDisableJar}
	resp, raw = mfaJSONRequest(t, postDisableClient, "POST", ts.URL+"/api/auth/login", map[string]any{
		"email":    "alice@example.com",
		"password": "super-secret-password",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login after disable status = %d, body = %s", resp.StatusCode, raw)
	}
	if strings.Contains(string(raw), `"mfaRequired":true`) {
		t.Fatalf("unexpected mfaRequired after disable: %s", raw)
	}

	// 12. Verify audit events were recorded: auth.mfa_enable, auth.mfa_login, auth.mfa_disable.
	wsID := regMe.Workspaces[0].ID
	resp, raw = mfaJSONRequest(t, client, "GET", ts.URL+"/api/workspaces/1/audit-logs?limit=50", nil)
	if wsID != 1 {
		t.Fatalf("expected personal wsID 1, got %d", wsID)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("audit-logs status = %d, body = %s", resp.StatusCode, raw)
	}
	var page store.AuditLogPage
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatal(err)
	}
	actions := map[string]int{}
	for _, item := range page.Items {
		actions[item.Action]++
	}
	if actions["auth.mfa_enable"] != 1 {
		t.Errorf("expected 1 auth.mfa_enable audit log, got %d (all=%v)", actions["auth.mfa_enable"], actions)
	}
	if actions["auth.mfa_login"] != 2 {
		t.Errorf("expected 2 auth.mfa_login audit logs, got %d (all=%v)", actions["auth.mfa_login"], actions)
	}
	if actions["auth.mfa_disable"] != 1 {
		t.Errorf("expected 1 auth.mfa_disable audit log, got %d (all=%v)", actions["auth.mfa_disable"], actions)
	}
}

func TestMFADisableWithTOTPAndAttemptLimit(t *testing.T) {
	st := store.NewMemory()
	_, ts, nowPtr, clockMu := newMFATestServer(t, st, nil)

	getNow := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return *nowPtr
	}

	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}

	// Register + setup + enable MFA.
	resp, _ := mfaJSONRequest(t, client, "POST", ts.URL+"/api/auth/register", map[string]any{
		"email":    "bob@example.com",
		"name":     "Bob",
		"password": "bob-password-123",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register bob status = %d", resp.StatusCode)
	}
	_, raw := mfaJSONRequest(t, client, "POST", ts.URL+"/api/me/mfa/setup", map[string]any{})
	var setupResp mfaSetupResponse
	if err := json.Unmarshal(raw, &setupResp); err != nil {
		t.Fatal(err)
	}
	code, err := auth.TOTPCode(setupResp.Secret, getNow())
	if err != nil {
		t.Fatal(err)
	}
	resp, _ = mfaJSONRequest(t, client, "POST", ts.URL+"/api/me/mfa/enable", map[string]any{"code": code})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("enable bob MFA status = %d", resp.StatusCode)
	}

	// Trigger challenge and exceed 5 wrong attempts -> challenge gets burned even for valid code afterwards.
	_, raw = mfaJSONRequest(t, &http.Client{}, "POST", ts.URL+"/api/auth/login", map[string]any{
		"email":    "bob@example.com",
		"password": "bob-password-123",
	})
	var ch mfaChallengeResponse
	if err := json.Unmarshal(raw, &ch); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < mfaMaxVerifyAttempts; i++ {
		resp, _ = mfaJSONRequest(t, &http.Client{}, "POST", ts.URL+"/api/auth/mfa/verify", map[string]any{
			"mfaToken": ch.MFAToken,
			"code":     "000001",
		})
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("attempt %d status = %d, want 401", i+1, resp.StatusCode)
		}
	}
	// Now even the valid TOTP must be rejected because the challenge was revoked.
	resp, _ = mfaJSONRequest(t, &http.Client{}, "POST", ts.URL+"/api/auth/mfa/verify", map[string]any{
		"mfaToken": ch.MFAToken,
		"code":     code,
	})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("verify after max attempts status = %d, want 401", resp.StatusCode)
	}

	// Disable MFA using valid 6-digit TOTP code (instead of password).
	resp, raw = mfaJSONRequest(t, client, "POST", ts.URL+"/api/me/mfa/disable", map[string]any{
		"code": code,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("disable via TOTP status = %d, body = %s", resp.StatusCode, raw)
	}
}

func TestMFAWorkspacePolicyEnforcement(t *testing.T) {
	st := store.NewMemory()
	_, ts, nowPtr, clockMu := newMFATestServer(t, st, nil)
	getNow := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return *nowPtr
	}

	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}

	resp, raw := mfaJSONRequest(t, client, "POST", ts.URL+"/api/auth/register", map[string]any{
		"email":    "policy-owner@example.com",
		"name":     "Policy Owner",
		"password": "owner-password-123",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register = %d %s", resp.StatusCode, raw)
	}
	var regMe meResponse
	if err := json.Unmarshal(raw, &regMe); err != nil {
		t.Fatal(err)
	}

	// Initially: not required by policy, setup not required.
	resp, raw = mfaJSONRequest(t, client, "GET", ts.URL+"/api/me/mfa", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("getMyMFA initial = %d", resp.StatusCode)
	}
	var stResp mfaStatusResponse
	if err := json.Unmarshal(raw, &stResp); err != nil {
		t.Fatal(err)
	}
	if stResp.MFARequiredByPolicy || stResp.MFASetupRequired || len(stResp.MFARequiredWorkspaces) != 0 {
		t.Fatalf("unexpected initial policy status: %+v", stResp)
	}

	// Admin enables requireMfa on workspace 1 -> audit log records requireMfa=true.
	resp, raw = mfaJSONRequest(t, client, "PUT", ts.URL+"/api/workspaces/1/security-policy", map[string]any{
		"requireMfa": true,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("put policy = %d %s", resp.StatusCode, raw)
	}
	if !strings.Contains(string(raw), `"requireMfa":true`) {
		t.Fatalf("expected requireMfa:true in response, got %s", raw)
	}

	// Verify audit log contains requireMfa=true.
	resp, raw = mfaJSONRequest(t, client, "GET", ts.URL+"/api/workspaces/1/audit-logs?limit=10", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("audit-logs = %d %s", resp.StatusCode, raw)
	}
	if !strings.Contains(string(raw), `"requireMfa":true`) {
		t.Fatalf("expected requireMfa:true in audit log detail, got %s", raw)
	}

	// GET /api/me/mfa now reports mfaRequiredByPolicy=true, mfaSetupRequired=true, and workspace name.
	resp, raw = mfaJSONRequest(t, client, "GET", ts.URL+"/api/me/mfa", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("getMyMFA under policy = %d", resp.StatusCode)
	}
	if err := json.Unmarshal(raw, &stResp); err != nil {
		t.Fatal(err)
	}
	if !stResp.MFARequiredByPolicy || !stResp.MFASetupRequired || len(stResp.MFARequiredWorkspaces) != 1 || stResp.MFARequiredWorkspaces[0] != regMe.Workspaces[0].Name {
		t.Fatalf("unexpected MFA status under policy: %+v", stResp)
	}

	// Enable TOTP MFA -> mfaSetupRequired becomes false.
	_, raw = mfaJSONRequest(t, client, "POST", ts.URL+"/api/me/mfa/setup", map[string]any{})
	var setupResp mfaSetupResponse
	_ = json.Unmarshal(raw, &setupResp)
	code, err := auth.TOTPCode(setupResp.Secret, getNow())
	if err != nil {
		t.Fatal(err)
	}
	resp, raw = mfaJSONRequest(t, client, "POST", ts.URL+"/api/me/mfa/enable", map[string]any{"code": code})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("enable MFA = %d %s", resp.StatusCode, raw)
	}

	resp, raw = mfaJSONRequest(t, client, "GET", ts.URL+"/api/me/mfa", nil)
	_ = json.Unmarshal(raw, &stResp)
	if !stResp.Enabled || !stResp.MFARequiredByPolicy || stResp.MFASetupRequired {
		t.Fatalf("expected enabled=true, requiredByPolicy=true, setupRequired=false, got %+v", stResp)
	}

	// Disabling TOTP MFA while policy requires MFA and user has 0 passkeys -> 409 mfa_required_by_policy!
	resp, raw = mfaJSONRequest(t, client, "POST", ts.URL+"/api/me/mfa/disable", map[string]any{
		"password": "owner-password-123",
	})
	if resp.StatusCode != http.StatusConflict || !strings.Contains(string(raw), "mfa_required_by_policy") {
		t.Fatalf("disable MFA under policy (0 passkeys) = %d %s, want 409 mfa_required_by_policy", resp.StatusCode, raw)
	}

	// Once user has a registered passkey, disabling TOTP MFA is permitted!
	if _, err := st.CreateUserPasskey(context.Background(), store.UserPasskey{
		UserID:        regMe.User.ID,
		CredentialID:  []byte("fallback-passkey-cred"),
		PublicKeyCOSE: []byte{0xa1, 0x01, 0x02},
		Name:          "Touch ID",
	}); err != nil {
		t.Fatal(err)
	}
	resp, raw = mfaJSONRequest(t, client, "POST", ts.URL+"/api/me/mfa/disable", map[string]any{
		"password": "owner-password-123",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("disable MFA with passkey present = %d %s, want 200", resp.StatusCode, raw)
	}

	// After disabling TOTP while passkey exists, mfaSetupRequired remains false!
	resp, raw = mfaJSONRequest(t, client, "GET", ts.URL+"/api/me/mfa", nil)
	_ = json.Unmarshal(raw, &stResp)
	if stResp.Enabled || !stResp.MFARequiredByPolicy || stResp.MFASetupRequired {
		t.Fatalf("expected enabled=false, requiredByPolicy=true, setupRequired=false (passkey covers policy), got %+v", stResp)
	}
}
