package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newAccountSecurityTestServer(t *testing.T, st store.Store, configure func(*Server)) (*Server, *httptest.Server, *time.Time, *sync.Mutex) {
	t.Helper()
	var clockMu sync.Mutex
	now := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)

	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: 2 * time.Hour,
		Iterations: 1000,
		AISecret:   AISecretFromEnv("acct-sec-test-secret"),
		Now: func() time.Time {
			clockMu.Lock()
			defer clockMu.Unlock()
			return now
		},
	}
	if configure != nil {
		configure(s)
	}

	// Local ServeMux wiring mirrors the hooks coordinator will wire into api.go.
	requireUserWithTouch := func(next http.Handler) http.Handler {
		return s.requireUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if h := currentSessionTokenHash(r); len(h) > 0 {
				s.touchSessionMeta(r, h)
			}
			next.ServeHTTP(w, r)
		}))
	}
	recordOnSetCookie := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			next(w, r)
			for _, c := range w.Header().Values("Set-Cookie") {
				if strings.HasPrefix(c, CookieName+"=") {
					val := strings.TrimPrefix(c, CookieName+"=")
					if semi := strings.IndexByte(val, ';'); semi >= 0 {
						val = val[:semi]
					}
					if val != "" {
						s.recordSessionMeta(r, auth.HashToken(val))
					}
				}
			}
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/register", recordOnSetCookie(s.register))
	mux.HandleFunc("POST /api/auth/login", recordOnSetCookie(s.login))
	mux.HandleFunc("POST /api/auth/logout", s.logout)
	mux.HandleFunc("POST /api/auth/password-reset/request", s.requestPasswordReset)
	mux.HandleFunc("POST /api/auth/password-reset/confirm", s.confirmPasswordReset)
	mux.Handle("GET /api/me", requireUserWithTouch(http.HandlerFunc(s.me)))
	mux.Handle("POST /api/me/password", requireUserWithTouch(http.HandlerFunc(s.changePassword)))
	mux.Handle("GET /api/me/sessions", requireUserWithTouch(http.HandlerFunc(s.listMySessions)))
	mux.Handle("DELETE /api/me/sessions/{sid}", requireUserWithTouch(http.HandlerFunc(s.revokeMySession)))
	mux.Handle("POST /api/me/sessions/revoke-others", requireUserWithTouch(http.HandlerFunc(s.revokeOtherMySessions)))
	mux.Handle("POST /api/workspaces/{wsId}/notification-channels", requireUserWithTouch(http.HandlerFunc(s.createNotificationChannel)))

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

func acctJSONReq(t *testing.T, client *http.Client, method, rawURL string, payload any, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	var body io.Reader
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, rawURL, body)
	if err != nil {
		t.Fatal(err)
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res, raw
}

func newAcctSecCookieClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Jar: jar}
}

