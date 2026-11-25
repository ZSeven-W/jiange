package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const (
	passwordResetTokenTTL       = 30 * time.Minute
	defaultSessionTouchInterval = time.Minute
	maxTrackedSessionTouches    = 4096
	maxSessionUARunes           = 256
	passwordResetOKMessage      = "如果该邮箱已注册，我们已发送密码重置邮件，请查收收件箱"
)

type sessionTouchTracker struct {
	mu       sync.Mutex
	interval time.Duration
	lastSeen map[string]time.Time
}

func newSessionTouchTracker() *sessionTouchTracker {
	return &sessionTouchTracker{
		interval: defaultSessionTouchInterval,
		lastSeen: make(map[string]time.Time),
	}
}

// Per-Server state maps avoid touching Server struct in api.go and keep tests isolated.
var (
	serverSessionTouches    sync.Map // map[*Server]*sessionTouchTracker
	serverResetDeliverHooks sync.Map // map[*Server]func(email, token, resetURL string)
)

func (s *Server) sessionTouchTracker() *sessionTouchTracker {
	if s == nil {
		return newSessionTouchTracker()
	}
	if v, ok := serverSessionTouches.Load(s); ok {
		return v.(*sessionTouchTracker)
	}
	tr := newSessionTouchTracker()
	actual, _ := serverSessionTouches.LoadOrStore(s, tr)
	return actual.(*sessionTouchTracker)
}

func (s *Server) setSessionTouchIntervalForTest(d time.Duration) {
	tr := s.sessionTouchTracker()
	tr.mu.Lock()
	tr.interval = d
	tr.mu.Unlock()
}

func (s *Server) setPasswordResetDeliverForTest(fn func(email, token, resetURL string)) {
	if fn == nil {
		serverResetDeliverHooks.Delete(s)
		return
	}
	serverResetDeliverHooks.Store(s, fn)
}

func (s *Server) passwordResetDeliverHook() func(email, token, resetURL string) {
	if s == nil {
		return nil
	}
	if v, ok := serverResetDeliverHooks.Load(s); ok {
		return v.(func(email, token, resetURL string))
	}
	return nil
}

func (s *Server) accountSecurityStore(w http.ResponseWriter) (store.AccountSecurityStore, bool) {
	st, ok := s.Store.(store.AccountSecurityStore)
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "not_implemented", "当前存储不支持账号安全自服务")
		return nil, false
	}
	return st, true
}

func currentSessionTokenHash(r *http.Request) []byte {
	if r == nil {
		return nil
	}
	c, err := r.Cookie(CookieName)
	if err != nil || strings.TrimSpace(c.Value) == "" {
		return nil
	}
	return auth.HashToken(c.Value)
}

func capUserAgent(raw string) string {
	clean := strings.TrimSpace(strings.ToValidUTF8(raw, ""))
	if utf8.RuneCountInString(clean) <= maxSessionUARunes {
		return clean
	}
	var b strings.Builder
	b.Grow(len(clean))
	n := 0
	for _, r := range clean {
		if n >= maxSessionUARunes {
			break
		}
		b.WriteRune(r)
		n++
	}
	return b.String()
}

// recordSessionMeta stores User-Agent and client IP on a newly created session.
// Best-effort: never fails the parent authentication flow.
func (s *Server) recordSessionMeta(r *http.Request, tokenHash []byte) {
	if s == nil || s.Store == nil || len(tokenHash) == 0 {
		return
	}
	acctStore, ok := s.Store.(store.AccountSecurityStore)
	if !ok {
		return
	}
	ctx := context.Background()
	ua := ""
	ip := ""
	if r != nil {
		ctx = r.Context()
		ua = capUserAgent(r.UserAgent())
		ip = clientIP(r)
	}
	now := s.now()
	if err := acctStore.UpdateSessionMetadata(ctx, tokenHash, ua, ip, now); err != nil && !errors.Is(err, store.ErrNotFound) && s.Log != nil {
		s.Log.Warn("update session metadata failed", "err", err)
	}
	tr := s.sessionTouchTracker()
	tr.mu.Lock()
	tr.lastSeen[string(tokenHash)] = now
	tr.mu.Unlock()
}

