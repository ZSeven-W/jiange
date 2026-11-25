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
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"choices":[{"message":{"content":"x"}}]}`))
	}))
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

func newAIDocStreamTestServer(t *testing.T, mem *store.Memory, secret []byte) (*httptest.Server, *http.Client) {
	t.Helper()
	s := &Server{
		Store:        mem,
		Log:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL:   time.Hour,
		Iterations:   1000,
		AISecret:     secret,
		AIAllowHTTP:  true,
		PreviewAllow: func(ip netip.Addr) bool { return true },
	}
	baseHandler := s.Handler()
	mux := http.NewServeMux()
	mux.Handle("POST /api/ai/doc/stream", s.requireUser(http.HandlerFunc(s.aiDocStream)))
	mux.Handle("/", baseHandler)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	return ts, &http.Client{Jar: jar}
}

type parsedTestSSE struct {
	event string
	data  string
}

func parseTestSSE(raw string) []parsedTestSSE {
	raw = strings.ReplaceAll(raw, "\r\n", "\n")
	blocks := strings.Split(raw, "\n\n")
	var out []parsedTestSSE
	for _, block := range blocks {
		block = strings.TrimSpace(block)
		if block == "" {
			continue
		}
		ev := "message"
		var dataLines []string
		for _, line := range strings.Split(block, "\n") {
			if strings.HasPrefix(line, "event:") {
				ev = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			} else if strings.HasPrefix(line, "data:") {
				dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
			}
		}
		if len(dataLines) > 0 {
			out = append(out, parsedTestSSE{event: ev, data: strings.Join(dataLines, "\n")})
		}
	}
	return out
}

func TestAIDocStreamOpenAISSEAndFallback(t *testing.T) {
	var rejectStream bool
	var gotStreamFlag bool
	var gotAuth, gotModel string

	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		gotAuth = r.Header.Get("Authorization")
		var body struct {
			Model  string `json:"model"`
			Stream bool   `json:"stream"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotModel = body.Model
		gotStreamFlag = body.Stream

		if rejectStream && body.Stream {
			http.Error(w, `{"error":"stream unsupported"}`, http.StatusBadRequest)
			return
		}
		if !body.Stream {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"回退完整响应"}}]}`))
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		chunks := []string{
			`data: {"choices":[{"delta":{"content":"你好，"}}]}`,
			`data: {"choices":[{"delta":{"content":"简阁 AI！"}}]}`,
			`data: [DONE]`,
		}
		for _, c := range chunks {
			_, _ = io.WriteString(w, c+"\n\n")
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	defer provider.Close()

	mem := store.NewMemory()
	ts, c := newAIDocStreamTestServer(t, mem, AISecretFromEnv("unit-test-secret"))
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "stream@example.test", "name": "Owner", "password": "password123"})

	var doc store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/docs", map[string]string{"title": "StreamDoc"}).Body).Decode(&doc)
	streamURL := ts.URL + "/api/ai/doc/stream"

	// Missing docId -> 400
	res := send(t, c, "POST", streamURL, map[string]any{
		"messages": []map[string]string{{"role": "user", "content": "总结"}},
	})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing docId status=%d", res.StatusCode)
	}

	// Unconfigured AI -> 412 before SSE starts
	res = send(t, c, "POST", streamURL, map[string]any{
		"docId":    doc.ID,
		"messages": []map[string]string{{"role": "user", "content": "总结"}},
	})
	if res.StatusCode != http.StatusPreconditionFailed {
		t.Fatalf("unconfigured status=%d", res.StatusCode)
	}

	// Configure OpenAI-compatible provider
	if res := send(t, c, "PUT", ts.URL+"/api/me/ai", map[string]string{
		"baseUrl": provider.URL + "/v1",
		"model":   "deepseek-chat",
		"apiKey":  "sk-stream-987654",
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("save ai settings status=%d", res.StatusCode)
	}

	// Stream OpenAI SSE deltas -> emits event: delta and event: done
	res = send(t, c, "POST", streamURL, map[string]any{
		"docId":    doc.ID,
		"messages": []map[string]string{{"role": "user", "content": "总结这篇文档"}},
	})
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("stream status=%d body=%s", res.StatusCode, raw)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type=%q", ct)
	}
	if !gotStreamFlag || gotAuth != "Bearer sk-stream-987654" || gotModel != "deepseek-chat" {
		t.Fatalf("upstream stream=%v auth=%q model=%q", gotStreamFlag, gotAuth, gotModel)
	}

	events := parseTestSSE(string(raw))
	var deltas []string
	var done struct {
		Text     string `json:"text"`
		Provider string `json:"provider"`
		Model    string `json:"model"`
	}
	gotDone := false
	for _, ev := range events {
		switch ev.event {
		case "delta":
			var d struct{ Text string }
			if err := json.Unmarshal([]byte(ev.data), &d); err != nil {
				t.Fatalf("bad delta json %q: %v", ev.data, err)
			}
			deltas = append(deltas, d.Text)
		case "done":
			if err := json.Unmarshal([]byte(ev.data), &done); err != nil {
				t.Fatalf("bad done json %q: %v", ev.data, err)
			}
			gotDone = true
		case "error":
			t.Fatalf("unexpected error event: %s", ev.data)
		}
	}
	if len(deltas) != 2 || deltas[0] != "你好，" || deltas[1] != "简阁 AI！" {
		t.Fatalf("deltas=%v raw=%s", deltas, raw)
	}
	if !gotDone || done.Text != "你好，简阁 AI！" || done.Provider != "openai" || done.Model != "deepseek-chat" {
		t.Fatalf("done=%+v gotDone=%v", done, gotDone)
	}

	// Upstream rejects stream=true -> gracefully falls back to non-streaming callAI and streams chunks
	rejectStream = true
	res = send(t, c, "POST", streamURL, map[string]any{
		"docId":    doc.ID,
		"messages": []map[string]string{{"role": "user", "content": "回退测试"}},
	})
	raw, _ = io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("fallback status=%d body=%s", res.StatusCode, raw)
	}
	events = parseTestSSE(string(raw))
	var fbText strings.Builder
	gotDone = false
	for _, ev := range events {
		if ev.event == "delta" {
			var d struct{ Text string }
			_ = json.Unmarshal([]byte(ev.data), &d)
			fbText.WriteString(d.Text)
		} else if ev.event == "done" {
			_ = json.Unmarshal([]byte(ev.data), &done)
			gotDone = true
		}
	}
	if !gotDone || fbText.String() != "回退完整响应" || done.Text != "回退完整响应" {
		t.Fatalf("fallback gotDone=%v text=%q done=%+v raw=%s", gotDone, fbText.String(), done, raw)
	}
	rejectStream = false

	// Copy-restricted document is refused for a view-only user (403 copy_restricted).
	if err := mem.SetCopyProtected(t.Context(), doc.ID, true); err != nil {
		t.Fatalf("SetCopyProtected: %v", err)
	}
	jar2, _ := cookiejar.New(nil)
	viewer := &http.Client{Jar: jar2}
	post(t, viewer, ts.URL+"/api/auth/register", map[string]string{"email": "viewer@example.test", "name": "Viewer", "password": "password123"})
	send(t, c, "PUT", ts.URL+"/api/docs/"+strconv.FormatInt(doc.ID, 10)+"/shares", map[string]string{"email": "viewer@example.test", "role": "view"})
	send(t, viewer, "PUT", ts.URL+"/api/me/ai", map[string]string{"baseUrl": provider.URL + "/v1", "apiKey": "sk-viewer-123456"})
	res = send(t, viewer, "POST", streamURL, map[string]any{
		"docId":    doc.ID,
		"messages": []map[string]string{{"role": "user", "content": "泄露正文"}},
	})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("copy restricted status=%d", res.StatusCode)
	}
}

func TestAIDocStreamAnthropicSSE(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("x-api-key") != "sk-ant-stream-1234" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		frames := []string{
			`event: content_block_delta` + "\n" + `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Claude "}}`,
			`event: content_block_delta` + "\n" + `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"streams!"}}`,
			`event: message_stop` + "\n" + `data: {"type":"message_stop"}`,
		}
		for _, f := range frames {
			_, _ = io.WriteString(w, f+"\n\n")
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	defer provider.Close()

	ts, c := newAIDocStreamTestServer(t, store.NewMemory(), AISecretFromEnv("unit-test-secret"))
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "antstream@example.test", "name": "C", "password": "password123"})
	send(t, c, "PUT", ts.URL+"/api/me/ai", map[string]string{
		"provider": "anthropic",
		"baseUrl":  provider.URL + "/v1",
		"apiKey":   "sk-ant-stream-1234",
	})
	var doc store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/docs", map[string]string{"title": "AntStream"}).Body).Decode(&doc)

	res := send(t, c, "POST", ts.URL+"/api/ai/doc/stream", map[string]any{
		"docId":    doc.ID,
		"messages": []map[string]string{{"role": "user", "content": "hi"}},
	})
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status=%d body=%s", res.StatusCode, raw)
	}
	events := parseTestSSE(string(raw))
	var joined strings.Builder
	var done struct {
		Text     string `json:"text"`
		Provider string `json:"provider"`
		Model    string `json:"model"`
	}
	for _, ev := range events {
		if ev.event == "delta" {
			var d struct{ Text string }
			_ = json.Unmarshal([]byte(ev.data), &d)
			joined.WriteString(d.Text)
		} else if ev.event == "done" {
			_ = json.Unmarshal([]byte(ev.data), &done)
		}
	}
	if joined.String() != "Claude streams!" || done.Text != "Claude streams!" || done.Provider != "anthropic" || done.Model != aiAnthropicModel {
		t.Fatalf("joined=%q done=%+v raw=%s", joined.String(), done, raw)
	}
}
