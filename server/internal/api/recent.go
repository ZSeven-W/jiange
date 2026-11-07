package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) recordVisit(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusNotFound, "not_found", "document not found")
		return
	}
	err = s.Store.RecordVisit(r.Context(), u.ID, id, s.now())
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "document not found")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listRecent(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	u, _ := UserFrom(r.Context())
	docs, err := s.Store.RecentDocs(r.Context(), u.ID, store.MaxRecentDocs)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if docs == nil {
		docs = []store.RecentDoc{}
	}
	// A direct share of a child does not grant access to its parent. Reuse the
	// same response-only parent filtering as other document lists.
	metadata := make([]store.DocMeta, len(docs))
	for i := range docs {
		metadata[i] = docs[i].DocMeta
	}
	metadata, err = s.sanitizeDocList(r.Context(), u.ID, metadata)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	for i := range docs {
		docs[i].DocMeta = metadata[i]
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"docs": docs})
}
