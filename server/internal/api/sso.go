package api

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const (
	ssoHTTPTimeout    = 15 * time.Second
	ssoMaxResponse    = 1 << 20 // 1 MiB
	ssoAuthStateTTL   = 10 * time.Minute
	ssoDevSecretSeed  = "jiange-dev-sso-secret"
	ssoDefaultScope   = "openid email profile"
	ssoMaxRedirectLen = 512
)

func (s *Server) ssoStore() (store.SSOStore, bool) {
	st, ok := s.Store.(store.SSOStore)
	return st, ok
}

// ssoSecretKey derives the 32-byte AES-256 key used to seal SSO client secrets.
// In production it derives from s.AISecret (JIANGE_SECRET_KEY); when unset (local dev),
// it falls back to a deterministic dev seed so self-hosted development works out of the box.
func (s *Server) ssoSecretKey() []byte {
	if len(s.AISecret) > 0 {
		h := sha256.New()
		h.Write([]byte("jiange-sso-secret-key:"))
		h.Write(s.AISecret)
		return h.Sum(nil)
	}
	sum := sha256.Sum256([]byte(ssoDevSecretSeed))
	return sum[:]
}

func ssoAAD(workspaceID int64) []byte {
	return []byte("jiange-sso-client-secret:" + strconv.FormatInt(workspaceID, 10))
}

func sealSSOSecret(key []byte, workspaceID int64, secret string) ([]byte, error) {
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
	return gcm.Seal(nonce, nonce, []byte(secret), ssoAAD(workspaceID)), nil
}

func openSSOSecret(key []byte, workspaceID int64, sealed []byte) (string, error) {
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
	plain, err := gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], ssoAAD(workspaceID))
	return string(plain), err
}

func ssoSecretHint(secret string) string {
	n := len(secret)
	if n == 0 {
		return ""
	}
	if n >= 4 {
		return secret[n-4:]
	}
	return "****"
}

func randomURLToken(numBytes int) (string, error) {
	b := make([]byte, numBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func pkceS256Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func (s *Server) validateSSOEndpointURL(raw string, required bool) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", !required
	}
	if len(trimmed) > 1024 {
		return "", false
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" {
		return "", false
	}
	if u.Scheme != "https" && !(s.SSOAllowHTTP && u.Scheme == "http") {
		return "", false
	}
	return u.String(), true
}

func (s *Server) ssoClient() *http.Client {
	if s.SSOTransport != nil {
		return &http.Client{
			Timeout:   ssoHTTPTimeout,
			Transport: s.SSOTransport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	allow := publicAddr
	if s.PreviewAllow != nil {
		allow = s.PreviewAllow
	}
	dialer := &net.Dialer{
		Timeout: 10 * time.Second,
		Control: func(network, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return errBlockedAddress
			}
			ip, err := netip.ParseAddr(host)
			if err != nil || !allow(ip) {
				return errBlockedAddress
			}
			return nil
		},
	}
	return &http.Client{
		Timeout: ssoHTTPTimeout,
		Transport: &http.Transport{
			Proxy:                  nil,
			DialContext:            dialer.DialContext,
			TLSHandshakeTimeout:    10 * time.Second,
			ResponseHeaderTimeout:  ssoHTTPTimeout,
			MaxResponseHeaderBytes: 64 << 10,
			DisableKeepAlives:      true,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func sanitizeSSORedirect(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > ssoMaxRedirectLen {
		return "/#/"
	}
	if !strings.HasPrefix(raw, "/#/") || strings.ContainsAny(raw, "\r\n\\") {
		return "/#/"
	}
	return raw
}

func ssoCallbackURL(r *http.Request, slug string) string {
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
	return fmt.Sprintf("%s://%s/api/auth/sso/%s/callback", scheme, host, url.PathEscape(slug))
}

func ssoErrorRedirect(w http.ResponseWriter, r *http.Request, code string) {
	code = strings.TrimSpace(code)
	if code == "" {
		code = "sso_failed"
	}
	if len(code) > 120 {
		code = code[:120]
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, "/#/?sso_error="+url.QueryEscape(code), http.StatusFound)
}

func (s *Server) ssoError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "仅空间所有者或管理员可管理企业 SSO 配置")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "SSO 登录配置不存在")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "sso_conflict", "SSO 标识（slug）已被占用或配置参数冲突")
	default:
		s.fail(w, r, err)
	}
}

