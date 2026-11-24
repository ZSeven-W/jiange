package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/btsync"
	"github.com/ZSeven-W/jiange/server/internal/sheetsync"
	"github.com/ZSeven-W/jiange/server/internal/slidessync"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

type failingPingStore struct {
	*store.Memory
	pingErr error
}

func (f *failingPingStore) Ping(context.Context) error {
	return f.pingErr
}

type poolStatsStore struct {
	*store.Memory
	acquired, idle, total, max int32
}

func (p *poolStatsStore) PoolStats() (int32, int32, int32, int32) {
	return p.acquired, p.idle, p.total, p.max
}

func TestReadyz(t *testing.T) {
	baseTime := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	now := baseTime

	t.Run("ready_without_blobs", func(t *testing.T) {
		s := &Server{
			Store: store.NewMemory(),
			Log:   slog.New(slog.NewTextHandler(io.Discard, nil)),
			Now:   func() time.Time { return now },
		}
		_ = s.metricsCollector()
		now = baseTime.Add(15 * time.Second)

		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
		s.readyz(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		var body readyzResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode readyz json: %v", err)
		}
		if body.Status != "ready" {
			t.Fatalf("expected status=ready, got %q", body.Status)
		}
		if body.Checks["database"] != "ok" || body.Checks["blobs"] != "disabled" {
			t.Fatalf("unexpected checks: %+v", body.Checks)
		}
		if body.UptimeSeconds < 14.9 || body.UptimeSeconds > 15.1 {
			t.Fatalf("expected uptime ~15s, got %v", body.UptimeSeconds)
		}
	})

	t.Run("ready_with_disk_blob_dir", func(t *testing.T) {
		dir, err := blob.NewDir(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		s := &Server{
			Store: store.NewMemory(),
			Blobs: dir,
			Log:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		}
		rec := httptest.NewRecorder()
		s.readyz(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		var body readyzResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Checks["blobs"] != "ok" || body.Status != "ready" {
			t.Fatalf("unexpected response: %+v", body)
		}
	})

	t.Run("degraded_when_db_ping_fails", func(t *testing.T) {
		s := &Server{
			Store: &failingPingStore{Memory: store.NewMemory(), pingErr: errors.New("connection refused")},
			Blobs: blob.NewMemory(),
			Log:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		}
		rec := httptest.NewRecorder()
		s.readyz(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))

		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("expected 503, got %d: %s", rec.Code, rec.Body.String())
		}
		var body readyzResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Status != "degraded" || body.Checks["database"] != "error" || body.Checks["blobs"] != "ok" {
			t.Fatalf("unexpected degraded response: %+v", body)
		}
	})

	t.Run("degraded_when_store_nil", func(t *testing.T) {
		s := &Server{
			Store: nil,
			Log:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		}
		rec := httptest.NewRecorder()
		s.readyz(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("expected 503, got %d", rec.Code)
		}
		var body readyzResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Status != "degraded" || body.Checks["database"] != "unavailable" {
			t.Fatalf("unexpected nil store response: %+v", body)
		}
	})

	t.Run("degraded_when_blob_dir_missing", func(t *testing.T) {
		missing := filepath.Join(t.TempDir(), "does-not-exist")
		s := &Server{
			Store: store.NewMemory(),
			Blobs: &blob.Dir{Root: missing},
			Log:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		}
		rec := httptest.NewRecorder()
		s.readyz(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("expected 503, got %d", rec.Code)
		}
		var body readyzResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Status != "degraded" || body.Checks["blobs"] != "error" {
			t.Fatalf("unexpected missing blob dir response: %+v", body)
		}
	})
}

