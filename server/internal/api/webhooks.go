package api

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
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
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const (
	webhookHTTPTimeout        = 8 * time.Second
	webhookDispatchBudget     = 20 * time.Second
	webhookMaxResponsePreview = 1024
	webhookMaxAttempts        = 3
	webhookMaxSecretLen       = 256
	webhookDevSecretSeed      = "jiange-dev-webhook-secret"
)

func (s *Server) webhookStore() (store.WebhookStore, bool) {
	st, ok := s.Store.(store.WebhookStore)
	return st, ok
}

// webhookSecretKey derives the 32-byte AES-256 key used to seal webhook signing secrets.
// In production it derives from s.AISecret (JIANGE_SECRET_KEY); in local dev it falls back
// to a deterministic dev seed so self-hosted development works out of the box.
func (s *Server) webhookSecretKey() []byte {
	if len(s.AISecret) > 0 {
		h := sha256.New()
		h.Write([]byte("jiange-webhook-secret-key:"))
		h.Write(s.AISecret)
		return h.Sum(nil)
	}
	sum := sha256.Sum256([]byte(webhookDevSecretSeed))
	return sum[:]
}

func webhookAAD(workspaceID int64) []byte {
	return []byte("jiange-webhook-secret:" + strconv.FormatInt(workspaceID, 10))
}

func sealWebhookSecret(key []byte, workspaceID int64, secret string) ([]byte, error) {
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
	return gcm.Seal(nonce, nonce, []byte(secret), webhookAAD(workspaceID)), nil
}

func openWebhookSecret(key []byte, workspaceID int64, sealed []byte) (string, error) {
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
	plain, err := gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], webhookAAD(workspaceID))
	return string(plain), err
}

func generateWebhookSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func generateWebhookDeliveryID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(b)
}

func webhookSecretHint(secret string) string {
	n := len(secret)
	if n == 0 {
		return ""
	}
	if n >= 4 {
		return secret[n-4:]
	}
	return "****"
}

