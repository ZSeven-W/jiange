package remote

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

type failingBody struct{}

func (failingBody) Read([]byte) (int, error) { return 0, errors.New("read failed") }
func (failingBody) Close() error             { return nil }

func TestClientPrefixAndURLResolution(t *testing.T) {
	cDefault := NewClient("http://localhost:8080/", nil, WithHTTPClient(nil))
	if got := cDefault.resolveURL("/health"); got != "http://localhost:8080/api/v1/health" {
		t.Fatalf("default resolveURL(/health) = %q", got)
	}
	if got := cDefault.resolveURL("sheets/s1"); got != "http://localhost:8080/api/v1/sheets/s1" {
		t.Fatalf("relative path resolveURL = %q", got)
	}
	if got := cDefault.resolveURL(""); got != "http://localhost:8080/api/v1/" {
		t.Fatalf("empty path resolveURL = %q", got)
	}
	if got := cDefault.resolveURL("/api/v1/sheets/s1"); got != "http://localhost:8080/api/v1/sheets/s1" {
		t.Fatalf("already-prefixed path resolveURL = %q", got)
	}

	cPrefixedBase := NewClient("http://localhost:8080/api/v1")
	if got := cPrefixedBase.resolveURL("/health"); got != "http://localhost:8080/api/v1/health" {
		t.Fatalf("prefixed baseURL resolveURL = %q", got)
	}

	cCustom := NewClient("http://localhost:8080", WithPrefix("api/jiange/"))
	if got := cCustom.resolveURL("/ai/tools"); got != "http://localhost:8080/api/jiange/ai/tools" {
		t.Fatalf("custom prefix resolveURL = %q", got)
	}

	cRoot := NewClient("http://localhost:8080", WithPrefix(""))
	if got := cRoot.resolveURL("/health"); got != "http://localhost:8080/health" {
		t.Fatalf("empty prefix resolveURL = %q", got)
	}
}

func TestClientEndpointsAndAuth(t *testing.T) {
	var lastAuth string
	var lastMethod string
	var lastPath string
	var lastBody map[string]any

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		lastAuth = r.Header.Get("Authorization")
		lastMethod = r.Method
		lastPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"service":"jiange-backend"}`))
	})
	mux.HandleFunc("/api/v1/ai/tools", func(w http.ResponseWriter, r *http.Request) {
		lastAuth = r.Header.Get("Authorization")
		lastMethod = r.Method
		lastPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tools":[{"name":"sheet_inspect"}]}`))
	})
	mux.HandleFunc("/api/v1/ai/tools/sheet_inspect", func(w http.ResponseWriter, r *http.Request) {
		lastAuth = r.Header.Get("Authorization")
		lastMethod = r.Method
		lastPath = r.URL.Path
		lastBody = nil
		_ = json.NewDecoder(r.Body).Decode(&lastBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"result":{"sheets":1}}`))
	})
	mux.HandleFunc("/api/v1/mcp", func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("Content-Type", "application/json")
		if req["method"] == "boom" {
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`))
	})
	mux.HandleFunc("/api/v1/items", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodGet:
			_, _ = w.Write([]byte(`[{"id":"1"},{"id":"2"}]`))
		case http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		case http.MethodPatch:
			_, _ = w.Write([]byte(`{"patched":true}`))
		}
	})

	ts := httptest.NewServer(mux)
	defer ts.Close()

	ctx := context.Background()
	c := NewClient(ts.URL, WithToken("secret-tok"), WithHTTPClient(ts.Client()))

	// Health
	h, err := c.Health(ctx)
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	if h["ok"] != true || lastAuth != "Bearer secret-tok" || lastMethod != http.MethodGet || lastPath != "/api/v1/health" {
		t.Fatalf("unexpected Health result/request: h=%v auth=%q method=%q path=%q", h, lastAuth, lastMethod, lastPath)
	}

	// ListAITools
	tools, err := c.ListAITools(ctx)
	if err != nil {
		t.Fatalf("ListAITools: %v", err)
	}
	if _, ok := tools["tools"]; !ok || lastPath != "/api/v1/ai/tools" {
		t.Fatalf("unexpected ListAITools: %v path=%q", tools, lastPath)
	}

	// CallAITool (empty name error, nil args, populated args)
	if _, err := c.CallAITool(ctx, "   ", nil); err == nil {
		t.Fatalf("expected error for empty tool name")
	}
	if _, err := c.CallAITool(ctx, "sheet_inspect", nil); err != nil {
		t.Fatalf("CallAITool nil args: %v", err)
	}
	if len(lastBody) != 0 {
		t.Fatalf("expected empty JSON object for nil args, got %v", lastBody)
	}
	res, err := c.CallAITool(ctx, "sheet_inspect", map[string]any{"id": "s1"})
	if err != nil {
		t.Fatalf("CallAITool: %v", err)
	}
	if res["ok"] != true || lastBody["id"] != "s1" {
		t.Fatalf("unexpected CallAITool result=%v body=%v", res, lastBody)
	}

	// MCPCall (empty method, without params, with params, RPC error)
	if _, err := c.MCPCall(ctx, "", nil); err == nil {
		t.Fatalf("expected error for empty MCP method")
	}
	mcpRes, err := c.MCPCall(ctx, "tools/list", nil)
	if err != nil || mcpRes["jsonrpc"] != "2.0" {
		t.Fatalf("MCPCall tools/list failed: res=%v err=%v", mcpRes, err)
	}
	mcpRes2, err := c.MCPCall(ctx, "tools/call", map[string]any{"name": "sheet_inspect"})
	if err != nil || mcpRes2["jsonrpc"] != "2.0" {
		t.Fatalf("MCPCall with params failed: res=%v err=%v", mcpRes2, err)
	}
	if _, err := c.MCPCall(ctx, "boom", nil); err == nil || !strings.Contains(err.Error(), "method not found") {
		t.Fatalf("expected MCP RPC error, got %v", err)
	}

	// Generic RequestJSON: array wrapping, 204 empty body, PATCH
	arrRes, err := c.RequestJSON(ctx, http.MethodGet, "/items", nil)
	if err != nil {
		t.Fatalf("GET /items: %v", err)
	}
	if items, ok := arrRes["data"].([]any); !ok || len(items) != 2 {
		t.Fatalf("expected wrapped array data, got %#v", arrRes)
	}
	delRes, err := c.RequestJSON(ctx, http.MethodDelete, "/items", nil)
	if err != nil || delRes["ok"] != true || delRes["status"] != http.StatusNoContent {
		t.Fatalf("DELETE /items unexpected: res=%#v err=%v", delRes, err)
	}
	patchRes, err := c.RequestJSON(ctx, http.MethodPatch, "/items", map[string]any{"name": "v2"})
	if err != nil || patchRes["patched"] != true {
		t.Fatalf("PATCH /items unexpected: res=%#v err=%v", patchRes, err)
	}
}