// listPublicSSOProviders handles GET /api/auth/sso/providers (unauthenticated).
func (s *Server) listPublicSSOProviders(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	st, ok := s.ssoStore()
	if !ok {
		httpx.JSON(w, http.StatusOK, map[string]any{"providers": []store.PublicSSOProvider{}})
		return
	}
	providers, err := st.ListPublicSSOProviders(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if providers == nil {
		providers = []store.PublicSSOProvider{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"providers": providers})
}

// startSSO handles GET /api/auth/sso/{slug}/start.
func (s *Server) startSSO(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	st, ok := s.ssoStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "sso_unavailable", "SSO 服务未启用")
		return
	}
	slug := strings.ToLower(strings.TrimSpace(r.PathValue("slug")))
	if slug == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_slug", "缺少 SSO 标识")
		return
	}
	provider, err := st.GetSSOProviderBySlug(r.Context(), slug)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "sso_not_found", "未找到该 SSO 登录方式")
			return
		}
		s.fail(w, r, err)
		return
	}
	if !provider.Enabled {
		httpx.Error(w, http.StatusNotFound, "sso_disabled", "该 SSO 登录方式已停用")
		return
	}
	authEndpoint, ok := s.validateSSOEndpointURL(provider.AuthURL, true)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_auth_url", "SSO 授权地址无效")
		return
	}
	authURLParsed, err := url.Parse(authEndpoint)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_auth_url", "SSO 授权地址无效")
		return
	}

	state, err := randomURLToken(32)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	nonce, err := randomURLToken(24)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	codeVerifier, err := randomURLToken(32)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	redirectRaw := r.URL.Query().Get("redirect")
	if redirectRaw == "" {
		redirectRaw = r.URL.Query().Get("redirect_to")
	}
	redirectTo := sanitizeSSORedirect(redirectRaw)

	if err := st.CreateSSOAuthState(r.Context(), store.SSOAuthState{
		State:        state,
		ProviderID:   provider.ID,
		CodeVerifier: codeVerifier,
		Nonce:        nonce,
		RedirectTo:   redirectTo,
		ExpiresAt:    s.now().Add(ssoAuthStateTTL),
	}); err != nil {
		s.fail(w, r, err)
		return
	}

	scopes := strings.TrimSpace(provider.Scopes)
	if scopes == "" {
		scopes = ssoDefaultScope
	}
	q := authURLParsed.Query()
	q.Set("response_type", "code")
	q.Set("client_id", provider.ClientID)
	q.Set("redirect_uri", ssoCallbackURL(r, provider.Slug))
	q.Set("scope", scopes)
	q.Set("state", state)
	q.Set("nonce", nonce)
	q.Set("code_challenge", pkceS256Challenge(codeVerifier))
	q.Set("code_challenge_method", "S256")
	authURLParsed.RawQuery = q.Encode()

	authorizeURL := authURLParsed.String()
	if strings.EqualFold(r.URL.Query().Get("mode"), "json") {
		httpx.JSON(w, http.StatusOK, map[string]string{
			"authorizeUrl": authorizeURL,
			"state":        state,
		})
		return
	}
	http.Redirect(w, r, authorizeURL, http.StatusFound)
}

type ssoTokenResponse struct {
	AccessToken string `json:"access_token"`
	IDToken     string `json:"id_token"`
	TokenType   string `json:"token_type"`
	Error       string `json:"error"`
	ErrorDesc   string `json:"error_description"`
}

type ssoIDClaims struct {
	Sub               string `json:"sub"`
	Email             string `json:"email"`
	Name              string `json:"name"`
	PreferredUsername string `json:"preferred_username"`
	Nickname          string `json:"nickname"`
	GivenName         string `json:"given_name"`
	FamilyName        string `json:"family_name"`
	Nonce             string `json:"nonce"`
	Exp               int64  `json:"exp"`
}

func decodeIDTokenClaims(rawJWT string) (ssoIDClaims, error) {
	parts := strings.Split(strings.TrimSpace(rawJWT), ".")
	if len(parts) != 3 {
		return ssoIDClaims{}, errors.New("malformed id_token")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ssoIDClaims{}, err
	}
	var claims ssoIDClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ssoIDClaims{}, err
	}
	return claims, nil
}

