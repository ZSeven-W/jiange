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
	doc, _, err := StateAtHead(r.Context(), s.Store, docID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	imageReference, fileReference := false, false
	for _, block := range doc.View().Blocks {
		if block.Props["fileId"] == strconv.FormatInt(fileID, 10) {
			imageReference = imageReference || block.Type == "image"
			fileReference = fileReference || block.Type == "file"
		}
	}
	if !imageReference && !fileReference {
		notFound()
		return
	}
	// A close, role change, or token rotation during materialization must not
	// accidentally authorize this request based on an earlier link setting.
	currentDoc, currentRole, err := s.Store.DocByToken(r.Context(), tok)
	if errors.Is(err, store.ErrNotFound) || err == nil && (currentDoc != docID || currentRole != "anon") {
		notFound()
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	meta, err := s.Store.GetDocSystem(r.Context(), docID)
	if errors.Is(err, store.ErrNotFound) {
		notFound()
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	allowDownload := fileReference && !meta.CopyProtected
	if !(imageReference && canInlineImage(file.Mime)) && !allowDownload {
		notFound()
		return
	}
	s.serveFile(w, r, file, !allowDownload)
}
