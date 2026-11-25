package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestAuthRateLimitClientIP(t *testing.T) {
	cases := []struct {
		name       string
		xff        string
		xri        string
		remoteAddr string
		want       string
	}{
		{"xff single", "203.0.113.5", "", "10.0.0.1:1234", "203.0.113.5"},
		{"xff chain", "198.51.100.2, 10.0.0.2", "10.0.0.3", "10.0.0.1:1234", "198.51.100.2"},
		{"xff with port", "203.0.113.9:5555, 10.0.0.2", "", "10.0.0.1:1234", "203.0.113.9"},
		{"x-real-ip", "", "192.0.2.44", "10.0.0.1:1234", "192.0.2.44"},
		{"remoteAddr ipv4", "", "", "192.0.2.8:4321", "192.0.2.8"},
		{"remoteAddr ipv6", "", "", "[2001:db8::1]:8443", "2001:db8::1"},
		{"fallback unknown", "", "", "", "unknown"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
			req.RemoteAddr = tc.remoteAddr
			if tc.xff != "" {
				req.Header.Set("X-Forwarded-For", tc.xff)
			}
			if tc.xri != "" {
				req.Header.Set("X-Real-IP", tc.xri)
			}
			if got := clientIP(req); got != tc.want {
				t.Fatalf("clientIP = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestAuthRateLimitSlidingWindowLockoutAndIsolation(t *testing.T) {
	var mu sync.Mutex
	now := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	advance := func(d time.Duration) {
		mu.Lock()
		now = now.Add(d)
		mu.Unlock()
	}

	s1 := &Server{Store: store.NewMemory(), Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: clock}
	s2 := &Server{Store: store.NewMemory(), Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: clock}

	// Allow 3 per IP, 2 per normalized email within 1 minute, 90s lockout on breach.
	s1.setAuthRateLimitForTest("login", 3, 2, time.Minute, 90*time.Second)
	s2.setAuthRateLimitForTest("login", 3, 2, time.Minute, 90*time.Second)

	call := func(srv *Server, ip, email string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
		req.Header.Set("X-Forwarded-For", ip)
		rr := httptest.NewRecorder()
		ok := srv.authRateLimit(rr, req, "login", email, 20, 10, 5*time.Minute)
		if ok {
			rr.WriteHeader(http.StatusOK)
		}
		return rr
	}

	// First 2 attempts for Alice@Example.com (case-insensitive) succeed.
	if rr := call(s1, "203.0.113.1", "Alice@Example.com"); rr.Code != http.StatusOK {
		t.Fatalf("attempt 1 = %d, want 200", rr.Code)
	}
	advance(5 * time.Second)
	if rr := call(s1, "203.0.113.2", " alice@example.com "); rr.Code != http.StatusOK {
		t.Fatalf("attempt 2 = %d, want 200", rr.Code)
	}

	// 3rd attempt against same normalized account from a brand new IP must be blocked with 429 + Retry-After.
	advance(5 * time.Second)
	rr := call(s1, "203.0.113.3", "ALICE@example.com")
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("account threshold breach = %d, want 429", rr.Code)
	}
	retrySec, err := strconv.Atoi(rr.Header().Get("Retry-After"))
	if err != nil || retrySec < 85 {
		t.Fatalf("unexpected Retry-After header: %q (err=%v)", rr.Header().Get("Retry-After"), err)
	}
	var errBody struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &errBody); err != nil {
		t.Fatalf("decode 429 json: %v", err)
	}
	if errBody.Error != "rate_limited" {
		t.Fatalf("error code = %q, want rate_limited", errBody.Error)
	}

	// Separate Server instance s2 must NOT be affected by s1's limiter state.
	if rr2 := call(s2, "203.0.113.3", "alice@example.com"); rr2.Code != http.StatusOK {
		t.Fatalf("s2 must be isolated from s1, got %d", rr2.Code)
	}

	// Different email on s1 from same IP still works until IP limit (3) is reached.
	if rr := call(s1, "203.0.113.1", "bob@example.com"); rr.Code != http.StatusOK {
		t.Fatalf("bob attempt 1 on IP1 = %d, want 200", rr.Code)
	}
	if rr := call(s1, "203.0.113.1", "carol@example.com"); rr.Code != http.StatusOK {
		t.Fatalf("carol attempt 1 on IP1 = %d, want 200", rr.Code)
	}
	// IP1 now has 3 recorded attempts (alice + bob + carol); 4th hits IP limit.
	if rr := call(s1, "203.0.113.1", "dave@example.com"); rr.Code != http.StatusTooManyRequests {
		t.Fatalf("IP threshold breach = %d, want 429", rr.Code)
	}

	// Advancing only 65s is still inside the 90s lockout for alice.
	advance(65 * time.Second)
	if rr := call(s1, "203.0.113.9", "alice@example.com"); rr.Code != http.StatusTooManyRequests {
		t.Fatalf("still locked out at +65s, got %d", rr.Code)
	}

	// Advancing past 90s lifts the lockout and allows new attempts.
	advance(30 * time.Second)
	if rr := call(s1, "203.0.113.9", "alice@example.com"); rr.Code != http.StatusOK {
		t.Fatalf("after lockout expiry = %d, want 200", rr.Code)
	}
}

func TestAuthRateLimitWiredHandlers(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	now := time.Date(2026, 11, 25, 14, 0, 0, 0, time.UTC)

	hash, err := auth.HashPassword("StrongPass123!", 1000)
	if err != nil {
		t.Fatal(err)
	}
	u, ws, err := st.CreateUser(ctx, "rl@example.test", "Rate User", hash)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, u.ID, nil, "Protected Doc", nil)
	if err != nil {
		t.Fatal(err)
	}
	linkTok := "rl-public-token-01"
	if err := st.SetLink(ctx, doc.ID, store.Link{Role: "anon", Token: linkTok}); err != nil {
		t.Fatal(err)
	}
	linkPassHash, err := auth.HashPassword("1234", 1000)
	if err != nil {
		t.Fatal(err)
	}
	// Create a valid session so guarded link-password setter succeeds.
	_, sessHash, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := st.CreateSession(ctx, sessHash, u.ID, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: u.ID, SessionHash: sessHash, Now: func() time.Time { return now }}
	if err := st.SetLinkPasswordGuarded(ctx, guard, doc.ID, linkPassHash); err != nil {
		t.Fatal(err)
	}

	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
		Now:        func() time.Time { return now },
	}
	s.setAuthRateLimitForTest(authRateBucketPublicPassword, 10, 2, time.Minute, 0)
	s.setAuthRateLimitForTest(authRateBucketMFA, 2, 0, time.Minute, 0)
	s.setAuthRateLimitForTest(authRateBucketPasskey, 2, 2, time.Minute, 0)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/public/{token}/verify-password", s.verifyPublicLinkPassword)
	mux.HandleFunc("POST /api/auth/mfa/verify", s.verifyMFALogin)
	mux.HandleFunc("POST /api/auth/passkey/login/begin", s.beginPasskeyLogin)
	mux.HandleFunc("POST /api/auth/passkey/login/finish", s.finishPasskeyLogin)

	postJSON := func(path, ip string, body any) *httptest.ResponseRecorder {
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Forwarded-For", ip)
		rr := httptest.NewRecorder()
		mux.ServeHTTP(rr, req)
		return rr
	}

	// 1. Public share link password verification rate limited on 3rd attempt.
	pubPath := "/api/public/" + linkTok + "/verify-password"
	for i := 0; i < 2; i++ {
		if rr := postJSON(pubPath, "198.51.100.10", map[string]string{"password": "wrong"}); rr.Code != http.StatusForbidden {
			t.Fatalf("public password attempt %d = %d, want 403", i+1, rr.Code)
		}
	}
	if rr := postJSON(pubPath, "198.51.100.10", map[string]string{"password": "wrong"}); rr.Code != http.StatusTooManyRequests {
		t.Fatalf("public password 3rd attempt = %d, want 429", rr.Code)
	} else if rr.Header().Get("Retry-After") == "" {
		t.Fatalf("missing Retry-After on public password 429")
	}

	// 2. MFA login verification rate limited on 3rd attempt.
	for i := 0; i < 2; i++ {
		if rr := postJSON("/api/auth/mfa/verify", "198.51.100.20", map[string]string{"mfaToken": "fake", "code": "000000"}); rr.Code != http.StatusUnauthorized {
			t.Fatalf("mfa verify attempt %d = %d, want 401", i+1, rr.Code)
		}
	}
	if rr := postJSON("/api/auth/mfa/verify", "198.51.100.20", map[string]string{"mfaToken": "fake", "code": "000000"}); rr.Code != http.StatusTooManyRequests {
		t.Fatalf("mfa verify 3rd attempt = %d, want 429", rr.Code)
	}

	// 3. Passkey login begin + finish share the passkey rate-limit bucket.
	if rr := postJSON("/api/auth/passkey/login/begin", "198.51.100.30", map[string]string{"email": "rl@example.test"}); rr.Code != http.StatusOK {
		t.Fatalf("passkey begin attempt 1 = %d, want 200", rr.Code)
	}
	if rr := postJSON("/api/auth/passkey/login/finish", "198.51.100.30", map[string]any{"id": "bad"}); rr.Code != http.StatusBadRequest {
		t.Fatalf("passkey finish attempt 2 = %d, want 400", rr.Code)
	}
	if rr := postJSON("/api/auth/passkey/login/finish", "198.51.100.30", map[string]any{"id": "bad"}); rr.Code != http.StatusTooManyRequests {
		t.Fatalf("passkey 3rd attempt = %d, want 429", rr.Code)
	}
}
