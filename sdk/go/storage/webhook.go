package storage

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// SignatureHeader is the HTTP header carrying the HMAC-SHA256 webhook signature.
const SignatureHeader = "X-Jiange-Signature"

// WebhookEvent represents a signed outbound lifecycle notification.
type WebhookEvent struct {
	ID        string         `json:"id"`
	Type      string         `json:"type"`
	DocID     string         `json:"docId,omitempty"`
	Kind      string         `json:"kind,omitempty"`
	Timestamp time.Time      `json:"timestamp"`
	Payload   map[string]any `json:"payload,omitempty"`
}

// SignPayload computes the HMAC-SHA256 signature ("sha256=<hex>") for payload using secret.
func SignPayload(secret string, payload []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(payload)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// VerifySignature validates a webhook signature in constant time.
func VerifySignature(secret string, payload []byte, signature string) bool {
	expected := SignPayload(secret, payload)
	return hmac.Equal([]byte(expected), []byte(signature))
}

// WebhookDispatcher delivers signed WebhookEvents to an HTTP endpoint.
type WebhookDispatcher struct {
	url    string
	secret string
	client *http.Client
}

// NewWebhookDispatcher creates a WebhookDispatcher targeting url and signing with secret.
func NewWebhookDispatcher(url, secret string, client *http.Client) *WebhookDispatcher {
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	return &WebhookDispatcher{
		url:    url,
		secret: secret,
		client: client,
	}
}

// Dispatch serializes evt, signs it with HMAC-SHA256, and POSTs it to the configured URL.
func (d *WebhookDispatcher) Dispatch(ctx context.Context, evt WebhookEvent) error {
	if evt.ID == "" {
		evt.ID = GenerateID("evt_")
	}
	if evt.Timestamp.IsZero() {
		evt.Timestamp = time.Now().UTC()
	}
	body, err := json.Marshal(evt)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(SignatureHeader, SignPayload(d.secret, body))

	resp, err := d.client.Do(req)
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("webhook returned status %d", resp.StatusCode)
	}
	return nil
}
