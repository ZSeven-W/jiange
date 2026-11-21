package doc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/ZSeven-W/jiange/sdk/go/ai"
	"github.com/ZSeven-W/jiange/sdk/go/storage"
)

const kindDoc = "doc"

// Option configures a doc HTTP handler.
type Option func(*handlerConfig)

type handlerConfig struct {
	auth    storage.Authenticator
	authz   storage.Authorizer
	webhook *storage.WebhookDispatcher
}

// WithAuth attaches authentication and authorization middleware to document routes.
func WithAuth(auth storage.Authenticator, authz storage.Authorizer) Option {
	return func(c *handlerConfig) {
		c.auth = auth
		c.authz = authz
	}
}

// WithWebhook attaches a signed WebhookDispatcher for document lifecycle events.
func WithWebhook(w *storage.WebhookDispatcher) Option {
	return func(c *handlerConfig) {
		c.webhook = w
	}
}

func loadDocRecord(ctx context.Context, store storage.Store, id string) (*storage.DocumentRecord, *Document, error) {
	rec, err := store.Get(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	var d Document
	if err := json.Unmarshal(rec.Data, &d); err != nil {
		return nil, nil, err
	}
	return rec, &d, nil
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
			Kind:    kindDoc,
			Payload: payload,
		})
	}
}

