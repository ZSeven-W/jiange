package whiteboard

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/ZSeven-W/jiange/sdk/go/ai"
	"github.com/ZSeven-W/jiange/sdk/go/storage"
)

const kindBoard = "whiteboard"

// Option configures a whiteboard HTTP handler.
type Option func(*handlerConfig)

type handlerConfig struct {
	auth    storage.Authenticator
	authz   storage.Authorizer
	webhook *storage.WebhookDispatcher
}

// WithAuth attaches authentication and authorization middleware to board routes.
func WithAuth(auth storage.Authenticator, authz storage.Authorizer) Option {
	return func(c *handlerConfig) {
		c.auth = auth
		c.authz = authz
	}
}

// WithWebhook attaches a signed WebhookDispatcher for whiteboard lifecycle events.
func WithWebhook(w *storage.WebhookDispatcher) Option {
	return func(c *handlerConfig) {
		c.webhook = w
	}
}

func loadBoardRecord(ctx context.Context, store storage.Store, id string) (*storage.DocumentRecord, *Board, error) {
	rec, err := store.Get(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	var b Board
	if err := json.Unmarshal(rec.Data, &b); err != nil {
		return nil, nil, err
	}
	return rec, &b, nil
}

func writeStoreErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, storage.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, storage.ErrVersionConflict):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, storage.ErrInvalidID):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func dispatchWebhook(ctx context.Context, w *storage.WebhookDispatcher, evtType, docID string, payload map[string]any) {
	if w != nil {
		_ = w.Dispatch(ctx, storage.WebhookEvent{
			Type:    evtType,
			DocID:   docID,
			Kind:    kindBoard,
			Payload: payload,
		})
	}
}

