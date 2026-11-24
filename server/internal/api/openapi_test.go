package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestOpenAPISpecEndpoint(t *testing.T) {
	s := &Server{
		Store: store.NewMemory(),
		Log:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/openapi.json", s.getOpenAPISpec)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)

	res, err := http.Get(ts.URL + "/api/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/openapi.json status=%d want 200", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type=%q want application/json", ct)
	}
	if cc := res.Header.Get("Cache-Control"); cc != "public, max-age=300" {
		t.Fatalf("Cache-Control=%q want %q", cc, "public, max-age=300")
	}

	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}

	var doc struct {
		OpenAPI string `json:"openapi"`
		Info    struct {
			Title       string `json:"title"`
			Version     string `json:"version"`
			Description string `json:"description"`
		} `json:"info"`
		Tags []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"tags"`
		Components struct {
			SecuritySchemes map[string]struct {
				Type         string `json:"type"`
				Scheme       string `json:"scheme"`
				BearerFormat string `json:"bearerFormat"`
				In           string `json:"in"`
				Name         string `json:"name"`
			} `json:"securitySchemes"`
		} `json:"components"`
		Paths map[string]map[string]struct {
			OperationID string         `json:"operationId"`
			Tags        []string       `json:"tags"`
			Summary     string         `json:"summary"`
			Description string         `json:"description"`
			Responses   map[string]any `json:"responses"`
		} `json:"paths"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("invalid OpenAPI JSON: %v", err)
	}

	if doc.OpenAPI != "3.1.0" {
		t.Fatalf("openapi=%q want 3.1.0", doc.OpenAPI)
	}
	if doc.Info.Title != "Jiange Open API" || doc.Info.Version != "0.2.0" || strings.TrimSpace(doc.Info.Description) == "" {
		t.Fatalf("unexpected info: %+v", doc.Info)
	}

	// Security schemes
	patScheme, ok := doc.Components.SecuritySchemes["bearerPAT"]
	if !ok || patScheme.Type != "http" || patScheme.Scheme != "bearer" || !strings.Contains(patScheme.BearerFormat, "jg_pat_") {
		t.Fatalf("unexpected bearerPAT securityScheme: ok=%v scheme=%+v", ok, patScheme)
	}
	cookieScheme, ok := doc.Components.SecuritySchemes["sessionCookie"]
	if !ok || cookieScheme.Type != "apiKey" || cookieScheme.In != "cookie" || cookieScheme.Name != CookieName {
		t.Fatalf("unexpected sessionCookie securityScheme: ok=%v scheme=%+v", ok, cookieScheme)
	}

	// Count paths and operations
	if len(doc.Paths) < 35 {
		t.Fatalf("expected >= 35 documented paths, got %d", len(doc.Paths))
	}
	opCount := 0
	for path, methods := range doc.Paths {
		if len(methods) == 0 {
			t.Fatalf("path %s has no operations", path)
		}
		for method, op := range methods {
			opCount++
			if strings.TrimSpace(op.Summary) == "" {
				t.Errorf("%s %s missing summary", strings.ToUpper(method), path)
			}
			if strings.TrimSpace(op.Description) == "" {
				t.Errorf("%s %s missing description", strings.ToUpper(method), path)
			}
			if len(op.Tags) == 0 {
				t.Errorf("%s %s missing tags", strings.ToUpper(method), path)
			}
			if len(op.Responses) == 0 {
				t.Errorf("%s %s missing responses", strings.ToUpper(method), path)
			}
		}
	}
	if opCount < 50 {
		t.Fatalf("expected >= 50 documented operations, got %d", opCount)
	}

	// Assert all key API groups & routes are present
	requiredPaths := []string{
		"/api/auth/login",
		"/api/auth/mfa/verify",
		"/api/me/mfa",
		"/api/auth/sso/providers",
		"/api/me/tokens",
		"/api/me/tokens/{tid}",
		"/api/docs",
		"/api/docs/{id}",
		"/api/docs/{id}/shares",
		"/api/sheets/{id}",
		"/api/sheets/{id}/cells",
		"/api/sheets/{id}/defined-names",
		"/api/bases",
		"/api/bases/{id}",
		"/api/bases/{id}/records",
		"/api/bases/{id}/query",
		"/api/slides/{id}/pages",
		"/api/slides/{id}/versions",
		"/api/drive/children",
		"/api/drive/cross-space-move/{id}",
		"/api/docs/{id}/ai",
		"/api/ai/ask-workspace",
		"/api/ai/sheet-assist",
		"/api/ai/base-fill",
		"/api/workspaces/{wsId}/org",
		"/scim/v2/ServiceProviderConfig",
		"/scim/v2/Users",
		"/scim/v2/Users/{uid}",
		"/scim/v2/Groups",
		"/scim/v2/Groups/{gid}",
		"/api/workspaces/{wsId}/audit-logs",
		"/api/workspaces/{wsId}/security-policy",
		"/api/workspaces/{wsId}/webhooks",
		"/api/workspaces/{wsId}/webhooks/{wid}/test",
		"/api/workspaces/{wsId}/notification-channels",
		"/api/workspaces/{wsId}/notification-channels/{cid}/test",
		"/api/openapi.json",
	}
	for _, p := range requiredPaths {
		if _, exists := doc.Paths[p]; !exists {
			t.Errorf("required OpenAPI path missing: %s", p)
		}
	}
}
