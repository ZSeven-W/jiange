package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/sdk/go/ai"
	"github.com/ZSeven-W/jiange/sdk/go/storage"
)

func TestServerAllFeaturesAndAccessors(t *testing.T) {
	whHits := 0
	whSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		whHits++
		w.WriteHeader(http.StatusOK)
	}))
	defer whSrv.Close()

	auth := storage.NewBearerTokenAuth(map[string]storage.Principal{
		"tok": {ID: "u1", Roles: []string{"admin"}},
	})
	srv := New(Config{
		Auth:    auth,
		Authz:   storage.NewRoleAuthorizer(nil),
		Webhook: storage.NewWebhookDispatcher(whSrv.URL, "secret", whSrv.Client()),
	})

	if srv.Store() == nil || srv.Hub() == nil || srv.Tools() == nil || srv.MCP() == nil || !srv.Features().Sheet {
		t.Fatal("expected all server components initialized")
	}
	// 4 sheet + 4 doc + 4 slides + 4 board + 4 base = 20 tools
	if len(srv.Tools().List()) != 20 {
		t.Fatalf("expected 20 registered tools, got %d", len(srv.Tools().List()))
	}

	req := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer tok")
		r.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, r)
		return rec
	}

	if rec := req(http.MethodGet, "/healthz", ""); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("healthz failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := req(http.MethodGet, "/health", ""); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("health alias failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := req(http.MethodPost, "/sheets", `{"id":"s1","title":"S1"}`); rec.Code != http.StatusCreated {
		t.Fatalf("sheet route failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := req(http.MethodPost, "/docs", `{"id":"d1","title":"D1"}`); rec.Code != http.StatusCreated {
		t.Fatalf("doc route failed: %d", rec.Code)
	}
	if rec := req(http.MethodPost, "/slides", `{"id":"p1","title":"P1"}`); rec.Code != http.StatusCreated {
		t.Fatalf("slides route failed: %d", rec.Code)
	}
	if rec := req(http.MethodPost, "/boards", `{"id":"b1","title":"B1"}`); rec.Code != http.StatusCreated {
		t.Fatalf("board route failed: %d", rec.Code)
	}
	if rec := req(http.MethodPost, "/bases", `{"id":"bs1","title":"BS1"}`); rec.Code != http.StatusCreated {
		t.Fatalf("base route failed: %d", rec.Code)
	}
	if rec := req(http.MethodPost, "/rooms/r1/ops", `{"baseSeq":0,"clientId":"c1","type":"ping"}`); rec.Code != http.StatusOK {
		t.Fatalf("sync route failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := req(http.MethodPost, "/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "sheet_inspect") {
		t.Fatalf("mcp route failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := req(http.MethodGet, "/ai/tools", ""); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "sheet_inspect") {
		t.Fatalf("ai tools list failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := req(http.MethodPost, "/ai/tools/sheet_inspect", `{"id":"s1"}`); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("ai tool call failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := req(http.MethodPost, "/ai/tools/sheet_inspect", `{bad`); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid json, got %d", rec.Code)
	}
	if rec := req(http.MethodPost, "/ai/tools/does_not_exist", `{}`); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown tool, got %d", rec.Code)
	}
	if rec := req(http.MethodPost, "/ai/tools/sheet_inspect", `{"id":"missing"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for tool execution error, got %d", rec.Code)
	}
	if whHits != 5 {
		t.Fatalf("expected 5 webhook hits across domains, got %d", whHits)
	}
}

func TestServerSelectiveSubsetAndDuplicateToolPanic(t *testing.T) {
	srv := New(Config{
		ServerName: "custom-sheet-api",
		Version:    "1.2.3",
		Enable:     Features{Sheet: true, MCP: true},
	})
	if srv.Hub() != nil {
		t.Fatal("expected nil Hub when Sync disabled")
	}
	if len(srv.Tools().List()) != 4 {
		t.Fatalf("expected only 4 sheet tools, got %d", len(srv.Tools().List()))
	}

	// Sheet works, Doc is not mounted -> 404
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/sheets", strings.NewReader(`{"id":"only-s"}`)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 for sheet, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/docs", strings.NewReader(`{}`)))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for disabled doc route, got %d", rec.Code)
	}

	// Duplicate tool in pre-populated registry triggers startup panic
	reg := ai.NewToolRegistry()
	_ = reg.Register(ai.ToolDefinition{Name: "sheet_inspect"}, func(context.Context, map[string]any) (any, error) {
		return nil, nil
	})
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic on duplicate tool registration")
		}
	}()
	_ = New(Config{Registry: reg, Enable: Features{Sheet: true}})
}
