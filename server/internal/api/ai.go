package api

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// 个人 AI：用户在设置中填写 OpenAI 兼容接口（地址、模型、API Key）。
//
//   - API Key 用 AES-GCM 加密后入库（密钥由 JIANGE_SECRET_KEY 派生，附加数据绑定用户 ID），
//     接口只返回末 4 位提示，从不回传明文；未配置服务端密钥时拒绝保存。
//   - 请求只发往 https 地址，连接时校验解析后的 IP 为公网地址（与网页卡片相同的 SSRF 防护），
//     不跟随跳转、不经代理；单次 60 秒超时、响应最多读取 1MB。
//   - AI 调用挂在具体文档下（/api/docs/{id}/ai），要求可查看且允许复制该文档内容——
//     受复制保护的内容不会被发送给第三方模型。每人每分钟最多 20 次。

const (
	aiTimeout       = 60 * time.Second
	aiMaxResponse   = 1 << 20
	aiMaxInputChars = 24000
	aiMaxMessages   = 20
	aiRatePerMinute = 20
	aiDefaultBase   = "https://api.openai.com/v1"
	aiDefaultModel  = "gpt-4o-mini"
	// Anthropic Messages API defaults.
	aiAnthropicBase    = "https://api.anthropic.com/v1"
	aiAnthropicModel   = "claude-sonnet-4-5"
	aiAnthropicVersion = "2023-06-01"
)

func aiDefaults(provider string) (string, string) {
	if provider == "anthropic" {
		return aiAnthropicBase, aiAnthropicModel
	}
	return aiDefaultBase, aiDefaultModel
}

func normalizeProvider(p string) (string, bool) {
	switch strings.TrimSpace(p) {
	case "", "openai":
		return "openai", true
	case "anthropic":
		return "anthropic", true
	}
	return "", false
}

var reAIModel = regexp.MustCompile(`^[A-Za-z0-9._:/@-]{1,100}$`)

// AISecretFromEnv derives the 32-byte key-encryption key. Empty input disables saving keys.
func AISecretFromEnv(raw string) []byte {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	sum := sha256.Sum256([]byte("jiange-ai-settings:" + raw))
	return sum[:]
}

func aiAAD(userID int64) []byte { return []byte("jiange-ai-key:" + strconv.FormatInt(userID, 10)) }

func sealAIKey(secret []byte, userID int64, key string) ([]byte, error) {
	block, err := aes.NewCipher(secret)
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
	return gcm.Seal(nonce, nonce, []byte(key), aiAAD(userID)), nil
}

func openAIKey(secret []byte, userID int64, sealed []byte) (string, error) {
	block, err := aes.NewCipher(secret)
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
	plain, err := gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], aiAAD(userID))
	return string(plain), err
}

// normalizeAIBase validates a provider base URL (https, no credentials).
func (s *Server) normalizeAIBase(raw, provider string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		raw, _ = aiDefaults(provider)
	}
	if len(raw) > 512 {
		return "", false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", false
	}
	if u.Scheme != "https" && !(s.AIAllowHTTP && u.Scheme == "http") {
		return "", false
	}
	return strings.TrimRight(u.String(), "/"), true
}

