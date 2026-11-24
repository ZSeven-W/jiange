package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newWebhookTestServer(t *testing.T, st store.Store, configure func(*Server)) (*Server, *httptest.Server) {
	t.Helper()
	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
	}
	if configure != nil {
		configure(s)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/register", s.register)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.Handle("GET /api/me", s.requireUser(http.HandlerFunc(s.me)))

	// Wire webhook endpoints locally so tests exercise full HTTP contract before api.go wiring.
	mux.Handle("GET /api/workspaces/{wsId}/webhooks", s.requireUser(http.HandlerFunc(s.listWorkspaceWebhooks)))
	mux.Handle("POST /api/workspaces/{wsId}/webhooks", s.requireUser(http.HandlerFunc(s.createWorkspaceWebhook)))
	mux.Handle("PATCH /api/workspaces/{wsId}/webhooks/{wid}", s.requireUser(http.HandlerFunc(s.updateWorkspaceWebhook)))
	mux.Handle("DELETE /api/workspaces/{wsId}/webhooks/{wid}", s.requireUser(http.HandlerFunc(s.deleteWorkspaceWebhook)))
	mux.Handle("POST /api/workspaces/{wsId}/webhooks/{wid}/test", s.requireUser(http.HandlerFunc(s.testWorkspaceWebhook)))
	mux.Handle("GET /api/workspaces/{wsId}/webhooks/{wid}/deliveries", s.requireUser(http.HandlerFunc(s.listWebhookDeliveries)))

	handler := httpx.Chain(mux,
		httpx.WithRequestID,
		httpx.Logger(s.Log),
		httpx.Recover(s.Log),
		httpx.SecurityHeaders,
		httpx.RequireJSON,
	)
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)
	return s, ts
}

func verifyHMACSHA256Header(secret string, body []byte, sigHeader string) bool {
	if !strings.HasPrefix(sigHeader, "sha256=") {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	want := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(want), []byte(sigHeader))
}

func TestWebhookSecretSealAndWorkspaceAAD(t *testing.T) {
	s := &Server{AISecret: AISecretFromEnv("unit-test-master-secret")}
	key := s.webhookSecretKey()
	sealed, err := sealWebhookSecret(key, 10, "my-secret-token")
	if err != nil {
		t.Fatal(err)
	}
	plain, err := openWebhookSecret(key, 10, sealed)
	if err != nil || plain != "my-secret-token" {
		t.Fatalf("openWebhookSecret = %q err=%v", plain, err)
	}
	if _, err := openWebhookSecret(key, 11, sealed); err == nil {
		t.Fatalf("expected AAD mismatch error for different workspace ID")
	}
}

