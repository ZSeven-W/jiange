package api

import (
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
)

// A separate route fails closed on older servers and rejects a switched
// browser session before invoking the transactionally guarded view creation.
func baseExpectedAccount(w http.ResponseWriter, r *http.Request) bool {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "请重新登录")
		return false
	}
	expected, err := strconv.ParseInt(r.Header.Get("X-Jiange-User-Id"), 10, 64)
	if err != nil || expected <= 0 {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "账号未确认")
		return false
	}
	if expected != u.ID {
		httpx.Error(w, http.StatusUnauthorized, "session_changed", "登录账号已变化，请重新打开表格")
		return false
	}
	return true
}

func (s *Server) addViewForAccount(w http.ResponseWriter, r *http.Request) {
	if !baseExpectedAccount(w, r) {
		return
	}
	s.addView(w, r)
}

func (s *Server) getBaseForAccount(w http.ResponseWriter, r *http.Request) {
	if !baseExpectedAccount(w, r) {
		return
	}
	s.getBase(w, r)
}
