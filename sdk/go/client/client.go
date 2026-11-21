package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ZSeven-W/jiange/sdk/go/base"
	"github.com/ZSeven-W/jiange/sdk/go/doc"
	"github.com/ZSeven-W/jiange/sdk/go/sheet"
	"github.com/ZSeven-W/jiange/sdk/go/slides"
	"github.com/ZSeven-W/jiange/sdk/go/whiteboard"
)

// APIError describes a non-2xx HTTP response returned by a Jiange backend service.
type APIError struct {
	StatusCode int
	Message    string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("jiange api error (status %d): %s", e.StatusCode, e.Message)
}

// Option configures a Client.
type Option func(*Client)

// WithBearerToken sets the Authorization: Bearer <token> header for every request.
func WithBearerToken(token string) Option {
	return func(c *Client) {
		c.token = token
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

// Client is a strongly-typed HTTP client for any Jiange Backend SDK service.
type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

// NewClient constructs a Client pointing at baseURL (e.g. "http://localhost:8080/api/jiange").
func NewClient(baseURL string, opts ...Option) *Client {
	c := &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{Timeout: 15 * time.Second},
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// SheetResponse is returned by CreateSheet.
type SheetResponse struct {
	ID       string          `json:"id"`
	Title    string          `json:"title"`
	Version  int64           `json:"version"`
	Workbook *sheet.Workbook `json:"workbook"`
}

// SheetInspectResponse is returned by InspectSheet.
type SheetInspectResponse struct {
	ID       string          `json:"id"`
	Title    string          `json:"title"`
	Version  int64           `json:"version"`
	Inspect  map[string]any  `json:"inspect"`
	Workbook *sheet.Workbook `json:"workbook"`
}

// DocResponse is returned by CreateDoc.
type DocResponse struct {
	ID       string        `json:"id"`
	Title    string        `json:"title"`
	Version  int64         `json:"version"`
	Document *doc.Document `json:"document"`
}

// SlidesResponse is returned by CreateSlides.
type SlidesResponse struct {
	ID      string       `json:"id"`
	Title   string       `json:"title"`
	Version int64        `json:"version"`
	Deck    *slides.Deck `json:"deck"`
}

// BoardResponse is returned by CreateBoard.
type BoardResponse struct {
	ID      string            `json:"id"`
	Title   string            `json:"title"`
	Version int64             `json:"version"`
	Board   *whiteboard.Board `json:"board"`
}

// BaseResponse is returned by CreateBase.
type BaseResponse struct {
	ID      string     `json:"id"`
	Title   string     `json:"title"`
	Version int64      `json:"version"`
	Base    *base.Base `json:"base"`
}

// ApplyResponse is returned by ApplySheet and ApplyDoc.
type ApplyResponse struct {
	OK      bool     `json:"ok"`
	Applied int      `json:"applied"`
	DryRun  bool     `json:"dryRun"`
	Diff    []string `json:"diff"`
	Version int64    `json:"version"`
}

func (c *Client) doRaw(ctx context.Context, method, path string, body any) ([]byte, error) {
	var bodyReader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		bodyReader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bodyReader)
	if err != nil {
		return nil, err
	}
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
		msg := strings.TrimSpace(string(data))
		var errBody struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &errBody) == nil && errBody.Error != "" {
			msg = errBody.Error
		}
		return nil, &APIError{StatusCode: resp.StatusCode, Message: msg}
	}
	return data, nil
}

func (c *Client) doJSON(ctx context.Context, method, path string, reqBody, dst any) error {
	data, err := c.doRaw(ctx, method, path, reqBody)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, dst)
}