func pickClaimName(name, preferred, nickname, given, family string) string {
	for _, v := range []string{name, preferred, nickname} {
		if t := strings.TrimSpace(v); t != "" {
			return t
		}
	}
	full := strings.TrimSpace(strings.TrimSpace(given) + " " + strings.TrimSpace(family))
	return full
}

func parseUserinfoPayload(raw []byte) (sub, email, name string, err error) {
	var top map[string]any
	if err := json.Unmarshal(raw, &top); err != nil {
		return "", "", "", err
	}
	// Support Feishu / enterprise IdP envelope { "code": 0, "data": { ... } }.
	obj := top
	if nested, ok := top["data"].(map[string]any); ok && top["sub"] == nil && top["id"] == nil {
		obj = nested
	}
	strField := func(keys ...string) string {
		for _, k := range keys {
			v, ok := obj[k]
			if !ok || v == nil {
				continue
			}
			switch tv := v.(type) {
			case string:
				if t := strings.TrimSpace(tv); t != "" {
					return t
				}
			case float64:
				return strconv.FormatInt(int64(tv), 10)
			case json.Number:
				return tv.String()
			}
		}
		return ""
	}
	sub = strField("sub", "open_id", "union_id", "userid", "user_id", "id")
	email = strField("email", "mail", "enterprise_email")
	name = strField("name", "preferred_username", "nickname", "en_name", "login")
	if name == "" {
		given := strField("given_name")
		family := strField("family_name")
		name = strings.TrimSpace(given + " " + family)
	}
	return sub, email, name, nil
}

func emailMatchesAllowedDomains(email, allowedDomains string) bool {
	allowedDomains = strings.TrimSpace(allowedDomains)
	if allowedDomains == "" {
		return true
	}
	email = strings.ToLower(strings.TrimSpace(email))
	at := strings.LastIndexByte(email, '@')
	if at <= 0 || at >= len(email)-1 {
		return false
	}
	domain := email[at+1:]
	for _, allowed := range strings.Split(allowedDomains, ",") {
		allowed = strings.ToLower(strings.TrimSpace(allowed))
		if allowed != "" && domain == allowed {
			return true
		}
	}
	return false
}

