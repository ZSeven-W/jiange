package api

import (
	"context"
	"errors"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

// sanitizeDocMeta returns a response-only copy. Internal authorization,
// copying and moving must continue to use the real parent from the store.
// A nil cache is allowed for one response; list responses share a cache so a
// common parent is checked at most once per request.
func (s *Server) sanitizeDocMeta(ctx context.Context, uid int64, doc store.DocMeta, cache map[int64]bool) (store.DocMeta, error) {
	if doc.ParentID == nil {
		return doc, nil
	}
	id := *doc.ParentID
	visible, known := cache[id]
	if !known {
		_, err := s.Store.GetDoc(ctx, uid, id)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return store.DocMeta{}, err
		}
		visible = err == nil
		if cache != nil {
			cache[id] = visible
		}
	}
	if !visible {
		doc.ParentID = nil
	}
	return doc, nil
}

func (s *Server) sanitizeDocList(ctx context.Context, uid int64, docs []store.DocMeta) ([]store.DocMeta, error) {
	out := make([]store.DocMeta, len(docs))
	cache := make(map[int64]bool)
	// IDs already included in the response are visible to this caller. Reusing
	// them avoids extra parent lookups for the common in-list tree case, and
	// keeps relationships between entries in the caller's trash intact.
	for _, doc := range docs {
		cache[doc.ID] = true
	}
	for i, doc := range docs {
		var err error
		out[i], err = s.sanitizeDocMeta(ctx, uid, doc, cache)
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// A successful write must remain successful even if the follow-up visibility
// check fails. Hide the parent in that case rather than leaking it or inviting
// the client to retry an operation that has already committed.
func (s *Server) sanitizeWrittenDocMeta(ctx context.Context, uid int64, doc store.DocMeta) store.DocMeta {
	safe, err := s.sanitizeDocMeta(ctx, uid, doc, nil)
	if err != nil {
		doc.ParentID = nil
		return doc
	}
	return safe
}
