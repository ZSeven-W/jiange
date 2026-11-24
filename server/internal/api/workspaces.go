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

type renameWorkspaceRequest struct {
	Name string `json:"name"`
}

type transferWorkspaceOwnerRequest struct {
	TargetUserID int64 `json:"targetUserId"`
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

// renameWorkspace handles PATCH /api/workspaces/{wsId}, allowing a workspace
// owner or admin to update the workspace name and logging workspace.renamed.
func (s *Server) renameWorkspace(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}

	var in renameWorkspaceRequest
	if !httpx.Decode(w, r, &in) {
		return
	}

	mgr, ok := s.Store.(store.WorkspaceManagerStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "workspaces_unavailable", "当前存储不支持管理工作空间")
		return
	}

	ws, err := mgr.RenameWorkspace(r.Context(), u.ID, wsID, in.Name)
	switch {
	case err == nil:
	case errors.Is(err, store.ErrInvalidInput):
		httpx.Error(w, http.StatusBadRequest, "invalid_workspace_name", "工作空间名称长度需为 1-80 个字符")
		return
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "仅空间所有者或管理员可重命名工作空间")
		return
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "工作空间不存在")
		return
	default:
		s.fail(w, r, err)
		return
	}

	s.recordAudit(r, ws.ID, "workspace.renamed", "workspace", ws.ID, ws.Name, map[string]any{
		"name": ws.Name,
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"workspace": ws})
}

// deleteWorkspace handles DELETE /api/workspaces/{wsId}, allowing only the
// workspace owner to permanently delete a workspace when they retain at least
// one other workspace, and recording a workspace.deleted audit event on a
// remaining workspace.
func (s *Server) deleteWorkspace(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}

	mgr, ok := s.Store.(store.WorkspaceManagerStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "workspaces_unavailable", "当前存储不支持管理工作空间")
		return
	}

	var deletedName string
	var auditWSID int64
	if existing, err := s.Store.Workspaces(r.Context(), u.ID); err == nil {
		var fallbackWSID int64
		for _, item := range existing {
			if item.ID == wsID {
				deletedName = item.Name
				continue
			}
			if fallbackWSID == 0 {
				fallbackWSID = item.ID
			}
			if item.OwnerID == u.ID && auditWSID == 0 {
				auditWSID = item.ID
			}
		}
		if auditWSID == 0 {
			auditWSID = fallbackWSID
		}
	}

	err := mgr.DeleteWorkspace(r.Context(), u.ID, wsID)
	switch {
	case err == nil:
	case errors.Is(err, store.ErrInvalidInput):
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "无效的工作空间参数")
		return
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "仅空间所有者可删除工作空间")
		return
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "工作空间不存在")
		return
	case errors.Is(err, store.ErrLastWorkspace):
		httpx.Error(w, http.StatusConflict, "last_workspace", "至少需要保留一个工作空间，无法删除最后一个工作空间")
		return
	default:
		s.fail(w, r, err)
		return
	}

	if auditWSID > 0 {
		s.recordAudit(r, auditWSID, "workspace.deleted", "workspace", wsID, deletedName, map[string]any{
			"deletedWorkspaceId": wsID,
			"name":               deletedName,
		})
	}
	w.WriteHeader(http.StatusNoContent)
}

// transferWorkspaceOwner handles POST /api/workspaces/{wsId}/transfer-owner,
// atomically promoting an existing workspace member to owner and demoting the
// current owner to admin.
func (s *Server) transferWorkspaceOwner(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}

	var in transferWorkspaceOwnerRequest
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.TargetUserID <= 0 || in.TargetUserID == u.ID {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "请选择有效的目标成员")
		return
	}

	mgr, ok := s.Store.(store.WorkspaceManagerStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "workspaces_unavailable", "当前存储不支持管理工作空间")
		return
	}

	var wsName string
	if existing, err := s.Store.Workspaces(r.Context(), u.ID); err == nil {
		for _, item := range existing {
			if item.ID == wsID {
				wsName = item.Name
				break
			}
		}
	}

	err := mgr.TransferWorkspaceOwner(r.Context(), u.ID, wsID, in.TargetUserID)
	switch {
	case err == nil:
	case errors.Is(err, store.ErrInvalidInput):
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "目标成员无效或不能转让给自己")
		return
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "仅空间所有者可转让所有权")
		return
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "工作空间或目标成员不存在")
		return
	default:
		s.fail(w, r, err)
		return
	}

	s.recordAudit(r, wsID, "workspace.owner_transferred", "workspace", wsID, wsName, map[string]any{
		"previousOwnerId": u.ID,
		"newOwnerId":      in.TargetUserID,
	})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"workspaceId": wsID,
		"ownerId":     in.TargetUserID,
	})
}

// leaveWorkspace handles POST /api/workspaces/{wsId}/leave, allowing any
// non-owner member (admin or member) to leave a workspace when they retain at
// least one other workspace.
func (s *Server) leaveWorkspace(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}

	mgr, ok := s.Store.(store.WorkspaceManagerStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "workspaces_unavailable", "当前存储不支持管理工作空间")
		return
	}

	var wsName string
	if existing, err := s.Store.Workspaces(r.Context(), u.ID); err == nil {
		for _, item := range existing {
			if item.ID == wsID {
				wsName = item.Name
				break
			}
		}
	}

	err := mgr.LeaveWorkspace(r.Context(), u.ID, wsID)
	switch {
	case err == nil:
	case errors.Is(err, store.ErrInvalidInput):
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "无效的工作空间参数")
		return
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "您不是该工作空间的成员")
		return
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "工作空间不存在")
		return
	case errors.Is(err, store.ErrOwnerCannotLeave):
		httpx.Error(w, http.StatusConflict, "owner_cannot_leave", "空间所有者不能直接退出，请先转让所有权或删除空间")
		return
	case errors.Is(err, store.ErrLastWorkspace):
		httpx.Error(w, http.StatusConflict, "last_workspace", "至少需要保留一个工作空间，无法退出最后一个工作空间")
		return
	default:
		s.fail(w, r, err)
		return
	}

	s.recordAudit(r, wsID, "workspace.member_left", "workspace", wsID, wsName, map[string]any{
		"userId": u.ID,
	})
	w.WriteHeader(http.StatusNoContent)
}
