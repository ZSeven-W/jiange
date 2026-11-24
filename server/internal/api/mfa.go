package api

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const (
	mfaDevSecretSeed     = "jiange-dev-mfa-secret"
	mfaChallengeTTL      = 5 * time.Minute
	mfaIssuerName        = "Jiange"
	mfaRecoveryCodeCount = auth.DefaultRecoveryCodeCount
	mfaMaxVerifyAttempts = 5
)

type mfaAttemptEntry struct {
	failures  int
	expiresAt time.Time
}

var (
	mfaAttemptsMu sync.Mutex
	mfaAttempts   = map[string]mfaAttemptEntry{}
)

func recordMFAVerifyFailure(tokenKey string, now time.Time) int {
	mfaAttemptsMu.Lock()
	defer mfaAttemptsMu.Unlock()
	for k, v := range mfaAttempts {
		if !now.Before(v.expiresAt) {
			delete(mfaAttempts, k)
		}
	}
	entry := mfaAttempts[tokenKey]
	entry.failures++
	entry.expiresAt = now.Add(mfaChallengeTTL)
	mfaAttempts[tokenKey] = entry
	return entry.failures
}

func clearMFAVerifyFailures(tokenKey string) {
	mfaAttemptsMu.Lock()
	delete(mfaAttempts, tokenKey)
	mfaAttemptsMu.Unlock()
}

func (s *Server) mfaStore() (store.MFAStore, bool) {
	st, ok := s.Store.(store.MFAStore)
	return st, ok
}

// mfaSecretKey derives the 32-byte AES-256 key used to seal TOTP secrets.
// In production it derives from s.AISecret (JIANGE_SECRET_KEY); in local dev when
// unset it falls back to a deterministic dev seed so self-hosted dev works out of the box.
func (s *Server) mfaSecretKey() []byte {
	if len(s.AISecret) > 0 {
		h := sha256.New()
		h.Write([]byte("jiange-mfa-secret-key:"))
		h.Write(s.AISecret)
		return h.Sum(nil)
	}
	sum := sha256.Sum256([]byte(mfaDevSecretSeed))
	return sum[:]
}

func mfaAAD(userID int64) []byte {
	return []byte("jiange-mfa-totp-secret:" + strconv.FormatInt(userID, 10))
}

func sealMFASecret(key []byte, userID int64, secret string) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, []byte(secret), mfaAAD(userID)), nil
}

func openMFASecret(key []byte, userID int64, sealed []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(sealed) < gcm.NonceSize() {
		return "", errors.New("short ciphertext")
	}
	plain, err := gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], mfaAAD(userID))
	return string(plain), err
}

func (s *Server) firstWorkspaceID(r *http.Request, userID int64) int64 {
	if ws, err := s.Store.Workspaces(r.Context(), userID); err == nil && len(ws) > 0 {
		return ws[0].ID
	}
	return 0
}

type mfaChallengeResponse struct {
	MFARequired bool   `json:"mfaRequired"`
	MFAToken    string `json:"mfaToken"`
	Email       string `json:"email"`
}

type mfaStatusResponse struct {
	Enabled                bool       `json:"enabled"`
	RecoveryCodesRemaining int        `json:"recoveryCodesRemaining"`
	EnabledAt              *time.Time `json:"enabledAt"`
}

type mfaSetupResponse struct {
	Secret     string `json:"secret"`
	OtpAuthURI string `json:"otpauthUri"`
}

type mfaEnableRequest struct {
	Code string `json:"code"`
}

type mfaEnableResponse struct {
	Enabled                bool       `json:"enabled"`
	RecoveryCodes          []string   `json:"recoveryCodes"`
	RecoveryCodesRemaining int        `json:"recoveryCodesRemaining"`
	EnabledAt              *time.Time `json:"enabledAt"`
}

type mfaDisableRequest struct {
	Password string `json:"password,omitempty"`
	Code     string `json:"code,omitempty"`
}

type mfaDisableResponse struct {
	Enabled bool `json:"enabled"`
}

type mfaVerifyLoginRequest struct {
	MFAToken string `json:"mfaToken"`
	Code     string `json:"code"`
}

// maybeStartMFAChallenge inspects whether user u has TOTP MFA enabled.
// When disabled (or never configured), it returns false so standard password login proceeds.
// When enabled, it creates a 5-minute single-use challenge, writes the JSON challenge
// response, and returns true. On unexpected persistence error it fails closed (writes 500
// and returns true) so MFA is never silently bypassed.
func (s *Server) maybeStartMFAChallenge(w http.ResponseWriter, r *http.Request, u store.User) bool {
	mfaStore, ok := s.mfaStore()
	if !ok {
		return false
	}
	state, err := mfaStore.GetUserMFA(r.Context(), u.ID)
	if errors.Is(err, store.ErrNotFound) {
		return false
	}
	if err != nil {
		s.fail(w, r, err)
		return true
	}
	if !state.Enabled {
		return false
	}
	mfaToken, tokenHash, err := auth.NewToken()
	if err != nil {
		s.fail(w, r, err)
		return true
	}
	if err := mfaStore.CreateMFAChallenge(r.Context(), tokenHash, u.ID, s.now().Add(mfaChallengeTTL)); err != nil {
		s.fail(w, r, err)
		return true
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, mfaChallengeResponse{
		MFARequired: true,
		MFAToken:    mfaToken,
		Email:       u.Email,
	})
	return true
}

