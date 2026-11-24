package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type crossSpaceMoveRequest struct {
	TargetWorkspaceID int64  `json:"targetWorkspaceId"`
	TargetParentID    *int64 `json:"targetParentId"`
	TargetPersonal    bool   `json:"targetPersonal"`
	Expected          int64  `json:"expected"`
}

// postDriveCrossSpaceMove handles POST /api/drive/cross-space-move/{id}.
// Explicitly moves a drive node (and its descendant subtree) between personal/shared
// scopes or across workspaces where the actor is a valid member.
func (s *Server) postDriveCrossSpaceMove(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, u.ID) {
		return
	}
	if cur, err := s.Store.SessionUser(r.Context(), g.SessionHash, s.now()); errors.Is(err, store.ErrNotFound) || (err == nil && cur.ID != u.ID) {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "会话已过期，请重新登录")
		return
	} else if err != nil {
		s.fail(w, r, err)
		return
	}

	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "node id required")
		return
	}
	var in crossSpaceMoveRequest
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.TargetWorkspaceID < 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_workspace", "目标空间无效")
		return
	}
	if in.TargetParentID != nil && *in.TargetParentID <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_parent", "目标目录无效")
		return
	}

	cs, ok := s.Store.(store.CrossSpaceMoveStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "cross_space_move_unavailable", "当前存储不支持跨空间移动")
		return
	}

	// Capture source workspace before mutation for audit detail.
	var sourceWS int64
	if before, beforeErr := s.Store.GetDocSystem(r.Context(), id); beforeErr == nil {
		sourceWS = before.WorkspaceID
	}

	entry, err := cs.CrossSpaceMoveNode(
		r.Context(),
		u.ID,
		id,
		in.TargetWorkspaceID,
		in.TargetParentID,
		in.TargetPersonal,
		in.Expected,
	)
	if driveWriteErr(w, err, "cross-space-move") {
		return
	}

	detail := map[string]any{
		"sourceWorkspaceId": sourceWS,
		"targetWorkspaceId": entry.WorkspaceID,
		"targetParentId":    entry.ParentID,
		"targetPersonal":    entry.Personal,
		"revision":          entry.Revision,
	}
	s.recordAudit(r, entry.WorkspaceID, "drive.cross_space_move", entry.Kind, entry.ID, entry.Title, detail)
	if sourceWS > 0 && sourceWS != entry.WorkspaceID {
		s.recordAudit(r, sourceWS, "drive.cross_space_move", entry.Kind, entry.ID, entry.Title, detail)
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"entry": entry})
}