func (s *Server) aiClient() *http.Client {
	if s.AITransport != nil {
		return &http.Client{Timeout: aiTimeout, Transport: s.AITransport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	allow := publicAddr
	if s.PreviewAllow != nil {
		allow = s.PreviewAllow
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second, Control: func(network, address string, _ syscall.RawConn) error {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return errBlockedAddress
		}
		ip, err := netip.ParseAddr(host)
		if err != nil || !allow(ip) {
			return errBlockedAddress
		}
		return nil
	}}
	return &http.Client{
		Timeout:       aiTimeout,
		Transport:     &http.Transport{Proxy: nil, DialContext: dialer.DialContext, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: aiTimeout, MaxResponseHeaderBytes: 64 << 10},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

type aiLimiter struct {
	mu   sync.Mutex
	hits map[int64][]time.Time
}

var aiRate = &aiLimiter{hits: map[int64][]time.Time{}}

func (l *aiLimiter) allow(userID int64, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	cut := now.Add(-time.Minute)
	kept := l.hits[userID][:0]
	for _, t := range l.hits[userID] {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= aiRatePerMinute {
		l.hits[userID] = kept
		return false
	}
	l.hits[userID] = append(kept, now)
	return true
}

type aiSettingsView struct {
	Configured  bool   `json:"configured"`
	Provider    string `json:"provider"`
	BaseURL     string `json:"baseUrl"`
	Model       string `json:"model"`
	KeyHint     string `json:"keyHint,omitempty"`
	ServerReady bool   `json:"serverReady"`
}

func (s *Server) getAISettings(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	view := aiSettingsView{Provider: "openai", BaseURL: aiDefaultBase, Model: aiDefaultModel, ServerReady: len(s.AISecret) == 32}
	cur, err := s.Store.AISettings(r.Context(), u.ID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, r, err)
		return
	}
	if err == nil {
		provider, _ := normalizeProvider(cur.Provider)
		view = aiSettingsView{Configured: true, Provider: provider, BaseURL: cur.BaseURL, Model: cur.Model, KeyHint: cur.KeyHint, ServerReady: view.ServerReady}
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, view)
}

func (s *Server) putAISettings(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	var in struct {
		Provider string `json:"provider"`
		BaseURL  string `json:"baseUrl"`
		Model    string `json:"model"`
		APIKey   string `json:"apiKey"` // empty keeps the saved key
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if len(s.AISecret) != 32 {
		httpx.Error(w, http.StatusServiceUnavailable, "ai_secret_missing", "服务器未配置 JIANGE_SECRET_KEY，暂不能保存 API Key，请联系管理员")
		return
	}
	provider, ok := normalizeProvider(in.Provider)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_provider", "不支持的接口协议")
		return
	}
	base, ok := s.normalizeAIBase(in.BaseURL, provider)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_base_url", "接口地址需为 https 开头的 OpenAI 兼容或 Anthropic 地址")
		return
	}
	model := strings.TrimSpace(in.Model)
	if model == "" {
		_, model = aiDefaults(provider)
	}
	if !reAIModel.MatchString(model) {
		httpx.Error(w, http.StatusBadRequest, "invalid_model", "模型名称无效")
		return
	}
	next := store.AISettings{UserID: u.ID, Provider: provider, BaseURL: base, Model: model}
	key := strings.TrimSpace(in.APIKey)
	if key == "" {
		cur, err := s.Store.AISettings(r.Context(), u.ID)
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusBadRequest, "missing_api_key", "请填写 API Key")
			return
		}
		if err != nil {
			s.fail(w, r, err)
			return
		}
		next.APIKeyCipher, next.KeyHint = cur.APIKeyCipher, cur.KeyHint
	} else {
		if utf8.RuneCountInString(key) < 8 || len(key) > 512 || strings.ContainsFunc(key, func(c rune) bool { return c <= ' ' || c == 0x7f }) {
			httpx.Error(w, http.StatusBadRequest, "invalid_api_key", "API Key 格式无效")
			return
		}
		sealed, err := sealAIKey(s.AISecret, u.ID, key)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		next.APIKeyCipher, next.KeyHint = sealed, key[len(key)-4:]
	}
	if err := s.Store.SetAISettings(r.Context(), next); err != nil {
		s.fail(w, r, err)
		return
	}
	s.getAISettings(w, r)
}

func (s *Server) deleteAISettings(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	if err := s.Store.DeleteAISettings(r.Context(), u.ID); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type aiMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

var errAINotConfigured = errors.New("ai not configured")

type aiProviderError struct {
	status  int
	code    string
	message string
}

func (e aiProviderError) Error() string { return e.message }

// callAI sends one chat completion with the caller's own settings.
func (s *Server) callAI(ctx context.Context, userID int64, messages []aiMessage) (string, error) {
	cur, err := s.Store.AISettings(ctx, userID)
	if errors.Is(err, store.ErrNotFound) {
		return "", errAINotConfigured
	}
	if err != nil {
		return "", err
	}
	if len(s.AISecret) != 32 {
		return "", aiProviderError{http.StatusServiceUnavailable, "ai_secret_missing", "服务器未配置 JIANGE_SECRET_KEY，无法读取已保存的 API Key"}
	}
	key, err := openAIKey(s.AISecret, userID, cur.APIKeyCipher)
	if err != nil {
		return "", aiProviderError{http.StatusConflict, "ai_key_unreadable", "已保存的 API Key 无法解密（服务端密钥可能已更换），请在 AI 设置中重新填写"}
	}
	provider, _ := normalizeProvider(cur.Provider)
	base, ok := s.normalizeAIBase(cur.BaseURL, provider)
	if !ok {
		return "", aiProviderError{http.StatusBadRequest, "invalid_base_url", "接口地址无效，请在 AI 设置中修改"}
	}
	var req *http.Request
	if provider == "anthropic" {
		req, err = anthropicRequest(ctx, base, key, cur.Model, messages)
	} else {
		body, _ := json.Marshal(map[string]any{"model": cur.Model, "messages": messages, "max_tokens": 2048, "temperature": 0.3})
		req, err = http.NewRequestWithContext(ctx, http.MethodPost, base+"/chat/completions", bytes.NewReader(body))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+key)
		}
	}
	if err != nil {
		return "", err
	}
	res, err := s.aiClient().Do(req)
	if err != nil {
		if errors.Is(err, errBlockedAddress) || strings.Contains(err.Error(), errBlockedAddress.Error()) {
			return "", aiProviderError{http.StatusBadRequest, "ai_blocked_address", "接口地址指向内网或保留地址，已拒绝"}
		}
		return "", aiProviderError{http.StatusBadGateway, "ai_unreachable", "无法连接 AI 服务，请检查接口地址或稍后重试"}
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, aiMaxResponse+1))
	if err != nil || len(raw) > aiMaxResponse {
		return "", aiProviderError{http.StatusBadGateway, "ai_bad_response", "AI 服务响应过大或中断"}
	}
	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return "", aiProviderError{http.StatusBadGateway, "ai_auth_failed", "API Key 无效或没有该模型的权限"}
	case res.StatusCode == http.StatusTooManyRequests:
		return "", aiProviderError{http.StatusTooManyRequests, "ai_rate_limited", "AI 服务限流或额度不足，请稍后重试"}
	case res.StatusCode >= 300:
		return "", aiProviderError{http.StatusBadGateway, "ai_failed", fmt.Sprintf("AI 服务返回错误（HTTP %d）", res.StatusCode)}
	}
	if provider == "anthropic" {
		return parseAnthropic(raw)
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(raw, &out) != nil || len(out.Choices) == 0 {
		return "", aiProviderError{http.StatusBadGateway, "ai_bad_response", "AI 服务返回了无法识别的结果"}
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}

func (s *Server) aiError(w http.ResponseWriter, r *http.Request, err error) {
	var pe aiProviderError
	switch {
	case errors.Is(err, errAINotConfigured):
		httpx.Error(w, http.StatusPreconditionFailed, "ai_not_configured", "尚未配置 AI，请在「设置 → AI」中填写 API Key")
	case errors.As(err, &pe):
		httpx.Error(w, pe.status, pe.code, pe.message)
	default:
		s.fail(w, r, err)
	}
}

func (s *Server) testAISettings(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	if !aiRate.allow(u.ID, s.now()) {
		httpx.Error(w, http.StatusTooManyRequests, "ai_rate_limited", "请求过于频繁，请稍后再试")
		return
	}
	text, err := s.callAI(r.Context(), u.ID, []aiMessage{{Role: "user", Content: "Reply with: OK"}})
	if err != nil {
		s.aiError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"text": text})
}

