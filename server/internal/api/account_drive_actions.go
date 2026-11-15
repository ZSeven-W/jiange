package api

import (
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
)

// Dedicated endpoints fail closed on servers that cannot bind an action to
// the account that initiated it. Authentication still comes from the cookie.
func requireActionAccount(w http.ResponseWriter, r *http.Request) bool {
	user, _ := UserFrom(r.Context())
	raw := r.Header.Get("X-Jiange-User-Id")
	if raw == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "操作账号未确认")
		return false
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 || id != user.ID {
		httpx.Error(w, http.StatusUnauthorized, "session_changed", "登录账号已变化，请重新操作")
		return false
	}
	return true
}

func (s *Server) postAccountDriveMove(w http.ResponseWriter, r *http.Request) {
	if requireActionAccount(w, r) {
		s.postDriveMove(w, r)
	}
}

func (s *Server) accountPin(w http.ResponseWriter, r *http.Request) {
	if requireActionAccount(w, r) {
		s.putPin(w, r)
	}
}

func (s *Server) accountFavorite(w http.ResponseWriter, r *http.Request) {
	if requireActionAccount(w, r) {
		s.putFavorite(w, r)
	}
}
func (s *Server) accountFavorites(w http.ResponseWriter, r *http.Request) {
	if requireActionAccount(w, r) {
		s.listFavorites(w, r)
	}
}
func (s *Server) accountPins(w http.ResponseWriter, r *http.Request) {
	if requireActionAccount(w, r) {
		s.listPins(w, r)
	}
}
