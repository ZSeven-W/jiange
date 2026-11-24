package api

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
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

func TestWebhookSuiteEventEmissions(t *testing.T) {
	const signingSecret = "suite-events-hmac-secret-2026"
	type capturedDelivery struct {
		Event     string
		Signature string
		Body      []byte
		Envelope  struct {
			ID          string         `json:"id"`
			Event       string         `json:"event"`
			WorkspaceID int64          `json:"workspaceId"`
			Data        map[string]any `json:"data"`
		}
	}
	var (
		mu       sync.Mutex
		received []capturedDelivery
	)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		rec := capturedDelivery{
			Event:     r.Header.Get("X-Jiange-Event"),
			Signature: r.Header.Get("X-Jiange-Signature"),
			Body:      body,
		}
		_ = json.Unmarshal(body, &rec.Envelope)
		mu.Lock()
		received = append(received, rec)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(receiver.Close)

	mem := store.NewMemory()
	srv := &Server{
		Store:            mem,
		Log:              slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL:       time.Hour,
		Iterations:       1000,
		WebhookAllowHTTP: true,
		WebhookTransport: receiver.Client().Transport,
		AISecret:         AISecretFromEnv("suite-events-master-key"),
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	ownerClient := newSSOCookieClient(false)
	regRes := post(t, ownerClient, ts.URL+"/api/auth/register", map[string]string{
		"email": "suite-wh@corp.example.com", "name": "Suite Owner", "password": "password123",
	})
	var ownerMe meResponse
	if err := json.NewDecoder(regRes.Body).Decode(&ownerMe); err != nil {
		t.Fatal(err)
	}
	regRes.Body.Close()
	wsID := ownerMe.Workspaces[0].ID
	ownerID := ownerMe.User.ID

	doAuthJSON := func(method, url string, payload any, extraHeaders map[string]string) *http.Response {
		t.Helper()
		var bodyReader io.Reader
		if payload != nil {
			b, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			bodyReader = bytes.NewReader(b)
		}
		req, err := http.NewRequest(method, url, bodyReader)
		if err != nil {
			t.Fatal(err)
		}
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(ownerID, 10))
		for k, v := range extraHeaders {
			req.Header.Set(k, v)
		}
		res, err := ownerClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}

	// Subscribe one enabled webhook to all 3 events.
	whRes := doAuthJSON(http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/webhooks", ts.URL, wsID), map[string]any{
		"name":   "Suite Events Hook",
		"url":    receiver.URL + "/events",
		"secret": signingSecret,
		"events": []string{
			store.WebhookEventBaseRecordMutated,
			store.WebhookEventSheetCellsUpdated,
			store.WebhookEventSlidesVersionCreated,
		},
		"enabled": true,
	}, nil)
	whBody, _ := io.ReadAll(whRes.Body)
	whRes.Body.Close()
	if whRes.StatusCode != http.StatusCreated {
		t.Fatalf("create webhook status=%d body=%s", whRes.StatusCode, whBody)
	}

	// --- 1. Base record mutations (create, update, batch_update, batch_delete, batch_restore, delete, import) ---
	baseRes := doAuthJSON(http.MethodPost, ts.URL+"/api/bases", map[string]any{
		"title":       "CRM Base",
		"workspaceId": wsID,
	}, nil)
	var baseDoc store.DocMeta
	if err := json.NewDecoder(baseRes.Body).Decode(&baseDoc); err != nil {
		t.Fatal(err)
	}
	baseRes.Body.Close()
	if baseRes.StatusCode != http.StatusCreated {
		t.Fatalf("create base status=%d", baseRes.StatusCode)
	}
	fields, err := mem.Fields(t.Context(), baseDoc.ID)
	if err != nil || len(fields) == 0 {
		t.Fatalf("fields = %+v err=%v", fields, err)
	}
	primaryField := fields[0]
	fieldKey := strconv.FormatInt(primaryField.ID, 10)

	// 1a. Create record
	recCreateRes := doAuthJSON(http.MethodPost, fmt.Sprintf("%s/api/bases/%d/records", ts.URL, baseDoc.ID), map[string]any{
		"cells": map[string]any{fieldKey: "Acme Corp"},
	}, nil)
	var createdRec store.Record
	if err := json.NewDecoder(recCreateRes.Body).Decode(&createdRec); err != nil {
		t.Fatal(err)
	}
	recCreateRes.Body.Close()
	if recCreateRes.StatusCode != http.StatusCreated {
		t.Fatalf("create record status=%d", recCreateRes.StatusCode)
	}

	// 1b. Update record
	recPatchRes := doAuthJSON(http.MethodPatch, fmt.Sprintf("%s/api/bases/%d/records/%d", ts.URL, baseDoc.ID, createdRec.ID), map[string]any{
		"cells": map[string]any{fieldKey: "Acme Updated"},
	}, nil)
	recPatchRes.Body.Close()
	if recPatchRes.StatusCode != http.StatusOK {
		t.Fatalf("patch record status=%d", recPatchRes.StatusCode)
	}

	// 1c. Batch update record
	batchUpdRes := doAuthJSON(http.MethodPost, fmt.Sprintf("%s/api/bases/%d/records/batch-update", ts.URL, baseDoc.ID), map[string]any{
		"updates": []map[string]any{
			{"id": createdRec.ID, "cells": map[string]any{fieldKey: "Acme Batch"}},
		},
	}, nil)
	batchUpdRes.Body.Close()
	if batchUpdRes.StatusCode != http.StatusOK {
		t.Fatalf("batch-update status=%d", batchUpdRes.StatusCode)
	}

	// 1d. Batch delete record
	batchDelRes := doAuthJSON(http.MethodPost, fmt.Sprintf("%s/api/bases/%d/records/batch-delete", ts.URL, baseDoc.ID), map[string]any{
		"ids": []int64{createdRec.ID},
	}, nil)
	batchDelRes.Body.Close()
	if batchDelRes.StatusCode != http.StatusOK {
		t.Fatalf("batch-delete status=%d", batchDelRes.StatusCode)
	}

	// 1e. Batch restore record
	batchRestRes := doAuthJSON(http.MethodPost, fmt.Sprintf("%s/api/bases/%d/records/batch-restore", ts.URL, baseDoc.ID), map[string]any{
		"records": []map[string]any{
			{"tableId": createdRec.TableID, "position": createdRec.Position, "cells": map[string]any{fieldKey: "Acme Restored"}},
		},
	}, nil)
	var restoredBody struct {
		Records []store.Record `json:"records"`
	}
	if err := json.NewDecoder(batchRestRes.Body).Decode(&restoredBody); err != nil {
		t.Fatal(err)
	}
	batchRestRes.Body.Close()
	if batchRestRes.StatusCode != http.StatusCreated || len(restoredBody.Records) != 1 {
		t.Fatalf("batch-restore status=%d body=%+v", batchRestRes.StatusCode, restoredBody)
	}

	// 1f. Delete record
	delRecRes := doAuthJSON(http.MethodDelete, fmt.Sprintf("%s/api/bases/%d/records/%d", ts.URL, baseDoc.ID, restoredBody.Records[0].ID), nil, nil)
	delRecRes.Body.Close()
	if delRecRes.StatusCode != http.StatusNoContent {
		t.Fatalf("delete record status=%d", delRecRes.StatusCode)
	}

	// 1g. Import records
	impRes := doAuthJSON(http.MethodPost, fmt.Sprintf("%s/api/bases/%d/import-records", ts.URL, baseDoc.ID), map[string]any{
		"fields": []map[string]any{
			{"id": primaryField.ID, "name": primaryField.Name, "type": primaryField.Type, "options": primaryField.Options},
		},
		"rows": []map[string]any{
			{fieldKey: "Imported Row 1"},
			{fieldKey: "Imported Row 2"},
		},
	}, nil)
	impRaw, _ := io.ReadAll(impRes.Body)
	impRes.Body.Close()
	if impRes.StatusCode != http.StatusOK {
		t.Fatalf("import-records status=%d body=%s", impRes.StatusCode, impRaw)
	}

	// --- 2. Sheet cells updated (writeSheetCells + importSheetXlsx) ---
	sheetNodeRes := doAuthJSON(http.MethodPost, ts.URL+"/api/drive/nodes", map[string]any{
		"workspaceId": wsID,
		"kind":        "sheet",
		"title":       "Metrics Sheet",
	}, nil)
	var sheetEntry store.DriveEntry
	if err := json.NewDecoder(sheetNodeRes.Body).Decode(&sheetEntry); err != nil {
		t.Fatal(err)
	}
	sheetNodeRes.Body.Close()
	if sheetNodeRes.StatusCode != http.StatusCreated {
		t.Fatalf("create sheet status=%d", sheetNodeRes.StatusCode)
	}
	sheetHeaders := map[string]string{"X-Jiange-Sheet-Version": sheetProtocolVersion}
	sheetGetRes := doAuthJSON(http.MethodGet, fmt.Sprintf("%s/api/sheets/%d", ts.URL, sheetEntry.ID), nil, sheetHeaders)
	var sheetSnap store.SheetSnapshot
	if err := json.NewDecoder(sheetGetRes.Body).Decode(&sheetSnap); err != nil {
		t.Fatal(err)
	}
	sheetGetRes.Body.Close()

	rawCell := "Q4 Revenue"
	writeCellsRes := doAuthJSON(http.MethodPost, fmt.Sprintf("%s/api/sheets/%d/cells", ts.URL, sheetEntry.ID), store.SheetCellBatch{
		MutationID:  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		WorksheetID: sheetSnap.Sheets[0].ID,
		Cells: []store.SheetCellWrite{
			{
				RowID:            sheetSnap.Sheets[0].Rows[0].ID,
				ColumnID:         sheetSnap.Sheets[0].Columns[0].ID,
				ExpectedRevision: 0,
				Raw:              &rawCell,
			},
		},
	}, sheetHeaders)
	var cellResult store.SheetBatchResult
	if err := json.NewDecoder(writeCellsRes.Body).Decode(&cellResult); err != nil {
		t.Fatal(err)
	}
	writeCellsRes.Body.Close()
	if writeCellsRes.StatusCode != http.StatusOK {
		t.Fatalf("writeSheetCells status=%d", writeCellsRes.StatusCode)
	}

	importXlsxRes := doAuthJSON(http.MethodPost, fmt.Sprintf("%s/api/sheets/%d/import-xlsx", ts.URL, sheetEntry.ID), map[string]any{
		"expectedWorkbookRevision": cellResult.WorkbookRevision,
		"mutationId":               "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"sheets": []store.ImportedWorksheet{
			{
				Title: "Imported",
				Rows:  5,
				Cols:  5,
				Cells: []store.ImportedSheetCell{
					{Row: 0, Col: 0, Raw: "A1"},
					{Row: 0, Col: 1, Raw: "B1"},
				},
			},
		},
	}, sheetHeaders)
	importXlsxRaw, _ := io.ReadAll(importXlsxRes.Body)
	importXlsxRes.Body.Close()
	if importXlsxRes.StatusCode != http.StatusOK {
		t.Fatalf("importSheetXlsx status=%d body=%s", importXlsxRes.StatusCode, importXlsxRaw)
	}

	// --- 3. Slides version created ---
	slidesNodeRes := doAuthJSON(http.MethodPost, ts.URL+"/api/drive/nodes", map[string]any{
		"workspaceId": wsID,
		"kind":        "slides",
		"title":       "Launch Deck",
	}, nil)
	var slidesEntry store.DriveEntry
	if err := json.NewDecoder(slidesNodeRes.Body).Decode(&slidesEntry); err != nil {
		t.Fatal(err)
	}
	slidesNodeRes.Body.Close()
	if slidesNodeRes.StatusCode != http.StatusCreated {
		t.Fatalf("create slides status=%d", slidesNodeRes.StatusCode)
	}
	verRes := doAuthJSON(http.MethodPost, fmt.Sprintf("%s/api/slides/%d/versions", ts.URL, slidesEntry.ID), map[string]any{
		"label": "Release v1.0",
	}, nil)
	var verResp struct {
		Version store.SlidesVersionMeta `json:"version"`
	}
	if err := json.NewDecoder(verRes.Body).Decode(&verResp); err != nil {
		t.Fatal(err)
	}
	verRes.Body.Close()
	if verRes.StatusCode != http.StatusCreated {
		t.Fatalf("create slides version status=%d", verRes.StatusCode)
	}

	// Wait for all 10 async webhook deliveries (7 base + 2 sheet + 1 slides).
	const wantTotal = 10
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(received)
		mu.Unlock()
		if n >= wantTotal {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}

	mu.Lock()
	got := append([]capturedDelivery(nil), received...)
	mu.Unlock()
	if len(got) != wantTotal {
		t.Fatalf("received %d webhook deliveries, want %d", len(got), wantTotal)
	}

	baseActions := map[string]float64{}
	sheetCellCounts := map[float64]bool{}
	var slidesHit *capturedDelivery

	for i, d := range got {
		if !verifyHMACSHA256Header(signingSecret, d.Body, d.Signature) {
			t.Fatalf("delivery[%d] (%s) invalid HMAC signature %q", i, d.Event, d.Signature)
		}
		if d.Envelope.WorkspaceID != wsID || d.Envelope.Event != d.Event {
			t.Fatalf("delivery[%d] envelope mismatch: %+v", i, d.Envelope)
		}
		if gotActor, _ := d.Envelope.Data["actorId"].(float64); int64(gotActor) != ownerID {
			t.Fatalf("delivery[%d] (%s) actorId=%v, want %d", i, d.Event, d.Envelope.Data["actorId"], ownerID)
		}
		switch d.Event {
		case store.WebhookEventBaseRecordMutated:
			if bid, _ := d.Envelope.Data["baseId"].(float64); int64(bid) != baseDoc.ID {
				t.Fatalf("base event baseId=%v, want %d", d.Envelope.Data["baseId"], baseDoc.ID)
			}
			act, _ := d.Envelope.Data["action"].(string)
			cnt, _ := d.Envelope.Data["count"].(float64)
			baseActions[act] = cnt
		case store.WebhookEventSheetCellsUpdated:
			if sid, _ := d.Envelope.Data["sheetId"].(float64); int64(sid) != sheetEntry.ID {
				t.Fatalf("sheet event sheetId=%v, want %d", d.Envelope.Data["sheetId"], sheetEntry.ID)
			}
			if rev, _ := d.Envelope.Data["workbookRevision"].(float64); rev < 2 {
				t.Fatalf("sheet event workbookRevision=%v, want >= 2", rev)
			}
			cnt, _ := d.Envelope.Data["cellCount"].(float64)
			sheetCellCounts[cnt] = true
		case store.WebhookEventSlidesVersionCreated:
			cp := d
			slidesHit = &cp
		default:
			t.Fatalf("unexpected webhook event %q", d.Event)
		}
	}

	wantBaseActions := map[string]float64{
		"create":        1,
		"update":        1,
		"batch_update":  1,
		"batch_delete":  1,
		"batch_restore": 1,
		"delete":        1,
		"import":        2,
	}
	for act, wantCnt := range wantBaseActions {
		if baseActions[act] != wantCnt {
			t.Fatalf("base action %q count=%v, want %v (all=%+v)", act, baseActions[act], wantCnt, baseActions)
		}
	}
	if !sheetCellCounts[1] || !sheetCellCounts[2] {
		t.Fatalf("expected sheet.cells_updated cellCounts 1 and 2, got %+v", sheetCellCounts)
	}
	if slidesHit == nil {
		t.Fatalf("missing slides.version_created webhook delivery")
	}
	if sid, _ := slidesHit.Envelope.Data["slidesId"].(float64); int64(sid) != slidesEntry.ID {
		t.Fatalf("slidesId=%v, want %d", slidesHit.Envelope.Data["slidesId"], slidesEntry.ID)
	}
	if vid, _ := slidesHit.Envelope.Data["versionId"].(float64); int64(vid) != verResp.Version.ID {
		t.Fatalf("versionId=%v, want %d", slidesHit.Envelope.Data["versionId"], verResp.Version.ID)
	}
	if name, _ := slidesHit.Envelope.Data["name"].(string); name != "Release v1.0" {
		t.Fatalf("slides version name=%q, want Release v1.0", name)
	}
}