// callbackSSO handles GET /api/auth/sso/{slug}/callback.
func (s *Server) callbackSSO(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	st, ok := s.ssoStore()
	if !ok {
		ssoErrorRedirect(w, r, "sso_unavailable")
		return
	}
	q := r.URL.Query()
	if idpErr := strings.TrimSpace(q.Get("error")); idpErr != "" {
		ssoErrorRedirect(w, r, idpErr)
		return
	}
	code := strings.TrimSpace(q.Get("code"))
	state := strings.TrimSpace(q.Get("state"))
	if code == "" || state == "" {
		ssoErrorRedirect(w, r, "missing_code_or_state")
		return
	}
	slug := strings.ToLower(strings.TrimSpace(r.PathValue("slug")))
	provider, err := st.GetSSOProviderBySlug(r.Context(), slug)
	if err != nil || !provider.Enabled {
		ssoErrorRedirect(w, r, "provider_disabled")
		return
	}

	authState, err := st.ConsumeSSOAuthState(r.Context(), state, s.now())
	if err != nil || authState.ProviderID != provider.ID {
		ssoErrorRedirect(w, r, "invalid_state")
		return
	}

	tokenEndpoint, ok := s.validateSSOEndpointURL(provider.TokenURL, true)
	if !ok {
		ssoErrorRedirect(w, r, "invalid_provider_config")
		return
	}

	var clientSecret string
	if len(provider.ClientSecretEnc) > 0 {
		clientSecret, err = openSSOSecret(s.ssoSecretKey(), provider.WorkspaceID, provider.ClientSecretEnc)
		if err != nil {
			s.Log.Error("sso secret decrypt failed", "provider", provider.Slug, "err", err)
			ssoErrorRedirect(w, r, "secret_decrypt_failed")
			return
		}
	}

	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", ssoCallbackURL(r, provider.Slug))
	form.Set("client_id", provider.ClientID)
	form.Set("code_verifier", authState.CodeVerifier)
	if clientSecret != "" {
		form.Set("client_secret", clientSecret)
	}

	tokenReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, tokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		ssoErrorRedirect(w, r, "token_exchange_failed")
		return
	}
	tokenReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	tokenReq.Header.Set("Accept", "application/json")

	client := s.ssoClient()
	tokenRes, err := client.Do(tokenReq)
	if err != nil {
		s.Log.Error("sso token exchange failed", "provider", provider.Slug, "err", err)
		ssoErrorRedirect(w, r, "token_exchange_failed")
		return
	}
	defer tokenRes.Body.Close()
	tokenRaw, err := io.ReadAll(io.LimitReader(tokenRes.Body, ssoMaxResponse+1))
	if err != nil || len(tokenRaw) > ssoMaxResponse || tokenRes.StatusCode < 200 || tokenRes.StatusCode >= 300 {
		ssoErrorRedirect(w, r, "token_exchange_failed")
		return
	}

	var tok ssoTokenResponse
	if err := json.Unmarshal(tokenRaw, &tok); err != nil {
		// Support form-encoded token responses (e.g. legacy GitHub OAuth2).
		if vals, perr := url.ParseQuery(string(tokenRaw)); perr == nil && vals.Get("access_token") != "" {
			tok.AccessToken = vals.Get("access_token")
			tok.IDToken = vals.Get("id_token")
			tok.TokenType = vals.Get("token_type")
		} else {
			ssoErrorRedirect(w, r, "token_exchange_failed")
			return
		}
	}
	if tok.Error != "" {
		ssoErrorRedirect(w, r, tok.Error)
		return
	}

	var sub, email, name string
	if tok.IDToken != "" {
		claims, err := decodeIDTokenClaims(tok.IDToken)
		if err != nil {
			ssoErrorRedirect(w, r, "invalid_id_token")
			return
		}
		if claims.Nonce != "" && subtle.ConstantTimeCompare([]byte(claims.Nonce), []byte(authState.Nonce)) != 1 {
			ssoErrorRedirect(w, r, "nonce_mismatch")
			return
		}
		if claims.Exp > 0 && s.now().Unix() > claims.Exp+60 {
			ssoErrorRedirect(w, r, "token_expired")
			return
		}
		sub = strings.TrimSpace(claims.Sub)
		email = strings.TrimSpace(claims.Email)
		name = pickClaimName(claims.Name, claims.PreferredUsername, claims.Nickname, claims.GivenName, claims.FamilyName)
	}

	if provider.UserinfoURL != "" && tok.AccessToken != "" && (sub == "" || email == "" || name == "") {
		userinfoEndpoint, ok := s.validateSSOEndpointURL(provider.UserinfoURL, true)
		if !ok {
			ssoErrorRedirect(w, r, "invalid_provider_config")
			return
		}
		uiReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, userinfoEndpoint, nil)
		if err != nil {
			ssoErrorRedirect(w, r, "userinfo_failed")
			return
		}
		uiReq.Header.Set("Authorization", "Bearer "+tok.AccessToken)
		uiReq.Header.Set("Accept", "application/json")
		uiRes, err := client.Do(uiReq)
		if err != nil {
			s.Log.Error("sso userinfo request failed", "provider", provider.Slug, "err", err)
			ssoErrorRedirect(w, r, "userinfo_failed")
			return
		}
		defer uiRes.Body.Close()
		uiRaw, err := io.ReadAll(io.LimitReader(uiRes.Body, ssoMaxResponse+1))
		if err != nil || len(uiRaw) > ssoMaxResponse || uiRes.StatusCode < 200 || uiRes.StatusCode >= 300 {
			ssoErrorRedirect(w, r, "userinfo_failed")
			return
		}
		uiSub, uiEmail, uiName, err := parseUserinfoPayload(uiRaw)
		if err != nil {
			ssoErrorRedirect(w, r, "userinfo_failed")
			return
		}
		if sub != "" && uiSub != "" && sub != uiSub {
			ssoErrorRedirect(w, r, "subject_mismatch")
			return
		}
		if sub == "" {
			sub = uiSub
		}
		if email == "" {
			email = uiEmail
		}
		if name == "" {
			name = uiName
		}
	}

	if sub == "" {
		ssoErrorRedirect(w, r, "identity_missing")
		return
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if !emailMatchesAllowedDomains(email, provider.AllowedDomains) {
		ssoErrorRedirect(w, r, "domain_not_allowed")
		return
	}

	u, err := st.ResolveOrProvisionSSOUser(
		r.Context(),
		provider.ID,
		provider.WorkspaceID,
		sub,
		email,
		name,
		provider.AutoCreateUser,
		provider.DefaultRole,
	)
	if err != nil {
		if errors.Is(err, store.ErrForbidden) {
			ssoErrorRedirect(w, r, "user_not_provisioned")
			return
		}
		s.Log.Error("sso user provisioning failed", "provider", provider.Slug, "err", err)
		ssoErrorRedirect(w, r, "login_failed")
		return
	}
	if !s.startSession(w, r, u.ID) {
		return
	}
	s.recordAuthAudit(r, provider.WorkspaceID, u.ID, u.Name, u.Email, "auth.sso_login", map[string]any{
		"providerSlug": provider.Slug,
		"providerType": provider.ProviderType,
	})
	http.Redirect(w, r, sanitizeSSORedirect(authState.RedirectTo), http.StatusFound)
}