func TestMetrics(t *testing.T) {
	t.Setenv("JIANGE_METRICS_TOKEN", "")
	mem := store.NewMemory()
	st := &poolStatsStore{Memory: mem, acquired: 3, idle: 7, total: 10, max: 25}
	s := &Server{
		Store:     st,
		Log:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		Hub:       &syncsrv.Hub{Store: mem},
		BtHub:     &btsync.Hub{Store: mem},
		SheetHub:  &sheetsync.Hub{Store: mem},
		SlidesHub: &slidessync.Hub{},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/docs/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("POST /api/docs", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})
	mux.HandleFunc("GET /fail", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	mux.HandleFunc("GET /metrics", s.metrics)
	handler := s.observabilityMiddleware(mux)

	// Send requests across multiple concrete IDs to verify route grouping.
	for _, p := range []string{"/api/docs/101", "/api/docs/202"} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: got %d", p, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/docs", nil))
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /api/docs: got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/fail", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("GET /fail: got %d", rec.Code)
	}

	// Scrape /metrics.
	mrec := httptest.NewRecorder()
	s.metrics(mrec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if mrec.Code != http.StatusOK {
		t.Fatalf("/metrics status: got %d", mrec.Code)
	}
	if ct := mrec.Header().Get("Content-Type"); ct != "text/plain; version=0.0.4; charset=utf-8" {
		t.Fatalf("unexpected Content-Type: %q", ct)
	}
	out := mrec.Body.String()

	required := []string{
		"# HELP jiange_process_uptime_seconds ",
		"# TYPE jiange_process_uptime_seconds gauge",
		"jiange_process_uptime_seconds ",
		"# TYPE jiange_go_goroutines gauge",
		"jiange_go_goroutines ",
		"# TYPE jiange_go_mem_alloc_bytes gauge",
		"jiange_go_mem_alloc_bytes ",
		"# TYPE jiange_ws_rooms gauge",
		`jiange_ws_rooms{hub="doc"} 0`,
		`jiange_ws_rooms{hub="base"} 0`,
		`jiange_ws_rooms{hub="sheet"} 0`,
		`jiange_ws_rooms{hub="slides"} 0`,
		"# TYPE jiange_db_pool_acquired_conns gauge",
		"jiange_db_pool_acquired_conns 3",
		"jiange_db_pool_idle_conns 7",
		"jiange_db_pool_total_conns 10",
		"jiange_db_pool_max_conns 25",
		"# TYPE jiange_http_requests_total counter",
		`jiange_http_requests_total{method="GET",route="/api/docs/{id}",status_class="2xx"} 2`,
		`jiange_http_requests_total{method="POST",route="/api/docs",status_class="2xx"} 1`,
		`jiange_http_requests_total{method="GET",route="/fail",status_class="5xx"} 1`,
		"# TYPE jiange_http_request_duration_seconds histogram",
		`jiange_http_request_duration_seconds_bucket{method="GET",route="/api/docs/{id}",le="0.005"}`,
		`jiange_http_request_duration_seconds_bucket{method="GET",route="/api/docs/{id}",le="5"} 2`,
		`jiange_http_request_duration_seconds_bucket{method="GET",route="/api/docs/{id}",le="+Inf"} 2`,
		`jiange_http_request_duration_seconds_sum{method="GET",route="/api/docs/{id}"}`,
		`jiange_http_request_duration_seconds_count{method="GET",route="/api/docs/{id}"} 2`,
	}
	for _, substr := range required {
		if !strings.Contains(out, substr) {
			t.Errorf("metrics output missing %q\n--- full output ---\n%s", substr, out)
		}
	}
	// Ensure concrete IDs did NOT leak into Prometheus labels.
	if strings.Contains(out, "/api/docs/101") || strings.Contains(out, "/api/docs/202") {
		t.Fatalf("unbounded concrete doc IDs leaked into metrics:\n%s", out)
	}
}

func TestMetricsTokenAuth(t *testing.T) {
	t.Setenv("JIANGE_METRICS_TOKEN", "s3cr3t-prom-token")
	s := &Server{Store: store.NewMemory(), Log: slog.New(slog.NewTextHandler(io.Discard, nil))}

	cases := []struct {
		name   string
		header string
		want   int
	}{
		{"missing", "", http.StatusUnauthorized},
		{"wrong_scheme", "Basic dXNlcjpwYXNz", http.StatusUnauthorized},
		{"wrong_token", "Bearer nope", http.StatusUnauthorized},
		{"valid_token", "Bearer s3cr3t-prom-token", http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}
			s.metrics(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("got %d, want %d (body=%s)", rec.Code, tc.want, rec.Body.String())
			}
		})
	}
}