// verifyMFALogin handles POST /api/auth/mfa/verify (unauthenticated public route).
// It validates the MFA challenge token along with a 6-digit TOTP code or one-time
// recovery code, atomically consumes the challenge on success, issues a session cookie,
// records an auth.mfa_login audit event, and returns meResponse.
func (s *Server) verifyMFALogin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var req mfaVerifyLoginRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.MFAToken = strings.TrimSpace(req.MFAToken)
	req.Code = strings.TrimSpace(req.Code)
	if req.MFAToken == "" || req.Code == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "请提供二步验证令牌和验证码")
		return
	}
	mfaStore, ok := s.mfaStore()
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "not_implemented", "当前存储不支持二步验证")
		return
	}
	now := s.now()
	tokenHash := auth.HashToken(req.MFAToken)
	tokenKey := string(tokenHash)

	userID, err := mfaStore.PeekMFAChallenge(r.Context(), tokenHash, now)
	if errors.Is(err, store.ErrNotFound) {
		clearMFAVerifyFailures(tokenKey)
		httpx.Error(w, http.StatusUnauthorized, "invalid_mfa_token", "二步验证会话已失效，请重新登录")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}

	state, err := mfaStore.GetUserMFA(r.Context(), userID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && !state.Enabled) {
		_, _ = mfaStore.ConsumeMFAChallenge(r.Context(), tokenHash, now)
		clearMFAVerifyFailures(tokenKey)
		httpx.Error(w, http.StatusUnauthorized, "mfa_not_enabled", "二步验证状态已变更，请重新登录")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}

	secret, err := openMFASecret(s.mfaSecretKey(), userID, state.SecretEnc)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	method := ""
	recoveryIdx := -1
	if auth.VerifyTOTP(secret, req.Code, now) {
		method = "totp"
	} else if idx := auth.MatchRecoveryCode(req.Code, state.RecoveryCodesHash); idx >= 0 {
		method = "recovery_code"
		recoveryIdx = idx
	}

	if method == "" {
		failures := recordMFAVerifyFailure(tokenKey, now)
		if failures >= mfaMaxVerifyAttempts {
			_, _ = mfaStore.ConsumeMFAChallenge(r.Context(), tokenHash, now)
			clearMFAVerifyFailures(tokenKey)
			httpx.Error(w, http.StatusUnauthorized, "mfa_attempts_exceeded", "验证码错误次数过多，请重新登录")
			return
		}
		httpx.Error(w, http.StatusUnauthorized, "invalid_mfa_code", "验证码不正确，请重新输入")
		return
	}

	// Atomically consume the challenge so concurrent replays cannot both succeed.
	consumedUID, err := mfaStore.ConsumeMFAChallenge(r.Context(), tokenHash, now)
	clearMFAVerifyFailures(tokenKey)
	if errors.Is(err, store.ErrNotFound) || (err == nil && consumedUID != userID) {
		httpx.Error(w, http.StatusUnauthorized, "invalid_mfa_token", "二步验证会话已失效，请重新登录")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}

	if recoveryIdx >= 0 {
		remaining := make([]string, 0, len(state.RecoveryCodesHash)-1)
		remaining = append(remaining, state.RecoveryCodesHash[:recoveryIdx]...)
		remaining = append(remaining, state.RecoveryCodesHash[recoveryIdx+1:]...)
		state.RecoveryCodesHash = remaining
		state.UpdatedAt = now.UTC()
		if err := mfaStore.UpsertUserMFA(r.Context(), state); err != nil {
			s.fail(w, r, err)
			return
		}
	}

	u, err := mfaStore.GetUserByIDForMFA(r.Context(), userID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "账号不存在")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}

	ws, err := s.Store.Workspaces(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !s.startSession(w, r, u.ID) {
		return
	}

	var auditWS int64
	if len(ws) > 0 {
		auditWS = ws[0].ID
	}
	s.recordAuthAudit(r, auditWS, u.ID, u.Name, u.Email, "auth.mfa_login", map[string]any{
		"method": method,
	})
	httpx.JSON(w, http.StatusOK, meResponse{u, ws})
}

// getMyMFA handles GET /api/me/mfa.
func (s *Server) getMyMFA(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	mfaStore, ok := s.mfaStore()
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "not_implemented", "当前存储不支持二步验证")
		return
	}
	state, err := mfaStore.GetUserMFA(r.Context(), u.ID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && !state.Enabled) {
		httpx.JSON(w, http.StatusOK, mfaStatusResponse{
			Enabled:                false,
			RecoveryCodesRemaining: 0,
			EnabledAt:              nil,
		})
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, mfaStatusResponse{
		Enabled:                true,
		RecoveryCodesRemaining: len(state.RecoveryCodesHash),
		EnabledAt:              state.EnabledAt,
	})
}

