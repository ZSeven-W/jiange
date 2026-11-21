package slides

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/ZSeven-W/jiange/sdk/go/ai"
	"github.com/ZSeven-W/jiange/sdk/go/storage"
)

const kindSlides = "slides"

// Option configures a slides HTTP handler.
type Option func(*handlerConfig)

type handlerConfig struct {
	auth    storage.Authenticator
	authz   storage.Authorizer
	webhook *storage.WebhookDispatcher
}

// WithAuth attaches authentication and authorization middleware to slide routes.
func WithAuth(auth storage.Authenticator, authz storage.Authorizer) Option {
	return func(c *handlerConfig) {
		c.auth = auth
		c.authz = authz
	}
}

// WithWebhook attaches a signed WebhookDispatcher for presentation lifecycle events.
func WithWebhook(w *storage.WebhookDispatcher) Option {
	return func(c *handlerConfig) {
		c.webhook = w
	}
}

func loadDeckRecord(ctx context.Context, store storage.Store, id string) (*storage.DocumentRecord, *Deck, error) {
	rec, err := store.Get(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	var deck Deck
	if err := json.Unmarshal(rec.Data, &deck); err != nil {
		return nil, nil, err
	}
	return rec, &deck, nil
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
			Kind:    kindSlides,
			Payload: payload,
		})
	}
}

// NewHandler builds a drop-in net/http.Handler for Jiange Slides APIs.
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

	// POST /slides — accepts JSON or raw PPTX.
	mux.Handle("POST /slides", wrap(storage.ActionWrite, func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 32*1024*1024))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
		ct := strings.ToLower(r.Header.Get("Content-Type"))
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		title := strings.TrimSpace(r.URL.Query().Get("title"))

		var deck *Deck
		if format == "pptx" || strings.Contains(ct, "presentationml") {
			deck, err = ParsePPTX(body)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
		} else {
			var payload struct {
				ID    string `json:"id"`
				Title string `json:"title"`
				Deck  *Deck  `json:"deck"`
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
			deck = payload.Deck
			if deck == nil {
				deck = &Deck{Title: title, Slides: make([]Slide, 0)}
			}
		}

		if id == "" {
			id = storage.GenerateID("sld_")
		}
		if title == "" {
			title = deck.Title
		}
		if title == "" {
			title = "Untitled Deck"
		}
		deck.Title = title
		raw, _ := json.Marshal(deck)
		rec := &storage.DocumentRecord{ID: id, Kind: kindSlides, Title: title, Data: raw}
		if err := store.Put(r.Context(), rec); err != nil {
			writeStoreErr(w, err)
			return
		}
		dispatchWebhook(r.Context(), cfg.webhook, "slides.created", rec.ID, map[string]any{"version": rec.Version, "title": rec.Title})
		writeJSON(w, http.StatusCreated, map[string]any{
			"id":      rec.ID,
			"title":   rec.Title,
			"version": rec.Version,
			"deck":    deck,
		})
	}))

	// GET /slides/{id}
	mux.Handle("GET /slides/{id}", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		rec, deck, err := loadDeckRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"id":      rec.ID,
			"title":   rec.Title,
			"version": rec.Version,
			"inspect": deck.Inspect(),
			"deck":    deck,
		})
	}))

	// GET /slides/{id}/export
	mux.Handle("GET /slides/{id}/export", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		rec, deck, err := loadDeckRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		out, err := WritePPTX(deck)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.pptx"`, rec.ID))
		_, _ = w.Write(out)
	}))

	// GET /slides/{id}/render/{index}.svg
	mux.Handle("GET /slides/{id}/render/{file}", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		file := r.PathValue("file")
		if !strings.HasSuffix(file, ".svg") {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "expected {index}.svg"})
			return
		}
		idx, err := strconv.Atoi(strings.TrimSuffix(file, ".svg"))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid slide index"})
			return
		}
		_, deck, err := loadDeckRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		svg, err := deck.RenderSlideSVG(idx)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
		_, _ = io.WriteString(w, svg)
	}))

	// POST /slides/{id}/apply
	mux.Handle("POST /slides/{id}/apply", wrap(storage.ActionWrite, func(w http.ResponseWriter, r *http.Request) {
		rec, deck, err := loadDeckRecord(r.Context(), store, r.PathValue("id"))
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
		applied, diff, err := deck.Apply(req.Ops, req.DryRun)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if !req.DryRun {
			rec.Data, _ = json.Marshal(deck)
			if err := store.Put(r.Context(), rec); err != nil {
				writeStoreErr(w, err)
				return
			}
			dispatchWebhook(r.Context(), cfg.webhook, "slides.updated", rec.ID, map[string]any{"version": rec.Version, "applied": applied})
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"applied": applied,
			"dryRun":  req.DryRun,
			"diff":    diff,
			"version": rec.Version,
		})
	}))

	// POST /slides/{id}/verify
	mux.Handle("POST /slides/{id}/verify", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		_, deck, err := loadDeckRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"diagnostics": deck.Verify()})
	}))

	// DELETE /slides/{id}
	mux.Handle("DELETE /slides/{id}", wrap(storage.ActionAdmin, func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := store.Delete(r.Context(), id); err != nil {
			writeStoreErr(w, err)
			return
		}
		dispatchWebhook(r.Context(), cfg.webhook, "slides.deleted", id, nil)
		w.WriteHeader(http.StatusNoContent)
	}))

	return mux
}

