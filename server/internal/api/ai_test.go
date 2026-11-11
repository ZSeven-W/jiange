package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newAITestServer(t *testing.T, mem *store.Memory, secret []byte) (*httptest.Server, *http.Client) {
	t.Helper()
	s := &Server{Store: mem, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 1000, AISecret: secret, AIAllowHTTP: true,
		PreviewAllow: func(ip netip.Addr) bool { return true }}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	return ts, &http.Client{Jar: jar}
}

func TestPersonalAISettingsAndDocAI(t *testing.T) {
	var gotAuth, gotModel string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		var body struct {
			Model string `json:"model"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		gotModel = body.Model
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(`{"choices":[{"message":{"content":" 你好 "}}]}`))
	}))
	defer provider.Close()
	mem := store.NewMemory()

	// Without a server secret, keys are never stored.
	ts0, c0 := newAITestServer(t, mem, nil)
	post(t, c0, ts0.URL+"/api/auth/register", map[string]string{"email": "ai0@example.test", "name": "A", "password": "password123"})
	if res := send(t, c0, "PUT", ts0.URL+"/api/me/ai", map[string]string{"baseUrl": provider.URL + "/v1", "apiKey": "sk-test-123456"}); res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("no secret status=%d", res.StatusCode)
	}

	ts, c := newAITestServer(t, mem, AISecretFromEnv("unit-test-secret"))
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "ai@example.test", "name": "Owner", "password": "password123"})
	var doc store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/docs", map[string]string{"title": "AI"}).Body).Decode(&doc)
	aiPath := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10) + "/ai"
	ask := map[string]any{"messages": []map[string]string{{"role": "user", "content": "总结"}}}
	if res := send(t, c, "POST", aiPath, ask); res.StatusCode != http.StatusPreconditionFailed {
		t.Fatalf("unconfigured status=%d", res.StatusCode)
	}
	if res := send(t, c, "PUT", ts.URL+"/api/me/ai", map[string]string{"baseUrl": "ftp://x", "apiKey": "sk-test-123456"}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad url status=%d", res.StatusCode)
	}
	res := send(t, c, "PUT", ts.URL+"/api/me/ai", map[string]string{"baseUrl": provider.URL + "/v1/", "model": "deepseek-chat", "apiKey": "sk-test-123456"})
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK || strings.Contains(string(raw), "sk-test-123456") || !strings.Contains(string(raw), `"keyHint":"3456"`) {
		t.Fatalf("save status=%d body=%s", res.StatusCode, raw)
	}
	// Stored ciphertext is not the plaintext key and is bound to the user.
	u, _ := mem.UserByEmail(t.Context(), "ai@example.test")
	saved, err := mem.AISettings(t.Context(), u.ID)
	if err != nil || bytes.Contains(saved.APIKeyCipher, []byte("sk-test")) {
		t.Fatalf("saved=%v err=%v", saved, err)
	}
	if _, err := openAIKey(AISecretFromEnv("unit-test-secret"), u.ID+1, saved.APIKeyCipher); err == nil {
		t.Fatal("ciphertext opened for another user")
	}
	res = send(t, c, "POST", aiPath, ask)
	var out struct{ Text string }
	json.NewDecoder(res.Body).Decode(&out)
	if res.StatusCode != http.StatusOK || out.Text != "你好" || gotAuth != "Bearer sk-test-123456" || gotModel != "deepseek-chat" {
		t.Fatalf("ai status=%d text=%q auth=%q model=%q", res.StatusCode, out.Text, gotAuth, gotModel)
	}
	// Updating without a key keeps the saved one.
	if res := send(t, c, "PUT", ts.URL+"/api/me/ai", map[string]string{"baseUrl": provider.URL + "/v1", "model": "gpt-4o-mini"}); res.StatusCode != http.StatusOK {
		t.Fatalf("keep key status=%d", res.StatusCode)
	}
	send(t, c, "POST", aiPath, ask)
	if gotAuth != "Bearer sk-test-123456" || gotModel != "gpt-4o-mini" {
		t.Fatalf("after update auth=%q model=%q", gotAuth, gotModel)
	}
	// Oversized input and copy-protected documents are refused.
	big := map[string]any{"messages": []map[string]string{{"role": "user", "content": strings.Repeat("字", aiMaxInputChars+1)}}}
	if res := send(t, c, "POST", aiPath, big); res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("big status=%d", res.StatusCode)
	}
	if res := send(t, c, "DELETE", ts.URL+"/api/me/ai", nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete status=%d", res.StatusCode)
	}
	if res := send(t, c, "POST", aiPath, ask); res.StatusCode != http.StatusPreconditionFailed {
		t.Fatalf("after delete status=%d", res.StatusCode)
	}
}

func TestAIBlocksPrivateAddresses(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"choices":[{"message":{"content":"x"}}]}`)) }))
	defer provider.Close()
	mem := store.NewMemory()
	s := &Server{Store: mem, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 1000, AISecret: AISecretFromEnv("k"), AIAllowHTTP: true}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "ssrf@example.test", "name": "S", "password": "password123"})
	send(t, c, "PUT", ts.URL+"/api/me/ai", map[string]string{"baseUrl": provider.URL, "apiKey": "sk-test-123456"})
	res := send(t, c, "POST", ts.URL+"/api/me/ai/test", nil)
	var body struct {
		Code string `json:"error"`
	}
	json.NewDecoder(res.Body).Decode(&body)
	if res.StatusCode != http.StatusBadRequest || body.Code != "ai_blocked_address" {
		t.Fatalf("loopback provider status=%d code=%q", res.StatusCode, body.Code)
	}
}