// listWorkspaceSSOProviders handles GET /api/workspaces/{wsId}/sso/providers.
func (s *Server) listWorkspaceSSOProviders(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	st, ok := s.ssoStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "sso_unavailable", "SSO 服务未启用")
		return
	}
	providers, err := st.ListWorkspaceSSOProviders(r.Context(), guard, wsID)
	if err != nil {
		s.ssoError(w, r, err)
		return
	}
	if providers == nil {
		providers = []store.SSOProvider{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"providers": providers})
}

type createSSOProviderRequest struct {
	Slug           string `json:"slug"`
	Name           string `json:"name"`
	ProviderType   string `json:"providerType"`
	Enabled        *bool  `json:"enabled"`
	IssuerURL      string `json:"issuerUrl"`
	AuthURL        string `json:"authUrl"`
	TokenURL       string `json:"tokenUrl"`
	UserinfoURL    string `json:"userinfoUrl"`
	ClientID       string `json:"clientId"`
	ClientSecret   string `json:"clientSecret"`
	Scopes         string `json:"scopes"`
	AutoCreateUser *bool  `json:"autoCreateUser"`
	DefaultRole    string `json:"defaultRole"`
	AllowedDomains string `json:"allowedDomains"`
}

// createWorkspaceSSOProvider handles POST /api/workspaces/{wsId}/sso/providers.
func (s *Server) createWorkspaceSSOProvider(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	st, ok := s.ssoStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "sso_unavailable", "SSO 服务未启用")
		return
	}
	var in createSSOProviderRequest
	if !httpx.Decode(w, r, &in) {
		return
	}
	slug := strings.ToLower(strings.TrimSpace(in.Slug))
	if !store.ValidSSOSlug(slug) {
		httpx.Error(w, http.StatusBadRequest, "invalid_slug", "SSO 标识需为 2-40 位小写字母、数字、短横线或下划线，且以字母或数字开头")
		return
	}
	name := strings.TrimSpace(in.Name)
	if n := utf8.RuneCountInString(name); n < 1 || n > 120 {
		httpx.Error(w, http.StatusBadRequest, "invalid_name", "SSO 名称需为 1-120 个字符")
		return
	}
	providerType := strings.ToLower(strings.TrimSpace(in.ProviderType))
	if providerType == "" {
		providerType = store.SSOProviderOIDC
	}
	if !store.ValidSSOProviderType(providerType) {
		httpx.Error(w, http.StatusBadRequest, "invalid_provider_type", "不支持的 SSO 提供商类型")
		return
	}
	issuerURL, ok := s.validateSSOEndpointURL(in.IssuerURL, false)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_issuer_url", "Issuer 地址无效（需为 https 地址）")
		return
	}
	authURL, ok := s.validateSSOEndpointURL(in.AuthURL, true)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_auth_url", "授权地址（Auth URL）无效（需为 https 地址）")
		return
	}
	tokenURL, ok := s.validateSSOEndpointURL(in.TokenURL, true)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_token_url", "令牌地址（Token URL）无效（需为 https 地址）")
		return
	}
	userinfoURL, ok := s.validateSSOEndpointURL(in.UserinfoURL, false)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_userinfo_url", "用户信息地址（Userinfo URL）无效（需为 https 地址）")
		return
	}
	clientID := strings.TrimSpace(in.ClientID)
	if clientID == "" || len(clientID) > 256 {
		httpx.Error(w, http.StatusBadRequest, "invalid_client_id", "请填写有效的 Client ID")
		return
	}
	defaultRole := strings.ToLower(strings.TrimSpace(in.DefaultRole))
	if defaultRole == "" {
		defaultRole = store.WorkspaceRoleMember
	}
	if !store.ValidSSODefaultRole(defaultRole) {
		httpx.Error(w, http.StatusBadRequest, "invalid_default_role", "默认角色仅支持 member 或 admin")
		return
	}

	var secretEnc []byte
	var secretHint string
	secret := strings.TrimSpace(in.ClientSecret)
	if secret != "" {
		if len(secret) > 1024 {
			httpx.Error(w, http.StatusBadRequest, "invalid_client_secret", "Client Secret 长度超出限制")
			return
		}
		var err error
		secretEnc, err = sealSSOSecret(s.ssoSecretKey(), wsID, secret)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		secretHint = ssoSecretHint(secret)
	}

	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	autoCreate := true
	if in.AutoCreateUser != nil {
		autoCreate = *in.AutoCreateUser
	}

	created, err := st.CreateSSOProviderGuarded(r.Context(), guard, wsID, store.SSOProviderInput{
		Slug:            slug,
		Name:            name,
		ProviderType:    providerType,
		Enabled:         enabled,
		IssuerURL:       strings.TrimRight(issuerURL, "/"),
		AuthURL:         authURL,
		TokenURL:        tokenURL,
		UserinfoURL:     userinfoURL,
		ClientID:        clientID,
		ClientSecretEnc: secretEnc,
		SecretHint:      secretHint,
		Scopes:          in.Scopes,
		AutoCreateUser:  autoCreate,
		DefaultRole:     defaultRole,
		AllowedDomains:  in.AllowedDomains,
	})
	if err != nil {
		s.ssoError(w, r, err)
		return
	}
	s.recordAudit(r, wsID, "org.sso_update", "sso", created.ID, created.Name, map[string]any{"op": "create", "slug": created.Slug, "providerType": created.ProviderType})
	httpx.JSON(w, http.StatusCreated, created)
}

