package httpx

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLoggerRedactsShareTokens(t *testing.T) {
	for _, path := range []string{"/api/public/secret-token", "/api/public/secret-token/files/123", "/api/share/secret-token", "/api//public/secret-token", "/x/../api/share/secret-token", "/api/public/secret-token/../../healthz", "/prefix/../api/x/../public/secret-token"} {
		var log bytes.Buffer
		h := Logger(slog.New(slog.NewJSONHandler(&log, nil)))(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
		if strings.Contains(log.String(), "secret-token") || !strings.Contains(log.String(), "[redacted]") {
			t.Fatalf("share credential leaked in log for %s: %s", path, log.String())
		}
	}
}
