package client

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/sdk/go/base"
	"github.com/ZSeven-W/jiange/sdk/go/doc"
	"github.com/ZSeven-W/jiange/sdk/go/server"
	"github.com/ZSeven-W/jiange/sdk/go/sheet"
	"github.com/ZSeven-W/jiange/sdk/go/slides"
	"github.com/ZSeven-W/jiange/sdk/go/storage"
	"github.com/ZSeven-W/jiange/sdk/go/whiteboard"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type errReadCloser struct{}

func (errReadCloser) Read([]byte) (int, error) { return 0, errors.New("body read fail") }
func (errReadCloser) Close() error             { return nil }

func TestClientEndToEndWithServer(t *testing.T) {
	auth := storage.NewBearerTokenAuth(map[string]storage.Principal{
		"valid-tok": {ID: "u1", Roles: []string{"admin"}},
	})
	backend := server.New(server.Config{
		Auth:  auth,
		Authz: storage.NewRoleAuthorizer(nil),
	})
	ts := httptest.NewServer(backend)
	defer ts.Close()

	c := NewClient(ts.URL+"/", WithBearerToken("valid-tok"), WithHTTPClient(ts.Client()))
	ctx := context.Background()

	// Sheet lifecycle
	wb := sheet.NewWorkbook("Budget")
	sResp, err := c.CreateSheet(ctx, "s1", "Q1 Budget", wb)
	if err != nil || sResp.ID != "s1" || sResp.Version != 1 {
		t.Fatalf("CreateSheet failed: %+v err=%v", sResp, err)
	}
	aResp, err := c.ApplySheet(ctx, "s1", []sheet.Op{
		{Op: "setCell", Sheet: "Budget", A1: "A1", Raw: "10"},
		{Op: "setCell", Sheet: "Budget", A1: "A2", Raw: "=A1*5"},
	}, false)
	if err != nil || aResp.Applied != 2 || aResp.Version != 2 {
		t.Fatalf("ApplySheet failed: %+v err=%v", aResp, err)
	}
	insp, err := c.InspectSheet(ctx, "s1", "full")
	if err != nil || insp.Workbook.Sheets[0].Cells["A2"].Value != 50.0 {
		t.Fatalf("InspectSheet failed: %+v err=%v", insp, err)
	}
	diags, err := c.VerifySheet(ctx, "s1")
	if err != nil || len(diags) != 0 {
		t.Fatalf("VerifySheet failed: %+v err=%v", diags, err)
	}

	// Doc lifecycle
	dResp, err := c.CreateDoc(ctx, "d1", "Spec", doc.ParseMarkdown("# Intro\n\nHello", "Spec"))
	if err != nil || dResp.ID != "d1" {
		t.Fatalf("CreateDoc failed: %+v err=%v", dResp, err)
	}
	docApply, err := c.ApplyDoc(ctx, "d1", []doc.Op{{Op: "appendBlock", Text: "More text"}}, false)
	if err != nil || docApply.Applied != 1 {
		t.Fatalf("ApplyDoc failed: %+v err=%v", docApply, err)
	}

	// Slides lifecycle + SVG render
	slResp, err := c.CreateSlides(ctx, "p1", "Deck", &slides.Deck{
		Title:  "Deck",
		Slides: []slides.Slide{{Index: 0, Title: "Hello", Body: "World"}},
	})
	if err != nil || slResp.ID != "p1" {
		t.Fatalf("CreateSlides failed: %+v err=%v", slResp, err)
	}
	svg, err := c.RenderSlideSVG(ctx, "p1", 0)
	if err != nil || !strings.Contains(svg, "<svg") || !strings.Contains(svg, "Hello") {
		t.Fatalf("RenderSlideSVG failed: %q err=%v", svg, err)
	}

	// Whiteboard lifecycle
	bResp, err := c.CreateBoard(ctx, "b1", "Arch", whiteboard.ParseMermaid("flowchart TD\nA --> B"))
	if err != nil || bResp.ID != "b1" || len(bResp.Board.Nodes) != 2 {
		t.Fatalf("CreateBoard failed: %+v err=%v", bResp, err)
	}

	// Base lifecycle + Query
	baseData, _ := base.ParseCSV([]byte("Name,Score\nAlice,99\nBob,80\n"), "Scores")
	bsResp, err := c.CreateBase(ctx, "bs1", "Scores", baseData)
	if err != nil || bsResp.ID != "bs1" {
		t.Fatalf("CreateBase failed: %+v err=%v", bsResp, err)
	}
	recs, err := c.QueryBase(ctx, "bs1", 1, "alice", 10)
	if err != nil || len(recs) != 1 {
		t.Fatalf("QueryBase failed: %+v err=%v", recs, err)
	}

	// MCP tool call success & tool error
	mcpOut, err := c.CallMCPTool(ctx, "sheet_inspect", map[string]any{"id": "s1"})
	if err != nil || !strings.Contains(mcpOut, `"Budget"`) {
		t.Fatalf("CallMCPTool failed: %q err=%v", mcpOut, err)
	}
	if _, err := c.CallMCPTool(ctx, "sheet_inspect", map[string]any{"id": "missing"}); err == nil || !strings.Contains(err.Error(), "mcp tool error") {
		t.Fatalf("expected mcp tool error, got %v", err)
	}
}

