package api

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"path"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const (
	// maxTrackedMetricRoutes bounds HTTP metric label cardinality even under
	// arbitrary scanner/404 traffic.
	maxTrackedMetricRoutes = 512
	readyzCheckTimeout     = 2 * time.Second
)

// Standard Prometheus HTTP latency histogram buckets in seconds.
var httpDurationBuckets = [...]float64{
	0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
}

type obsCtxKey int

const traceContextKey obsCtxKey = 1

type traceContext struct {
	traceID  string
	spanID   string
	parentID string
	flags    string
	header   string
}

// TraceIDFromContext returns the active 32-hex W3C trace ID attached by
// observabilityMiddleware, or "" if none is present.
func TraceIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	tc, _ := ctx.Value(traceContextKey).(traceContext)
	return tc.traceID
}

// SpanIDFromContext returns the active 16-hex W3C span ID attached by
// observabilityMiddleware, or "" if none is present.
func SpanIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	tc, _ := ctx.Value(traceContextKey).(traceContext)
	return tc.spanID
}

// TraceparentFromContext returns the formatted W3C traceparent header value
// for the current request span, or "" if none is present.
func TraceparentFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	tc, _ := ctx.Value(traceContextKey).(traceContext)
	return tc.header
}

type httpCounterKey struct {
	method      string
	route       string
	statusClass string
}

type httpRouteKey struct {
	method string
	route  string
}

type durationHistogram struct {
	buckets [len(httpDurationBuckets)]uint64
	count   uint64
	sum     float64
}

// MetricsCollector holds thread-safe runtime and HTTP metrics for a Server.
type MetricsCollector struct {
	startedAt time.Time

	mu          sync.RWMutex
	reqCounts   map[httpCounterKey]uint64
	reqDuration map[httpRouteKey]*durationHistogram
}

// NewMetricsCollector creates a fresh MetricsCollector starting at now.
func NewMetricsCollector() *MetricsCollector {
	return newMetricsCollectorAt(time.Now())
}

func newMetricsCollectorAt(startedAt time.Time) *MetricsCollector {
	return &MetricsCollector{
		startedAt:   startedAt,
		reqCounts:   make(map[httpCounterKey]uint64),
		reqDuration: make(map[httpRouteKey]*durationHistogram),
	}
}

// serverMetrics lazily binds a *MetricsCollector to each *Server without
// requiring extra fields on the Server struct.
var serverMetrics sync.Map // map[*Server]*MetricsCollector

func (s *Server) metricsCollector() *MetricsCollector {
	if s == nil {
		return NewMetricsCollector()
	}
	if v, ok := serverMetrics.Load(s); ok {
		return v.(*MetricsCollector)
	}
	c := newMetricsCollectorAt(s.now())
	actual, _ := serverMetrics.LoadOrStore(s, c)
	return actual.(*MetricsCollector)
}

