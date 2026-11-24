package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// documentFileAccess authorizes the specific visible reference, not just an
// upload's document ID. Editors can read new uploads before inserting them.
// Rechecking after loading a snapshot prevents a downgrade during the read
// from turning an editor-only history into a reader-accessible attachment.
func (s *Server) documentFileAccess(r *http.Request, file store.FileMeta, guard store.RestoreGuard) (bool, error) {
	ctx := r.Context()
	role, err := s.versionReadRole(ctx, guard, file.DocID)
	if err != nil {
		return false, fileAuthorizationError(err)
	}
	meta, err := s.Store.GetDoc(ctx, guard.UserID, file.DocID)
	if err != nil {
		return false, fileAuthorizationError(err)
	}
	if meta.Kind != "doc" || meta.Role != role {
		return false, store.ErrNotFound
	}
	restricted := !store.DocumentDownloadAllowed(meta, role)
	values, hasVersion := r.URL.Query()["version"]
	var seq int64
	if hasVersion {
		if len(values) != 1 {
			return false, store.ErrNotFound
		}
		seq, err = strconv.ParseInt(values[0], 10, 64)
		if err != nil || seq <= 0 {
			return false, store.ErrNotFound
		}
		_, allowed, err := s.mayReadVersion(ctx, guard, file.DocID, seq)
		if err != nil {
			return false, fileAuthorizationError(err)
		}
		if !allowed {
			return false, store.ErrNotFound
		}
	}
	needsReference := hasVersion || restricted || store.RoleRank(role) < store.RoleRank(store.RoleEdit)
	imageReference, fileReference := false, false
	var head int64
	if needsReference {
		var doc *collab.Doc
		if hasVersion {
			state, err := s.Store.VersionState(ctx, file.DocID, seq)
			if err != nil {
				return false, fileAuthorizationError(err)
			}
			doc, err = collab.DecodeState(state)
			if err != nil {
				return false, err
			}
		} else {
			doc, head, err = StateAtHead(ctx, s.Store, file.DocID)
			if err != nil {
				return false, err
			}
		}
		want := strconv.FormatInt(file.ID, 10)
		for _, block := range doc.View().Blocks {
			if block.Props["fileId"] == want {
				imageReference = imageReference || block.Type == "image"
				fileReference = fileReference || block.Type == "file" || block.Type == "audio" || block.Type == "video"
			}
			if block.Type == "flowchart" && flowchartReferencesImage(block.Props, want) {
				imageReference = true
			}
		}
	}
	if hasVersion {
		currentRole, allowed, err := s.mayReadVersion(ctx, guard, file.DocID, seq)
		if err != nil {
			return false, fileAuthorizationError(err)
		}
		if !allowed || currentRole != role {
			return false, store.ErrNotFound
		}
	} else {
		currentRole, err := s.versionReadRole(ctx, guard, file.DocID)
		if err != nil {
			return false, fileAuthorizationError(err)
		}
		if currentRole != role {
			return false, store.ErrNotFound
		}
	}
	current, err := s.Store.GetDoc(ctx, guard.UserID, file.DocID)
	if err != nil {
		return false, fileAuthorizationError(err)
	}
	if current.Kind != "doc" || current.Role != role || store.DocumentDownloadAllowed(current, role) == restricted {
		return false, store.ErrNotFound
	}
	if needsReference && !hasVersion {
		currentHead, err := s.Store.Head(ctx, file.DocID)
		if err != nil {
			return false, err
		}
		if currentHead != head {
			return false, store.ErrNotFound
		}
	}
	// The head or snapshot check can block; do not rely on a session or
	// download policy observed before it completed.
	finalRole, err := s.versionReadRole(ctx, guard, file.DocID)
	if err != nil {
		return false, fileAuthorizationError(err)
	}
	if finalRole != role {
		return false, store.ErrNotFound
	}
	finalMeta, err := s.Store.GetDoc(ctx, guard.UserID, file.DocID)
	if err != nil {
		return false, fileAuthorizationError(err)
	}
	if finalMeta.Kind != "doc" || finalMeta.Role != role || store.DocumentDownloadAllowed(finalMeta, role) == restricted {
		return false, store.ErrNotFound
	}
	if restricted {
		if !imageReference || !canInlineImage(file.Mime) {
			return false, store.ErrNotFound
		}
		return true, nil
	}
	if needsReference && !imageReference && !fileReference {
		return false, store.ErrNotFound
	}
	return false, nil
}

func fileAuthorizationError(err error) error {
	if errors.Is(err, store.ErrUnauthenticated) || errors.Is(err, store.ErrForbidden) || errors.Is(err, store.ErrNotFound) {
		return store.ErrNotFound
	}
	return err
}