func TestWebhookCRUDAndPermissions(t *testing.T) {
	mem := store.NewMemory()
	_, ts := newWebhookTestServer(t, mem, func(s *Server) {
		s.AISecret = AISecretFromEnv("prod-webhook-key")
	})

	ownerClient := newSSOCookieClient(false)
	memberClient := newSSOCookieClient(false)
	anonClient := newSSOCookieClient(false)

	regOwner := post(t, ownerClient, ts.URL+"/api/auth/register", map[string]string{
		"email": "wh-owner@corp.example.com", "name": "Owner", "password": "password123",
	})
	var ownerMe meResponse
	_ = json.NewDecoder(regOwner.Body).Decode(&ownerMe)
	wsID := ownerMe.Workspaces[0].ID

	regMem := post(t, memberClient, ts.URL+"/api/auth/register", map[string]string{
		"email": "wh-member@corp.example.com", "name": "Member", "password": "password123",
	})
	var memMe meResponse
	_ = json.NewDecoder(regMem.Body).Decode(&memMe)
	if err := mem.AddWorkspaceMember(t.Context(), wsID, memMe.User.ID); err != nil {
		t.Fatal(err)
	}

	baseURL := fmt.Sprintf("%s/api/workspaces/%d/webhooks", ts.URL, wsID)

	// Unauthenticated & regular member rejected.
	if res := doJSONReq(t, anonClient, http.MethodGet, baseURL, nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anon list status = %d, want 401", res.StatusCode)
	}
	if res := doJSONReq(t, memberClient, http.MethodGet, baseURL, nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("member list status = %d, want 403", res.StatusCode)
	}
	if res := doJSONReq(t, memberClient, http.MethodPost, baseURL, map[string]any{
		"name": "Blocked", "url": "https://hooks.example.com/a", "events": []string{"doc.created"},
	}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("member create status = %d, want 403", res.StatusCode)
	}

	// Production URL validation rejects HTTP and private IP literals.
	for _, badURL := range []string{"http://hooks.example.com/a", "https://127.0.0.1/hook", "https://10.0.0.5/hook", "ftp://hooks.example.com"} {
		res := doJSONReq(t, ownerClient, http.MethodPost, baseURL, map[string]any{
			"name": "Bad URL", "url": badURL, "events": []string{"doc.created"},
		})
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("badURL %q status = %d, want 400", badURL, res.StatusCode)
		}
	}

	// Create with empty secret -> auto-generates 32-byte hex secret (64 chars) returned ONCE.
	res := doJSONReq(t, ownerClient, http.MethodPost, baseURL, map[string]any{
		"name":   "Docs Hook",
		"url":    "https://hooks.example.com/docs",
		"events": []string{"doc.created", "share.updated"},
	})
	if res.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("create status = %d body=%s", res.StatusCode, body)
	}
	var createdResp struct {
		Webhook       store.WorkspaceWebhook `json:"webhook"`
		SigningSecret string                 `json:"signingSecret"`
	}
	if err := json.NewDecoder(res.Body).Decode(&createdResp); err != nil {
		t.Fatal(err)
	}
	if len(createdResp.SigningSecret) != 64 {
		t.Fatalf("auto-generated signingSecret len = %d, want 64 hex chars", len(createdResp.SigningSecret))
	}
	if _, err := hex.DecodeString(createdResp.SigningSecret); err != nil {
		t.Fatalf("signingSecret not valid hex: %v", err)
	}
	if !createdResp.Webhook.HasSecret || createdResp.Webhook.SecretHint != createdResp.SigningSecret[60:] {
		t.Fatalf("unexpected webhook secret metadata: %+v", createdResp.Webhook)
	}

	// GET list must NEVER expose the raw signingSecret.
	listRes := doJSONReq(t, ownerClient, http.MethodGet, baseURL, nil)
	if listRes.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d", listRes.StatusCode)
	}
	rawList, _ := io.ReadAll(listRes.Body)
	if strings.Contains(string(rawList), createdResp.SigningSecret) {
		t.Fatalf("GET webhooks leaked raw signingSecret!")
	}
	var listBody struct {
		Webhooks []store.WorkspaceWebhook `json:"webhooks"`
	}
	if err := json.Unmarshal(rawList, &listBody); err != nil || len(listBody.Webhooks) != 1 {
		t.Fatalf("list decode = %+v err=%v", listBody, err)
	}

	// PATCH name & toggle enabled -> keeps secret hint, does not return signingSecret.
	patchURL := fmt.Sprintf("%s/%d", baseURL, createdResp.Webhook.ID)
	patchRes := doJSONReq(t, ownerClient, http.MethodPatch, patchURL, map[string]any{
		"name":    "Docs Hook Renamed",
		"enabled": false,
	})
	if patchRes.StatusCode != http.StatusOK {
		t.Fatalf("patch status = %d", patchRes.StatusCode)
	}
	rawPatch, _ := io.ReadAll(patchRes.Body)
	if strings.Contains(string(rawPatch), createdResp.SigningSecret) || strings.Contains(string(rawPatch), "signingSecret") {
		t.Fatalf("non-rotate PATCH leaked secret: %s", rawPatch)
	}
	var patchBody struct {
		Webhook store.WorkspaceWebhook `json:"webhook"`
	}
	_ = json.Unmarshal(rawPatch, &patchBody)
	if patchBody.Webhook.Name != "Docs Hook Renamed" || patchBody.Webhook.Enabled || patchBody.Webhook.SecretHint != createdResp.Webhook.SecretHint {
		t.Fatalf("unexpected patched webhook: %+v", patchBody.Webhook)
	}

	// DELETE removes webhook.
	delRes := doJSONReq(t, ownerClient, http.MethodDelete, patchURL, nil)
	if delRes.StatusCode != http.StatusNoContent {
		t.Fatalf("delete status = %d, want 204", delRes.StatusCode)
	}
	listAfterDel := doJSONReq(t, ownerClient, http.MethodGet, baseURL, nil)
	var afterDel struct {
		Webhooks []store.WorkspaceWebhook `json:"webhooks"`
	}
	_ = json.NewDecoder(listAfterDel.Body).Decode(&afterDel)
	if len(afterDel.Webhooks) != 0 {
		t.Fatalf("expected 0 webhooks after delete, got %d", len(afterDel.Webhooks))
	}
}

