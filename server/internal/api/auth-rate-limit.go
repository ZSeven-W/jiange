package api

import (
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
)

const (
	authRateBucketLogin     = "login"
	authRateLoginMaxIP      = 20
	authRateLoginMaxAccount = 10
	authRateLoginWindow     = 5 * time.Minute

	authRateBucketRegister = "register"
	authRateRegisterMaxIP  = 20
	authRateRegisterWindow = 10 * time.Minute

	authRateBucketMFA = "mfa"
	authRateMFAMaxIP  = 15
	authRateMFAWindow = 5 * time.Minute

	authRateBucketPasskey     = "passkey"
	authRatePasskeyMaxIP      = 30
	authRatePasskeyMaxAccount = 15
	authRatePasskeyWindow     = 5 * time.Minute

	authRateBucketPublicPassword   = "public_password"
	authRatePublicPasswordMaxIP    = 30
	authRatePublicPasswordMaxToken = 15
	authRatePublicPasswordWindow   = 5 * time.Minute

	authRateBucketPasswordResetReq     = "password_reset_request"
	authRatePasswordResetReqMaxIP      = 10
	authRatePasswordResetReqMaxAccount = 5
	authRatePasswordResetReqWindow     = 10 * time.Minute

	authRateBucketPasswordResetConfirm = "password_reset_confirm"
	authRatePasswordResetConfirmMaxIP  = 10
	authRatePasswordResetConfirmWindow = 10 * time.Minute

	authRateMaxTrackedKeys = 4096
)

type authRateBucketOverride struct {
	maxIP      int
	maxAccount int
	window     time.Duration
	lockout    time.Duration
}

type authRateEntry struct {
	attempts    []time.Time
	lockedUntil time.Time
	lastTouched time.Time
}

type authRateLimiter struct {
	mu        sync.Mutex
	entries   map[string]*authRateEntry
	overrides map[string]authRateBucketOverride
}

func newAuthRateLimiter() *authRateLimiter {
	return &authRateLimiter{
		entries:   make(map[string]*authRateEntry),
		overrides: make(map[string]authRateBucketOverride),
	}
}

// serverAuthRateLimiters binds an isolated *authRateLimiter to each *Server so
// tests never share rate-limit state across independent server instances.
var serverAuthRateLimiters sync.Map // map[*Server]*authRateLimiter

func (s *Server) authLimiter() *authRateLimiter {
	if s == nil {
		return newAuthRateLimiter()
	}
	if v, ok := serverAuthRateLimiters.Load(s); ok {
		return v.(*authRateLimiter)
	}
	l := newAuthRateLimiter()
	actual, _ := serverAuthRateLimiters.LoadOrStore(s, l)
	return actual.(*authRateLimiter)
}

// clientIP extracts the best-effort client IP address from X-Forwarded-For,
// X-Real-IP, or RemoteAddr.
func clientIP(r *http.Request) string {
	if r == nil {
		return "unknown"
	}
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		first, _, _ := strings.Cut(xff, ",")
		if cleaned := cleanClientIP(first); cleaned != "" {
			return cleaned
		}
	}
	if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
		if cleaned := cleanClientIP(xri); cleaned != "" {
			return cleaned
		}
	}
	if cleaned := cleanClientIP(r.RemoteAddr); cleaned != "" {
		return cleaned
	}
	return "unknown"
}

func cleanClientIP(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(trimmed); err == nil && host != "" {
		return strings.Trim(host, "[]")
	}
	return strings.Trim(trimmed, "[]")
}

// setAuthRateLimitForTest configures deterministic per-bucket limits on a
// Server instance for unit tests. Pass lockout <= 0 to default lockout to the
// remaining sliding window.
func (s *Server) setAuthRateLimitForTest(bucket string, maxIP, maxAccount int, window, lockout time.Duration) {
	l := s.authLimiter()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.overrides[bucket] = authRateBucketOverride{
		maxIP:      maxIP,
		maxAccount: maxAccount,
		window:     window,
		lockout:    lockout,
	}
}

// resetAuthRateLimitForTest clears all tracked rate-limit buckets on this Server.
func (s *Server) resetAuthRateLimitForTest() {
	l := s.authLimiter()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = make(map[string]*authRateEntry)
}

func (l *authRateLimiter) pruneEntryLocked(e *authRateEntry, now time.Time, window time.Duration) {
	if !e.lockedUntil.IsZero() && !now.Before(e.lockedUntil) {
		e.lockedUntil = time.Time{}
	}
	cutoff := now.Add(-window)
	kept := e.attempts[:0]
	for _, ts := range e.attempts {
		if ts.After(cutoff) {
			kept = append(kept, ts)
		}
	}
	e.attempts = kept
}