func signWebhookPayload(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func (s *Server) validateWebhookTargetURL(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 1024 {
		return "", false
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" {
		return "", false
	}
	if u.Scheme != "https" && !(s.WebhookAllowHTTP && u.Scheme == "http") {
		return "", false
	}
	if s.WebhookTransport == nil && !s.WebhookAllowHTTP {
		allow := publicAddr
		if s.PreviewAllow != nil {
			allow = s.PreviewAllow
		}
		if ip, err := netip.ParseAddr(u.Hostname()); err == nil && !allow(ip) {
			return "", false
		}
	}
	return u.String(), true
}

func (s *Server) webhookClient() *http.Client {
	if s.WebhookTransport != nil {
		return &http.Client{
			Timeout:   webhookHTTPTimeout,
			Transport: s.WebhookTransport,
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
		Timeout: 5 * time.Second,
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
		Timeout: webhookHTTPTimeout,
		Transport: &http.Transport{
			Proxy:                  nil,
			DialContext:            dialer.DialContext,
			TLSHandshakeTimeout:    5 * time.Second,
			ResponseHeaderTimeout:  webhookHTTPTimeout,
			MaxResponseHeaderBytes: 64 << 10,
			DisableKeepAlives:      true,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func webhookRetryDelay(attempt int, fast bool) time.Duration {
	if fast {
		if attempt == 1 {
			return 20 * time.Millisecond
		}
		return 50 * time.Millisecond
	}
	if attempt == 1 {
		return 1 * time.Second
	}
	return 3 * time.Second
}

func (s *Server) buildWebhookEnvelope(wsID int64, eventType, deliveryID string, dataRaw json.RawMessage) []byte {
	if len(bytes.TrimSpace(dataRaw)) == 0 || !json.Valid(dataRaw) {
		dataRaw = json.RawMessage("{}")
	}
	env := struct {
		ID          string          `json:"id"`
		Event       string          `json:"event"`
		WorkspaceID int64           `json:"workspaceId"`
		Timestamp   string          `json:"timestamp"`
		Data        json.RawMessage `json:"data"`
	}{
		ID:          deliveryID,
		Event:       eventType,
		WorkspaceID: wsID,
		Timestamp:   s.now().UTC().Format(time.RFC3339),
		Data:        dataRaw,
	}
	b, err := json.Marshal(env)
	if err != nil {
		return []byte(`{}`)
	}
	return b
}

func marshalWebhookData(payload map[string]any) json.RawMessage {
	if len(payload) == 0 {
		return json.RawMessage("{}")
	}
	b, err := json.Marshal(payload)
	if err != nil || len(b) == 0 {
		return json.RawMessage("{}")
	}
	return json.RawMessage(b)
}

func truncateWebhookBytes(b []byte, maxBytes int) string {
	if len(b) > maxBytes {
		b = b[:maxBytes]
	}
	s := strings.ToValidUTF8(string(b), "")
	for len(s) > maxBytes {
		s = s[:len(s)-1]
	}
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}

// deliverWebhookAttempt executes a single signed HTTP POST attempt without recording it.
// Returns the delivery record and whether the failure is eligible for retry.
func (s *Server) deliverWebhookAttempt(ctx context.Context, wh store.WorkspaceWebhook, eventType, deliveryID string, bodyBytes []byte, attempt int) (store.WebhookDelivery, bool) {
	delivery := store.WebhookDelivery{
		WebhookID:   wh.ID,
		WorkspaceID: wh.WorkspaceID,
		EventType:   eventType,
		Payload:     json.RawMessage(append([]byte(nil), bodyBytes...)),
		Attempt:     attempt,
		CreatedAt:   s.now().UTC(),
	}

	targetURL, ok := s.validateWebhookTargetURL(wh.URL)
	if !ok {
		delivery.ErrorMsg = "webhook target URL rejected by security policy"
		return delivery, false
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(bodyBytes))
	if err != nil {
		delivery.ErrorMsg = err.Error()
		return delivery, false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Jiange-Webhook/1.0")
	req.Header.Set("X-Jiange-Event", eventType)
	req.Header.Set("X-Jiange-Delivery", deliveryID)

	if len(wh.SecretEnc) > 0 {
		secret, err := openWebhookSecret(s.webhookSecretKey(), wh.WorkspaceID, wh.SecretEnc)
		if err != nil {
			delivery.ErrorMsg = "failed to decrypt webhook signing secret"
			return delivery, false
		}
		if secret != "" {
			req.Header.Set("X-Jiange-Signature", signWebhookPayload(secret, bodyBytes))
		}
	}

	res, err := s.webhookClient().Do(req)
	if err != nil {
		if errors.Is(err, errBlockedAddress) || strings.Contains(err.Error(), errBlockedAddress.Error()) {
			delivery.ErrorMsg = "target address blocked by SSRF policy"
			return delivery, false
		}
		delivery.ErrorMsg = err.Error()
		return delivery, true
	}
	defer res.Body.Close()

	respRaw, _ := io.ReadAll(io.LimitReader(res.Body, webhookMaxResponsePreview))
	delivery.StatusCode = res.StatusCode
	delivery.ResponseBody = truncateWebhookBytes(respRaw, webhookMaxResponsePreview)
	delivery.Success = res.StatusCode >= 200 && res.StatusCode < 300
	if !delivery.Success {
		statusText := strings.TrimSpace(http.StatusText(res.StatusCode))
		if statusText != "" {
			delivery.ErrorMsg = fmt.Sprintf("HTTP %d %s", res.StatusCode, statusText)
		} else {
			delivery.ErrorMsg = fmt.Sprintf("HTTP %d", res.StatusCode)
		}
	}
	retryable := res.StatusCode >= 500 && res.StatusCode <= 599
	return delivery, retryable
}

// deliverWebhookOnce performs one synchronous signed delivery and persists its audit record.
func (s *Server) deliverWebhookOnce(ctx context.Context, wh store.WorkspaceWebhook, eventType string, payload map[string]any) store.WebhookDelivery {
	deliveryID := generateWebhookDeliveryID()
	bodyBytes := s.buildWebhookEnvelope(wh.WorkspaceID, eventType, deliveryID, marshalWebhookData(payload))
	delivery, _ := s.deliverWebhookAttempt(ctx, wh, eventType, deliveryID, bodyBytes, 1)
	if st, ok := s.webhookStore(); ok {
		if saved, err := st.RecordWebhookDelivery(ctx, delivery); err == nil {
			return saved
		} else if s.Log != nil {
			s.Log.Warn("record webhook delivery failed", "webhookId", wh.ID, "event", eventType, "err", err)
		}
	}
	return delivery
}

// dispatchWorkspaceEvent asynchronously fans out a workspace event to all enabled webhooks
// subscribed to eventType, signing each request with HMAC-SHA256 and retrying up to 3 times
// on network errors or 5xx responses.
func (s *Server) dispatchWorkspaceEvent(wsID int64, eventType string, payload map[string]any) {
	if s == nil || s.Store == nil || wsID <= 0 || !store.IsValidWebhookEvent(eventType) {
		return
	}
	st, ok := s.webhookStore()
	if !ok {
		return
	}
	// Snapshot payload eagerly on the caller goroutine to avoid data races.
	dataRaw := marshalWebhookData(payload)

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), webhookDispatchBudget)
		defer cancel()

		webhooks, err := st.ListEnabledWebhooksForEvent(ctx, wsID, eventType)
		if err != nil {
			if s.Log != nil {
				s.Log.Warn("list webhooks for event failed", "wsId", wsID, "event", eventType, "err", err)
			}
			return
		}
		if len(webhooks) == 0 {
			return
		}

		var wg sync.WaitGroup
		for _, wh := range webhooks {
			wh := wh
			wg.Add(1)
			go func() {
				defer wg.Done()
				deliveryID := generateWebhookDeliveryID()
				bodyBytes := s.buildWebhookEnvelope(wsID, eventType, deliveryID, dataRaw)
				for attempt := 1; attempt <= webhookMaxAttempts; attempt++ {
					if ctx.Err() != nil {
						return
					}
					d, retryable := s.deliverWebhookAttempt(ctx, wh, eventType, deliveryID, bodyBytes, attempt)
					if _, recErr := st.RecordWebhookDelivery(ctx, d); recErr != nil && s.Log != nil {
						s.Log.Warn("record webhook delivery failed", "webhookId", wh.ID, "attempt", attempt, "err", recErr)
					}
					if d.Success || !retryable || attempt == webhookMaxAttempts {
						return
					}
					delay := webhookRetryDelay(attempt, s.WebhookAllowHTTP)
					timer := time.NewTimer(delay)
					select {
					case <-ctx.Done():
						timer.Stop()
						return
					case <-timer.C:
					}
				}
			}()
		}
		wg.Wait()
	}()
}

func (s *Server) webhookError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "仅空间所有者或管理员可管理 Webhook")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "Webhook 不存在")
	case errors.Is(err, store.ErrWebhookLimitReached):
		httpx.Error(w, http.StatusConflict, "webhook_limit_reached", fmt.Sprintf("当前空间最多可配置 %d 个 Webhook", store.MaxWebhooksPerWorkspace))
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "webhook_conflict", "Webhook 参数无效或发生冲突")
	default:
		s.fail(w, r, err)
	}
}