// touchSessionMeta throttles last_seen_at updates for authenticated cookie requests.
// Best-effort: never fails the parent request.
func (s *Server) touchSessionMeta(r *http.Request, tokenHash []byte) {
	if s == nil || s.Store == nil || len(tokenHash) == 0 {
		return
	}
	acctStore, ok := s.Store.(store.AccountSecurityStore)
	if !ok {
		return
	}
	now := s.now()
	key := string(tokenHash)
	tr := s.sessionTouchTracker()
	tr.mu.Lock()
	interval := tr.interval
	if prev, ok := tr.lastSeen[key]; ok && interval > 0 && now.Sub(prev) < interval {
		tr.mu.Unlock()
		return
	}
	if len(tr.lastSeen) >= maxTrackedSessionTouches {
		cutoff := now.Add(-10 * time.Minute)
		for k, ts := range tr.lastSeen {
			if ts.Before(cutoff) {
				delete(tr.lastSeen, k)
			}
		}
	}
	tr.lastSeen[key] = now
	tr.mu.Unlock()

	ctx := context.Background()
	if r != nil {
		ctx = r.Context()
	}
	if err := acctStore.TouchSession(ctx, tokenHash, now); err != nil && !errors.Is(err, store.ErrNotFound) && s.Log != nil {
		s.Log.Warn("touch session failed", "err", err)
	}
}

func requestOriginBaseURL(r *http.Request) string {
	if r == nil {
		return ""
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if fwdProto := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); fwdProto != "" {
		lower := strings.ToLower(fwdProto)
		if lower == "http" || lower == "https" {
			scheme = lower
		}
	}
	host := strings.TrimSpace(r.Host)
	if fwdHost := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0]); fwdHost != "" && !strings.ContainsAny(fwdHost, "/ \t\r\n") {
		host = fwdHost
	}
	if host == "" {
		return ""
	}
	return scheme + "://" + host
}

func (s *Server) findEnabledSMTPChannelForUser(ctx context.Context, userID int64) (store.NotificationChannel, smtpChannelConfig, bool) {
	ncStore, ok := s.Store.(store.NotificationChannelStore)
	if !ok {
		return store.NotificationChannel{}, smtpChannelConfig{}, false
	}
	wsList, err := s.Store.Workspaces(ctx, userID)
	if err != nil || len(wsList) == 0 {
		return store.NotificationChannel{}, smtpChannelConfig{}, false
	}
	seenChannel := make(map[int64]struct{})
	for _, ws := range wsList {
		for _, ev := range store.ValidNotificationEvents {
			channels, cErr := ncStore.ListActiveNotificationChannelsForEvent(ctx, ws.ID, ev)
			if cErr != nil {
				continue
			}
			for _, ch := range channels {
				if ch.Kind != store.NotificationChannelKindSMTP || len(ch.ConfigEnc) == 0 {
					continue
				}
				if _, visited := seenChannel[ch.ID]; visited {
					continue
				}
				seenChannel[ch.ID] = struct{}{}
				plain, decErr := openNotifChannelConfig(s.notifChannelSecretKey(), ch.WorkspaceID, ch.ConfigEnc)
				if decErr != nil {
					continue
				}
				var cfg smtpChannelConfig
				if json.Unmarshal(plain, &cfg) != nil || strings.TrimSpace(cfg.Host) == "" || cfg.Port <= 0 || strings.TrimSpace(cfg.From) == "" {
					continue
				}
				return ch, cfg, true
			}
		}
	}
	return store.NotificationChannel{}, smtpChannelConfig{}, false
}