func (l *authRateLimiter) checkKeyLocked(key string, maxAttempts int, window, lockout time.Duration, now time.Time) (allowed bool, retryAfter time.Duration) {
	if maxAttempts <= 0 || window <= 0 {
		return true, 0
	}
	e, ok := l.entries[key]
	if !ok {
		return true, 0
	}
	l.pruneEntryLocked(e, now, window)
	if !e.lockedUntil.IsZero() && now.Before(e.lockedUntil) {
		return false, e.lockedUntil.Sub(now)
	}
	if len(e.attempts) >= maxAttempts {
		retryUntil := e.attempts[0].Add(window)
		if lockout > 0 && now.Add(lockout).After(retryUntil) {
			retryUntil = now.Add(lockout)
		}
		if !retryUntil.After(now) {
			retryUntil = now.Add(time.Second)
		}
		e.lockedUntil = retryUntil
		e.lastTouched = now
		return false, retryUntil.Sub(now)
	}
	return true, 0
}

func (l *authRateLimiter) recordKeyLocked(key string, now time.Time) {
	e, ok := l.entries[key]
	if !ok {
		e = &authRateEntry{}
		l.entries[key] = e
	}
	e.attempts = append(e.attempts, now)
	e.lastTouched = now
}

func (l *authRateLimiter) gcLocked(now time.Time, window time.Duration) {
	if len(l.entries) <= authRateMaxTrackedKeys {
		return
	}
	staleCutoff := now.Add(-window)
	for k, e := range l.entries {
		if (e.lockedUntil.IsZero() || !now.Before(e.lockedUntil)) && e.lastTouched.Before(staleCutoff) {
			delete(l.entries, k)
		}
	}
}

func (l *authRateLimiter) checkAndRecord(bucket, ip, accountKey string, maxIP, maxAccount int, window time.Duration, now time.Time) (allowed bool, retryAfter time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	var lockout time.Duration
	if ov, ok := l.overrides[bucket]; ok {
		maxIP = ov.maxIP
		maxAccount = ov.maxAccount
		window = ov.window
		lockout = ov.lockout
	}
	if window <= 0 {
		return true, 0
	}

	ipKey := bucket + ":ip:" + ip
	var acctKey string
	if norm := strings.ToLower(strings.TrimSpace(accountKey)); norm != "" && maxAccount > 0 {
		acctKey = bucket + ":acct:" + norm
	}

	ipOK, ipRetry := l.checkKeyLocked(ipKey, maxIP, window, lockout, now)
	acctOK, acctRetry := true, time.Duration(0)
	if acctKey != "" {
		acctOK, acctRetry = l.checkKeyLocked(acctKey, maxAccount, window, lockout, now)
	}

	if !ipOK || !acctOK {
		retry := ipRetry
		if acctRetry > retry {
			retry = acctRetry
		}
		return false, retry
	}

	if maxIP > 0 {
		l.recordKeyLocked(ipKey, now)
	}
	if acctKey != "" {
		l.recordKeyLocked(acctKey, now)
	}
	l.gcLocked(now, window)
	return true, 0
}

// authRateLimit enforces sliding-window brute-force rate limiting with
// temporary lockout per client IP and optional normalized account key.
// When exceeded it writes HTTP 429 with a Retry-After header and returns false.
func (s *Server) authRateLimit(w http.ResponseWriter, r *http.Request, bucket, accountKey string, maxIP, maxAccount int, window time.Duration) bool {
	allowed, retryAfter := s.authLimiter().checkAndRecord(
		bucket,
		clientIP(r),
		accountKey,
		maxIP,
		maxAccount,
		window,
		s.now(),
	)
	if allowed {
		return true
	}
	retrySec := int(math.Ceil(retryAfter.Seconds()))
	if retrySec < 1 {
		retrySec = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(retrySec))
	httpx.Error(w, http.StatusTooManyRequests, "rate_limited", "请求过于频繁，请稍后再试")
	return false
}

// authRateLimitReset clears the rate-limit state for a specific bucket + key
// (e.g. after a confirmed password reset or successful authentication reset).
func (s *Server) authRateLimitReset(bucket, accountKey string) {
	norm := strings.ToLower(strings.TrimSpace(accountKey))
	if norm == "" {
		return
	}
	l := s.authLimiter()
	l.mu.Lock()
	delete(l.entries, bucket+":acct:"+norm)
	l.mu.Unlock()
}
