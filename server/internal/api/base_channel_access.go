package api

import (
	"context"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// baseChannelAccess is used for channels that cannot yet project individual
// rows and fields. It checks the original session and the current Base role on
// every use, and denies restricted users rather than exposing unfiltered data.
func (s *Server) baseChannelAccess(ctx context.Context, r *http.Request, baseID int64, minRole string) error {
	return s.baseChannelAccessPolicy(ctx, r, baseID, minRole, false)
}

// CSV exports are downloads and must honor the current copy/download policy.
func (s *Server) baseExportAccess(ctx context.Context, r *http.Request, baseID int64) error {
	return s.baseChannelAccessPolicy(ctx, r, baseID, store.RoleView, true)
}

func (s *Server) baseChannelAccessPolicy(ctx context.Context, r *http.Request, baseID int64, minRole string, denyProtected bool) error {
	u, ok := UserFrom(r.Context())
	if !ok {
		return store.ErrNotFound
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		return store.ErrNotFound
	}
	current, err := s.Store.SessionUser(ctx, auth.HashToken(cookie.Value), s.now())
	if err != nil || current.ID != u.ID {
		return store.ErrNotFound
	}
	meta, err := s.Store.GetDoc(ctx, u.ID, baseID)
	if err != nil || meta.Kind != "base" || store.RoleRank(meta.Role) < store.RoleRank(minRole) {
		return store.ErrNotFound
	}
	if denyProtected && meta.CopyProtected && meta.Role != store.RoleManage {
		return store.ErrNotFound
	}
	restricted, err := s.baseRestricted(ctx, meta)
	if err != nil || restricted {
		return store.ErrNotFound
	}
	return nil
}