// CreateSheet creates a new spreadsheet document via POST /sheets.
func (c *Client) CreateSheet(ctx context.Context, id, title string, wb *sheet.Workbook) (*SheetResponse, error) {
	var out SheetResponse
	err := c.doJSON(ctx, http.MethodPost, "/sheets", map[string]any{
		"id":       id,
		"title":    title,
		"workbook": wb,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// InspectSheet fetches and inspects a spreadsheet via GET /sheets/{id}.
func (c *Client) InspectSheet(ctx context.Context, id, detail string) (*SheetInspectResponse, error) {
	path := "/sheets/" + url.PathEscape(id)
	if detail != "" {
		path += "?detail=" + url.QueryEscape(detail)
	}
	var out SheetInspectResponse
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ApplySheet atomically applies spreadsheet ops via POST /sheets/{id}/apply.
func (c *Client) ApplySheet(ctx context.Context, id string, ops []sheet.Op, dryRun bool) (*ApplyResponse, error) {
	var out ApplyResponse
	err := c.doJSON(ctx, http.MethodPost, "/sheets/"+url.PathEscape(id)+"/apply", map[string]any{
		"ops":    ops,
		"dryRun": dryRun,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// VerifySheet runs formula verification via POST /sheets/{id}/verify.
func (c *Client) VerifySheet(ctx context.Context, id string) ([]sheet.Diagnostic, error) {
	var out struct {
		Diagnostics []sheet.Diagnostic `json:"diagnostics"`
	}
	if err := c.doJSON(ctx, http.MethodPost, "/sheets/"+url.PathEscape(id)+"/verify", nil, &out); err != nil {
		return nil, err
	}
	return out.Diagnostics, nil
}

// CreateDoc creates a new document via POST /docs.
func (c *Client) CreateDoc(ctx context.Context, id, title string, d *doc.Document) (*DocResponse, error) {
	var out DocResponse
	err := c.doJSON(ctx, http.MethodPost, "/docs", map[string]any{
		"id":       id,
		"title":    title,
		"document": d,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ApplyDoc atomically applies document ops via POST /docs/{id}/apply.
func (c *Client) ApplyDoc(ctx context.Context, id string, ops []doc.Op, dryRun bool) (*ApplyResponse, error) {
	var out ApplyResponse
	err := c.doJSON(ctx, http.MethodPost, "/docs/"+url.PathEscape(id)+"/apply", map[string]any{
		"ops":    ops,
		"dryRun": dryRun,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateSlides creates a new slide deck via POST /slides.
func (c *Client) CreateSlides(ctx context.Context, id, title string, d *slides.Deck) (*SlidesResponse, error) {
	var out SlidesResponse
	err := c.doJSON(ctx, http.MethodPost, "/slides", map[string]any{
		"id":    id,
		"title": title,
		"deck":  d,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// RenderSlideSVG renders slide at index as SVG via GET /slides/{id}/render/{index}.svg.
func (c *Client) RenderSlideSVG(ctx context.Context, id string, index int) (string, error) {
	raw, err := c.doRaw(ctx, http.MethodGet, fmt.Sprintf("/slides/%s/render/%d.svg", url.PathEscape(id), index), nil)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// CreateBoard creates a new whiteboard via POST /boards.
func (c *Client) CreateBoard(ctx context.Context, id, title string, b *whiteboard.Board) (*BoardResponse, error) {
	var out BoardResponse
	err := c.doJSON(ctx, http.MethodPost, "/boards", map[string]any{
		"id":    id,
		"title": title,
		"board": b,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateBase creates a new multidimensional Base via POST /bases.
func (c *Client) CreateBase(ctx context.Context, id, title string, b *base.Base) (*BaseResponse, error) {
	var out BaseResponse
	err := c.doJSON(ctx, http.MethodPost, "/bases", map[string]any{
		"id":    id,
		"title": title,
		"base":  b,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// QueryBase queries Base records via POST /bases/{id}/query.
func (c *Client) QueryBase(ctx context.Context, id string, tableID int, search string, limit int) ([]base.Record, error) {
	var out struct {
		Records []base.Record `json:"records"`
	}
	err := c.doJSON(ctx, http.MethodPost, "/bases/"+url.PathEscape(id)+"/query", map[string]any{
		"tableId": tableID,
		"search":  search,
		"limit":   limit,
	}, &out)
	if err != nil {
		return nil, err
	}
	return out.Records, nil
}

// CallMCPTool invokes an MCP tool via JSON-RPC 2.0 POST /mcp and returns its text output.
func (c *Client) CallMCPTool(ctx context.Context, name string, args map[string]any) (string, error) {
	var rpcResp struct {
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	err := c.doJSON(ctx, http.MethodPost, "/mcp", map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      name,
			"arguments": args,
		},
	}, &rpcResp)
	if err != nil {
		return "", err
	}
	if rpcResp.Error != nil {
		return "", fmt.Errorf("mcp rpc error %d: %s", rpcResp.Error.Code, rpcResp.Error.Message)
	}
	var texts []string
	for _, item := range rpcResp.Result.Content {
		texts = append(texts, item.Text)
	}
	joined := strings.Join(texts, "\n")
	if rpcResp.Result.IsError {
		return "", fmt.Errorf("mcp tool error: %s", joined)
	}
	return joined, nil
}