// listWorkspaceWebhooks handles GET /api/workspaces/{wsId}/webhooks.
func (s *Server) listWorkspaceWebhooks(w http.ResponseWriter, r *http.Request) {
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
	st, ok := s.webhookStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "webhooks_unavailable", "Webhook 服务未启用")
		return
	}
	webhooks, err := st.ListWorkspaceWebhooks(r.Context(), guard, wsID)
	if err != nil {
		s.webhookError(w, r, err)
		return
	}
	if webhooks == nil {
		webhooks = []store.WorkspaceWebhook{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"webhooks": webhooks})
}

type createWorkspaceWebhookRequest struct {
	Name    string   `json:"name"`
	URL     string   `json:"url"`
	Secret  string   `json:"secret"`
	Events  []string `json:"events"`
	Enabled *bool    `json:"enabled"`
}

// createWorkspaceWebhook handles POST /api/workspaces/{wsId}/webhooks.
func (s *Server) createWorkspaceWebhook(w http.ResponseWriter, r *http.Request) {
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
	st, ok := s.webhookStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "webhooks_unavailable", "Webhook 服务未启用")
		return
	}
	var in createWorkspaceWebhookRequest
	if !httpx.Decode(w, r, &in) {
		return
	}

	name := strings.TrimSpace(in.Name)
	if n := utf8.RuneCountInString(name); n < 1 || n > 80 {
		httpx.Error(w, http.StatusBadRequest, "invalid_name", "Webhook 名称需为 1-80 个字符")
		return
	}
	targetURL, ok := s.validateWebhookTargetURL(in.URL)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_url", "请填写有效的公网 HTTPS 回调地址")
		return
	}
	events, ok := store.NormalizeWebhookEvents(in.Events)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_events", "请至少选择一个有效的订阅事件")
		return
	}

	rawSecret := strings.TrimSpace(in.Secret)
	if rawSecret == "" {
		var err error
		rawSecret, err = generateWebhookSecret()
		if err != nil {
			s.fail(w, r, err)
			return
		}
	} else if len(rawSecret) > webhookMaxSecretLen {
		httpx.Error(w, http.StatusBadRequest, "invalid_secret", "签名密钥长度超出限制")
		return
	}
	secretEnc, err := sealWebhookSecret(s.webhookSecretKey(), wsID, rawSecret)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	secretHint := webhookSecretHint(rawSecret)

	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}

	created, err := st.CreateWorkspaceWebhookGuarded(r.Context(), guard, wsID, store.WorkspaceWebhookInput{
		Name:       name,
		URL:        targetURL,
		SecretEnc:  secretEnc,
		SecretHint: secretHint,
		Events:     events,
		Enabled:    enabled,
	})
	if err != nil {
		s.webhookError(w, r, err)
		return
	}
	s.recordAudit(r, wsID, "org.webhook_update", "webhook", created.ID, created.Name, map[string]any{
		"op":      "create",
		"events":  created.Events,
		"enabled": created.Enabled,
	})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"webhook":       created,
		"signingSecret": rawSecret,
	})
}

