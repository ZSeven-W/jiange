// Package httpx holds small self-written HTTP helpers and middleware on top of net/http.
package httpx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"mime"
	"net/http"
	"path"
	"runtime/debug"
	"strings"
	"time"
)

type Middleware func(http.Handler) http.Handler

// Chain applies middleware so that the first one is the outermost.
func Chain(h http.Handler, mw ...Middleware) http.Handler {
	for i := len(mw) - 1; i >= 0; i-- {
		h = mw[i](h)
	}
	return h
}

type ctxKey int

const requestIDKey ctxKey = 1

func RequestID(r *http.Request) string {
	v, _ := r.Context().Value(requestIDKey).(string)
	return v
}

// WithRequestID assigns an X-Request-Id to every request.
func WithRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if id == "" || len(id) > 64 {
			b := make([]byte, 8)
			_, _ = rand.Read(b)
			id = hex.EncodeToString(b)
		}
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey, id)))
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(c int)           { s.status = c; s.ResponseWriter.WriteHeader(c) }
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// Logger logs one line per request.
func Logger(log *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			sw := &statusWriter{ResponseWriter: w, status: 200}
			next.ServeHTTP(sw, r)
			log.Info("http", "method", r.Method, "path", safeLogPath(r.URL.Path), "status", sw.status,
				"dur_ms", time.Since(start).Milliseconds(), "rid", RequestID(r))
		})
	}
}

// Share tokens are bearer credentials and must not be written to access logs.
func safeLogPath(rawPath string) string {
	redact := func(value string) (string, bool) {
		parts := strings.Split(value, "/")
		found := false
		next := func(i int) int {
			for i < len(parts) && (parts[i] == "" || parts[i] == ".") {
				i++
			}
			return i
		}
		for i := 0; i < len(parts); i++ {
			if parts[i] != "api" {
				continue
			}
			j := next(i + 1)
			if j >= len(parts) || parts[j] != "public" && parts[j] != "share" && parts[j] != "forms" {
				continue
			}
			k := next(j + 1)
			if k < len(parts) {
				if parts[j] == "forms" {
					// Redact the entire tail even for malformed or encoded paths;
					// bearer credentials must never reach an access log.
					parts = append(parts[:k], "[redacted]")
				} else {
					parts[k] = "[redacted]"
				}
				found = true
			}
		}
		return strings.Join(parts, "/"), found
	}
	// Check both forms: cleaning a path can either reveal the protected route
	// or erase it after a token, e.g. /api/public/token/../../healthz.
	if redacted, found := redact(rawPath); found {
		return redacted
	}
	cleaned := path.Clean("/" + strings.TrimPrefix(rawPath, "/"))
	if redacted, found := redact(cleaned); found {
		return redacted
	}
	return rawPath
}

// Recover turns panics into 500 responses.
func Recover(log *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if v := recover(); v != nil {
					log.Error("panic", "err", v, "rid", RequestID(r), "stack", string(debug.Stack()))
					Error(w, http.StatusInternalServerError, "internal_error", "internal error")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// SecurityHeaders sets conservative default headers.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		next.ServeHTTP(w, r)
	})
}

// RequireJSON rejects state-changing requests that are not application/json.
// Together with SameSite=Lax cookies this blocks classic form-based CSRF.
func RequireJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
			mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
			// uploads carry a custom header, which cross-site forms cannot set
			upload := mt == "multipart/form-data" && r.Header.Get("X-Jiange-Upload") == "1"
			if mt != "application/json" && r.ContentLength != 0 && !upload {
				Error(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "expected application/json")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// JSON writes v as JSON with the given status.
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

type errorBody struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

func Error(w http.ResponseWriter, status int, code, msg string) {
	JSON(w, status, errorBody{code, msg})
}

// Decode reads a JSON body (max 1 MiB) into v, rejecting unknown fields.
func Decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		Error(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return false
	}
	return true
}