// RegisterTools registers opt-in Slides AI/MCP tools backed by store.
func RegisterTools(reg *ai.ToolRegistry, store storage.Store) error {
	if reg == nil || store == nil {
		return errors.New("slides: registry and store are required")
	}
	idProp := map[string]any{"type": "string", "description": "Deck document ID"}
	specs := []struct {
		def ai.ToolDefinition
		fn  ai.ToolHandler
	}{
		{
			def: ai.ToolDefinition{
				Name:        "slides_inspect",
				Description: "Inspect a stored presentation deck outline and slide contents.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id"}, "properties": map[string]any{"id": idProp}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				_, deck, err := loadDeckRecord(ctx, store, ai.StringArg(args, "id"))
				if err != nil {
					return nil, err
				}
				return deck.Inspect(), nil
			},
		},
		{
			def: ai.ToolDefinition{
				Name:        "slides_apply",
				Description: "Atomically apply slide ops (addSlide, updateSlide, deleteSlide) with optional dryRun.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id", "ops"}, "properties": map[string]any{"id": idProp, "ops": map[string]any{"type": "array"}, "dryRun": map[string]any{"type": "boolean"}}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				rec, deck, err := loadDeckRecord(ctx, store, ai.StringArg(args, "id"))
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
				applied, diff, err := deck.Apply(ops, dryRun)
				if err != nil {
					return nil, err
				}
				if !dryRun {
					rec.Data, _ = json.Marshal(deck)
					if err := store.Put(ctx, rec); err != nil {
						return nil, err
					}
				}
				return map[string]any{"ok": true, "applied": applied, "dryRun": dryRun, "diff": diff, "version": rec.Version}, nil
			},
		},
		{
			def: ai.ToolDefinition{
				Name:        "slides_verify",
				Description: "Verify a stored presentation deck for empty slides and text overflow.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id"}, "properties": map[string]any{"id": idProp}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				_, deck, err := loadDeckRecord(ctx, store, ai.StringArg(args, "id"))
				if err != nil {
					return nil, err
				}
				return deck.Verify(), nil
			},
		},
		{
			def: ai.ToolDefinition{
				Name:        "slides_render_svg",
				Description: "Render a slide from a stored presentation deck to a 16:9 SVG string.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id"}, "properties": map[string]any{"id": idProp, "slideIndex": map[string]any{"type": "number"}}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				_, deck, err := loadDeckRecord(ctx, store, ai.StringArg(args, "id"))
				if err != nil {
					return nil, err
				}
				svg, err := deck.RenderSlideSVG(ai.IntArg(args, "slideIndex"))
				if err != nil {
					return nil, err
				}
				return map[string]any{"svg": svg}, nil
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
