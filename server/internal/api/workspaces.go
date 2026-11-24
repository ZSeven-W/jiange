package api

import (
	"errors"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type createWorkspaceRequest struct {
	Name string `json:"name"`
}

// listMyWorkspaces handles GET /api/workspaces and returns all workspaces the
// signed-in user belongs to.
func (s *Server) listMyWorkspaces(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	ws, err := s.Store.Workspaces(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if ws == nil {
		ws = []store.Workspace{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"workspaces": ws})
}

// createWorkspace handles POST /api/workspaces, creating a new workspace owned
// by the signed-in user and recording a workspace.create enterprise audit event.
func (s *Server) createWorkspace(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}

	var in createWorkspaceRequest
	if !httpx.Decode(w, r, &in) {
		return
	}

	mgr, ok := s.Store.(store.WorkspaceManagerStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "workspaces_unavailable", "当前存储不支持新建工作空间")
		return
	}

	ws, err := mgr.CreateWorkspace(r.Context(), u.ID, in.Name)
	switch {
	case err == nil:
	case errors.Is(err, store.ErrInvalidInput):
		httpx.Error(w, http.StatusBadRequest, "invalid_workspace_name", "工作空间名称长度需为 1-80 个字符")
		return
	case errors.Is(err, store.ErrWorkspaceLimitReached), errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "workspace_limit_reached", "已达到可创建的工作空间数量上限（20 个）")
		return
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "用户不存在")
		return
	default:
		s.fail(w, r, err)
		return
	}

	s.recordAudit(r, ws.ID, "workspace.create", "workspace", ws.ID, ws.Name, map[string]any{
		"ownerId": ws.OwnerID,
	})
	httpx.JSON(w, http.StatusCreated, map[string]any{"workspace": ws})
}