func TestTraceparent(t *testing.T) {
	s := &Server{Store: store.NewMemory(), Log: slog.New(slog.NewTextHandler(io.Discard, nil))}

	var seenTraceID, seenSpanID, seenHeader string
	handler := s.observabilityMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenTraceID = TraceIDFromContext(r.Context())
		seenSpanID = SpanIDFromContext(r.Context())
		seenHeader = TraceparentFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	t.Run("generates_fresh_traceparent_when_absent", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
		got := rec.Header().Get("Traceparent")
		traceID, spanID, flags, ok := parseTraceparent(got)
		if !ok {
			t.Fatalf("generated invalid traceparent: %q", got)
		}
		if flags != "01" {
			t.Fatalf("expected flags=01, got %q", flags)
		}
		if seenTraceID != traceID || seenSpanID != spanID || seenHeader != got {
			t.Fatalf("context mismatch: ctx=(%s,%s,%s) header=%s", seenTraceID, seenSpanID, seenHeader, got)
		}
	})

	t.Run("propagates_valid_incoming_trace_id", func(t *testing.T) {
		const inTrace = "4bf92f3577b34da6a3ce929d0e0e4736"
		const inParent = "00f067aa0ba902b7"
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		req.Header.Set("traceparent", "00-"+inTrace+"-"+inParent+"-00")
		handler.ServeHTTP(rec, req)

		got := rec.Header().Get("Traceparent")
		traceID, spanID, flags, ok := parseTraceparent(got)
		if !ok {
			t.Fatalf("invalid outgoing traceparent: %q", got)
		}
		if traceID != inTrace {
			t.Fatalf("trace ID not preserved: got %q want %q", traceID, inTrace)
		}
		if spanID == inParent {
			t.Fatalf("span ID should be newly generated, still %q", spanID)
		}
		if flags != "00" {
			t.Fatalf("trace flags not preserved: got %q want 00", flags)
		}
		if seenTraceID != inTrace {
			t.Fatalf("TraceIDFromContext = %q, want %q", seenTraceID, inTrace)
		}
	})

	t.Run("replaces_malformed_traceparent", func(t *testing.T) {
		badHeaders := []string{
			"invalid",
			"ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
			"00-00000000000000000000000000000000-00f067aa0ba902b7-01",
			"00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
			"00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
			"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra",
		}
		for _, bad := range badHeaders {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
			req.Header.Set("traceparent", bad)
			handler.ServeHTTP(rec, req)
			got := rec.Header().Get("Traceparent")
			if _, _, _, ok := parseTraceparent(got); !ok {
				t.Fatalf("for bad input %q, generated invalid header %q", bad, got)
			}
			if got == bad {
				t.Fatalf("bad input %q was echoed verbatim", bad)
			}
		}
	})
}

type hijackFlushRecorder struct {
	*httptest.ResponseRecorder
	flushed  bool
	hijacked bool
}

func (r *hijackFlushRecorder) Flush() {
	r.flushed = true
	r.ResponseRecorder.Flush()
}

func (r *hijackFlushRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	r.hijacked = true
	c1, c2 := net.Pipe()
	_ = c2.Close()
	return c1, bufio.NewReadWriter(bufio.NewReader(c1), bufio.NewWriter(c1)), nil
}