func TestWebhookTestEndpointSignatureAndRedirectBlocked(t *testing.T) {
	var (
		mu             sync.Mutex
		gotEvent       string
		gotDeliveryID  string
		gotSignature   string
		gotContentType string
		gotBody        []byte
		redirectTarget int32
	)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok":
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			gotEvent = r.Header.Get("X-Jiange-Event")
			gotDeliveryID = r.Header.Get("X-Jiange-Delivery")
			gotSignature = r.Header.Get("X-Jiange-Signature")
			gotContentType = r.Header.Get("Content-Type")
			gotBody = body
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(strings.Repeat("A", 2048)))
		case "/redirect":
			http.Redirect(w, r, "/should-not-follow", http.StatusFound)
		case "/should-not-follow":
			atomic.AddInt32(&redirectTarget, 1)
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(receiver.Close)

	mem := store.NewMemory()
	_, ts := newWebhookTestServer(t, mem, func(s *Server) {
		s.WebhookAllowHTTP = true
		s.WebhookTransport = receiver.Client().Transport
	})

	ownerClient := newSSOCookieClient(false)
	regRes := post(t, ownerClient, ts.URL+"/api/auth/register", map[string]string{
		"email": "wh-test@corp.example.com", "name": "Tester", "password": "password123",
	})
	var ownerMe meResponse
	_ = json.NewDecoder(regRes.Body).Decode(&ownerMe)
	wsID := ownerMe.Workspaces[0].ID
	baseURL := fmt.Sprintf("%s/api/workspaces/%d/webhooks", ts.URL, wsID)

	// Create disabled webhook to verify /test works synchronously even before enabling.
	createRes := doJSONReq(t, ownerClient, http.MethodPost, baseURL, map[string]any{
		"name":    "Sync Test Hook",
		"url":     receiver.URL + "/ok",
		"events":  []string{"doc.created"},
		"enabled": false,
	})
	var created struct {
		Webhook       store.WorkspaceWebhook `json:"webhook"`
		SigningSecret string                 `json:"signingSecret"`
	}
	_ = json.NewDecoder(createRes.Body).Decode(&created)

	testRes := doJSONReq(t, ownerClient, http.MethodPost, fmt.Sprintf("%s/%d/test", baseURL, created.Webhook.ID), map[string]any{})
	if testRes.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(testRes.Body)
		t.Fatalf("test webhook status = %d body=%s", testRes.StatusCode, b)
	}
	var testBody struct {
		Delivery  store.WebhookDelivery `json:"delivery"`
		LatencyMs int64                 `json:"latencyMs"`
	}
	if err := json.NewDecoder(testRes.Body).Decode(&testBody); err != nil {
		t.Fatal(err)
	}
	if !testBody.Delivery.Success || testBody.Delivery.StatusCode != http.StatusOK || testBody.Delivery.Attempt != 1 {
		t.Fatalf("unexpected test delivery: %+v", testBody.Delivery)
	}
	if testBody.Delivery.EventType != store.WebhookEventTest {
		t.Fatalf("eventType = %q, want webhook.test", testBody.Delivery.EventType)
	}
	if len(testBody.Delivery.ResponseBody) != 1024 {
		t.Fatalf("responseBody len = %d, want truncated 1024", len(testBody.Delivery.ResponseBody))
	}

	mu.Lock()
	ev, delID, sig, ct, rawBody := gotEvent, gotDeliveryID, gotSignature, gotContentType, gotBody
	mu.Unlock()
	if ev != "webhook.test" || delID == "" || ct != "application/json" {
		t.Fatalf("unexpected receiver headers: event=%q delivery=%q ct=%q", ev, delID, ct)
	}
	if !verifyHMACSHA256Header(created.SigningSecret, rawBody, sig) {
		t.Fatalf("HMAC-SHA256 verification failed: sig=%q body=%s", sig, rawBody)
	}

	// Verify delivery persisted in /deliveries.
	delivRes := doJSONReq(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/%d/deliveries", baseURL, created.Webhook.ID), nil)
	var delivBody struct {
		Deliveries []store.WebhookDelivery `json:"deliveries"`
	}
	_ = json.NewDecoder(delivRes.Body).Decode(&delivBody)
	if len(delivBody.Deliveries) != 1 || delivBody.Deliveries[0].ID != testBody.Delivery.ID {
		t.Fatalf("deliveries = %+v", delivBody.Deliveries)
	}

	// Verify 302 redirects are NEVER followed.
	redirCreate := doJSONReq(t, ownerClient, http.MethodPost, baseURL, map[string]any{
		"name":   "Redirect Hook",
		"url":    receiver.URL + "/redirect",
		"events": []string{"doc.created"},
	})
	var redirWH struct {
		Webhook store.WorkspaceWebhook `json:"webhook"`
	}
	_ = json.NewDecoder(redirCreate.Body).Decode(&redirWH)
	redirTest := doJSONReq(t, ownerClient, http.MethodPost, fmt.Sprintf("%s/%d/test", baseURL, redirWH.Webhook.ID), map[string]any{})
	var redirTestBody struct {
		Delivery store.WebhookDelivery `json:"delivery"`
	}
	_ = json.NewDecoder(redirTest.Body).Decode(&redirTestBody)
	if redirTestBody.Delivery.Success || redirTestBody.Delivery.StatusCode != http.StatusFound {
		t.Fatalf("redirect delivery = %+v, want 302 failed", redirTestBody.Delivery)
	}
	if atomic.LoadInt32(&redirectTarget) != 0 {
		t.Fatalf("webhook client followed redirect!")
	}
}