func (c *MetricsCollector) recordHTTP(method, route string, status int, dur time.Duration) {
	if method == "" {
		method = "UNKNOWN"
	}
	if route == "" {
		route = "/*"
	}
	statusClass := httpStatusClass(status)
	durSec := dur.Seconds()
	if durSec < 0 {
		durSec = 0
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	rk := httpRouteKey{method: method, route: route}
	hist, ok := c.reqDuration[rk]
	if !ok {
		if len(c.reqDuration) >= maxTrackedMetricRoutes {
			route = "_other"
			rk.route = route
			hist = c.reqDuration[rk]
		}
		if hist == nil {
			hist = &durationHistogram{}
			c.reqDuration[rk] = hist
		}
	}

	ck := httpCounterKey{method: method, route: route, statusClass: statusClass}
	c.reqCounts[ck]++

	for i, bound := range httpDurationBuckets {
		if durSec <= bound {
			hist.buckets[i]++
		}
	}
	hist.count++
	hist.sum += durSec
}

type readyzResponse struct {
	Status        string            `json:"status"`
	Checks        map[string]string `json:"checks"`
	UptimeSeconds float64           `json:"uptimeSeconds"`
}

// readyz reports service readiness for Kubernetes readiness probes.
func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	c := s.metricsCollector()
	ctx, cancel := context.WithTimeout(r.Context(), readyzCheckTimeout)
	defer cancel()

	checks := make(map[string]string, 2)
	ready := true

	// Database check.
	switch st := s.Store.(type) {
	case nil:
		checks["database"] = "unavailable"
		ready = false
	case *store.Postgres:
		if st == nil || st.Pool == nil {
			checks["database"] = "unavailable"
			ready = false
		} else if err := st.Pool.Ping(ctx); err != nil {
			checks["database"] = "error"
			ready = false
		} else {
			checks["database"] = "ok"
		}
	default:
		if err := st.Ping(ctx); err != nil {
			checks["database"] = "error"
			ready = false
		} else {
			checks["database"] = "ok"
		}
	}

	// Blob storage check.
	switch b := s.Blobs.(type) {
	case nil:
		checks["blobs"] = "disabled"
	case *blob.Dir:
		if b == nil || !checkReadableDir(b.Root) {
			checks["blobs"] = "error"
			ready = false
		} else {
			checks["blobs"] = "ok"
		}
	default:
		checks["blobs"] = "ok"
	}

	uptime := s.now().Sub(c.startedAt).Seconds()
	if uptime < 0 {
		uptime = 0
	}

	statusStr := "ready"
	httpCode := http.StatusOK
	if !ready {
		statusStr = "degraded"
		httpCode = http.StatusServiceUnavailable
	}

	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, httpCode, readyzResponse{
		Status:        statusStr,
		Checks:        checks,
		UptimeSeconds: uptime,
	})
}

func checkReadableDir(dir string) bool {
	if dir == "" {
		return false
	}
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() {
		return false
	}
	f, err := os.Open(dir)
	if err != nil {
		return false
	}
	_ = f.Close()
	return true
}

type dbPoolStats struct {
	acquired int32
	idle     int32
	total    int32
	max      int32
}

type dbPoolStatter interface {
	PoolStats() (acquired, idle, total, max int32)
}

func (s *Server) readDBPoolStats() (dbPoolStats, bool) {
	if pg, ok := s.Store.(*store.Postgres); ok && pg != nil && pg.Pool != nil {
		st := pg.Pool.Stat()
		return dbPoolStats{
			acquired: st.AcquiredConns(),
			idle:     st.IdleConns(),
			total:    st.TotalConns(),
			max:      st.MaxConns(),
		}, true
	}
	if st, ok := s.Store.(dbPoolStatter); ok && st != nil {
		acq, idle, total, maxConns := st.PoolStats()
		return dbPoolStats{
			acquired: acq,
			idle:     idle,
			total:    total,
			max:      maxConns,
		}, true
	}
	return dbPoolStats{}, false
}

