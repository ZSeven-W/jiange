package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/ZSeven-W/jiange/sdk/go/ai"
	"github.com/ZSeven-W/jiange/sdk/go/base"
	"github.com/ZSeven-W/jiange/sdk/go/doc"
	"github.com/ZSeven-W/jiange/sdk/go/sheet"
	"github.com/ZSeven-W/jiange/sdk/go/slides"
	"github.com/ZSeven-W/jiange/sdk/go/storage"
	"github.com/ZSeven-W/jiange/sdk/go/sync"
	"github.com/ZSeven-W/jiange/sdk/go/whiteboard"
)

// Features toggles which Jiange subsystems are mounted by New.
// When all fields are false (zero value), AllFeatures() is enabled automatically.
type Features struct {
	Sheet      bool `json:"sheet"`
	Doc        bool `json:"doc"`
	Slides     bool `json:"slides"`
	Whiteboard bool `json:"whiteboard"`
	Base       bool `json:"base"`
	Sync       bool `json:"sync"`
	MCP        bool `json:"mcp"`
}

// AllFeatures returns a Features struct with every Jiange subsystem enabled.
func AllFeatures() Features {
	return Features{
		Sheet:      true,
		Doc:        true,
		Slides:     true,
		Whiteboard: true,
		Base:       true,
		Sync:       true,
		MCP:        true,
	}
}

// Config configures the all-in-one Jiange backend router.
type Config struct {
	Store      storage.Store
	Hub        *sync.RoomHub
	Auth       storage.Authenticator
	Authz      storage.Authorizer
	Webhook    *storage.WebhookDispatcher
	Registry   *ai.ToolRegistry
	ServerName string
	Version    string
	Enable     Features
}

// Server is a composable http.Handler mounting enabled Jiange domain APIs, Sync hub, and MCP.
type Server struct {
	mux      *http.ServeMux
	store    storage.Store
	hub      *sync.RoomHub
	registry *ai.ToolRegistry
	mcp      *ai.Server
	features Features
}

// New builds an all-in-one Jiange backend Server ready to mount on net/http, Gin, Echo, Chi, or Fiber.
func New(cfg Config) *Server {
	features := cfg.Enable
	if features == (Features{}) {
		features = AllFeatures()
	}
	store := cfg.Store
	if store == nil {
		store = storage.NewMemoryStore()
	}
	reg := cfg.Registry
	if reg == nil {
		reg = ai.NewToolRegistry()
	}
	name := cfg.ServerName
	if name == "" {
		name = "jiange-backend"
	}
	version := cfg.Version
	if version == "" {
		version = "0.1.0"
	}

	mux := http.NewServeMux()
	healthHandler := func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":       true,
			"service":  name,
			"version":  version,
			"features": features,
		})
	}
	mux.HandleFunc("GET /healthz", healthHandler)
	mux.HandleFunc("GET /health", healthHandler)

	var registrars []func(*ai.ToolRegistry) error

	if features.Sheet {
		h := sheet.NewHandler(store, sheet.WithAuth(cfg.Auth, cfg.Authz), sheet.WithWebhook(cfg.Webhook))
		mux.Handle("/sheets", h)
		mux.Handle("/sheets/", h)
		registrars = append(registrars, func(r *ai.ToolRegistry) error { return sheet.RegisterTools(r, store) })
	}
	if features.Doc {
		h := doc.NewHandler(store, doc.WithAuth(cfg.Auth, cfg.Authz), doc.WithWebhook(cfg.Webhook))
		mux.Handle("/docs", h)
		mux.Handle("/docs/", h)
		registrars = append(registrars, func(r *ai.ToolRegistry) error { return doc.RegisterTools(r, store) })
	}
	if features.Slides {
		h := slides.NewHandler(store, slides.WithAuth(cfg.Auth, cfg.Authz), slides.WithWebhook(cfg.Webhook))
		mux.Handle("/slides", h)
		mux.Handle("/slides/", h)
		registrars = append(registrars, func(r *ai.ToolRegistry) error { return slides.RegisterTools(r, store) })
	}
	if features.Whiteboard {
		h := whiteboard.NewHandler(store, whiteboard.WithAuth(cfg.Auth, cfg.Authz), whiteboard.WithWebhook(cfg.Webhook))
		mux.Handle("/boards", h)
		mux.Handle("/boards/", h)
		registrars = append(registrars, func(r *ai.ToolRegistry) error { return whiteboard.RegisterTools(r, store) })
	}
	if features.Base {
		h := base.NewHandler(store, base.WithAuth(cfg.Auth, cfg.Authz), base.WithWebhook(cfg.Webhook))
		mux.Handle("/bases", h)
		mux.Handle("/bases/", h)
		registrars = append(registrars, func(r *ai.ToolRegistry) error { return base.RegisterTools(r, store) })
	}

	var hub *sync.RoomHub
	if features.Sync {
		hub = cfg.Hub
		if hub == nil {
			hub = sync.NewRoomHub()
		}
		mux.Handle("/rooms/", sync.NewHandler(hub, sync.WithAuth(cfg.Auth, cfg.Authz)))
	}

	if err := reg.RegisterAll(registrars...); err != nil {
		panic("server: register tools: " + err.Error())
	}

	var mcpServer *ai.Server
	if features.MCP {
		mcpServer = ai.NewServer(reg, name, version)
		mux.Handle("/mcp", storage.AuthMiddleware(cfg.Auth, cfg.Authz, nil, storage.ActionWrite, mcpServer.HTTPHandler()))
		mux.Handle("GET /ai/tools", storage.AuthMiddleware(cfg.Auth, cfg.Authz, nil, storage.ActionRead, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"tools": reg.List()})
		})))
		mux.Handle("POST /ai/tools/{name}", storage.AuthMiddleware(cfg.Auth, cfg.Authz, nil, storage.ActionWrite, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			args := map[string]any{}
			if err := json.NewDecoder(r.Body).Decode(&args); err != nil && !errors.Is(err, io.EOF) {
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": "invalid json body"})
				return
			}
			res, err := reg.Call(r.Context(), r.PathValue("name"), args)
			if err != nil {
				status := http.StatusBadRequest
				if errors.Is(err, ai.ErrToolNotFound) {
					status = http.StatusNotFound
				}
				w.WriteHeader(status)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": err.Error()})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": res})
		})))
	}

	return &Server{
		mux:      mux,
		store:    store,
		hub:      hub,
		registry: reg,
		mcp:      mcpServer,
		features: features,
	}
}

// ServeHTTP dispatches HTTP requests to the mounted Jiange handlers.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

// Store returns the shared persistence store.
func (s *Server) Store() storage.Store { return s.store }

// Hub returns the shared real-time sync RoomHub (nil when Sync is disabled).
func (s *Server) Hub() *sync.RoomHub { return s.hub }

// Tools returns the modular AI/MCP ToolRegistry.
func (s *Server) Tools() *ai.ToolRegistry { return s.registry }

// MCP returns the MCP server instance (nil when MCP is disabled).
func (s *Server) MCP() *ai.Server { return s.mcp }

// Features returns the active subsystem flags.
func (s *Server) Features() Features { return s.features }
