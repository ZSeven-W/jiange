package sheet

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

const kindSheet = "sheet"

// Option configures a sheet HTTP handler.
type Option func(*handlerConfig)

type handlerConfig struct {
	auth    storage.Authenticator
	authz   storage.Authorizer
	webhook *storage.WebhookDispatcher
}

// WithAuth attaches authentication and authorization middleware to sheet routes.
func WithAuth(auth storage.Authenticator, authz storage.Authorizer) Option {
	return func(c *handlerConfig) {
		c.auth = auth
		c.authz = authz
	}
}

// WithWebhook attaches a signed WebhookDispatcher for sheet lifecycle events.
func WithWebhook(w *storage.WebhookDispatcher) Option {
	return func(c *handlerConfig) {
		c.webhook = w
	}
}

func loadWorkbookRecord(ctx context.Context, store storage.Store, id string) (*storage.DocumentRecord, *Workbook, error) {
	rec, err := store.Get(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	var wb Workbook
	if err := json.Unmarshal(rec.Data, &wb); err != nil {
		return nil, nil, err
	}
	wb.Recalculate()
	return rec, &wb, nil
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
			Kind:    kindSheet,
			Payload: payload,
		})
	}
}

// NewHandler builds a drop-in net/http.Handler for Jiange Spreadsheet APIs.
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

	// POST /sheets — accepts JSON payload, raw XLSX, or raw CSV.
	mux.Handle("POST /sheets", wrap(storage.ActionWrite, func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 32*1024*1024))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
		ct := strings.ToLower(r.Header.Get("Content-Type"))
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		title := strings.TrimSpace(r.URL.Query().Get("title"))

		var wb *Workbook
		switch {
		case format == "xlsx" || strings.Contains(ct, "spreadsheetml"):
			wb, err = ParseXLSX(body)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
		case format == "csv" || strings.Contains(ct, "text/csv"):
			wb, err = ParseCSV(body, title)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
		default:
			var payload struct {
				ID       string    `json:"id"`
				Title    string    `json:"title"`
				Workbook *Workbook `json:"workbook"`
			}
			if len(bytesTrimSpace(body)) > 0 {
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
			wb = payload.Workbook
			if wb == nil {
				wb = NewWorkbook("Sheet1")
			}
		}

		if id == "" {
			id = storage.GenerateID("sht_")
		}
		if title == "" {
			title = "Untitled Sheet"
		}
		wb.Recalculate()
		raw, _ := json.Marshal(wb)
		rec := &storage.DocumentRecord{
			ID:    id,
			Kind:  kindSheet,
			Title: title,
			Data:  raw,
		}
		if err := store.Put(r.Context(), rec); err != nil {
			writeStoreErr(w, err)
			return
		}
		dispatchWebhook(r.Context(), cfg.webhook, "sheet.created", rec.ID, map[string]any{"version": rec.Version, "title": rec.Title})
		writeJSON(w, http.StatusCreated, map[string]any{
			"id":       rec.ID,
			"title":    rec.Title,
			"version":  rec.Version,
			"workbook": wb,
		})
	}))

	// GET /sheets/{id}
	mux.Handle("GET /sheets/{id}", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		rec, wb, err := loadWorkbookRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		detail := r.URL.Query().Get("detail")
		writeJSON(w, http.StatusOK, map[string]any{
			"id":       rec.ID,
			"title":    rec.Title,
			"version":  rec.Version,
			"inspect":  wb.Inspect(detail),
			"workbook": wb,
		})
	}))

	// GET /sheets/{id}/export?format=xlsx|csv
	mux.Handle("GET /sheets/{id}/export", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		rec, wb, err := loadWorkbookRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
		if format == "" {
			format = "xlsx"
		}
		switch format {
		case "xlsx":
			out, err := WriteXLSX(wb)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
			w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.xlsx"`, rec.ID))
			_, _ = w.Write(out)
		case "csv":
			sheetIdx := 0
			if rawIdx := r.URL.Query().Get("sheetIndex"); rawIdx != "" {
				n, err := strconv.Atoi(rawIdx)
				if err != nil {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sheetIndex"})
					return
				}
				sheetIdx = n
			}
			out, err := WriteCSV(wb, sheetIdx)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			w.Header().Set("Content-Type", "text/csv; charset=utf-8")
			w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.csv"`, rec.ID))
			_, _ = w.Write(out)
		default:
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported export format: " + format})
		}
	}))

	// POST /sheets/{id}/query
	mux.Handle("POST /sheets/{id}/query", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		_, wb, err := loadWorkbookRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		var req struct {
			Sheet        string `json:"sheet"`
			Search       string `json:"search"`
			OnlyFormulas bool   `json:"onlyFormulas"`
			OnlyErrors   bool   `json:"onlyErrors"`
			Limit        int    `json:"limit"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4*1024*1024)).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json: " + err.Error()})
			return
		}
		cells := wb.Query(req.Sheet, req.Search, req.OnlyFormulas, req.OnlyErrors, req.Limit)
		writeJSON(w, http.StatusOK, map[string]any{"cells": cells})
	}))

	// POST /sheets/{id}/apply
	mux.Handle("POST /sheets/{id}/apply", wrap(storage.ActionWrite, func(w http.ResponseWriter, r *http.Request) {
		rec, wb, err := loadWorkbookRecord(r.Context(), store, r.PathValue("id"))
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
		applied, diff, err := wb.Apply(req.Ops, req.DryRun)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if !req.DryRun {
			rec.Data, _ = json.Marshal(wb)
			if err := store.Put(r.Context(), rec); err != nil {
				writeStoreErr(w, err)
				return
			}
			dispatchWebhook(r.Context(), cfg.webhook, "sheet.updated", rec.ID, map[string]any{"version": rec.Version, "applied": applied})
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"applied": applied,
			"dryRun":  req.DryRun,
			"diff":    diff,
			"version": rec.Version,
		})
	}))

	// POST /sheets/{id}/verify
	mux.Handle("POST /sheets/{id}/verify", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		_, wb, err := loadWorkbookRecord(r.Context(), store, r.PathValue("id"))
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"diagnostics": wb.Verify()})
	}))

	// DELETE /sheets/{id}
	mux.Handle("DELETE /sheets/{id}", wrap(storage.ActionAdmin, func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := store.Delete(r.Context(), id); err != nil {
			writeStoreErr(w, err)
			return
		}
		dispatchWebhook(r.Context(), cfg.webhook, "sheet.deleted", id, nil)
		w.WriteHeader(http.StatusNoContent)
	}))

	return mux
}

func bytesTrimSpace(b []byte) []byte {
	return []byte(strings.TrimSpace(string(b)))
}

// RegisterTools registers opt-in Sheet AI/MCP tools backed by store.
func RegisterTools(reg *ai.ToolRegistry, store storage.Store) error {
	if reg == nil || store == nil {
		return errors.New("sheet: registry and store are required")
	}
	idProp := map[string]any{"type": "string", "description": "Sheet document ID"}
	specs := []struct {
		def ai.ToolDefinition
		fn  ai.ToolHandler
	}{
		{
			def: ai.ToolDefinition{
				Name:        "sheet_inspect",
				Description: "Inspect a stored spreadsheet workbook structure, cell counts, formulas, and errors.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id"}, "properties": map[string]any{"id": idProp, "detail": map[string]any{"type": "string"}}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				_, wb, err := loadWorkbookRecord(ctx, store, ai.StringArg(args, "id"))
				if err != nil {
					return nil, err
				}
				return wb.Inspect(ai.StringArg(args, "detail")), nil
			},
		},
		{
			def: ai.ToolDefinition{
				Name:        "sheet_query",
				Description: "Query cells in a stored spreadsheet by sheet name, keyword, formulas, or errors.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id"}, "properties": map[string]any{"id": idProp, "sheet": map[string]any{"type": "string"}, "search": map[string]any{"type": "string"}, "onlyFormulas": map[string]any{"type": "boolean"}, "onlyErrors": map[string]any{"type": "boolean"}, "limit": map[string]any{"type": "number"}}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				_, wb, err := loadWorkbookRecord(ctx, store, ai.StringArg(args, "id"))
				if err != nil {
					return nil, err
				}
				return wb.Query(ai.StringArg(args, "sheet"), ai.StringArg(args, "search"), ai.BoolArg(args, "onlyFormulas"), ai.BoolArg(args, "onlyErrors"), ai.IntArg(args, "limit")), nil
			},
		},
		{
			def: ai.ToolDefinition{
				Name:        "sheet_apply",
				Description: "Atomically apply spreadsheet ops (setCell, addSheet, deleteSheet) with optional dryRun.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id", "ops"}, "properties": map[string]any{"id": idProp, "ops": map[string]any{"type": "array"}, "dryRun": map[string]any{"type": "boolean"}}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				rec, wb, err := loadWorkbookRecord(ctx, store, ai.StringArg(args, "id"))
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
				applied, diff, err := wb.Apply(ops, dryRun)
				if err != nil {
					return nil, err
				}
				if !dryRun {
					rec.Data, _ = json.Marshal(wb)
					if err := store.Put(ctx, rec); err != nil {
						return nil, err
					}
				}
				return map[string]any{"ok": true, "applied": applied, "dryRun": dryRun, "diff": diff, "version": rec.Version}, nil
			},
		},
		{
			def: ai.ToolDefinition{
				Name:        "sheet_verify",
				Description: "Verify all formulas in a stored spreadsheet and report diagnostics.",
				InputSchema: map[string]any{"type": "object", "required": []string{"id"}, "properties": map[string]any{"id": idProp}},
			},
			fn: func(ctx context.Context, args map[string]any) (any, error) {
				_, wb, err := loadWorkbookRecord(ctx, store, ai.StringArg(args, "id"))
				if err != nil {
					return nil, err
				}
				return wb.Verify(), nil
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
