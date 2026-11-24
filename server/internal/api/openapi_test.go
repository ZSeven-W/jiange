package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func collectSchemaRefs(node any, refs *[]string) {
	switch v := node.(type) {
	case map[string]any:
		if r, ok := v["$ref"].(string); ok {
			*refs = append(*refs, r)
		}
		for _, child := range v {
			collectSchemaRefs(child, refs)
		}
	case []any:
		for _, item := range v {
			collectSchemaRefs(item, refs)
		}
	}
}

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
			Schemas map[string]any `json:"schemas"`
		} `json:"components"`
		Paths map[string]map[string]struct {
			OperationID string   `json:"operationId"`
			Tags        []string `json:"tags"`
			Summary     string   `json:"summary"`
			Description string   `json:"description"`
			Parameters  []struct {
				Name     string `json:"name"`
				In       string `json:"in"`
				Required bool   `json:"required"`
			} `json:"parameters"`
			Responses map[string]any `json:"responses"`
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

	// Reusable schemas under components.schemas
	requiredSchemas := []string{
		"ErrorResponse",
		"HealthResponse",
		"ReadyResponse",
		"User",
		"Workspace",
		"DocMeta",
		"Comment",
		"BaseTable",
		"BaseField",
		"BaseRecord",
		"SheetWorkbook",
		"SlidesDeck",
		"SlidesPage",
		"WikiSpace",
		"Webhook",
		"NotificationChannel",
		"SecurityPolicy",
		"DLPCheckResult",
		"RetentionPurgeResult",
		"AuditLogEntry",
		"SCIMError",
		"SCIMUser",
		"SCIMGroup",
		"SCIMSchema",
		"SCIMResourceType",
		"PersonalAccessToken",
	}
	for _, name := range requiredSchemas {
		if _, exists := doc.Components.Schemas[name]; !exists {
			t.Errorf("required components.schemas entry missing: %s", name)
		}
	}

	// Validate every $ref in the entire spec resolves to an existing components.schemas entry
	var genericSpec any
	if err := json.Unmarshal(raw, &genericSpec); err != nil {
		t.Fatal(err)
	}
	var allRefs []string
	collectSchemaRefs(genericSpec, &allRefs)
	if len(allRefs) == 0 {
		t.Fatal("expected $ref references to reusable schemas, got 0")
	}
	for _, ref := range allRefs {
		if !strings.HasPrefix(ref, "#/components/schemas/") {
			t.Errorf("unexpected non-schema $ref: %s", ref)
			continue
		}
		target := strings.TrimPrefix(ref, "#/components/schemas/")
		if _, exists := doc.Components.Schemas[target]; !exists {
			t.Errorf("dangling $ref %q: schema %q does not exist in components.schemas", ref, target)
		}
	}

	// Validate operations: non-empty metadata, unique operationId, and matching path params
	opIDs := map[string]string{}
	opCount := 0
	for path, methods := range doc.Paths {
		if len(methods) == 0 {
			t.Fatalf("path %s has no operations", path)
		}
		pathVars := oaPathVarRE.FindAllStringSubmatch(path, -1)
		for method, op := range methods {
			opCount++
			label := strings.ToUpper(method) + " " + path
			if strings.TrimSpace(op.OperationID) == "" {
				t.Errorf("%s missing operationId", label)
			} else if prev, dup := opIDs[op.OperationID]; dup {
				t.Errorf("duplicate operationId %q used by %s and %s", op.OperationID, prev, label)
			} else {
				opIDs[op.OperationID] = label
			}
			if strings.TrimSpace(op.Summary) == "" {
				t.Errorf("%s missing summary", label)
			}
			if strings.TrimSpace(op.Description) == "" {
				t.Errorf("%s missing description", label)
			}
			if len(op.Tags) == 0 {
				t.Errorf("%s missing tags", label)
			}
			if len(op.Responses) == 0 {
				t.Errorf("%s missing responses", label)
			}
			documentedPathParams := map[string]bool{}
			for _, p := range op.Parameters {
				if p.In == "path" {
					documentedPathParams[p.Name] = true
				}
			}
			for _, m := range pathVars {
				if !documentedPathParams[m[1]] {
					t.Errorf("%s missing path parameter descriptor for {%s}", label, m[1])
				}
			}
		}
	}
	if opCount < 330 {
		t.Fatalf("expected >= 330 documented operations, got %d", opCount)
	}
}

// TestOpenAPICoversAllRegisteredRoutes guarantees 100% route coverage parity:
// every HTTP route registered in api.go (plus all Wave 1 routes) MUST exist in
// the generated OpenAPI 3.1.0 specification under paths[path][method].
func TestOpenAPICoversAllRegisteredRoutes(t *testing.T) {
	apiSrc, err := os.ReadFile("api.go")
	if err != nil {
		t.Fatalf("failed to read api.go: %v", err)
	}

	routeRE := regexp.MustCompile(`"(GET|POST|PUT|PATCH|DELETE)\s+(/[^"\s]+)"`)
	matches := routeRE.FindAllStringSubmatch(string(apiSrc), -1)
	if len(matches) < 250 {
		t.Fatalf("expected >= 250 registered routes in api.go, found %d", len(matches))
	}

	raw := cachedOpenAPISpecJSON()
	var doc struct {
		Paths map[string]map[string]any `json:"paths"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("invalid OpenAPI JSON: %v", err)
	}

	var missing []string
	seen := map[string]bool{}
	for _, m := range matches {
		method := strings.ToLower(m[1])
		path := m[2]
		key := strings.ToUpper(method) + " " + path
		if seen[key] {
			continue
		}
		seen[key] = true
		ops, ok := doc.Paths[path]
		if !ok {
			missing = append(missing, key)
			continue
		}
		if _, ok := ops[method]; !ok {
			missing = append(missing, key)
		}
	}

	// Verify all 13 Wave 1 routes are also documented in OpenAPI spec.
	wave1Routes := []struct {
		method string
		path   string
	}{
		{"GET", "/readyz"},
		{"GET", "/metrics"},
		{"GET", "/scim/v2/Schemas"},
		{"GET", "/scim/v2/Schemas/{schemaId}"},
		{"GET", "/scim/v2/ResourceTypes"},
		{"GET", "/scim/v2/ResourceTypes/{typeId}"},
		{"PUT", "/scim/v2/Users/{uid}"},
		{"PUT", "/scim/v2/Groups/{gid}"},
		{"PATCH", "/api/workspaces/{wsId}"},
		{"DELETE", "/api/workspaces/{wsId}"},
		{"POST", "/api/workspaces/{wsId}/transfer-owner"},
		{"POST", "/api/workspaces/{wsId}/leave"},
		{"POST", "/api/workspaces/{wsId}/retention/run"},
	}
	for _, w1 := range wave1Routes {
		ops, ok := doc.Paths[w1.path]
		if !ok || ops[strings.ToLower(w1.method)] == nil {
			missing = append(missing, w1.method+" "+w1.path+" (Wave 1)")
		}
	}

	if len(missing) > 0 {
		sort.Strings(missing)
		t.Fatalf("OpenAPI spec is missing %d registered route(s):\n  %s", len(missing), strings.Join(missing, "\n  "))
	}
}
