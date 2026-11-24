package api

import (
	"context"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type revisionLinkStore interface {
	ChangeLinkRoleAtRevision(context.Context, store.RestoreGuard, int64, string, string, int64) (store.Link, error)
}

func (s *Server) getSharesForAccount(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "未确认当前账号")
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	s.getShares(w, r)
}

// The separate route fails closed against older servers. The revision and
// authenticated account must be those observed when the user made the choice.
func (s *Server) putLinkAtRevision(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	d, ok := s.need(w, r, store.RoleManage)
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "未确认当前账号")
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		Role             string `json:"role"`
		ExpectedRevision *int64 `json:"expectedRevision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.ExpectedRevision == nil || *in.ExpectedRevision < 0 || *in.ExpectedRevision > 9007199254740991 || (in.Role != "none" && in.Role != "anon" && in.Role != store.RoleView && in.Role != store.RoleEdit && in.Role != store.LinkWorkspaceView && in.Role != store.LinkWorkspaceEdit) || ((d.Kind == "file" || d.Kind == "sheet") && in.Role == "anon") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "链接权限或版本无效")
		return
	}
	st, ok := s.Store.(revisionLinkStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "服务暂不支持安全修改链接权限")
		return
	}
	candidate := ""
	if in.Role != "none" {
		var err error
		candidate, err = token()
		if err != nil {
			s.fail(w, r, err)
			return
		}
	}
	link, err := st.ChangeLinkRoleAtRevision(r.Context(), guard, d.ID, in.Role, candidate, *in.ExpectedRevision)
	if err != nil {
		s.shareMutationError(w, r, err)
		return
	}
	if in.Role == "none" {
		s.clearLinkPasswordBestEffort(r.Context(), guard, d.ID)
	}
	current, docErr := s.Store.GetDoc(r.Context(), guard.UserID, d.ID)
	user, sessionErr := s.Store.SessionUser(r.Context(), guard.SessionHash, s.now())
	if docErr != nil || current.Role != store.RoleManage || sessionErr != nil || user.ID != guard.UserID {
		w.Header().Set("X-Share-Refresh-Required", "true")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	hasPass := false
	if link.Role != "none" {
		if hash, pErr := s.getLinkPasswordHash(r.Context(), d.ID); pErr == nil && hash != "" {
			hasPass = true
		}
	}
	httpx.JSON(w, http.StatusOK, linkWithPassword{Link: link, HasPassword: hasPass})
}