func TestObservabilityMiddlewarePreservesHijackerAndFlusher(t *testing.T) {
	s := &Server{Store: store.NewMemory(), Log: slog.New(slog.NewTextHandler(io.Discard, nil))}

	t.Run("direct_interface_and_response_controller", func(t *testing.T) {
		var flusherOK, hijackerOK bool
		handler := s.observabilityMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fl, ok := w.(http.Flusher)
			flusherOK = ok
			if ok {
				fl.Flush()
			}
			// Also verify ResponseController Flush works through Unwrap().
			rc := http.NewResponseController(w)
			if err := rc.Flush(); err != nil {
				t.Errorf("ResponseController.Flush failed: %v", err)
			}
			hj, ok := w.(http.Hijacker)
			hijackerOK = ok
			if ok {
				conn, _, err := hj.Hijack()
				if err != nil {
					t.Errorf("Hijack failed: %v", err)
					return
				}
				_ = conn.Close()
			}
		}))

		rec := &hijackFlushRecorder{ResponseRecorder: httptest.NewRecorder()}
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/sync", nil))

		if !flusherOK || !rec.flushed {
			t.Fatalf("http.Flusher was not preserved: ok=%v flushed=%v", flusherOK, rec.flushed)
		}
		if !hijackerOK || !rec.hijacked {
			t.Fatalf("http.Hijacker was not preserved: ok=%v hijacked=%v", hijackerOK, rec.hijacked)
		}

		// Verify hijacked WebSocket request was recorded under 1xx status class.
		t.Setenv("JIANGE_METRICS_TOKEN", "")
		mrec := httptest.NewRecorder()
		s.metrics(mrec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
		if !strings.Contains(mrec.Body.String(), `jiange_http_requests_total{method="GET",route="/api/sync",status_class="1xx"} 1`) {
			t.Fatalf("expected 1xx counter for hijacked /api/sync, got:\n%s", mrec.Body.String())
		}
	})

	t.Run("real_http_server_hijack", func(t *testing.T) {
		ts := httptest.NewServer(s.observabilityMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hj, ok := w.(http.Hijacker)
			if !ok {
				http.Error(w, "no hijacker", http.StatusInternalServerError)
				return
			}
			conn, rw, err := hj.Hijack()
			if err != nil {
				return
			}
			defer conn.Close()
			_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\nHIJACK_OK")
			_ = rw.Flush()
		})))
		defer ts.Close()

		conn, err := net.DialTimeout("tcp", ts.Listener.Addr().String(), 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		_, _ = io.WriteString(conn, "GET /api/sync HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n")
		raw, err := io.ReadAll(conn)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(raw), "101 Switching Protocols") || !strings.Contains(string(raw), "HIJACK_OK") {
			t.Fatalf("unexpected hijacked response: %q", string(raw))
		}
	})
}

func TestObservabilityRouteNormalizationAndConcurrency(t *testing.T) {
	cases := map[string]string{
		"/healthz":                                   "/healthz",
		"/readyz":                                    "/readyz",
		"/metrics":                                   "/metrics",
		"/api/docs/12345/versions/7":                 "/api/docs/{id}/versions/{id}",
		"/api/public/secretToken123/files/99":        "/api/public/{token}/files/{id}",
		"/api/public/surveys/tok99/submit":           "/api/public/surveys/{token}/submit",
		"/api/share/abcdef/join-guarded":             "/api/share/{token}/join-guarded",
		"/api/forms/xyz123":                          "/api/forms/{token}",
		"/api/docs/42/account-document-search":       "/api/docs/{id}/account-document-search",
		"/api/workspaces/9/notification-channels/11": "/api/workspaces/{id}/notification-channels/{id}",
		"/random/scanner/path/wp-login.php":          "/*",
		"/docs/999":                                  "/*",
	}
	for in, want := range cases {
		if got := normalizePathFallback(in); got != want {
			t.Errorf("normalizePathFallback(%q) = %q, want %q", in, got, want)
		}
	}

	// Verify concurrent requests + metrics scraping + readyz are race-free.
	t.Setenv("JIANGE_METRICS_TOKEN", "")
	s := &Server{Store: store.NewMemory(), Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	h := s.observabilityMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/docs/42", nil))
				mrec := httptest.NewRecorder()
				s.metrics(mrec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
				rrec := httptest.NewRecorder()
				s.readyz(rrec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
			}
		}(i)
	}
	wg.Wait()

	// Ensure os.Getenv unused warnings don't creep in and env isolation works.
	_ = os.Getenv("JIANGE_METRICS_TOKEN")
}