// metrics serves runtime, WebSocket hub, DB pool, and HTTP metrics in
// Prometheus Text Exposition Format 0.0.4.
func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	if expected := os.Getenv("JIANGE_METRICS_TOKEN"); expected != "" {
		authz := r.Header.Get("Authorization")
		const prefix = "Bearer "
		provided := ""
		if strings.HasPrefix(authz, prefix) {
			provided = authz[len(prefix):]
		}
		if subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			w.Header().Set("WWW-Authenticate", `Bearer realm="metrics"`)
			httpx.Error(w, http.StatusUnauthorized, "unauthorized", "invalid metrics token")
			return
		}
	}

	c := s.metricsCollector()
	uptime := s.now().Sub(c.startedAt).Seconds()
	if uptime < 0 {
		uptime = 0
	}

	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	var buf bytes.Buffer

	// Process and Go runtime gauges.
	buf.WriteString("# HELP jiange_process_uptime_seconds Time elapsed since the Jiange server started in seconds.\n")
	buf.WriteString("# TYPE jiange_process_uptime_seconds gauge\n")
	fmt.Fprintf(&buf, "jiange_process_uptime_seconds %s\n", promFloat(uptime))

	buf.WriteString("# HELP jiange_go_goroutines Number of goroutines that currently exist.\n")
	buf.WriteString("# TYPE jiange_go_goroutines gauge\n")
	fmt.Fprintf(&buf, "jiange_go_goroutines %d\n", runtime.NumGoroutine())

	buf.WriteString("# HELP jiange_go_mem_alloc_bytes Number of bytes allocated and still in use.\n")
	buf.WriteString("# TYPE jiange_go_mem_alloc_bytes gauge\n")
	fmt.Fprintf(&buf, "jiange_go_mem_alloc_bytes %d\n", mem.Alloc)

	// WebSocket room gauges across all 4 collaboration hubs.
	var docRooms, baseRooms, sheetRooms, slidesRooms int
	if s.Hub != nil {
		docRooms = s.Hub.Rooms()
	}
	if s.BtHub != nil {
		baseRooms = s.BtHub.Rooms()
	}
	if s.SheetHub != nil {
		sheetRooms = s.SheetHub.Rooms()
	}
	if s.SlidesHub != nil {
		slidesRooms = s.SlidesHub.Rooms()
	}
	buf.WriteString("# HELP jiange_ws_rooms Number of currently active realtime WebSocket rooms per hub.\n")
	buf.WriteString("# TYPE jiange_ws_rooms gauge\n")
	fmt.Fprintf(&buf, "jiange_ws_rooms{hub=\"doc\"} %d\n", docRooms)
	fmt.Fprintf(&buf, "jiange_ws_rooms{hub=\"base\"} %d\n", baseRooms)
	fmt.Fprintf(&buf, "jiange_ws_rooms{hub=\"sheet\"} %d\n", sheetRooms)
	fmt.Fprintf(&buf, "jiange_ws_rooms{hub=\"slides\"} %d\n", slidesRooms)

	// Postgres pool gauges when backed by Postgres.
	if poolStats, ok := s.readDBPoolStats(); ok {
		buf.WriteString("# HELP jiange_db_pool_acquired_conns Number of currently acquired database pool connections.\n")
		buf.WriteString("# TYPE jiange_db_pool_acquired_conns gauge\n")
		fmt.Fprintf(&buf, "jiange_db_pool_acquired_conns %d\n", poolStats.acquired)

		buf.WriteString("# HELP jiange_db_pool_idle_conns Number of currently idle database pool connections.\n")
		buf.WriteString("# TYPE jiange_db_pool_idle_conns gauge\n")
		fmt.Fprintf(&buf, "jiange_db_pool_idle_conns %d\n", poolStats.idle)

		buf.WriteString("# HELP jiange_db_pool_total_conns Total number of database connections in the pool.\n")
		buf.WriteString("# TYPE jiange_db_pool_total_conns gauge\n")
		fmt.Fprintf(&buf, "jiange_db_pool_total_conns %d\n", poolStats.total)

		buf.WriteString("# HELP jiange_db_pool_max_conns Maximum size of the database connection pool.\n")
		buf.WriteString("# TYPE jiange_db_pool_max_conns gauge\n")
		fmt.Fprintf(&buf, "jiange_db_pool_max_conns %d\n", poolStats.max)
	}

	// Snapshot HTTP counters and histograms under read lock.
	c.mu.RLock()
	counterKeys := make([]httpCounterKey, 0, len(c.reqCounts))
	counterVals := make(map[httpCounterKey]uint64, len(c.reqCounts))
	for k, v := range c.reqCounts {
		counterKeys = append(counterKeys, k)
		counterVals[k] = v
	}
	histKeys := make([]httpRouteKey, 0, len(c.reqDuration))
	histSnap := make(map[httpRouteKey]durationHistogram, len(c.reqDuration))
	for k, v := range c.reqDuration {
		histKeys = append(histKeys, k)
		histSnap[k] = *v
	}
	c.mu.RUnlock()

	sort.Slice(counterKeys, func(i, j int) bool {
		if counterKeys[i].method != counterKeys[j].method {
			return counterKeys[i].method < counterKeys[j].method
		}
		if counterKeys[i].route != counterKeys[j].route {
			return counterKeys[i].route < counterKeys[j].route
		}
		return counterKeys[i].statusClass < counterKeys[j].statusClass
	})
	sort.Slice(histKeys, func(i, j int) bool {
		if histKeys[i].method != histKeys[j].method {
			return histKeys[i].method < histKeys[j].method
		}
		return histKeys[i].route < histKeys[j].route
	})

	buf.WriteString("# HELP jiange_http_requests_total Total number of HTTP requests handled.\n")
	buf.WriteString("# TYPE jiange_http_requests_total counter\n")
	for _, k := range counterKeys {
		fmt.Fprintf(&buf, "jiange_http_requests_total{method=\"%s\",route=\"%s\",status_class=\"%s\"} %d\n",
			promEscapeLabel(k.method), promEscapeLabel(k.route), promEscapeLabel(k.statusClass), counterVals[k])
	}

	buf.WriteString("# HELP jiange_http_request_duration_seconds HTTP request duration distributions in seconds.\n")
	buf.WriteString("# TYPE jiange_http_request_duration_seconds histogram\n")
	for _, k := range histKeys {
		h := histSnap[k]
		mEsc := promEscapeLabel(k.method)
		rEsc := promEscapeLabel(k.route)
		for i, bound := range httpDurationBuckets {
			fmt.Fprintf(&buf, "jiange_http_request_duration_seconds_bucket{method=\"%s\",route=\"%s\",le=\"%s\"} %d\n",
				mEsc, rEsc, promFloat(bound), h.buckets[i])
		}
		fmt.Fprintf(&buf, "jiange_http_request_duration_seconds_bucket{method=\"%s\",route=\"%s\",le=\"+Inf\"} %d\n",
			mEsc, rEsc, h.count)
		fmt.Fprintf(&buf, "jiange_http_request_duration_seconds_sum{method=\"%s\",route=\"%s\"} %s\n",
			mEsc, rEsc, promFloat(h.sum))
		fmt.Fprintf(&buf, "jiange_http_request_duration_seconds_count{method=\"%s\",route=\"%s\"} %d\n",
			mEsc, rEsc, h.count)
	}

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