type updateWorkspaceWebhookRequest struct {
	Name             *string   `json:"name"`
	URL              *string   `json:"url"`
	Secret           *string   `json:"secret"`
	RegenerateSecret bool      `json:"regenerateSecret"`
	Events           *[]string `json:"events"`
	Enabled          *bool     `json:"enabled"`
}

// updateWorkspaceWebhook handles PATCH /api/workspaces/{wsId}/webhooks/{wid}.
func (s *Server) updateWorkspaceWebhook(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	wid, ok := s.parsePositivePathID(w, r, "wid")
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
	st, ok := s.webhookStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "webhooks_unavailable", "Webhook 服务未启用")
		return
	}
	var in updateWorkspaceWebhookRequest
	if !httpx.Decode(w, r, &in) {
		return
	}

	patch := store.WorkspaceWebhookPatch{
		Enabled: in.Enabled,
	}
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if n := utf8.RuneCountInString(name); n < 1 || n > 80 {
			httpx.Error(w, http.StatusBadRequest, "invalid_name", "Webhook 名称需为 1-80 个字符")
			return
		}
		patch.Name = &name
	}
	if in.URL != nil {
		targetURL, ok := s.validateWebhookTargetURL(*in.URL)
		if !ok {
			httpx.Error(w, http.StatusBadRequest, "invalid_url", "请填写有效的公网 HTTPS 回调地址")
			return
		}
		patch.URL = &targetURL
	}
	if in.Events != nil {
		events, ok := store.NormalizeWebhookEvents(*in.Events)
		if !ok {
			httpx.Error(w, http.StatusBadRequest, "invalid_events", "请至少选择一个有效的订阅事件")
			return
		}
		patch.Events = &events
	}

	var rotatedSecret string
	if in.RegenerateSecret {
		rawSecret, err := generateWebhookSecret()
		if err != nil {
			s.fail(w, r, err)
			return
		}
		sealed, err := sealWebhookSecret(s.webhookSecretKey(), wsID, rawSecret)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		patch.UpdateSecret = true
		patch.SecretEnc = sealed
		patch.SecretHint = webhookSecretHint(rawSecret)
		rotatedSecret = rawSecret
	} else if in.Secret != nil && strings.TrimSpace(*in.Secret) != "" {
		rawSecret := strings.TrimSpace(*in.Secret)
		if len(rawSecret) > webhookMaxSecretLen {
			httpx.Error(w, http.StatusBadRequest, "invalid_secret", "签名密钥长度超出限制")
			return
		}
		sealed, err := sealWebhookSecret(s.webhookSecretKey(), wsID, rawSecret)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		patch.UpdateSecret = true
		patch.SecretEnc = sealed
		patch.SecretHint = webhookSecretHint(rawSecret)
	}

	updated, err := st.UpdateWorkspaceWebhookGuarded(r.Context(), guard, wsID, wid, patch)
	if err != nil {
		s.webhookError(w, r, err)
		return
	}
	s.recordAudit(r, wsID, "org.webhook_update", "webhook", updated.ID, updated.Name, map[string]any{
		"op":      "update",
		"events":  updated.Events,
		"enabled": updated.Enabled,
	})
	resp := map[string]any{"webhook": updated}
	if rotatedSecret != "" {
		resp["signingSecret"] = rotatedSecret
	}
	httpx.JSON(w, http.StatusOK, resp)
}