// setupMyMFA handles POST /api/me/mfa/setup.
func (s *Server) setupMyMFA(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	mfaStore, ok := s.mfaStore()
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "not_implemented", "当前存储不支持二步验证")
		return
	}
	if cur, err := mfaStore.GetUserMFA(r.Context(), u.ID); err == nil && cur.Enabled {
		httpx.Error(w, http.StatusConflict, "mfa_already_enabled", "当前账号已开启二步验证，请先关闭后再重新绑定")
		return
	} else if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, r, err)
		return
	}

	secret, err := auth.GenerateTOTPSecret()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	sealed, err := sealMFASecret(s.mfaSecretKey(), u.ID, secret)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := mfaStore.UpsertUserMFA(r.Context(), store.UserMFAState{
		UserID:            u.ID,
		SecretEnc:         sealed,
		Enabled:           false,
		RecoveryCodesHash: []string{},
		EnabledAt:         nil,
		UpdatedAt:         s.now().UTC(),
	}); err != nil {
		s.fail(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, mfaSetupResponse{
		Secret:     secret,
		OtpAuthURI: auth.BuildOtpAuthURI(mfaIssuerName, u.Email, secret),
	})
}

// enableMyMFA handles POST /api/me/mfa/enable.
func (s *Server) enableMyMFA(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	mfaStore, ok := s.mfaStore()
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "not_implemented", "当前存储不支持二步验证")
		return
	}
	var req mfaEnableRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Code = strings.TrimSpace(req.Code)
	if req.Code == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_code", "请输入 6 位动态验证码")
		return
	}
	state, err := mfaStore.GetUserMFA(r.Context(), u.ID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusBadRequest, "mfa_setup_required", "请先初始化二步验证密钥")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if state.Enabled {
		httpx.Error(w, http.StatusConflict, "mfa_already_enabled", "当前账号已开启二步验证")
		return
	}

	secret, err := openMFASecret(s.mfaSecretKey(), u.ID, state.SecretEnc)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	now := s.now()
	if !auth.VerifyTOTP(secret, req.Code, now) {
		httpx.Error(w, http.StatusBadRequest, "invalid_mfa_code", "动态验证码不正确，请确认设备时间已同步后重试")
		return
	}

	plainCodes, hashes, err := auth.GenerateRecoveryCodes(mfaRecoveryCodeCount)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	enabledAt := now.UTC()
	state.Enabled = true
	state.RecoveryCodesHash = hashes
	state.EnabledAt = &enabledAt
	state.UpdatedAt = enabledAt
	if err := mfaStore.UpsertUserMFA(r.Context(), state); err != nil {
		s.fail(w, r, err)
		return
	}

	s.recordAuthAudit(r, s.firstWorkspaceID(r, u.ID), u.ID, u.Name, u.Email, "auth.mfa_enable", map[string]any{
		"recoveryCodesCount": len(plainCodes),
	})
	httpx.JSON(w, http.StatusOK, mfaEnableResponse{
		Enabled:                true,
		RecoveryCodes:          plainCodes,
		RecoveryCodesRemaining: len(plainCodes),
		EnabledAt:              state.EnabledAt,
	})
}

// disableMyMFA handles POST /api/me/mfa/disable.
func (s *Server) disableMyMFA(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	mfaStore, ok := s.mfaStore()
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "not_implemented", "当前存储不支持二步验证")
		return
	}
	var req mfaDisableRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	code := strings.TrimSpace(req.Code)
	if req.Password == "" && code == "" {
		httpx.Error(w, http.StatusBadRequest, "verification_required", "请输入当前登录密码或 6 位动态验证码")
		return
	}
	state, err := mfaStore.GetUserMFA(r.Context(), u.ID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && !state.Enabled) {
		httpx.Error(w, http.StatusBadRequest, "mfa_not_enabled", "当前账号未开启二步验证")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}

	method := ""
	if req.Password != "" {
		if okPw, _ := auth.VerifyPassword(req.Password, u.PasswordHash); okPw {
			method = "password"
		}
	}
	if method == "" && code != "" {
		secret, decErr := openMFASecret(s.mfaSecretKey(), u.ID, state.SecretEnc)
		if decErr != nil {
			s.fail(w, r, decErr)
			return
		}
		if auth.VerifyTOTP(secret, code, s.now()) {
			method = "totp"
		} else if auth.MatchRecoveryCode(code, state.RecoveryCodesHash) >= 0 {
			method = "recovery_code"
		}
	}
	if method == "" {
		httpx.Error(w, http.StatusUnauthorized, "invalid_credentials", "密码或验证码不正确，无法关闭二步验证")
		return
	}

	if err := mfaStore.DeleteUserMFA(r.Context(), u.ID); err != nil {
		s.fail(w, r, err)
		return
	}

	s.recordAuthAudit(r, s.firstWorkspaceID(r, u.ID), u.ID, u.Name, u.Email, "auth.mfa_disable", map[string]any{
		"method": method,
	})
	httpx.JSON(w, http.StatusOK, mfaDisableResponse{Enabled: false})
}