// NewHandler builds a drop-in net/http.Handler for Jiange Whiteboard APIs.
func NewHandler(store storage.Store, opts ...Option) http.Handler {
	var cfg handlerConfig
	for _, opt := range opts {
		opt(&cfg)
	}
	mux := http.NewServeMux()
	docID := func(r *http.Request) string { return r.PathValue("id") }
	wrap := func(action storage.Action, fn http.HandlerFunc) http.Handler {
		return storage.AuthMiddleware(cfg.auth, cfg.authz, docID, action, fn)
	}

	// POST /boards — accepts JSON, Mermaid (.mmd), or XMind (.xmind).
	mux.Handle("POST /boards", wrap(storage.ActionWrite, func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 16*1024*1024))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
		ct := strings.ToLower(r.Header.Get("Content-Type"))
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		title := strings.TrimSpace(r.URL.Query().Get("title"))

		var board *Board
		switch {
		case format == "xmind" || strings.Contains(ct, "xmind"):
			board, err = ParseXMind(body)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
		case format == "mermaid" || format == "mmd" || strings.Contains(ct, "text/plain"):
			board = ParseMermaid(string(body))
		default:
			var payload struct {
				ID    string `json:"id"`
				Title string `json:"title"`
				Board *Board `json:"board"`
			}
			if len(strings.TrimSpace(string(body))) > 0 {
				if err := json.Unmarshal(body, &payload); err != nil {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json: " + err.Error()})
					return
				}
			}
			if payload.ID != "" {
				id = payload.ID
			}
			if payload.Title != "" {
				title = payload.Title
			}
			board = payload.Board
			if board == nil {
				board = &Board{Nodes: make([]Node, 0), Edges: make([]Edge, 0)}
			}
		}

		if id == "" {
			id = storage.GenerateID("brd_")
		}
		if title == "" {
			title = "Untitled Board"
		}
		raw, _ := json.Marshal(board)
		rec := &storage.DocumentRecord{ID: id, Kind: kindBoard, Title: title, Data: raw}
		if err := store.Put(r.Context(), rec); err != nil {
			writeStoreErr(w, err)
			return
		}
		dispatchWebhook(r.Context(), cfg.webhook, "board.created", rec.ID, map[string]any{"version": rec.Version, "title": rec.Title})
		writeJSON(w, http.StatusCreated, map[string]any{
			"id":      rec.ID,
			"title":   rec.Title,
			"version": rec.Version,
			"board":   board,
		})
	}))

	// GET /boards/{id}
	mux.Handle("GET /boards/{id}", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		rec, board, err := loadBoardRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"id":      rec.ID,
			"title":   rec.Title,
			"version": rec.Version,
			"inspect": board.Inspect(),
			"mermaid": board.ToMermaid(),
			"board":   board,
		})
	}))

	// GET /boards/{id}/render.svg
	mux.Handle("GET /boards/{id}/render.svg", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		_, board, err := loadBoardRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
		_, _ = io.WriteString(w, board.RenderSVG())
	}))

	// POST /boards/{id}/apply
	mux.Handle("POST /boards/{id}/apply", wrap(storage.ActionWrite, func(w http.ResponseWriter, r *http.Request) {
		rec, board, err := loadBoardRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		var req struct {
			Ops    []Op `json:"ops"`
			DryRun bool `json:"dryRun"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 8*1024*1024)).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json: " + err.Error()})
			return
		}
		applied, diff, err := board.Apply(req.Ops, req.DryRun)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if !req.DryRun {
			rec.Data, _ = json.Marshal(board)
			if err := store.Put(r.Context(), rec); err != nil {
				writeStoreErr(w, err)
				return
			}
			dispatchWebhook(r.Context(), cfg.webhook, "board.updated", rec.ID, map[string]any{"version": rec.Version, "applied": applied})
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"applied": applied,
			"dryRun":  req.DryRun,
			"diff":    diff,
			"version": rec.Version,
		})
	}))

	// POST /boards/{id}/verify
	mux.Handle("POST /boards/{id}/verify", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		_, board, err := loadBoardRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"diagnostics": board.Verify()})
	}))

	// DELETE /boards/{id}
	mux.Handle("DELETE /boards/{id}", wrap(storage.ActionAdmin, func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := store.Delete(r.Context(), id); err != nil {
			writeStoreErr(w, err)
			return
		}
		dispatchWebhook(r.Context(), cfg.webhook, "board.deleted", id, nil)
		w.WriteHeader(http.StatusNoContent)
	}))

	return mux
}

// RegisterTools registers opt-in Whiteboard AI/MCP tools backed by store.
func RegisterTools(reg *ai.ToolRegistry, store storage.Store) error {
	if reg == nil || store == nil {
		return errors.New("whiteboard: registry and store are required")
	}
	idProp := map[string]any{"type": "string", "description": "Board document ID"}
	specs := []struct {
		def ai.ToolDefinition
		fn  ai.ToolHandler
	}{
		{
			def: ai.ToolDefinition{
				Name:        "board_inspect",
				Description: "Inspect a stored whiteboard graph nodes and edges.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id"}, "properties": map[string]any{"id": idProp}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				_, board, err := loadBoardRecord(ctx, store, ai.StringArg(args, "id"))
				if err != nil {
					return nil, err
				}
				return board.Inspect(), nil
			},
		},
		{
			def: ai.ToolDefinition{
				Name:        "board_apply",
				Description: "Atomically apply whiteboard ops (addNode, updateNode, deleteNode, addEdge, deleteEdge) with optional dryRun.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id", "ops"}, "properties": map[string]any{"id": idProp, "ops": map[string]any{"type": "array"}, "dryRun": map[string]any{"type": "boolean"}}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				rec, board, err := loadBoardRecord(ctx, store, ai.StringArg(args, "id"))
				if err != nil {
					return nil, err
				}
				rawOps, err := json.Marshal(args["ops"])
				if err != nil {
					return nil, err
				}
				var ops []Op
				if err := json.Unmarshal(rawOps, &ops); err != nil {
					return nil, err
				}
				dryRun := ai.BoolArg(args, "dryRun")
				applied, diff, err := board.Apply(ops, dryRun)
				if err != nil {
					return nil, err
				}
				if !dryRun {
					rec.Data, _ = json.Marshal(board)
					if err := store.Put(ctx, rec); err != nil {
						return nil, err
					}
				}
				return map[string]any{"ok": true, "applied": applied, "dryRun": dryRun, "diff": diff, "version": rec.Version}, nil
			},
		},
		{
			def: ai.ToolDefinition{
				Name:        "board_verify",
				Description: "Verify stored whiteboard graph topology (dangling edges, isolated nodes).",
				InputSchema: map[string]any{"type": "object", "required": []string{"id"}, "properties": map[string]any{"id": idProp}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				_, board, err := loadBoardRecord(ctx, store, ai.StringArg(args, "id"))
				if err != nil {
					return nil, err
				}
				return board.Verify(), nil
			},
		},
		{
			def: ai.ToolDefinition{
				Name:        "board_render_svg",
				Description: "Render a stored whiteboard diagram as SVG.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id"}, "properties": map[string]any{"id": idProp}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				_, board, err := loadBoardRecord(ctx, store, ai.StringArg(args, "id"))
				if err != nil {
					return nil, err
				}
				return map[string]any{"svg": board.RenderSVG()}, nil
			},
		},
	}
	for _, s := range specs {
		if err := reg.Register(s.def, s.fn); err != nil {
			return err
		}
	}
	return nil
}
