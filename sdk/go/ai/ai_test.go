package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("write broken") }

func TestToolRegistryAndArgs(t *testing.T) {
	reg := NewToolRegistry()

	if err := reg.Register(ToolDefinition{Name: ""}, func(context.Context, map[string]any) (any, error) { return nil, nil }); !errors.Is(err, ErrInvalidTool) {
		t.Fatalf("expected ErrInvalidTool for empty name, got %v", err)
	}
	if err := reg.Register(ToolDefinition{Name: "t"}, nil); !errors.Is(err, ErrInvalidTool) {
		t.Fatalf("expected ErrInvalidTool for nil handler, got %v", err)
	}

	err := reg.RegisterAll(
		nil,
		func(r *ToolRegistry) error {
			return r.Register(ToolDefinition{Name: "z_tool", Description: "Z"}, func(_ context.Context, args map[string]any) (any, error) {
				return map[string]any{
					"s":  StringArg(args, "s"),
					"b":  BoolArg(args, "b"),
					"i1": IntArg(args, "f"),
					"i2": IntArg(args, "i"),
					"i3": IntArg(args, "missing"),
				}, nil
			})
		},
		func(r *ToolRegistry) error {
			return r.Register(ToolDefinition{Name: "a_tool", Description: "A"}, func(context.Context, map[string]any) (any, error) {
				return "ok", nil
			})
		},
	)
	if err != nil {
		t.Fatalf("RegisterAll failed: %v", err)
	}
	if err := reg.RegisterAll(func(*ToolRegistry) error { return errors.New("boom") }); err == nil {
		t.Fatal("expected error from failing registrar")
	}
	if err := reg.Register(ToolDefinition{Name: "a_tool"}, func(context.Context, map[string]any) (any, error) { return nil, nil }); !errors.Is(err, ErrDuplicateTool) {
		t.Fatalf("expected ErrDuplicateTool, got %v", err)
	}

	defs := reg.List()
	if len(defs) != 2 || defs[0].Name != "a_tool" || defs[1].Name != "z_tool" {
		t.Fatalf("unexpected sorted tool list: %+v", defs)
	}

	res, err := reg.Call(context.Background(), "z_tool", map[string]any{
		"s": "hello",
		"b": true,
		"f": float64(7),
		"i": 9,
	})
	if err != nil {
		t.Fatalf("call failed: %v", err)
	}
	m := res.(map[string]any)
	if m["s"] != "hello" || m["b"] != true || m["i1"] != 7 || m["i2"] != 9 || m["i3"] != 0 {
		t.Fatalf("unexpected arg helpers output: %+v", m)
	}
	if StringArg(nil, "k") != "" || BoolArg(nil, "k") {
		t.Fatal("expected zero defaults for nil args")
	}

	if _, err := reg.Call(context.Background(), "missing", nil); !errors.Is(err, ErrToolNotFound) {
		t.Fatalf("expected ErrToolNotFound, got %v", err)
	}
	if !reg.Unregister("a_tool") || reg.Unregister("a_tool") {
		t.Fatal("unexpected Unregister result")
	}
}

func TestMCPServerAndTransports(t *testing.T) {
	ctx := context.Background()
	srv := NewServer(nil, "", "")
	if srv.Name != "jiange-sdk-mcp" || srv.Version != "0.1.0" {
		t.Fatalf("unexpected defaults: %+v", srv)
	}

	_ = srv.Registry.Register(ToolDefinition{Name: "echo"}, func(_ context.Context, args map[string]any) (any, error) {
		return map[string]any{"echo": StringArg(args, "msg")}, nil
	})
	_ = srv.Registry.Register(ToolDefinition{Name: "unmarshalable"}, func(context.Context, map[string]any) (any, error) {
		return make(chan int), nil
	})

	// Notification returns nil
	if resp := srv.HandleRequest(ctx, RPCRequest{JSONRPC: "2.0", Method: "notifications/initialized"}); resp != nil {
		t.Fatalf("expected nil for notification, got %+v", resp)
	}
	// Initialize
	if resp := srv.HandleRequest(ctx, RPCRequest{JSONRPC: "2.0", ID: 1, Method: "initialize"}); resp == nil || resp.Error != nil {
		t.Fatalf("initialize failed: %+v", resp)
	}
	// Ping
	if resp := srv.HandleRequest(ctx, RPCRequest{JSONRPC: "2.0", ID: 2, Method: "ping"}); resp == nil || resp.Error != nil {
		t.Fatalf("ping failed: %+v", resp)
	}
	// tools/list
	if resp := srv.HandleRequest(ctx, RPCRequest{JSONRPC: "2.0", ID: 3, Method: "tools/list"}); resp == nil || resp.Error != nil {
		t.Fatalf("tools/list failed: %+v", resp)
	}
	// tools/call invalid params
	if resp := srv.HandleRequest(ctx, RPCRequest{JSONRPC: "2.0", ID: 4, Method: "tools/call", Params: json.RawMessage(`{bad`)}); resp.Error == nil || resp.Error.Code != -32602 {
		t.Fatalf("expected -32602, got %+v", resp)
	}
	// tools/call tool error -> isError=true
	resp := srv.HandleRequest(ctx, RPCRequest{JSONRPC: "2.0", ID: 5, Method: "tools/call", Params: json.RawMessage(`{"name":"nope"}`)})
	if resp.Error != nil || resp.Result.(map[string]any)["isError"] != true {
		t.Fatalf("expected tool isError, got %+v", resp)
	}
	// tools/call unmarshalable result -> -32603
	resp = srv.HandleRequest(ctx, RPCRequest{JSONRPC: "2.0", ID: 6, Method: "tools/call", Params: json.RawMessage(`{"name":"unmarshalable"}`)})
	if resp.Error == nil || resp.Error.Code != -32603 {
		t.Fatalf("expected -32603, got %+v", resp)
	}
	// tools/call success
	resp = srv.HandleRequest(ctx, RPCRequest{JSONRPC: "2.0", ID: 7, Method: "tools/call", Params: json.RawMessage(`{"name":"echo","arguments":{"msg":"hi"}}`)})
	if resp.Error != nil {
		t.Fatalf("echo failed: %+v", resp)
	}
	// Unknown method
	resp = srv.HandleRequest(ctx, RPCRequest{JSONRPC: "2.0", ID: 8, Method: "unknown/method"})
	if resp.Error == nil || resp.Error.Code != -32601 {
		t.Fatalf("expected -32601, got %+v", resp)
	}

	// ServeStdio: blank line, parse error, notification, valid request
	in := strings.Join([]string{
		"",
		"{not-json}",
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":1,"method":"ping"}`,
	}, "\n") + "\n"
	var out bytes.Buffer
	if err := srv.ServeStdio(ctx, strings.NewReader(in), &out); err != nil {
		t.Fatalf("ServeStdio failed: %v", err)
	}
	if !strings.Contains(out.String(), `-32700`) || !strings.Contains(out.String(), `"id":1`) {
		t.Fatalf("unexpected stdio output: %s", out.String())
	}
	// ServeStdio writer error on parse error and normal response
	if err := srv.ServeStdio(ctx, strings.NewReader("{bad}\n"), failingWriter{}); err == nil {
		t.Fatal("expected writer error on parse error")
	}
	if err := srv.ServeStdio(ctx, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`+"\n"), failingWriter{}); err == nil {
		t.Fatal("expected writer error on normal response")
	}

	// HTTPHandler
	h := srv.HTTPHandler()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("healthz failed: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/mcp", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader("{bad")))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"echo"`) {
		t.Fatalf("tools/list HTTP failed: %d %s", rec.Code, rec.Body.String())
	}
}