func TestAnthropicProvider(t *testing.T) {
	var headers http.Header
	var payload struct {
		Model    string      `json:"model"`
		System   string      `json:"system"`
		Messages []aiMessage `json:"messages"`
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers = r.Header.Clone()
		json.NewDecoder(r.Body).Decode(&payload)
		if r.URL.Path != "/v1/messages" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(`{"content":[{"type":"text","text":"Hello "},{"type":"text","text":"world"}]}`))
	}))
	defer provider.Close()
	ts, c := newAITestServer(t, store.NewMemory(), AISecretFromEnv("unit-test-secret"))
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "claude@example.test", "name": "C", "password": "password123"})
	if res := send(t, c, "PUT", ts.URL+"/api/me/ai", map[string]string{"provider": "gemini", "apiKey": "sk-ant-123456"}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad provider status=%d", res.StatusCode)
	}
	res := send(t, c, "PUT", ts.URL+"/api/me/ai", map[string]string{"provider": "anthropic", "baseUrl": provider.URL + "/v1", "apiKey": "sk-ant-123456"})
	var view aiSettingsView
	json.NewDecoder(res.Body).Decode(&view)
	if res.StatusCode != http.StatusOK || view.Provider != "anthropic" || view.Model != aiAnthropicModel {
		t.Fatalf("save status=%d view=%+v", res.StatusCode, view)
	}
	var doc store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/docs", map[string]string{"title": "C"}).Body).Decode(&doc)
	ask := map[string]any{"messages": []map[string]string{{"role": "system", "content": "规则"}, {"role": "user", "content": "一"}, {"role": "user", "content": "二"}}}
	res = send(t, c, "POST", ts.URL+"/api/docs/"+strconv.FormatInt(doc.ID, 10)+"/ai", ask)
	var out struct{ Text string }
	json.NewDecoder(res.Body).Decode(&out)
	if res.StatusCode != http.StatusOK || out.Text != "Hello world" {
		t.Fatalf("status=%d text=%q", res.StatusCode, out.Text)
	}
	if headers.Get("x-api-key") != "sk-ant-123456" || headers.Get("anthropic-version") == "" || headers.Get("Authorization") != "" {
		t.Fatalf("headers=%v", headers)
	}
	if payload.System != "规则" || len(payload.Messages) != 1 || payload.Messages[0].Content != "一\n\n二" {
		t.Fatalf("payload=%+v", payload)
	}
}