// changePassword handles POST /api/me/password.
func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	acctStore, ok := s.accountSecurityStore(w)
	if !ok {
		return
	}
	var req struct {
		CurrentPassword     string `json:"currentPassword"`
		NewPassword         string `json:"newPassword"`
		RevokeOtherSessions *bool  `json:"revokeOtherSessions,omitempty"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	if utf8.RuneCountInString(req.NewPassword) < 8 || len(req.NewPassword) > 256 {
		httpx.Error(w, http.StatusBadRequest, "weak_password", "新密码长度需为 8–256 个字符")
		return
	}
	matched, err := auth.VerifyPassword(req.CurrentPassword, u.PasswordHash)
	if err != nil || !matched {
		httpx.Error(w, http.StatusUnauthorized, "invalid_credentials", "当前密码不正确")
		return
	}
	newHash, err := auth.HashPassword(req.NewPassword, s.passwordIterations())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := acctStore.UpdateUserPasswordHash(r.Context(), u.ID, newHash); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusUnauthorized, "unauthorized", "账号不存在")
			return
		}
		s.fail(w, r, err)
		return
	}

	revokeOthers := true
	if req.RevokeOtherSessions != nil {
		revokeOthers = *req.RevokeOtherSessions
	}
	var revoked int64
	if revokeOthers {
		revoked, err = acctStore.RevokeOtherUserSessions(r.Context(), u.ID, currentSessionTokenHash(r))
		if err != nil {
			s.fail(w, r, err)
			return
		}
	}

	s.recordAuthAudit(r, s.firstWorkspaceID(r, u.ID), u.ID, u.Name, u.Email, "auth.password_changed", map[string]any{
		"revokeOtherSessions": revokeOthers,
		"revokedSessions":     revoked,
	})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"ok":              true,
		"revokedSessions": revoked,
	})
}

// listMySessions handles GET /api/me/sessions.
func (s *Server) listMySessions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	acctStore, ok := s.accountSecurityStore(w)
	if !ok {
		return
	}
	sessions, err := acctStore.ListUserSessions(r.Context(), u.ID, currentSessionTokenHash(r), s.now())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if sessions == nil {
		sessions = []store.UserSession{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

// revokeMySession handles DELETE /api/me/sessions/{sid}.
func (s *Server) revokeMySession(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	acctStore, ok := s.accountSecurityStore(w)
	if !ok {
		return
	}
	sid := pathID(r, "sid")
	if sid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "会话 ID 无效")
		return
	}
	if err := acctStore.RevokeUserSession(r.Context(), u.ID, sid); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "会话不存在或已下线")
		return
	} else if err != nil {
		s.fail(w, r, err)
		return
	}
	s.recordAuthAudit(r, s.firstWorkspaceID(r, u.ID), u.ID, u.Name, u.Email, "auth.session_revoked", map[string]any{
		"sessionId": sid,
	})
	w.WriteHeader(http.StatusNoContent)
}

// revokeOtherMySessions handles POST /api/me/sessions/revoke-others.
func (s *Server) revokeOtherMySessions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	acctStore, ok := s.accountSecurityStore(w)
	if !ok {
		return
	}
	revoked, err := acctStore.RevokeOtherUserSessions(r.Context(), u.ID, currentSessionTokenHash(r))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.recordAuthAudit(r, s.firstWorkspaceID(r, u.ID), u.ID, u.Name, u.Email, "auth.sessions_revoked_others", map[string]any{
		"revoked": revoked,
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"revoked": revoked})
}

// requestPasswordReset handles POST /api/auth/password-reset/request (public, rate-limited).
// Always responds 200 with a generic message to avoid user enumeration.
func (s *Server) requestPasswordReset(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var req struct {
		Email string `json:"email"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	email := strings.TrimSpace(req.Email)
	if !s.authRateLimit(w, r, authRateBucketPasswordResetReq, email, authRatePasswordResetReqMaxIP, authRatePasswordResetReqMaxAccount, authRatePasswordResetReqWindow) {
		return
	}
	if !validEmail(email) {
		httpx.JSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"message": passwordResetOKMessage,
		})
		return
	}

	u, err := s.Store.UserByEmail(r.Context(), email)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) && s.Log != nil {
			s.Log.Warn("password reset lookup failed", "err", err)
		}
		httpx.JSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"message": passwordResetOKMessage,
		})
		return
	}

	acctStore, ok := s.Store.(store.AccountSecurityStore)
	if !ok {
		httpx.JSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"message": passwordResetOKMessage,
		})
		return
	}

	rawToken, tokenHash, err := auth.NewToken()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := acctStore.CreatePasswordResetToken(r.Context(), tokenHash, u.ID, s.now().Add(passwordResetTokenTTL)); err != nil {
		s.fail(w, r, err)
		return
	}

	resetPath := "/#/login?reset_token=" + url.QueryEscape(rawToken)
	resetURL := resetPath
	if base := requestOriginBaseURL(r); base != "" {
		resetURL = base + resetPath
	}

	if hook := s.passwordResetDeliverHook(); hook != nil {
		hook(u.Email, rawToken, resetURL)
	}

	smtpSent := false
	if _, cfg, found := s.findEnabledSMTPChannelForUser(r.Context(), u.ID); found {
		// Override recipients strictly to the requesting user so tokens are never broadcast.
		cfg.To = []string{u.Email}
		subject := "【Jiange 简格】重置您的登录密码"
		body := fmt.Sprintf(
			"您好，%s：\n\n我们收到了重置您 Jiange 账号密码的请求。请在 30 分钟内点击下方链接，或在登录页“重置密码”中输入重置口令完成密码重设：\n\n重置口令：%s\n\n如果这不是您本人的操作，请忽略此邮件，您的账号密码不会被更改。",
			u.Name,
			rawToken,
		)
		if sendErr := s.sendSMTPEmail(r.Context(), cfg, subject, body, resetURL); sendErr != nil {
			if s.Log != nil {
				s.Log.Warn("password reset SMTP delivery failed", "userId", u.ID, "err", sendErr)
			}
		} else {
			smtpSent = true
		}
	} else if s.Log != nil {
		s.Log.Warn("password reset requested but no enabled SMTP notification channel is configured", "userId", u.ID)
	}

	s.recordAuthAudit(r, s.firstWorkspaceID(r, u.ID), u.ID, u.Name, u.Email, "auth.password_reset_requested", map[string]any{
		"smtpSent": smtpSent,
	})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": passwordResetOKMessage,
	})
}