// observabilityMiddleware propagates or generates W3C traceparent context,
// wraps the ResponseWriter (preserving http.Hijacker and http.Flusher for
// WebSockets and SSE streaming), and records HTTP request metrics.
func (s *Server) observabilityMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c := s.metricsCollector()
		start := time.Now()

		tc := resolveTraceContext(r.Header.Get("Traceparent"))
		w.Header().Set("Traceparent", tc.header)
		ctx := context.WithValue(r.Context(), traceContextKey, tc)
		req := r.WithContext(ctx)

		rw := &obsResponseWriter{
			ResponseWriter: w,
			status:         http.StatusOK,
		}
		next.ServeHTTP(rw, req)

		route := normalizeRoute(req)
		c.recordHTTP(req.Method, route, rw.status, time.Since(start))
	})
}

type obsResponseWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (w *obsResponseWriter) WriteHeader(code int) {
	if !w.wroteHeader && (code < 100 || code >= 200 || code == http.StatusSwitchingProtocols) {
		w.status = code
		w.wroteHeader = true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *obsResponseWriter) Write(p []byte) (int, error) {
	if !w.wroteHeader {
		w.status = http.StatusOK
		w.wroteHeader = true
	}
	return w.ResponseWriter.Write(p)
}

// Flush preserves http.Flusher for SSE / chunked streaming responses.
func (w *obsResponseWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack preserves http.Hijacker for WebSocket upgrades.
func (w *obsResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("observability: ResponseWriter does not implement http.Hijacker: %w", http.ErrNotSupported)
	}
	if !w.wroteHeader {
		w.status = http.StatusSwitchingProtocols
		w.wroteHeader = true
	}
	return h.Hijack()
}

// Unwrap supports http.ResponseController (Go 1.20+).
func (w *obsResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func resolveTraceContext(incoming string) traceContext {
	traceID, parentID, flags, ok := parseTraceparent(incoming)
	spanID := randomHexNonZero(8)
	if !ok {
		traceID = randomHexNonZero(16)
		parentID = ""
		flags = "01"
	}
	header := "00-" + traceID + "-" + spanID + "-" + flags
	return traceContext{
		traceID:  traceID,
		spanID:   spanID,
		parentID: parentID,
		flags:    flags,
		header:   header,
	}
}

func parseTraceparent(raw string) (traceID, parentID, flags string, ok bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", "", "", false
	}
	parts := strings.Split(s, "-")
	if len(parts) < 4 {
		return "", "", "", false
	}
	version := parts[0]
	if !isLowerHex(version, 2) || version == "ff" {
		return "", "", "", false
	}
	if version == "00" && len(parts) != 4 {
		return "", "", "", false
	}
	traceID = parts[1]
	parentID = parts[2]
	flags = parts[3]
	if !isLowerHex(traceID, 32) || isAllZero(traceID) {
		return "", "", "", false
	}
	if !isLowerHex(parentID, 16) || isAllZero(parentID) {
		return "", "", "", false
	}
	if !isLowerHex(flags, 2) {
		return "", "", "", false
	}
	return traceID, parentID, flags, true
}

func isLowerHex(s string, wantLen int) bool {
	if len(s) != wantLen {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func isAllZero(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] != '0' {
			return false
		}
	}
	return true
}

func randomHexNonZero(nBytes int) string {
	b := make([]byte, nBytes)
	_, _ = rand.Read(b)
	allZero := true
	for _, v := range b {
		if v != 0 {
			allZero = false
			break
		}
	}
	if allZero && len(b) > 0 {
		b[len(b)-1] = 1
	}
	return hex.EncodeToString(b)
}

func httpStatusClass(code int) string {
	switch {
	case code >= 100 && code < 200:
		return "1xx"
	case code >= 200 && code < 300:
		return "2xx"
	case code >= 300 && code < 400:
		return "3xx"
	case code >= 400 && code < 500:
		return "4xx"
	case code >= 500 && code < 600:
		return "5xx"
	default:
		return "unknown"
	}
}

func normalizeRoute(r *http.Request) string {
	if r == nil {
		return "/*"
	}
	if pat := strings.TrimSpace(r.Pattern); pat != "" {
		if idx := strings.IndexByte(pat, ' '); idx > 0 {
			methodPrefix := pat[:idx]
			if isAllUpperASCII(methodPrefix) {
				pat = strings.TrimSpace(pat[idx+1:])
			}
		}
		if pat == "/api/" {
			return "/api/*"
		}
		if pat != "" {
			return pat
		}
	}
	if r.URL == nil {
		return "/*"
	}
	return normalizePathFallback(r.URL.Path)
}

func normalizePathFallback(rawPath string) string {
	cleaned := path.Clean("/" + strings.TrimPrefix(rawPath, "/"))
	switch cleaned {
	case "/", "/healthz", "/readyz", "/metrics":
		return cleaned
	}
	if !strings.HasPrefix(cleaned, "/api/") && !strings.HasPrefix(cleaned, "/scim/") {
		return "/*"
	}
	parts := strings.Split(cleaned, "/")
	for i := 1; i < len(parts); i++ {
		seg := parts[i]
		prev := ""
		if i > 1 {
			prev = parts[i-1]
		}
		switch {
		case prev == "public" && seg != "surveys":
			parts[i] = "{token}"
		case prev == "surveys" && i >= 3 && parts[i-2] == "public":
			parts[i] = "{token}"
		case prev == "share" || prev == "forms":
			parts[i] = "{token}"
		case prev == "sso" && seg != "providers" && seg != "discover":
			parts[i] = "{slug}"
		case prev == "conditional-ops" || prev == "synced-blocks" || prev == "invitations" || prev == "files":
			parts[i] = "{id}"
		case isDigits(seg) || isUUIDLike(seg) || isLongHex(seg):
			parts[i] = "{id}"
		}
	}
	return strings.Join(parts, "/")
}

func isAllUpperASCII(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 'A' || s[i] > 'Z' {
			return false
		}
	}
	return true
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func isLongHex(s string) bool {
	if len(s) < 16 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func isUUIDLike(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func promEscapeLabel(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	return s
}

func promFloat(v float64) string {
	return strconv.FormatFloat(v, 'g', -1, 64)
}