func TestAccountSecurityChangePasswordAndSessions(t *testing.T) {
	st := store.NewMemory()
	_, ts, nowPtr, clockMu := newAccountSecurityTestServer(t, st, nil)

	dev1 := newAcctSecCookieClient(t)
	dev2 := newAcctSecCookieClient(t)
	dev3 := newAcctSecCookieClient(t)
	otherUser := newAcctSecCookieClient(t)

	// Register alice on device 1.
	res, raw := acctJSONReq(t, dev1, http.MethodPost, ts.URL+"/api/auth/register", map[string]string{
		"email": "alice-sec@example.test", "name": "Alice", "password": "OldPassword123!",
	}, map[string]string{
		"User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/128.0",
		"X-Forwarded-For": "203.0.113.11",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register alice = %d %s", res.StatusCode, raw)
	}
	var aliceMe meResponse
	_ = json.Unmarshal(raw, &aliceMe)

	// Register bob (separate user).
	res, raw = acctJSONReq(t, otherUser, http.MethodPost, ts.URL+"/api/auth/register", map[string]string{
		"email": "bob-sec@example.test", "name": "Bob", "password": "BobPassword123!",
	}, map[string]string{"User-Agent": "Firefox/130.0", "X-Forwarded-For": "198.51.100.99"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register bob = %d %s", res.StatusCode, raw)
	}

	// Login alice on device 2 and device 3 at later timestamps.
	clockMu.Lock()
	*nowPtr = nowPtr.Add(2 * time.Minute)
	clockMu.Unlock()
	res, raw = acctJSONReq(t, dev2, http.MethodPost, ts.URL+"/api/auth/login", map[string]string{
		"email": "alice-sec@example.test", "password": "OldPassword123!",
	}, map[string]string{
		"User-Agent":      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1",
		"X-Forwarded-For": "198.51.100.22",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("login dev2 = %d %s", res.StatusCode, raw)
	}

	clockMu.Lock()
	*nowPtr = nowPtr.Add(2 * time.Minute)
	clockMu.Unlock()
	res, raw = acctJSONReq(t, dev3, http.MethodPost, ts.URL+"/api/auth/login", map[string]string{
		"email": "alice-sec@example.test", "password": "OldPassword123!",
	}, map[string]string{
		"User-Agent":      "Mozilla/5.0 (Windows NT 10.0) Edg/128.0",
		"X-Forwarded-For": "192.0.2.33",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("login dev3 = %d %s", res.StatusCode, raw)
	}

	// List sessions from dev1 -> should see 3 sessions with dev1 marked current=true and metadata recorded.
	res, raw = acctJSONReq(t, dev1, http.MethodGet, ts.URL+"/api/me/sessions", nil, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("list sessions = %d %s", res.StatusCode, raw)
	}
	var listResp struct {
		Sessions []store.UserSession `json:"sessions"`
	}
	if err := json.Unmarshal(raw, &listResp); err != nil {
		t.Fatalf("decode sessions: %v", err)
	}
	if len(listResp.Sessions) != 3 {
		t.Fatalf("expected 3 sessions, got %d: %+v", len(listResp.Sessions), listResp.Sessions)
	}
	var currentCount int
	var dev2SessionID int64
	for _, sess := range listResp.Sessions {
		if sess.Current {
			currentCount++
			if sess.IPAddress != "203.0.113.11" || !strings.Contains(sess.UserAgent, "Chrome/128.0") {
				t.Fatalf("unexpected current session metadata: %+v", sess)
			}
		}
		if sess.IPAddress == "198.51.100.22" {
			dev2SessionID = sess.ID
		}
	}
	if currentCount != 1 || dev2SessionID == 0 {
		t.Fatalf("currentCount=%d dev2SessionID=%d sessions=%+v", currentCount, dev2SessionID, listResp.Sessions)
	}

	// Bob cannot revoke alice's session.
	res, _ = acctJSONReq(t, otherUser, http.MethodDelete, ts.URL+"/api/me/sessions/"+strconv.FormatInt(dev2SessionID, 10), nil, nil)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-user session revoke = %d, want 404", res.StatusCode)
	}

	// Alice revokes dev2 from dev1.
	res, raw = acctJSONReq(t, dev1, http.MethodDelete, ts.URL+"/api/me/sessions/"+strconv.FormatInt(dev2SessionID, 10), nil, nil)
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke dev2 = %d %s, want 204", res.StatusCode, raw)
	}
	// dev2 is now immediately unauthenticated.
	res, _ = acctJSONReq(t, dev2, http.MethodGet, ts.URL+"/api/me", nil, nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("revoked dev2 /api/me = %d, want 401", res.StatusCode)
	}

	// Change password rejects wrong current password and weak new password.
	res, _ = acctJSONReq(t, dev1, http.MethodPost, ts.URL+"/api/me/password", map[string]any{
		"currentPassword": "WrongPassword!",
		"newPassword":     "NewStrongPass456!",
	}, nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong current password = %d, want 401", res.StatusCode)
	}
	res, _ = acctJSONReq(t, dev1, http.MethodPost, ts.URL+"/api/me/password", map[string]any{
		"currentPassword": "OldPassword123!",
		"newPassword":     "short",
	}, nil)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("weak new password = %d, want 400", res.StatusCode)
	}

	// Change password succeeds with default revokeOtherSessions=true -> dev3 revoked, dev1 stays valid.
	res, raw = acctJSONReq(t, dev1, http.MethodPost, ts.URL+"/api/me/password", map[string]any{
		"currentPassword": "OldPassword123!",
		"newPassword":     "NewStrongPass456!",
	}, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("change password = %d %s, want 200", res.StatusCode, raw)
	}
	var changeResp struct {
		OK              bool  `json:"ok"`
		RevokedSessions int64 `json:"revokedSessions"`
	}
	_ = json.Unmarshal(raw, &changeResp)
	if !changeResp.OK || changeResp.RevokedSessions != 1 {
		t.Fatalf("unexpected changePassword response: %+v", changeResp)
	}

	// dev1 stays logged in, dev3 is revoked.
	res, _ = acctJSONReq(t, dev1, http.MethodGet, ts.URL+"/api/me", nil, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("dev1 after password change = %d, want 200", res.StatusCode)
	}
	res, _ = acctJSONReq(t, dev3, http.MethodGet, ts.URL+"/api/me", nil, nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("dev3 after password change = %d, want 401", res.StatusCode)
	}

	// Login with old password fails; login with new password succeeds.
	dev4 := newAcctSecCookieClient(t)
	res, _ = acctJSONReq(t, dev4, http.MethodPost, ts.URL+"/api/auth/login", map[string]string{
		"email": "alice-sec@example.test", "password": "OldPassword123!",
	}, nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("login with old password = %d, want 401", res.StatusCode)
	}
	res, _ = acctJSONReq(t, dev4, http.MethodPost, ts.URL+"/api/auth/login", map[string]string{
		"email": "alice-sec@example.test", "password": "NewStrongPass456!",
	}, map[string]string{"User-Agent": "Chrome/130.0", "X-Forwarded-For": "203.0.113.44"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("login with new password = %d, want 200", res.StatusCode)
	}

	// Revoke all other sessions from dev4 -> dev1 is revoked, dev4 stays alive.
	res, raw = acctJSONReq(t, dev4, http.MethodPost, ts.URL+"/api/me/sessions/revoke-others", map[string]any{}, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("revoke-others = %d %s", res.StatusCode, raw)
	}
	var revokeOthersResp struct {
		Revoked int64 `json:"revoked"`
	}
	_ = json.Unmarshal(raw, &revokeOthersResp)
	if revokeOthersResp.Revoked != 1 {
		t.Fatalf("expected 1 revoked other session, got %d", revokeOthersResp.Revoked)
	}
	res, _ = acctJSONReq(t, dev1, http.MethodGet, ts.URL+"/api/me", nil, nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("dev1 after revoke-others = %d, want 401", res.StatusCode)
	}
	res, _ = acctJSONReq(t, dev4, http.MethodGet, ts.URL+"/api/me", nil, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("dev4 after revoke-others = %d, want 200", res.StatusCode)
	}

	// Verify audit logs recorded password change & session revocations.
	guard := store.RestoreGuard{UserID: aliceMe.User.ID, SessionHash: []byte("audit-verify"), Now: func() time.Time { return *nowPtr }}
	_ = st.CreateSession(context.Background(), guard.SessionHash, aliceMe.User.ID, nowPtr.Add(time.Hour))
	auditPage, err := st.ListAuditLogsGuarded(context.Background(), guard, aliceMe.Workspaces[0].ID, store.AuditLogFilter{WorkspaceID: aliceMe.Workspaces[0].ID})
	if err != nil {
		t.Fatalf("ListAuditLogsGuarded: %v", err)
	}
	seenActions := map[string]bool{}
	for _, item := range auditPage.Items {
		seenActions[item.Action] = true
	}
	for _, want := range []string{"auth.session_revoked", "auth.password_changed", "auth.sessions_revoked_others"} {
		if !seenActions[want] {
			t.Fatalf("missing expected audit action %q in %+v", want, seenActions)
		}
	}
}

func TestAccountSecurityPasswordResetFlowAndSMTP(t *testing.T) {
	st := store.NewMemory()
	smtpAddr, transcript := startFakeSMTPServer(t)
	smtpHost, smtpPortStr, _ := net.SplitHostPort(smtpAddr)
	smtpPort, _ := strconv.Atoi(smtpPortStr)

	setNotifChannelSMTPDialer(func(ctx context.Context, addr string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, "tcp", smtpAddr)
	})
	t.Cleanup(func() { setNotifChannelSMTPDialer(nil) })

	var deliveredMu sync.Mutex
	var deliveredEmail, deliveredToken, deliveredURL string

	srv, ts, nowPtr, clockMu := newAccountSecurityTestServer(t, st, func(s *Server) {
		s.WebhookAllowHTTP = true
	})
	srv.setPasswordResetDeliverForTest(func(email, token, resetURL string) {
		deliveredMu.Lock()
		deliveredEmail = email
		deliveredToken = token
		deliveredURL = resetURL
		deliveredMu.Unlock()
	})

	owner := newAcctSecCookieClient(t)
	res, raw := acctJSONReq(t, owner, http.MethodPost, ts.URL+"/api/auth/register", map[string]string{
		"email": "reset-user@example.test", "name": "Reset Alice", "password": "InitialPassword1!",
	}, nil)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register = %d %s", res.StatusCode, raw)
	}
	var ownerMe meResponse
	_ = json.Unmarshal(raw, &ownerMe)
	wsID := ownerMe.Workspaces[0].ID

	// Configure an enabled SMTP notification channel on Alice's workspace whose default "to" is another team address.
	useTLS := false
	res, raw = acctJSONReq(t, owner, http.MethodPost, ts.URL+"/api/workspaces/"+strconv.FormatInt(wsID, 10)+"/notification-channels", map[string]any{
		"name": "Workspace SMTP",
		"kind": "smtp",
		"config": map[string]any{
			"host":   smtpHost,
			"port":   smtpPort,
			"from":   "noreply@jiange.test",
			"to":     []string{"team-alerts@jiange.test"},
			"useTLS": useTLS,
		},
		"events":  []string{"mention"},
		"enabled": true,
	}, nil)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create SMTP channel = %d %s", res.StatusCode, raw)
	}

	anon := newAcctSecCookieClient(t)

	// Unknown email must return identical 200 response (no user enumeration) and deliver nothing.
	resUnknown, rawUnknown := acctJSONReq(t, anon, http.MethodPost, ts.URL+"/api/auth/password-reset/request", map[string]string{
		"email": "nobody@example.test",
	}, map[string]string{"X-Forwarded-For": "203.0.113.50"})
	if resUnknown.StatusCode != http.StatusOK {
		t.Fatalf("unknown email reset request = %d %s", resUnknown.StatusCode, rawUnknown)
	}

	// Known email returns identical 200 response and sends SMTP reset email ONLY to reset-user@example.test.
	resKnown, rawKnown := acctJSONReq(t, anon, http.MethodPost, ts.URL+"/api/auth/password-reset/request", map[string]string{
		"email": "reset-user@example.test",
	}, map[string]string{"X-Forwarded-For": "203.0.113.51"})
	if resKnown.StatusCode != http.StatusOK {
		t.Fatalf("known email reset request = %d %s", resKnown.StatusCode, rawKnown)
	}
	if string(rawUnknown) != string(rawKnown) {
		t.Fatalf("enumeration leak: unknown=%s known=%s", rawUnknown, rawKnown)
	}

	deliveredMu.Lock()
	gotEmail, gotToken, gotURL := deliveredEmail, deliveredToken, deliveredURL
	deliveredMu.Unlock()
	if gotEmail != "reset-user@example.test" || gotToken == "" || !strings.Contains(gotURL, "/#/login?reset_token=") {
		t.Fatalf("unexpected delivery: email=%q token=%q url=%q", gotEmail, gotToken, gotURL)
	}

	// Verify SMTP transcript delivered ONLY to requesting user (NOT team-alerts@jiange.test!) and body contains token.
	transcript.mu.Lock()
	rcpts := append([]string(nil), transcript.rcptTo...)
	smtpData := transcript.data
	transcript.mu.Unlock()
	if len(rcpts) != 1 || !strings.Contains(strings.ToLower(rcpts[0]), "reset-user@example.test") {
		t.Fatalf("SMTP recipients must strictly be requesting user, got %+v", rcpts)
	}
	// Decode base64 MIME body from DATA section.
	parts := strings.SplitN(smtpData, "\r\n\r\n", 2)
	if len(parts) != 2 {
		t.Fatalf("unexpected SMTP MIME data: %q", smtpData)
	}
	decodedBody, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(parts[1], "\r\n", ""))
	if err != nil {
		t.Fatalf("decode base64 SMTP body: %v", err)
	}
	if !strings.Contains(string(decodedBody), gotToken) {
		t.Fatalf("SMTP body did not contain reset token: %s", string(decodedBody))
	}

	// Confirm with invalid token returns 400.
	res, _ = acctJSONReq(t, anon, http.MethodPost, ts.URL+"/api/auth/password-reset/confirm", map[string]string{
		"token":       "bad-token",
		"newPassword": "ResetPassword999!",
	}, nil)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid reset token = %d, want 400", res.StatusCode)
	}

	// Confirm with valid token updates password and revokes ALL existing sessions (including owner's active session).
	res, raw = acctJSONReq(t, anon, http.MethodPost, ts.URL+"/api/auth/password-reset/confirm", map[string]string{
		"token":       gotToken,
		"newPassword": "ResetPassword999!",
	}, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("confirm password reset = %d %s", res.StatusCode, raw)
	}

	// Token replay must fail with 400.
	res, _ = acctJSONReq(t, anon, http.MethodPost, ts.URL+"/api/auth/password-reset/confirm", map[string]string{
		"token":       gotToken,
		"newPassword": "AnotherPassword999!",
	}, nil)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("replayed reset token = %d, want 400", res.StatusCode)
	}

	// Prior owner session must be invalidated immediately.
	res, _ = acctJSONReq(t, owner, http.MethodGet, ts.URL+"/api/me", nil, nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("prior session after reset = %d, want 401", res.StatusCode)
	}

	// New password logs in cleanly.
	fresh := newAcctSecCookieClient(t)
	res, _ = acctJSONReq(t, fresh, http.MethodPost, ts.URL+"/api/auth/login", map[string]string{
		"email": "reset-user@example.test", "password": "ResetPassword999!",
	}, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("login with reset password = %d, want 200", res.StatusCode)
	}

	// Expired token cannot be confirmed.
	srv.setPasswordResetDeliverForTest(func(email, token, resetURL string) {
		deliveredMu.Lock()
		deliveredToken = token
		deliveredMu.Unlock()
	})
	res, _ = acctJSONReq(t, anon, http.MethodPost, ts.URL+"/api/auth/password-reset/request", map[string]string{
		"email": "reset-user@example.test",
	}, map[string]string{"X-Forwarded-For": "203.0.113.52"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("second reset request = %d, want 200", res.StatusCode)
	}
	deliveredMu.Lock()
	expiredTok := deliveredToken
	deliveredMu.Unlock()

	clockMu.Lock()
	*nowPtr = nowPtr.Add(31 * time.Minute)
	clockMu.Unlock()
	res, _ = acctJSONReq(t, anon, http.MethodPost, ts.URL+"/api/auth/password-reset/confirm", map[string]string{
		"token":       expiredTok,
		"newPassword": "ExpiredAttempt123!",
	}, nil)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expired reset token = %d, want 400", res.StatusCode)
	}

	// Rate limit check on password-reset request endpoint.
	srv.setAuthRateLimitForTest(authRateBucketPasswordResetReq, 2, 2, 10*time.Minute, 0)
	for i := 0; i < 2; i++ {
		res, _ = acctJSONReq(t, anon, http.MethodPost, ts.URL+"/api/auth/password-reset/request", map[string]string{
			"email": "rl-reset@example.test",
		}, map[string]string{"X-Forwarded-For": "203.0.113.88"})
		if res.StatusCode != http.StatusOK {
			t.Fatalf("reset rl attempt %d = %d, want 200", i+1, res.StatusCode)
		}
	}
	res, _ = acctJSONReq(t, anon, http.MethodPost, ts.URL+"/api/auth/password-reset/request", map[string]string{
		"email": "rl-reset@example.test",
	}, map[string]string{"X-Forwarded-For": "203.0.113.88"})
	if res.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("reset rl 3rd attempt = %d, want 429", res.StatusCode)
	}
}