// docAI runs a completion on behalf of a document the caller may read and copy.
func (s *Server) docAI(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	if !store.DocumentCopyAllowed(d, d.Role) {
		httpx.Error(w, http.StatusForbidden, "copy_restricted", "该文档禁止复制内容，不能发送给 AI")
		return
	}
	var in struct {
		Messages []aiMessage `json:"messages"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if len(in.Messages) == 0 || len(in.Messages) > aiMaxMessages {
		httpx.Error(w, http.StatusBadRequest, "invalid_messages", "消息数量无效")
		return
	}
	total := 0
	for _, m := range in.Messages {
		if m.Role != "system" && m.Role != "user" && m.Role != "assistant" {
			httpx.Error(w, http.StatusBadRequest, "invalid_messages", "消息角色无效")
			return
		}
		total += utf8.RuneCountInString(m.Content)
	}
	if total == 0 || total > aiMaxInputChars {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "ai_input_too_large", fmt.Sprintf("发送给 AI 的内容需在 1-%d 字之间", aiMaxInputChars))
		return
	}
	u, _ := UserFrom(r.Context())
	if !aiRate.allow(u.ID, s.now()) {
		httpx.Error(w, http.StatusTooManyRequests, "ai_rate_limited", "请求过于频繁，请稍后再试")
		return
	}
	text, err := s.callAI(r.Context(), u.ID, in.Messages)
	if err != nil {
		s.aiError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"text": text})
}

// anthropicRequest builds a Messages API call: system prompts go to the top-level
// "system" field, and consecutive same-role turns are merged (the API requires
// alternating user/assistant roles starting with user).
func anthropicRequest(ctx context.Context, base, key, model string, messages []aiMessage) (*http.Request, error) {
	var system []string
	turns := []aiMessage{}
	for _, m := range messages {
		if m.Role == "system" {
			system = append(system, m.Content)
			continue
		}
		if n := len(turns); n > 0 && turns[n-1].Role == m.Role {
			turns[n-1].Content += "\n\n" + m.Content
			continue
		}
		turns = append(turns, m)
	}
	if len(turns) == 0 || turns[0].Role != "user" {
		turns = append([]aiMessage{{Role: "user", Content: "（开始）"}}, turns...)
	}
	payload := map[string]any{"model": model, "max_tokens": 2048, "temperature": 0.3, "messages": turns}
	if len(system) > 0 {
		payload["system"] = strings.Join(system, "\n\n")
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/messages", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", key)
	req.Header.Set("anthropic-version", aiAnthropicVersion)
	return req, nil
}

func parseAnthropic(raw []byte) (string, error) {
	var out struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(raw, &out) != nil {
		return "", aiProviderError{http.StatusBadGateway, "ai_bad_response", "AI 服务返回了无法识别的结果"}
	}
	var parts []string
	for _, c := range out.Content {
		if c.Type == "text" {
			parts = append(parts, c.Text)
		}
	}
	if len(parts) == 0 {
		return "", aiProviderError{http.StatusBadGateway, "ai_bad_response", "AI 服务返回了无法识别的结果"}
	}
	return strings.TrimSpace(strings.Join(parts, "")), nil
}
