package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// getPublicFile serves only attachments visible in the currently shared
// document. A token for one document never grants access to another document,
// or to old uploads no longer present in its visible block tree.
func (s *Server) getPublicFile(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	notFound := func() { httpx.Error(w, http.StatusNotFound, "not_found", "文件不存在或链接已失效") }
	tok := r.PathValue("token")
	docID, role, err := s.Store.DocByToken(r.Context(), tok)
	if errors.Is(err, store.ErrNotFound) || err == nil && role != "anon" {
		notFound()
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	fileID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || fileID <= 0 || s.Blobs == nil {
		notFound()
		return
	}
	file, err := s.Store.GetFile(r.Context(), fileID)
	if errors.Is(err, store.ErrNotFound) || err == nil && file.DocID != docID {
		notFound()
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	authorize := func() (bool, error) {
		doc, _, err := StateAtHead(r.Context(), s.Store, docID)
		if err != nil {
			return false, err
		}
		imageReference, fileReference := false, false
		for _, block := range doc.View().Blocks {
			if block.Props["fileId"] == strconv.FormatInt(fileID, 10) {
				imageReference = imageReference || block.Type == "image"
				fileReference = fileReference || block.Type == "file"
			}
		}
		currentDoc, currentRole, err := s.Store.DocByToken(r.Context(), tok)
		if errors.Is(err, store.ErrNotFound) || err == nil && (currentDoc != docID || currentRole != "anon") {
			return false, store.ErrNotFound
		}
		if err != nil {
			return false, err
		}
		meta, err := s.Store.GetDocSystem(r.Context(), docID)
		if err != nil {
			return false, err
		}
		// Fetching document metadata can block. A link revoked while it was being
		// read must not authorize delivery based on the preceding token check.
		currentDoc, currentRole, err = s.Store.DocByToken(r.Context(), tok)
		if errors.Is(err, store.ErrNotFound) || err == nil && (currentDoc != docID || currentRole != "anon") {
			return false, store.ErrNotFound
		}
		if err != nil {
			return false, err
		}
		// Settings can change while the previous metadata read is blocked.
		// Check again before deciding whether the referenced file can download.
		meta, err = s.Store.GetDocSystem(r.Context(), docID)
		if err != nil {
			return false, err
		}
		currentDoc, currentRole, err = s.Store.DocByToken(r.Context(), tok)
		if errors.Is(err, store.ErrNotFound) || err == nil && (currentDoc != docID || currentRole != "anon") {
			return false, store.ErrNotFound
		}
		if err != nil {
			return false, err
		}
		allowDownload := fileReference && !meta.CopyProtected
		if !(imageReference && canInlineImage(file.Mime)) && !allowDownload {
			return false, store.ErrNotFound
		}
		return !allowDownload, nil
	}
	requireRaster, err := authorize()
	if err != nil {
		s.fileAccessError(w, r, err)
		return
	}
	s.serveFileAuthorized(w, r, file, requireRaster, authorize)
}
