package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) parsePositivePathID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", name+" must be a positive integer")
		return 0, false
	}
	return id, true
}

func (s *Server) orgError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "没有组织管理权限")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "组织对象或成员不存在")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "org_conflict", "参数无效或组织结构存在冲突")
	default:
		s.fail(w, r, err)
	}
}

func (s *Server) getWorkspaceOrg(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	snap, err := s.Store.GetWorkspaceOrg(r.Context(), guard, wsID)
	if err != nil {
		s.orgError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, snap)
}

func (s *Server) upsertWorkspaceMember(w http.ResponseWriter, r *http.Request) {
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	email, valid := store.NormalizeInviteEmail(in.Email)
	if !valid || (in.Role != store.WorkspaceRoleMember && in.Role != store.WorkspaceRoleAdmin && in.Role != "remove") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "请填写有效邮箱和成员角色")
		return
	}
	change, err := s.Store.UpsertWorkspaceMemberGuarded(r.Context(), guard, wsID, email, in.Role)
	if err != nil {
		if errors.Is(err, store.ErrConflict) && in.Role != "remove" {
			httpx.Error(w, http.StatusConflict, "invitation_limit", "待接受的邀请过多，请先撤销部分邀请")
			return
		}
		s.orgError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, change)
}

func (s *Server) revokeWorkspaceInvitation(w http.ResponseWriter, r *http.Request) {
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	inviteID, ok := s.parsePositivePathID(w, r, "inviteId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	if err := s.Store.RevokeInvitationGuarded(r.Context(), guard, wsID, inviteID); err != nil {
		s.orgError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listMyInvitations(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	invites, err := s.Store.ListMyInvitations(r.Context(), guard)
	if err != nil {
		s.orgError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"invitations": invites})
}

func (s *Server) respondInvitation(accept bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		inviteID, ok := s.parsePositivePathID(w, r, "inviteId")
		if !ok {
			return
		}
		guard, ok := s.driveGuard(w, r)
		if !ok {
			return
		}
		if !driveExpectedUser(w, r, guard.UserID) {
			return
		}
		if err := s.Store.RespondInvitationGuarded(r.Context(), guard, inviteID, accept); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				httpx.Error(w, http.StatusNotFound, "not_found", "邀请不存在或已失效")
				return
			}
			s.orgError(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func (s *Server) createDepartment(w http.ResponseWriter, r *http.Request) {
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		ParentID  *int64 `json:"parentId"`
		Name      string `json:"name"`
		SortOrder int    `json:"sortOrder"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_name", "部门名称不能为空")
		return
	}
	dept, err := s.Store.CreateDepartmentGuarded(r.Context(), guard, wsID, in.ParentID, in.Name, in.SortOrder)
	if err != nil {
		s.orgError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, dept)
}

func (s *Server) updateDepartment(w http.ResponseWriter, r *http.Request) {
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	deptID, ok := s.parsePositivePathID(w, r, "deptId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		ParentID  json.RawMessage `json:"parentId"`
		Name      *string         `json:"name"`
		SortOrder *int            `json:"sortOrder"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	var parentID *int64
	moveParent := false
	if in.ParentID != nil {
		moveParent = true
		if string(in.ParentID) != "null" {
			var pid int64
			if err := json.Unmarshal(in.ParentID, &pid); err != nil || pid <= 0 {
				httpx.Error(w, http.StatusBadRequest, "invalid_parent", "上级部门无效")
				return
			}
			parentID = &pid
		}
	}
	if in.Name != nil && strings.TrimSpace(*in.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_name", "部门名称不能为空")
		return
	}
	dept, err := s.Store.UpdateDepartmentGuarded(r.Context(), guard, wsID, deptID, parentID, moveParent, in.Name, in.SortOrder)
	if err != nil {
		s.orgError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, dept)
}

func (s *Server) deleteDepartment(w http.ResponseWriter, r *http.Request) {
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	deptID, ok := s.parsePositivePathID(w, r, "deptId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	if err := s.Store.DeleteDepartmentGuarded(r.Context(), guard, wsID, deptID); err != nil {
		s.orgError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) setDepartmentMember(w http.ResponseWriter, r *http.Request) {
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	deptID, ok := s.parsePositivePathID(w, r, "deptId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		UserID   int64 `json:"userId"`
		Present  bool  `json:"present"`
		IsLeader bool  `json:"isLeader"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.UserID <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_user", "成员 ID 无效")
		return
	}
	if err := s.Store.SetDepartmentMemberGuarded(r.Context(), guard, wsID, deptID, in.UserID, in.Present, in.IsLeader); err != nil {
		s.orgError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) createUserGroup(w http.ResponseWriter, r *http.Request) {
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_name", "用户组名称不能为空")
		return
	}
	group, err := s.Store.CreateUserGroupGuarded(r.Context(), guard, wsID, in.Name, in.Description)
	if err != nil {
		s.orgError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, group)
}

func (s *Server) updateUserGroup(w http.ResponseWriter, r *http.Request) {
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	groupID, ok := s.parsePositivePathID(w, r, "groupId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Name != nil && strings.TrimSpace(*in.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_name", "用户组名称不能为空")
		return
	}
	group, err := s.Store.UpdateUserGroupGuarded(r.Context(), guard, wsID, groupID, in.Name, in.Description)
	if err != nil {
		s.orgError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, group)
}

func (s *Server) deleteUserGroup(w http.ResponseWriter, r *http.Request) {
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	groupID, ok := s.parsePositivePathID(w, r, "groupId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	if err := s.Store.DeleteUserGroupGuarded(r.Context(), guard, wsID, groupID); err != nil {
		s.orgError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) setUserGroupMember(w http.ResponseWriter, r *http.Request) {
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	groupID, ok := s.parsePositivePathID(w, r, "groupId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		UserID  int64 `json:"userId"`
		Present bool  `json:"present"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.UserID <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_user", "成员 ID 无效")
		return
	}
	if err := s.Store.SetUserGroupMemberGuarded(r.Context(), guard, wsID, groupID, in.UserID, in.Present); err != nil {
		s.orgError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) putSubjectShare(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleManage)
	if !ok {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		SubjectType string `json:"subjectType"`
		SubjectID   int64  `json:"subjectId"`
		Role        string `json:"role"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if (in.SubjectType != store.SubjectTypeDepartment && in.SubjectType != store.SubjectTypeGroup) ||
		in.SubjectID <= 0 || (in.Role != "" && store.RoleRank(in.Role) == 0) {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "无效的部门或用户组权限参数")
		return
	}
	// 外部管理者不能借授权接口枚举空间的部门/用户组
	if member, err := s.Store.CanCreateIn(r.Context(), guard.UserID, d.WorkspaceID); err != nil {
		s.fail(w, r, err)
		return
	} else if !member {
		httpx.Error(w, http.StatusForbidden, "forbidden", "仅空间成员可按部门或用户组授权")
		return
	}
	if err := s.Store.SetSubjectShareGuarded(r.Context(), guard, d.ID, in.SubjectType, in.SubjectID, in.Role); err != nil {
		s.shareMutationError(w, r, err)
		return
	}
	s.shareResultAfterMutation(w, r, guard, d.ID)
}

func (s *Server) putInheritance(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleManage)
	if !ok {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		InheritParentACL *bool `json:"inheritParentAcl"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.InheritParentACL == nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "inheritParentAcl is required")
		return
	}
	if err := s.Store.SetNodeInheritParentACLGuarded(r.Context(), guard, d.ID, *in.InheritParentACL); err != nil {
		s.shareMutationError(w, r, err)
		return
	}
	s.shareResultAfterMutation(w, r, guard, d.ID)
}