type updateSSOProviderRequest struct {
	Slug              *string `json:"slug"`
	Name              *string `json:"name"`
	ProviderType      *string `json:"providerType"`
	Enabled           *bool   `json:"enabled"`
	IssuerURL         *string `json:"issuerUrl"`
	AuthURL           *string `json:"authUrl"`
	TokenURL          *string `json:"tokenUrl"`
	UserinfoURL       *string `json:"userinfoUrl"`
	ClientID          *string `json:"clientId"`
	ClientSecret      *string `json:"clientSecret"`
	ClearClientSecret bool    `json:"clearClientSecret"`
	Scopes            *string `json:"scopes"`
	AutoCreateUser    *bool   `json:"autoCreateUser"`
	DefaultRole       *string `json:"defaultRole"`
	AllowedDomains    *string `json:"allowedDomains"`
}

// updateWorkspaceSSOProvider handles PATCH /api/workspaces/{wsId}/sso/providers/{pid}.
func (s *Server) updateWorkspaceSSOProvider(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	pid, ok := s.parsePositivePathID(w, r, "pid")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	st, ok := s.ssoStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "sso_unavailable", "SSO 服务未启用")
		return
	}
	var in updateSSOProviderRequest
	if !httpx.Decode(w, r, &in) {
		return
	}

	patch := store.SSOProviderPatch{
		Enabled:        in.Enabled,
		Scopes:         in.Scopes,
		AutoCreateUser: in.AutoCreateUser,
		AllowedDomains: in.AllowedDomains,
	}
	if in.Slug != nil {
		slug := strings.ToLower(strings.TrimSpace(*in.Slug))
		if !store.ValidSSOSlug(slug) {
			httpx.Error(w, http.StatusBadRequest, "invalid_slug", "SSO 标识格式无效")
			return
		}
		patch.Slug = &slug
	}
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if n := utf8.RuneCountInString(name); n < 1 || n > 120 {
			httpx.Error(w, http.StatusBadRequest, "invalid_name", "SSO 名称需为 1-120 个字符")
			return
		}
		patch.Name = &name
	}
	if in.ProviderType != nil {
		pt := strings.ToLower(strings.TrimSpace(*in.ProviderType))
		if !store.ValidSSOProviderType(pt) {
			httpx.Error(w, http.StatusBadRequest, "invalid_provider_type", "不支持的 SSO 提供商类型")
			return
		}
		patch.ProviderType = &pt
	}
	if in.IssuerURL != nil {
		v, ok := s.validateSSOEndpointURL(*in.IssuerURL, false)
		if !ok {
			httpx.Error(w, http.StatusBadRequest, "invalid_issuer_url", "Issuer 地址无效")
			return
		}
		v = strings.TrimRight(v, "/")
		patch.IssuerURL = &v
	}
	if in.AuthURL != nil {
		v, ok := s.validateSSOEndpointURL(*in.AuthURL, true)
		if !ok {
			httpx.Error(w, http.StatusBadRequest, "invalid_auth_url", "授权地址（Auth URL）无效")
			return
		}
		patch.AuthURL = &v
	}
	if in.TokenURL != nil {
		v, ok := s.validateSSOEndpointURL(*in.TokenURL, true)
		if !ok {
			httpx.Error(w, http.StatusBadRequest, "invalid_token_url", "令牌地址（Token URL）无效")
			return
		}
		patch.TokenURL = &v
	}
	if in.UserinfoURL != nil {
		v, ok := s.validateSSOEndpointURL(*in.UserinfoURL, false)
		if !ok {
			httpx.Error(w, http.StatusBadRequest, "invalid_userinfo_url", "用户信息地址（Userinfo URL）无效")
			return
		}
		patch.UserinfoURL = &v
	}
	if in.ClientID != nil {
		cid := strings.TrimSpace(*in.ClientID)
		if cid == "" || len(cid) > 256 {
			httpx.Error(w, http.StatusBadRequest, "invalid_client_id", "Client ID 不能为空")
			return
		}
		patch.ClientID = &cid
	}
	if in.DefaultRole != nil {
		role := strings.ToLower(strings.TrimSpace(*in.DefaultRole))
		if !store.ValidSSODefaultRole(role) {
			httpx.Error(w, http.StatusBadRequest, "invalid_default_role", "默认角色仅支持 member 或 admin")
			return
		}
		patch.DefaultRole = &role
	}
	if in.ClearClientSecret {
		patch.UpdateSecret = true
		patch.ClientSecretEnc = nil
		patch.SecretHint = ""
	} else if in.ClientSecret != nil && strings.TrimSpace(*in.ClientSecret) != "" {
		secret := strings.TrimSpace(*in.ClientSecret)
		if len(secret) > 1024 {
			httpx.Error(w, http.StatusBadRequest, "invalid_client_secret", "Client Secret 长度超出限制")
			return
		}
		sealed, err := sealSSOSecret(s.ssoSecretKey(), wsID, secret)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		patch.UpdateSecret = true
		patch.ClientSecretEnc = sealed
		patch.SecretHint = ssoSecretHint(secret)
	}

	updated, err := st.UpdateSSOProviderGuarded(r.Context(), guard, wsID, pid, patch)
	if err != nil {
		s.ssoError(w, r, err)
		return
	}
	s.recordAudit(r, wsID, "org.sso_update", "sso", updated.ID, updated.Name, map[string]any{"op": "update", "slug": updated.Slug, "enabled": updated.Enabled})
	httpx.JSON(w, http.StatusOK, updated)
}

