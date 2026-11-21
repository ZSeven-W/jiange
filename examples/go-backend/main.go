// Example embedding Jiange's zero-dependency Go Backend SDK into an existing net/http application.
//
// Run self-test (in-process round-trip via httptest, exits 0):
//
//	cd examples/go-backend && go run . --check
//
// Or start a live HTTP server on :8090:
//
//	cd examples/go-backend && go run .
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"

	"github.com/ZSeven-W/jiange/sdk/go/client"
	"github.com/ZSeven-W/jiange/sdk/go/server"
	"github.com/ZSeven-W/jiange/sdk/go/sheet"
	"github.com/ZSeven-W/jiange/sdk/go/storage"
)

func buildMux() http.Handler {
	app := server.New(server.Config{
		Store:   storage.NewMemoryStore(),
		Auth:    storage.NewBearerTokenAuth(map[string]storage.Principal{"demo-token": {ID: "u-1", Name: "Demo User", Roles: []string{"admin"}}}),
		Version: "0.2.0",
	})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"service":"host-app","jiangeMountedAt":"/api/v1"}`))
	})
	mux.Handle("/api/v1/", http.StripPrefix("/api/v1", app))
	return mux
}

func runSelfCheck() error {
	ts := httptest.NewServer(buildMux())
	defer ts.Close()

	c := client.NewClient(ts.URL+"/api/v1", client.WithBearerToken("demo-token"))
	ctx := context.Background()

	wb, err := c.CreateSheet(ctx, "wb-demo", "Q4 Budget", sheet.NewWorkbook("Sales"))
	if err != nil {
		return fmt.Errorf("create sheet: %w", err)
	}
	if _, err := c.ApplySheet(ctx, wb.ID, []sheet.Op{
		{Op: "setCell", Sheet: "Sales", A1: "A1", Raw: "100"},
		{Op: "setCell", Sheet: "Sales", A1: "A2", Raw: "250"},
		{Op: "setCell", Sheet: "Sales", A1: "A3", Raw: "=SUM(A1:A2)"},
	}, false); err != nil {
		return fmt.Errorf("apply sheet: %w", err)
	}
	inspected, err := c.InspectSheet(ctx, wb.ID, "summary")
	if err != nil {
		return fmt.Errorf("inspect sheet: %w", err)
	}
	diags, err := c.VerifySheet(ctx, wb.ID)
	if err != nil {
		return fmt.Errorf("verify sheet: %w", err)
	}
	mcpOut, err := c.CallMCPTool(ctx, "sheet_verify", map[string]any{"id": wb.ID})
	if err != nil {
		return fmt.Errorf("mcp call: %w", err)
	}
	out, _ := json.MarshalIndent(map[string]any{
		"ok":          true,
		"workbookId":  wb.ID,
		"version":     inspected.Version,
		"diagnostics": len(diags),
		"mcpVerified": len(mcpOut) > 0,
	}, "", "  ")
	fmt.Println(string(out))
	return nil
}

func main() {
	check := flag.Bool("check", false, "run an in-process round-trip self-check and exit")
	addr := flag.String("addr", ":8090", "listen address")
	flag.Parse()

	if *check {
		if err := runSelfCheck(); err != nil {
			fmt.Fprintf(os.Stderr, "self-check failed: %v\n", err)
			os.Exit(1)
		}
		return
	}

	log.Printf("host app with embedded Jiange Go SDK listening on %s", *addr)
	if err := http.ListenAndServe(*addr, buildMux()); err != nil {
		log.Fatal(err)
	}
}