func TestWebhookAsyncDispatchSignatureAndRetries(t *testing.T) {
	type capturedReq struct {
		Event      string
		DeliveryID string
		Signature  string
		Body       []byte
	}
	var (
		mu             sync.Mutex
		flakyAttempts  int
		flakyCaptured  []capturedReq
		clientErrCalls int
		otherEventHit  int
	)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		switch r.URL.Path {
		case "/flaky":
			mu.Lock()
			flakyAttempts++
			attempt := flakyAttempts
			flakyCaptured = append(flakyCaptured, capturedReq{
				Event:      r.Header.Get("X-Jiange-Event"),
				DeliveryID: r.Header.Get("X-Jiange-Delivery"),
				Signature:  r.Header.Get("X-Jiange-Signature"),
				Body:       body,
			})
			mu.Unlock()
			if attempt < 3 {
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(fmt.Sprintf("temporary error #%d", attempt)))
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true}`))
		case "/bad-request":
			mu.Lock()
			clientErrCalls++
			mu.Unlock()
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("invalid schema"))
		case "/other":
			mu.Lock()
			otherEventHit++
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(receiver.Close)

	mem := store.NewMemory()
	srv, ts := newWebhookTestServer(t, mem, func(s *Server) {
		s.WebhookAllowHTTP = true
		s.WebhookTransport = receiver.Client().Transport
		s.AISecret = AISecretFromEnv("dispatch-test-secret")
	})

	ownerClient := newSSOCookieClient(false)
	regRes := post(t, ownerClient, ts.URL+"/api/auth/register", map[string]string{
		"email": "wh-dispatch@corp.example.com", "name": "Dispatcher", "password": "password123",
	})
	var ownerMe meResponse
	_ = json.NewDecoder(regRes.Body).Decode(&ownerMe)
	wsID := ownerMe.Workspaces[0].ID
	baseURL := fmt.Sprintf("%s/api/workspaces/%d/webhooks", ts.URL, wsID)

	// 1) Flaky webhook (503 -> 503 -> 200) subscribed to doc.created.
	createFlaky := doJSONReq(t, ownerClient, http.MethodPost, baseURL, map[string]any{
		"name":   "Flaky Hook",
		"url":    receiver.URL + "/flaky",
		"secret": "custom-hmac-secret-9999",
		"events": []string{"doc.created"},
	})
	var flakyWH struct {
		Webhook       store.WorkspaceWebhook `json:"webhook"`
		SigningSecret string                 `json:"signingSecret"`
	}
	_ = json.NewDecoder(createFlaky.Body).Decode(&flakyWH)

	// 2) 400 webhook subscribed to doc.created -> must NOT retry.
	createBad := doJSONReq(t, ownerClient, http.MethodPost, baseURL, map[string]any{
		"name":   "4xx Hook",
		"url":    receiver.URL + "/bad-request",
		"events": []string{"doc.created"},
	})
	var badWH struct {
		Webhook store.WorkspaceWebhook `json:"webhook"`
	}
	_ = json.NewDecoder(createBad.Body).Decode(&badWH)

	// 3) Webhook subscribed only to doc.deleted -> must NOT be called for doc.created.
	_ = doJSONReq(t, ownerClient, http.MethodPost, baseURL, map[string]any{
		"name":   "Deleted Only Hook",
		"url":    receiver.URL + "/other",
		"events": []string{"doc.deleted"},
	})

	// Fire async event!
	srv.dispatchWorkspaceEvent(wsID, store.WebhookEventDocCreated, map[string]any{
		"docId": 42,
		"title": "Architecture Spec",
	})

	// Poll /deliveries until all 3 attempts on flakyWH + 1 attempt on badWH are persisted.
	deadline := time.Now().Add(5 * time.Second)
	var flakyDeliveries []store.WebhookDelivery
	var badDeliveries []store.WebhookDelivery
	for time.Now().Before(deadline) {
		r1 := doJSONReq(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/%d/deliveries", baseURL, flakyWH.Webhook.ID), nil)
		var b1 struct {
			Deliveries []store.WebhookDelivery `json:"deliveries"`
		}
		_ = json.NewDecoder(r1.Body).Decode(&b1)
		r1.Body.Close()
		flakyDeliveries = b1.Deliveries

		r2 := doJSONReq(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/%d/deliveries", baseURL, badWH.Webhook.ID), nil)
		var b2 struct {
			Deliveries []store.WebhookDelivery `json:"deliveries"`
		}
		_ = json.NewDecoder(r2.Body).Decode(&b2)
		r2.Body.Close()
		badDeliveries = b2.Deliveries

		if len(flakyDeliveries) == 3 && len(badDeliveries) == 1 {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}

	if len(flakyDeliveries) != 3 {
		t.Fatalf("flakyDeliveries len = %d, want 3: %+v", len(flakyDeliveries), flakyDeliveries)
	}
	// Newest-first: attempt 3 succeeded (200), attempts 2 & 1 failed (503).
	if flakyDeliveries[0].Attempt != 3 || !flakyDeliveries[0].Success || flakyDeliveries[0].StatusCode != 200 {
		t.Fatalf("flakyDeliveries[0] = %+v, want attempt 3 success 200", flakyDeliveries[0])
	}
	if flakyDeliveries[1].Attempt != 2 || flakyDeliveries[1].Success || flakyDeliveries[1].StatusCode != 503 {
		t.Fatalf("flakyDeliveries[1] = %+v, want attempt 2 failed 503", flakyDeliveries[1])
	}
	if flakyDeliveries[2].Attempt != 1 || flakyDeliveries[2].Success || flakyDeliveries[2].StatusCode != 503 {
		t.Fatalf("flakyDeliveries[2] = %+v, want attempt 1 failed 503", flakyDeliveries[2])
	}

	// Verify HMAC-SHA256 signatures & consistent delivery ID across retries.
	mu.Lock()
	captured := append([]capturedReq(nil), flakyCaptured...)
	gotBadCalls := clientErrCalls
	gotOtherHits := otherEventHit
	mu.Unlock()
	if len(captured) != 3 {
		t.Fatalf("captured len = %d, want 3", len(captured))
	}
	sharedDeliveryID := captured[0].DeliveryID
	if sharedDeliveryID == "" {
		t.Fatalf("missing X-Jiange-Delivery header")
	}
	for i, c := range captured {
		if c.Event != store.WebhookEventDocCreated {
			t.Fatalf("attempt %d event = %q, want doc.created", i+1, c.Event)
		}
		if c.DeliveryID != sharedDeliveryID {
			t.Fatalf("attempt %d deliveryID = %q, want %q", i+1, c.DeliveryID, sharedDeliveryID)
		}
		if !verifyHMACSHA256Header("custom-hmac-secret-9999", c.Body, c.Signature) {
			t.Fatalf("attempt %d HMAC verification failed: sig=%q", i+1, c.Signature)
		}
		if !strings.Contains(string(c.Body), `"Architecture Spec"`) {
			t.Fatalf("attempt %d payload missing doc title: %s", i+1, c.Body)
		}
	}

	// 4xx must not be retried, and unsubscribed webhook must not be hit.
	if gotBadCalls != 1 || len(badDeliveries) != 1 || badDeliveries[0].StatusCode != 400 || badDeliveries[0].Success {
		t.Fatalf("4xx hook calls=%d deliveries=%+v", gotBadCalls, badDeliveries)
	}
	if gotOtherHits != 0 {
		t.Fatalf("unsubscribed webhook was unexpectedly called %d times", gotOtherHits)
	}
}

func TestWebhookSSRFProtectionBlocksLoopback(t *testing.T) {
	var hits int32
	localTLS := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(localTLS.Close)

	// Production-like server: WebhookAllowHTTP=false, WebhookTransport=nil, PreviewAllow=nil.
	mem := store.NewMemory()
	s := &Server{
		Store:      mem,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
	}

	// Even if a webhook record existed pointing to localhost/127.0.0.1, delivery is blocked before connecting.
	d := s.deliverWebhookOnce(t.Context(), store.WorkspaceWebhook{
		ID:          1,
		WorkspaceID: 1,
		Name:        "SSRF Attempt",
		URL:         strings.Replace(localTLS.URL, "127.0.0.1", "localhost", 1),
		Events:      []string{store.WebhookEventTest},
		Enabled:     true,
	}, store.WebhookEventTest, map[string]any{"probe": true})

	if d.Success || d.StatusCode != 0 {
		t.Fatalf("SSRF attempt was not blocked: %+v", d)
	}
	if !strings.Contains(strings.ToLower(d.ErrorMsg), "blocked") {
		t.Fatalf("expected SSRF blocked error message, got %q", d.ErrorMsg)
	}
	if atomic.LoadInt32(&hits) != 0 {
		t.Fatalf("local loopback receiver was reached despite SSRF guard!")
	}
}
