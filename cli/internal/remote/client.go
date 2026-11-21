package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

// DefaultPrefix is the default API route prefix for Jiange Go Backend SDK servers.
const DefaultPrefix = "/api/v1"

// APIError describes a non-2xx HTTP response returned by a remote Jiange backend server.
type APIError struct {
	StatusCode int
	Message    string
	Body       string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("remote api error (status %d): %s", e.StatusCode, e.Message)
}

// Option configures a remote Client.
type Option func(*Client)

// WithToken sets the Bearer token sent via Authorization: Bearer <token>.
func WithToken(token string) Option {
	return func(c *Client) {
		c.token = strings.TrimSpace(token)
	}
}

// WithPrefix sets a custom API base prefix (e.g. "/api/v1", "/api/jiange", or "" for root).
func WithPrefix(prefix string) Option {
	return func(c *Client) {
		c.prefix = normalizePrefix(prefix)
	}
}

// WithHTTPClient overrides the underlying *http.Client.
func WithHTTPClient(hc *http.Client) Option {
	return func(c *Client) {
		if hc != nil {
			c.httpClient = hc
		}
	}
}

// Client is a zero-dependency HTTP client targeting any Jiange Go Backend SDK server.
type Client struct {
	baseURL    string
	prefix     string
	token      string
	httpClient *http.Client
	nextRPCID  atomic.Int64
}

// NewClient creates a remote Client pointing at baseURL with DefaultPrefix ("/api/v1").
func NewClient(baseURL string, opts ...Option) *Client {
	c := &Client{
		baseURL:    strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		prefix:     DefaultPrefix,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
	for _, opt := range opts {
		if opt != nil {
			opt(c)
		}
	}
	return c
}

func normalizePrefix(prefix string) string {
	trimmed := strings.Trim(strings.TrimSpace(prefix), "/")
	if trimmed == "" {
		return ""
	}
	return "/" + trimmed
}

func (c *Client) resolveURL(path string) string {
	p := strings.TrimSpace(path)
	if p == "" {
		p = "/"
	} else if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	if c.prefix == "" || strings.HasSuffix(c.baseURL, c.prefix) || p == c.prefix || strings.HasPrefix(p, c.prefix+"/") {
		return c.baseURL + p
	}
	return c.baseURL + c.prefix + p
}

// RequestJSON performs an HTTP request with optional JSON body and decodes the JSON response.
// Non-2xx responses return a structured *APIError. Empty 2xx bodies return {"ok": true, "status": code}.
func (c *Client) RequestJSON(ctx context.Context, method, path string, body any) (map[string]any, error) {
	if c.baseURL == "" {
		return nil, fmt.Errorf("remote server url is required")
	}
	var bodyReader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encode request body: %w", err)
		}
		bodyReader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.resolveURL(path), bodyReader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 32*1024*1024))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		rawMsg := strings.TrimSpace(string(data))
		msg := rawMsg
		var errPayload struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		if json.Unmarshal(data, &errPayload) == nil {
			if errPayload.Error != "" {
				msg = errPayload.Error
			} else if errPayload.Message != "" {
				msg = errPayload.Message
			}
		}
		if msg == "" {
			msg = http.StatusText(resp.StatusCode)
		}
		return nil, &APIError{
			StatusCode: resp.StatusCode,
			Message:    msg,
			Body:       rawMsg,
		}
	}

	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return map[string]any{"ok": true, "status": resp.StatusCode}, nil
	}
	var decoded any
	if err := json.Unmarshal(trimmed, &decoded); err != nil {
		return nil, fmt.Errorf("decode response json: %w", err)
	}
	if obj, ok := decoded.(map[string]any); ok {
		return obj, nil
	}
	return map[string]any{"data": decoded}, nil
}

// Health calls GET /health on the remote server.
func (c *Client) Health(ctx context.Context) (map[string]any, error) {
	return c.RequestJSON(ctx, http.MethodGet, "/health", nil)
}

// ListAITools calls GET /ai/tools on the remote server.
func (c *Client) ListAITools(ctx context.Context) (map[string]any, error) {
	return c.RequestJSON(ctx, http.MethodGet, "/ai/tools", nil)
}

// CallAITool invokes a named AI tool via POST /ai/tools/{name}.
func (c *Client) CallAITool(ctx context.Context, name string, args map[string]any) (map[string]any, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("tool name is required")
	}
	if args == nil {
		args = map[string]any{}
	}
	return c.RequestJSON(ctx, http.MethodPost, "/ai/tools/"+url.PathEscape(name), args)
}

// MCPCall invokes a JSON-RPC 2.0 MCP method via POST /mcp.
func (c *Client) MCPCall(ctx context.Context, method string, params any) (map[string]any, error) {
	method = strings.TrimSpace(method)
	if method == "" {
		return nil, fmt.Errorf("mcp method is required")
	}
	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      c.nextRPCID.Add(1),
		"method":  method,
	}
	if params != nil {
		payload["params"] = params
	}
	resp, err := c.RequestJSON(ctx, http.MethodPost, "/mcp", payload)
	if err != nil {
		return nil, err
	}
	if rpcErr, ok := resp["error"].(map[string]any); ok && rpcErr != nil {
		return nil, fmt.Errorf("mcp rpc error (%v): %v", rpcErr["code"], rpcErr["message"])
	}
	return resp, nil
}
