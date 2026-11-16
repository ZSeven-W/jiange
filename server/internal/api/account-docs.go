package api

import (
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
)

// listDocsForAccount binds the document-title list to the initiating account.
// The header is not authentication; requireUser and a final session check
// prevent a response from a different login being cached under this account.
func (s *Server) listDocsForAccount(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "账号未确认")
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok || !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	docs, err := s.Store.ListDocs(r.Context(), guard.UserID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// Only return titles used for link recognition, never parent metadata.
	type titleItem struct {
		ID    int64  `json:"id"`
		Title string `json:"title"`
	}
	titles := make([]titleItem, 0, len(docs))
	for _, doc := range docs {
		if doc.Kind == "doc" {
			titles = append(titles, titleItem{ID: doc.ID, Title: doc.Title})
			if len(titles) == 500 {
				break
			}
		}
	}
	current, err := s.Store.SessionUser(r.Context(), guard.SessionHash, s.now())
	if err != nil || current.ID != guard.UserID {
		httpx.Error(w, http.StatusUnauthorized, "session_changed", "登录账号已变化，请重新登录")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"docs": titles})
}
