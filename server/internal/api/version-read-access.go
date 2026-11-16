package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// Automatic history is available to editors; readers may open only an
// explicitly saved version. Recheck the original session and document role.
func (s *Server) versionReadRole(ctx context.Context, guard store.RestoreGuard, docID int64) (string, error) {
	user, err := s.Store.SessionUser(ctx, guard.SessionHash, s.now())
	if errors.Is(err, store.ErrNotFound) || err == nil && user.ID != guard.UserID {
		return "", store.ErrUnauthenticated
	}
	if err != nil {
		return "", err
	}
	meta, err := s.Store.GetDoc(ctx, guard.UserID, docID)
	if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrForbidden) || err == nil && store.RoleRank(meta.Role) < store.RoleRank(store.RoleView) {
		return "", store.ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return meta.Role, nil
}

func (s *Server) mayReadVersion(ctx context.Context, guard store.RestoreGuard, docID, seq int64) (string, bool, error) {
	role, err := s.versionReadRole(ctx, guard, docID)
	if err != nil || store.RoleRank(role) >= store.RoleRank(store.RoleEdit) {
		return role, err == nil, err
	}
	st, ok := s.Store.(versionEntryStore)
	if !ok {
		return "", false, store.ErrNotFound
	}
	entries, err := st.ListVersionEntries(ctx, guard, docID)
	if err != nil {
		return "", false, err
	}
	role, err = s.versionReadRole(ctx, guard, docID)
	if err != nil || store.RoleRank(role) >= store.RoleRank(store.RoleEdit) {
		return role, err == nil, err
	}
	for _, entry := range entries {
		// Automatic snapshots are stored with no creator. A missing creator is
		// treated conservatively; an explicit named version has a real author.
		if entry.Seq == seq && entry.CreatedBy > 0 {
			return role, true, nil
		}
	}
	return role, false, nil
}

func (s *Server) versionReadError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, store.ErrUnauthenticated) {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
	} else if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrForbidden) {
		httpx.Error(w, http.StatusNotFound, "not_found", "版本不存在或无权访问")
	} else {
		s.fail(w, r, err)
	}
}

func versionScope(r *http.Request) (string, bool) {
	values := r.URL.Query()["scope"]
	if len(values) == 0 {
		return "", true
	}
	return values[0], len(values) == 1 && (values[0] == "saved" || values[0] == "history")
}