func TestClientErrorPaths(t *testing.T) {
	ctx := context.Background()

	// Unauthorized API error on every client method
	errSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/mcp" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":"unauthorized"}`)
	}))
	defer errSrv.Close()

	c := NewClient(errSrv.URL)
	if _, err := c.CreateSheet(ctx, "s1", "T", nil); err == nil || !strings.Contains(err.Error(), "status 401") {
		t.Fatalf("expected APIError 401, got %v", err)
	}
	if _, err := c.InspectSheet(ctx, "s1", ""); err == nil {
		t.Fatal("expected InspectSheet error")
	}
	if _, err := c.ApplySheet(ctx, "s1", nil, false); err == nil {
		t.Fatal("expected ApplySheet error")
	}
	if _, err := c.VerifySheet(ctx, "s1"); err == nil {
		t.Fatal("expected VerifySheet error")
	}
	if _, err := c.CreateDoc(ctx, "d1", "T", nil); err == nil {
		t.Fatal("expected CreateDoc error")
	}
	if _, err := c.ApplyDoc(ctx, "d1", nil, false); err == nil {
		t.Fatal("expected ApplyDoc error")
	}
	if _, err := c.CreateSlides(ctx, "p1", "T", nil); err == nil {
		t.Fatal("expected CreateSlides error")
	}
	if _, err := c.RenderSlideSVG(ctx, "p1", 0); err == nil {
		t.Fatal("expected RenderSlideSVG error")
	}
	if _, err := c.CreateBoard(ctx, "b1", "T", nil); err == nil {
		t.Fatal("expected CreateBoard error")
	}
	if _, err := c.CreateBase(ctx, "bs1", "T", nil); err == nil {
		t.Fatal("expected CreateBase error")
	}
	if _, err := c.QueryBase(ctx, "bs1", 1, "", 10); err == nil {
		t.Fatal("expected QueryBase error")
	}
	if _, err := c.CallMCPTool(ctx, "x", nil); err == nil || !strings.Contains(err.Error(), "mcp rpc error") {
		t.Fatalf("expected mcp rpc error, got %v", err)
	}

	// Marshal error inside CallMCPTool
	if _, err := c.CallMCPTool(ctx, "x", map[string]any{"bad": make(chan int)}); err == nil {
		t.Fatal("expected json marshal error")
	}

	// Bad baseURL -> http.NewRequestWithContext error
	badURL := NewClient("://bad-url")
	if _, err := badURL.InspectSheet(ctx, "s1", ""); err == nil {
		t.Fatal("expected invalid URL error")
	}

	// Transport error
	netErrClient := NewClient("http://example.invalid", WithHTTPClient(&http.Client{
		Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("dial failed")
		}),
	}))
	if _, err := netErrClient.InspectSheet(ctx, "s1", ""); err == nil {
		t.Fatal("expected transport error")
	}

	// Response body read error
	bodyErrClient := NewClient("http://example.invalid", WithHTTPClient(&http.Client{
		Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, Body: errReadCloser{}}, nil
		}),
	}))
	if _, err := bodyErrClient.InspectSheet(ctx, "s1", ""); err == nil {
		t.Fatal("expected body read error")
	}
}