// NewHandler builds a drop-in net/http.Handler for Jiange Document APIs.
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

	// POST /docs — accepts JSON, raw DOCX, or raw Markdown.
	mux.Handle("POST /docs", wrap(storage.ActionWrite, func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 32*1024*1024))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
		ct := strings.ToLower(r.Header.Get("Content-Type"))
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		title := strings.TrimSpace(r.URL.Query().Get("title"))

		var d *Document
		switch {
		case format == "docx" || strings.Contains(ct, "wordprocessingml"):
			d, err = ParseDOCX(body, title)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
		case format == "md" || format == "markdown" || strings.Contains(ct, "text/markdown"):
			d = ParseMarkdown(string(body), title)
		default:
			var payload struct {
				ID       string    `json:"id"`
				Title    string    `json:"title"`
				Document *Document `json:"document"`
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
			d = payload.Document
			if d == nil {
				d = &Document{Title: title, Blocks: make([]Block, 0)}
			}
		}

		if id == "" {
			id = storage.GenerateID("doc_")
		}
		if title == "" {
			title = d.Title
		}
		if title == "" {
			title = "Untitled Document"
		}
		d.Title = title
		raw, _ := json.Marshal(d)
		rec := &storage.DocumentRecord{ID: id, Kind: kindDoc, Title: title, Data: raw}
		if err := store.Put(r.Context(), rec); err != nil {
			writeStoreErr(w, err)
			return
		}
		dispatchWebhook(r.Context(), cfg.webhook, "doc.created", rec.ID, map[string]any{"version": rec.Version, "title": rec.Title})
		writeJSON(w, http.StatusCreated, map[string]any{
			"id":       rec.ID,
			"title":    rec.Title,
			"version":  rec.Version,
			"document": d,
		})
	}))

	// GET /docs/{id}
	mux.Handle("GET /docs/{id}", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		rec, d, err := loadDocRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"id":       rec.ID,
			"title":    rec.Title,
			"version":  rec.Version,
			"inspect":  d.Inspect(r.URL.Query().Get("detail")),
			"document": d,
		})
	}))

	// GET /docs/{id}/export?format=docx|md
	mux.Handle("GET /docs/{id}/export", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		rec, d, err := loadDocRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
		if format == "" {
			format = "docx"
		}
		switch format {
		case "docx":
			out, err := WriteDOCX(d)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
			w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.docx"`, rec.ID))
			_, _ = w.Write(out)
		case "md", "markdown":
			w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
			w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.md"`, rec.ID))
			_, _ = io.WriteString(w, d.ToMarkdown())
		default:
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported export format: " + format})
		}
	}))

	// POST /docs/{id}/query
	mux.Handle("POST /docs/{id}/query", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		_, d, err := loadDocRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		var req struct {
			Text string `json:"text"`
			Type string `json:"type"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4*1024*1024)).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json: " + err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"blocks": d.Query(req.Text, req.Type)})
	}))

	// POST /docs/{id}/apply
	mux.Handle("POST /docs/{id}/apply", wrap(storage.ActionWrite, func(w http.ResponseWriter, r *http.Request) {
		rec, d, err := loadDocRecord(r.Context(), store, r.PathValue("id"))
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
		applied, diff, err := d.Apply(req.Ops, req.DryRun)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if !req.DryRun {
			rec.Data, _ = json.Marshal(d)
			if err := store.Put(r.Context(), rec); err != nil {
				writeStoreErr(w, err)
				return
			}
			dispatchWebhook(r.Context(), cfg.webhook, "doc.updated", rec.ID, map[string]any{"version": rec.Version, "applied": applied})
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"applied": applied,
			"dryRun":  req.DryRun,
			"diff":    diff,
			"version": rec.Version,
		})
	}))

	// POST /docs/{id}/verify
	mux.Handle("POST /docs/{id}/verify", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		_, d, err := loadDocRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"diagnostics": d.Verify()})
	}))

	// DELETE /docs/{id}
	mux.Handle("DELETE /docs/{id}", wrap(storage.ActionAdmin, func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := store.Delete(r.Context(), id); err != nil {
			writeStoreErr(w, err)
			return
		}
		dispatchWebhook(r.Context(), cfg.webhook, "doc.deleted", id, nil)
		w.WriteHeader(http.StatusNoContent)
	}))

	return mux
}

// RegisterTools registers opt-in Document AI/MCP tools backed by store.
func RegisterTools(reg *ai.ToolRegistry, store storage.Store) error {
	if reg == nil || store == nil {
		return errors.New("doc: registry and store are required")
	}
	idProp := map[string]any{"type": "string", "description": "Document ID"}
	specs := []struct {
		def ai.ToolDefinition
		fn  ai.ToolHandler
	}{
		{
			def: ai.ToolDefinition{
				Name:        "doc_inspect",
				Description: "Inspect a stored document outline, block count, and word count.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id"}, "properties": map[string]any{"id": idProp, "detail": map[string]any{"type": "string"}}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				_, d, err := loadDocRecord(ctx, store, ai.StringArg(args, "id"))
				if err != nil {
					return nil, err
				}
				return d.Inspect(ai.StringArg(args, "detail")), nil
			},
		},
		{
			def: ai.ToolDefinition{
				Name:        "doc_query",
				Description: "Search blocks in a stored document by text or block type.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id"}, "properties": map[string]any{"id": idProp, "text": map[string]any{"type": "string"}, "type": map[string]any{"type": "string"}}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				_, d, err := loadDocRecord(ctx, store, ai.StringArg(args, "id"))
				if err != nil {
					return nil, err
				}
				return d.Query(ai.StringArg(args, "text"), ai.StringArg(args, "type")), nil
			},
		},
		{
			def: ai.ToolDefinition{
				Name:        "doc_apply",
				Description: "Atomically apply document ops (appendBlock, replaceText, deleteBlock) with optional dryRun.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id", "ops"}, "properties": map[string]any{"id": idProp, "ops": map[string]any{"type": "array"}, "dryRun": map[string]any{"type": "boolean"}}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				rec, d, err := loadDocRecord(ctx, store, ai.StringArg(args, "id"))
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
				applied, diff, err := d.Apply(ops, dryRun)
				if err != nil {
					return nil, err
				}
				if !dryRun {
					rec.Data, _ = json.Marshal(d)
					if err := store.Put(ctx, rec); err != nil {
						return nil, err
					}
				}
				return map[string]any{"ok": true, "applied": applied, "dryRun": dryRun, "diff": diff, "version": rec.Version}, nil
			},
		},
		{
			def: ai.ToolDefinition{
				Name:        "doc_verify",
				Description: "Verify stored document heading hierarchy and structure.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id"}, "properties": map[string]any{"id": idProp}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				_, d, err := loadDocRecord(ctx, store, ai.StringArg(args, "id"))
				if err != nil {
					return nil, err
				}
				return d.Verify(), nil
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