// deleteWorkspaceWebhook handles DELETE /api/workspaces/{wsId}/webhooks/{wid}.
func (s *Server) deleteWorkspaceWebhook(w http.ResponseWriter, r *http.Request) {
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	wid, ok := s.parsePositivePathID(w, r, "wid")
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
	st, ok := s.webhookStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "webhooks_unavailable", "Webhook 服务未启用")
		return
	}
	if err := st.DeleteWorkspaceWebhookGuarded(r.Context(), guard, wsID, wid); err != nil {
		s.webhookError(w, r, err)
		return
	}
	s.recordAudit(r, wsID, "org.webhook_update", "webhook", wid, "", map[string]any{"op": "delete"})
	w.WriteHeader(http.StatusNoContent)
}

// testWorkspaceWebhook handles POST /api/workspaces/{wsId}/webhooks/{wid}/test.
func (s *Server) testWorkspaceWebhook(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	wid, ok := s.parsePositivePathID(w, r, "wid")
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
	st, ok := s.webhookStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "webhooks_unavailable", "Webhook 服务未启用")
		return
	}
	wh, err := st.GetWorkspaceWebhookGuarded(r.Context(), guard, wsID, wid)
	if err != nil {
		s.webhookError(w, r, err)
		return
	}

	start := time.Now()
	delivery := s.deliverWebhookOnce(r.Context(), wh, store.WebhookEventTest, map[string]any{
		"webhookId":   wh.ID,
		"webhookName": wh.Name,
		"triggeredBy": guard.UserID,
		"message":     "Jiange webhook test event",
	})
	latencyMs := time.Since(start).Milliseconds()

	httpx.JSON(w, http.StatusOK, map[string]any{
		"delivery":  delivery,
		"latencyMs": latencyMs,
	})
}

// listWebhookDeliveries handles GET /api/workspaces/{wsId}/webhooks/{wid}/deliveries.
func (s *Server) listWebhookDeliveries(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	wid, ok := s.parsePositivePathID(w, r, "wid")
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
	st, ok := s.webhookStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "webhooks_unavailable", "Webhook 服务未启用")
		return
	}

	limit := 0
	if rawLimit := strings.TrimSpace(r.URL.Query().Get("limit")); rawLimit != "" {
		v, err := strconv.Atoi(rawLimit)
		if err != nil || v <= 0 {
			httpx.Error(w, http.StatusBadRequest, "invalid_limit", "limit 必须为正整数")
			return
		}
		limit = v
	}

	deliveries, err := st.ListWebhookDeliveriesGuarded(r.Context(), guard, wsID, wid, limit)
	if err != nil {
		s.webhookError(w, r, err)
		return
	}
	if deliveries == nil {
		deliveries = []store.WebhookDelivery{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deliveries": deliveries})
}