// confirmPasswordReset handles POST /api/auth/password-reset/confirm (public, rate-limited).
func (s *Server) confirmPasswordReset(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.authRateLimit(w, r, authRateBucketPasswordResetConfirm, "", authRatePasswordResetConfirmMaxIP, 0, authRatePasswordResetConfirmWindow) {
		return
	}
	var req struct {
		Token       string `json:"token"`
		NewPassword string `json:"newPassword"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	token := strings.TrimSpace(req.Token)
	if token == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_reset_token", "重置口令无效或已过期，请重新申请")
		return
	}
	if utf8.RuneCountInString(req.NewPassword) < 8 || len(req.NewPassword) > 256 {
		httpx.Error(w, http.StatusBadRequest, "weak_password", "新密码长度需为 8–256 个字符")
		return
	}
	acctStore, ok := s.accountSecurityStore(w)
	if !ok {
		return
	}

	tokenHash := auth.HashToken(token)
	userID, err := acctStore.ConsumePasswordResetToken(r.Context(), tokenHash, s.now())
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusBadRequest, "invalid_reset_token", "重置口令无效或已过期，请重新申请")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}

	newHash, err := auth.HashPassword(req.NewPassword, s.passwordIterations())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := acctStore.UpdateUserPasswordHash(r.Context(), userID, newHash); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusBadRequest, "invalid_reset_token", "重置口令无效或已过期，请重新申请")
			return
		}
		s.fail(w, r, err)
		return
	}

	revoked, err := acctStore.RevokeOtherUserSessions(r.Context(), userID, nil)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	var actorName, actorEmail string
	if mfaStore, ok := s.mfaStore(); ok {
		if u, uErr := mfaStore.GetUserByIDForMFA(r.Context(), userID); uErr == nil {
			actorName = u.Name
			actorEmail = u.Email
			s.authRateLimitReset(authRateBucketLogin, u.Email)
		}
	}
	s.recordAuthAudit(r, s.firstWorkspaceID(r, userID), userID, actorName, actorEmail, "auth.password_reset_completed", map[string]any{
		"revokedSessions": revoked,
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
