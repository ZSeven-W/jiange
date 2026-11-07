package api

import (
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// isProtectedImage permits preview only for a real image block of the same
// document. A named version may reference an image no longer in the current
// document; only that document's own saved snapshot can authorize it.
func (s *Server) isProtectedImage(r *http.Request, file store.FileMeta) (bool, error) {
	var doc *collab.Doc
	var err error
	versions, hasVersion := r.URL.Query()["version"]
	if hasVersion {
		if len(versions) != 1 || versions[0] == "" {
			return false, store.ErrNotFound
		}
		seq, parseErr := strconv.ParseInt(versions[0], 10, 64)
		if parseErr != nil || seq < 1 {
			return false, store.ErrNotFound
		}
		state, stateErr := s.Store.VersionState(r.Context(), file.DocID, seq)
		if stateErr != nil {
			return false, stateErr
		}
		doc, err = collab.DecodeState(state)
	} else {
		doc, _, err = StateAtHead(r.Context(), s.Store, file.DocID)
	}
	if err != nil {
		return false, err
	}
	want := strconv.FormatInt(file.ID, 10)
	for _, block := range doc.View().Blocks {
		if block.Type == "image" && block.Props["fileId"] == want {
			return true, nil
		}
	}
	return false, nil
}
