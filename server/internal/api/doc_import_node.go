package api

import (
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
)

// A separate route makes an old server fail closed if it cannot bind the
// document creation to the account that initiated the import.
func (s *Server) postWordImportNode(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "导入账号未确认")
		return
	}
	u, _ := UserFrom(r.Context())
	if !driveExpectedUser(w, r, u.ID) {
		return
	}
	s.postDriveNode(w, r)
}
