package sync

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/ZSeven-W/jiange/sdk/go/storage"
)

// HandlerOption configures the HTTP handler produced by NewHandler.
type HandlerOption func(*handlerConfig)

type handlerConfig struct {
	auth  storage.Authenticator
	authz storage.Authorizer
}

// WithAuth attaches optional authentication and authorization middleware to room endpoints.
func WithAuth(auth storage.Authenticator, authz storage.Authorizer) HandlerOption {
	return func(c *handlerConfig) {
		c.auth = auth
		c.authz = authz
	}
}

// NewHandler builds an http.Handler exposing SSE events, op append/pull, and presence endpoints.
func NewHandler(hub *RoomHub, opts ...HandlerOption) http.Handler {
	var cfg handlerConfig
	for _, opt := range opts {
		opt(&cfg)
	}
	mux := http.NewServeMux()
	roomID := func(r *http.Request) string { return r.PathValue("id") }
	wrap := func(action storage.Action, fn http.HandlerFunc) http.Handler {
		return storage.AuthMiddleware(cfg.auth, cfg.authz, roomID, action, fn)
	}

	mux.Handle("GET /rooms/{id}/events", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		conn := NewChanConn(64)
		subID := hub.Subscribe(id, conn)
		defer hub.Unsubscribe(id, subID)

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		rc := http.NewResponseController(w)
		snap, _ := json.Marshal(hub.Snapshot(id))
		_, _ = fmt.Fprintf(w, "event: snapshot\ndata: %s\n\n", snap)
		_ = rc.Flush()

		for {
			select {
			case <-r.Context().Done():
				return
			case msg, ok := <-conn.Events():
				if !ok {
					return
				}
				_, _ = fmt.Fprintf(w, "event: message\ndata: %s\n\n", msg)
				_ = rc.Flush()
			}
		}
	}))

	mux.Handle("POST /rooms/{id}/ops", wrap(storage.ActionWrite, func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var req struct {
			BaseSeq  int64           `json:"baseSeq"`
			ClientID string          `json:"clientId"`
			Type     string          `json:"type"`
			Payload  json.RawMessage `json:"payload"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4*1024*1024)).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json: " + err.Error()})
			return
		}
		if strings.TrimSpace(req.ClientID) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "clientId is required"})
			return
		}
		op, err := hub.Append(id, req.BaseSeq, req.ClientID, req.Type, req.Payload)
		if errors.Is(err, ErrSeqConflict) {
			_, latest := hub.PullSince(id, 0)
			writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "latestSeq": latest})
			return
		}
		writeJSON(w, http.StatusOK, op)
	}))

	mux.Handle("GET /rooms/{id}/ops", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var after int64
		if raw := strings.TrimSpace(r.URL.Query().Get("after")); raw != "" {
			n, err := strconv.ParseInt(raw, 10, 64)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid after parameter"})
				return
			}
			after = n
		}
		ops, latest := hub.PullSince(id, after)
		writeJSON(w, http.StatusOK, map[string]any{
			"roomId":    id,
			"latestSeq": latest,
			"ops":       ops,
		})
	}))

	mux.Handle("POST /rooms/{id}/presence", wrap(storage.ActionWrite, func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var p Presence
		if err := json.NewDecoder(io.LimitReader(r.Body, 1*1024*1024)).Decode(&p); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json: " + err.Error()})
			return
		}
		if strings.TrimSpace(p.ClientID) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "clientId is required"})
			return
		}
		updated := hub.UpdatePresence(id, p)
		writeJSON(w, http.StatusOK, updated)
	}))

	mux.Handle("GET /rooms/{id}/presence", wrap(storage.ActionRead, func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		writeJSON(w, http.StatusOK, map[string]any{
			"roomId":   id,
			"presence": hub.ListPresence(id),
		})
	}))

	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