func TestClientErrorPaths(t *testing.T) {
	ctx := context.Background()

	// Empty baseURL
	if _, err := NewClient("").Health(ctx); err == nil {
		t.Fatalf("expected error for empty baseURL")
	}

	// Unmarshalable request body
	cBase := NewClient("http://127.0.0.1:1")
	if _, err := cBase.RequestJSON(ctx, http.MethodPost, "/x", make(chan int)); err == nil {
		t.Fatalf("expected encode request body error")
	}

	// Invalid HTTP method
	if _, err := cBase.RequestJSON(ctx, "BAD METHOD", "/x", nil); err == nil {
		t.Fatalf("expected invalid method error")
	}

	// Transport failure (also triggers MCPCall RequestJSON error branch)
	cFailDo := NewClient("http://example.invalid", WithHTTPClient(&http.Client{
		Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("dial boom")
		}),
	}))
	if _, err := cFailDo.MCPCall(ctx, "ping", nil); err == nil || !strings.Contains(err.Error(), "dial boom") {
		t.Fatalf("expected transport error, got %v", err)
	}

	// Response body read error
	cFailRead := NewClient("http://example.invalid", WithHTTPClient(&http.Client{
		Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       failingBody{},
				Header:     make(http.Header),
			}, nil
		}),
	}))
	if _, err := cFailRead.Health(ctx); err == nil || !strings.Contains(err.Error(), "read failed") {
		t.Fatalf("expected body read error, got %v", err)
	}

	// HTTP error variants & invalid JSON 200 body
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/err-json-error":
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":"invalid token"}`)
		case "/api/v1/err-json-message":
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"message":"resource missing"}`)
		case "/api/v1/err-plain":
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, "plain server crash")
		case "/api/v1/err-empty":
			w.WriteHeader(http.StatusServiceUnavailable)
		case "/api/v1/bad-json":
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, "{not-valid-json")
		}
	}))
	defer ts.Close()

	c := NewClient(ts.URL)

	tests := []struct {
		path       string
		wantStatus int
		wantSubstr string
	}{
		{"/err-json-error", http.StatusUnauthorized, "invalid token"},
		{"/err-json-message", http.StatusNotFound, "resource missing"},
		{"/err-plain", http.StatusInternalServerError, "plain server crash"},
		{"/err-empty", http.StatusServiceUnavailable, "Service Unavailable"},
	}
	for _, tc := range tests {
		_, err := c.RequestJSON(ctx, http.MethodGet, tc.path, nil)
		var apiErr *APIError
		if !errors.As(err, &apiErr) {
			t.Fatalf("%s: expected *APIError, got %T (%v)", tc.path, err, err)
		}
		if apiErr.StatusCode != tc.wantStatus || !strings.Contains(apiErr.Error(), tc.wantSubstr) {
			t.Fatalf("%s: unexpected APIError: %#v (%q)", tc.path, apiErr, apiErr.Error())
		}
	}

	if _, err := c.RequestJSON(ctx, http.MethodGet, "/bad-json", nil); err == nil || !strings.Contains(err.Error(), "decode response json") {
		t.Fatalf("expected decode response json error, got %v", err)
	}
}