// deleteWorkspaceSSOProvider handles DELETE /api/workspaces/{wsId}/sso/providers/{pid}.
func (s *Server) deleteWorkspaceSSOProvider(w http.ResponseWriter, r *http.Request) {
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	pid, ok := s.parsePositivePathID(w, r, "pid")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	st, ok := s.ssoStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "sso_unavailable", "SSO 服务未启用")
		return
	}
	if err := st.DeleteSSOProviderGuarded(r.Context(), guard, wsID, pid); err != nil {
		s.ssoError(w, r, err)
		return
	}
	s.recordAudit(r, wsID, "org.sso_update", "sso", pid, "", map[string]any{"op": "delete"})
	w.WriteHeader(http.StatusNoContent)
}

// discoverSSOProvider handles POST /api/workspaces/{wsId}/sso/discover.
func (s *Server) discoverSSOProvider(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	st, ok := s.ssoStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "sso_unavailable", "SSO 服务未启用")
		return
	}
	// Verify caller is workspace owner/admin before making any outbound HTTP call.
	if _, err := st.ListWorkspaceSSOProviders(r.Context(), guard, wsID); err != nil {
		s.ssoError(w, r, err)
		return
	}

	var in struct {
		IssuerURL string `json:"issuerUrl"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	issuerClean, ok := s.validateSSOEndpointURL(in.IssuerURL, true)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_issuer_url", "请填写有效的 https Issuer 地址")
		return
	}
	u, err := url.Parse(issuerClean)
	if err != nil || u.RawQuery != "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_issuer_url", "Issuer 地址不能包含查询参数")
		return
	}
	base := strings.TrimRight(issuerClean, "/")
	discoveryURL := base
	const wellKnownSuffix = "/.well-known/openid-configuration"
	if !strings.HasSuffix(base, wellKnownSuffix) {
		discoveryURL = base + wellKnownSuffix
	} else {
		base = strings.TrimSuffix(base, wellKnownSuffix)
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, discoveryURL, nil)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_issuer_url", "无法构造 OIDC 发现地址")
		return
	}
	req.Header.Set("Accept", "application/json")
	res, err := s.ssoClient().Do(req)
	if err != nil {
		if errors.Is(err, errBlockedAddress) || strings.Contains(err.Error(), errBlockedAddress.Error()) {
			httpx.Error(w, http.StatusBadRequest, "sso_blocked_address", "Issuer 地址指向内网或保留地址，已拒绝")
			return
		}
		httpx.Error(w, http.StatusBadGateway, "sso_discover_failed", "无法连接 OIDC 发现端点，请检查 Issuer 地址")
		return
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, ssoMaxResponse+1))
	if err != nil || len(raw) > ssoMaxResponse || res.StatusCode < 200 || res.StatusCode >= 300 {
		httpx.Error(w, http.StatusBadGateway, "sso_discover_failed", fmt.Sprintf("OIDC 发现端点返回错误（HTTP %d）", res.StatusCode))
		return
	}
	var doc struct {
		Issuer                string   `json:"issuer"`
		AuthorizationEndpoint string   `json:"authorization_endpoint"`
		TokenEndpoint         string   `json:"token_endpoint"`
		UserinfoEndpoint      string   `json:"userinfo_endpoint"`
		ScopesSupported       []string `json:"scopes_supported"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		httpx.Error(w, http.StatusBadGateway, "sso_discover_invalid", "OIDC 发现文档 JSON 格式无效")
		return
	}
	authURL, okAuth := s.validateSSOEndpointURL(doc.AuthorizationEndpoint, true)
	tokenURL, okToken := s.validateSSOEndpointURL(doc.TokenEndpoint, true)
	userinfoURL, okUserinfo := s.validateSSOEndpointURL(doc.UserinfoEndpoint, false)
	if !okAuth || !okToken || !okUserinfo {
		httpx.Error(w, http.StatusBadGateway, "sso_discover_invalid", "OIDC 发现文档缺少有效的授权或令牌地址")
		return
	}
	resolvedIssuer := strings.TrimRight(strings.TrimSpace(doc.Issuer), "/")
	if resolvedIssuer == "" {
		resolvedIssuer = base
	}
	scopes := ssoDefaultScope
	if len(doc.ScopesSupported) > 0 {
		supported := map[string]bool{}
		for _, sc := range doc.ScopesSupported {
			supported[strings.TrimSpace(sc)] = true
		}
		preferred := []string{}
		for _, want := range []string{"openid", "email", "profile"} {
			if supported[want] {
				preferred = append(preferred, want)
			}
		}
		if len(preferred) > 0 {
			scopes = strings.Join(preferred, " ")
		}
	}

	httpx.JSON(w, http.StatusOK, map[string]string{
		"issuerUrl":   resolvedIssuer,
		"authUrl":     authURL,
		"tokenUrl":    tokenURL,
		"userinfoUrl": userinfoURL,
		"scopes":      scopes,
	})
}
