package base

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

const kindBase = "base"

// Option configures a base HTTP handler.
type Option func(*handlerConfig)

type handlerConfig struct {
	auth    storage.Authenticator
	authz   storage.Authorizer
	webhook *storage.WebhookDispatcher
}

// WithAuth attaches authentication and authorization middleware to base routes.
func WithAuth(auth storage.Authenticator, authz storage.Authorizer) Option {
	return func(c *handlerConfig) {
		c.auth = auth
		c.authz = authz
	}
}

// WithWebhook attaches a signed WebhookDispatcher for Base lifecycle events.
func WithWebhook(w *storage.WebhookDispatcher) Option {
	return func(c *handlerConfig) {
		c.webhook = w
	}
}

func loadBaseRecord(ctx context.Context, store storage.Store, id string) (*storage.DocumentRecord, *Base, error) {
	rec, err := store.Get(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	var b Base
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
			Kind:    kindBase,
			Payload: payload,
		})
	}
}

// NewHandler builds a drop-in net/http.Handler for Jiange Base APIs.
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

	// POST /bases — accepts JSON or raw CSV.
	mux.Handle("POST /bases", wrap(storage.ActionWrite, func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 32*1024*1024))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
		ct := strings.ToLower(r.Header.Get("Content-Type"))
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		title := strings.TrimSpace(r.URL.Query().Get("title"))

		var b *Base
		if format == "csv" || strings.Contains(ct, "text/csv") {
			b, err = ParseCSV(body, title)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
		} else {
			var payload struct {
				ID    string `json:"id"`
				Title string `json:"title"`
				Base  *Base  `json:"base"`
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
			b = payload.Base
			if b == nil {
				b = &Base{
					Name:    title,
					Tables:  []Table{{ID: 1, Name: "Table 1"}},
					Fields:  make([]Field, 0),
					Records: make([]Record, 0),
				}
			}
		}

		if id == "" {
			id = storage.GenerateID("bas_")
		}
		if title == "" {
			title = b.Name
		}
		if title == "" {
			title = "Untitled Base"
		}
		b.Name = title
		raw, _ := json.Marshal(b)
		rec := &storage.DocumentRecord{ID: id, Kind: kindBase, Title: title, Data: raw}
		if err := store.Put(r.Context(), rec); err != nil {
			writeStoreErr(w, err)
			return
		}
		dispatchWebhook(r.Context(), cfg.webhook, "base.created", rec.ID, map[string]any{"version": rec.Version, "title": rec.Title})
		writeJSON(w, http.StatusCreated, map[string]any{
			"id":      rec.ID,
			"title":   rec.Title,
			"version": rec.Version,
			"base":    b,
		})
	}))

	// GET /bases/{id}
	mux.Handle("GET /bases/{id}", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		rec, b, err := loadBaseRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"id":      rec.ID,
			"title":   rec.Title,
			"version": rec.Version,
			"inspect": b.Inspect(),
			"base":    b,
		})
	}))

	// GET /bases/{id}/export.csv
	mux.Handle("GET /bases/{id}/export.csv", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		rec, b, err := loadBaseRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		tableID := 0
		if raw := strings.TrimSpace(r.URL.Query().Get("tableId")); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid tableId"})
				return
			}
			tableID = n
		}
		out, err := b.ToCSV(tableID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.csv"`, rec.ID))
		_, _ = w.Write(out)
	}))

	// POST /bases/{id}/query
	mux.Handle("POST /bases/{id}/query", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		_, b, err := loadBaseRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		var req struct {
			TableID int    `json:"tableId"`
			Search  string `json:"search"`
			Limit   int    `json:"limit"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4*1024*1024)).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json: " + err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"records": b.Query(req.TableID, req.Search, req.Limit)})
	}))

	// POST /bases/{id}/apply
	mux.Handle("POST /bases/{id}/apply", wrap(storage.ActionWrite, func(w http.ResponseWriter, r *http.Request) {
		rec, b, err := loadBaseRecord(r.Context(), store, r.PathValue("id"))
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
		applied, diff, err := b.Apply(req.Ops, req.DryRun)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if !req.DryRun {
			rec.Data, _ = json.Marshal(b)
			if err := store.Put(r.Context(), rec); err != nil {
				writeStoreErr(w, err)
				return
			}
			dispatchWebhook(r.Context(), cfg.webhook, "base.updated", rec.ID, map[string]any{"version": rec.Version, "applied": applied})
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"applied": applied,
			"dryRun":  req.DryRun,
			"diff":    diff,
			"version": rec.Version,
		})
	}))

	// POST /bases/{id}/verify
	mux.Handle("POST /bases/{id}/verify", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		_, b, err := loadBaseRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"diagnostics": b.Verify()})
	}))

	// DELETE /bases/{id}
	mux.Handle("DELETE /bases/{id}", wrap(storage.ActionAdmin, func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := store.Delete(r.Context(), id); err != nil {
			writeStoreErr(w, err)
			return
		}
		dispatchWebhook(r.Context(), cfg.webhook, "base.deleted", id, nil)
		w.WriteHeader(http.StatusNoContent)
	}))

	return mux
}

// RegisterTools registers opt-in Base AI/MCP tools backed by store.
func RegisterTools(reg *ai.ToolRegistry, store storage.Store) error {
	if reg == nil || store == nil {
		return errors.New("base: registry and store are required")
	}
	idProp := map[string]any{"type": "string", "description": "Base document ID"}
	specs := []struct {
		def ai.ToolDefinition
		fn  ai.ToolHandler
	}{
		{
			def: ai.ToolDefinition{
				Name:        "base_inspect",
				Description: "Inspect a stored Base tables, field schemas, and record counts.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id"}, "properties": map[string]any{"id": idProp}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				_, b, err := loadBaseRecord(ctx, store, ai.StringArg(args, "id"))
				if err != nil {
					return nil, err
				}
				return b.Inspect(), nil
			},
		},
		{
			def: ai.ToolDefinition{
				Name:        "base_query",
				Description: "Query stored Base records by tableId and search keyword.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id"}, "properties": map[string]any{"id": idProp, "tableId": map[string]any{"type": "number"}, "search": map[string]any{"type": "string"}, "limit": map[string]any{"type": "number"}}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				_, b, err := loadBaseRecord(ctx, store, ai.StringArg(args, "id"))
				if err != nil {
					return nil, err
				}
				return b.Query(ai.IntArg(args, "tableId"), ai.StringArg(args, "search"), ai.IntArg(args, "limit")), nil
			},
		},
		{
			def: ai.ToolDefinition{
				Name:        "base_apply",
				Description: "Atomically apply Base ops (addTable, addField, addRecord, updateRecord, deleteRecord) with optional dryRun.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id", "ops"}, "properties": map[string]any{"id": idProp, "ops": map[string]any{"type": "array"}, "dryRun": map[string]any{"type": "boolean"}}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				rec, b, err := loadBaseRecord(ctx, store, ai.StringArg(args, "id"))
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
				applied, diff, err := b.Apply(ops, dryRun)
				if err != nil {
					return nil, err
				}
				if !dryRun {
					rec.Data, _ = json.Marshal(b)
					if err := store.Put(ctx, rec); err != nil {
						return nil, err
					}
				}
				return map[string]any{"ok": true, "applied": applied, "dryRun": dryRun, "diff": diff, "version": rec.Version}, nil
			},
		},
		{
			def: ai.ToolDefinition{
				Name:        "base_verify",
				Description: "Verify stored Base schema consistency, duplicate fields, and formula fields.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id"}, "properties": map[string]any{"id": idProp}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				_, b, err := loadBaseRecord(ctx, store, ai.StringArg(args, "id"))
				if err != nil {
					return nil, err
				}
				return b.Verify(), nil
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
