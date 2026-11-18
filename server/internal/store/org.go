package store

import (
	"context"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	SubjectTypeDepartment = "department"
	SubjectTypeGroup      = "group"
	WorkspaceRoleOwner    = "owner"
	WorkspaceRoleAdmin    = "admin"
	WorkspaceRoleMember   = "member"
)

// WorkspaceMemberInfo describes a member and their workspace-level role.
type WorkspaceMemberInfo struct {
	UserID    int64     `json:"userId"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	Role      string    `json:"role"` // owner | admin | member
	CreatedAt time.Time `json:"createdAt"`
}

// OrgDepartmentMember describes a user's membership inside a department.
type OrgDepartmentMember struct {
	UserID   int64  `json:"userId"`
	Name     string `json:"name"`
	Email    string `json:"email"`
	IsLeader bool   `json:"isLeader"`
}

// OrgDepartment is a hierarchical enterprise department inside a workspace.
type OrgDepartment struct {
	ID          int64                 `json:"id"`
	WorkspaceID int64                 `json:"workspaceId"`
	ParentID    *int64                `json:"parentId"`
	Name        string                `json:"name"`
	SortOrder   int                   `json:"sortOrder"`
	Members     []OrgDepartmentMember `json:"members"`
	CreatedAt   time.Time             `json:"createdAt"`
	UpdatedAt   time.Time             `json:"updatedAt"`
}

// OrgGroupMember describes a user inside an enterprise user group.
type OrgGroupMember struct {
	UserID int64  `json:"userId"`
	Name   string `json:"name"`
	Email  string `json:"email"`
}

// OrgGroup is an explicit user group inside a workspace for batch sharing.
type OrgGroup struct {
	ID          int64            `json:"id"`
	WorkspaceID int64            `json:"workspaceId"`
	Name        string           `json:"name"`
	Description string           `json:"description"`
	Members     []OrgGroupMember `json:"members"`
	CreatedAt   time.Time        `json:"createdAt"`
	UpdatedAt   time.Time        `json:"updatedAt"`
}

// WorkspaceOrgSnapshot is the full organization directory of a workspace.
type WorkspaceOrgSnapshot struct {
	WorkspaceID   int64                 `json:"workspaceId"`
	WorkspaceName string                `json:"workspaceName"`
	CallerRole    string                `json:"callerRole"` // owner | admin | member
	Members       []WorkspaceMemberInfo `json:"members"`
	Departments   []OrgDepartment       `json:"departments"`
	Groups        []OrgGroup            `json:"groups"`
	// Invitations lists pending invitations; only owners/admins see them.
	Invitations []WorkspaceInvitation `json:"invitations"`
}

// WorkspaceInvitation is a pending request for someone to join a workspace.
// Nothing about the invitee's account is exposed to the inviter.
type WorkspaceInvitation struct {
	ID            int64     `json:"id"`
	WorkspaceID   int64     `json:"workspaceId"`
	WorkspaceName string    `json:"workspaceName,omitempty"`
	Email         string    `json:"email"`
	Role          string    `json:"role"` // member | admin
	InviterName   string    `json:"inviterName,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
}

const (
	MemberChangeUpdated = "updated"
	MemberChangeInvited = "invited"
	MemberChangeRemoved = "removed"
)

// maxPendingInvitations bounds how many open invitations one workspace keeps.
const maxPendingInvitations = 200

// WorkspaceMemberChange reports what an admin's member request did. A
// non-member email always yields an invitation, whether or not an account
// exists for it.
type WorkspaceMemberChange struct {
	Status     string               `json:"status"` // updated | invited | removed
	Member     *WorkspaceMemberInfo `json:"member,omitempty"`
	Invitation *WorkspaceInvitation `json:"invitation,omitempty"`
}

// NormalizeInviteEmail trims and lower-cases an email; ok is false when it
// cannot be an address.
func NormalizeInviteEmail(raw string) (string, bool) {
	email := strings.ToLower(strings.TrimSpace(raw))
	at := strings.IndexByte(email, '@')
	n := utf8.RuneCountInString(email)
	return email, n >= 3 && n <= 320 && at > 0 && at < len(email)-1 && !strings.ContainsAny(email, " \t\r\n")
}

// SubjectShare is an explicit department or user-group grant on a node.
type SubjectShare struct {
	SubjectType string `json:"subjectType"` // department | group
	SubjectID   int64  `json:"subjectId"`
	Name        string `json:"name"`
	MemberCount int    `json:"memberCount"`
	Role        string `json:"role"` // view | edit | manage
}

// OrgStore manages enterprise workspace members, departments, user groups,
// subject-based sharing, and node ACL inheritance controls.
type OrgStore interface {
	GetWorkspaceOrg(ctx context.Context, guard RestoreGuard, wsID int64) (WorkspaceOrgSnapshot, error)
	// UpsertWorkspaceMemberGuarded changes an existing member's role, removes
	// a member/invitation ("remove"), or invites a non-member email.
	UpsertWorkspaceMemberGuarded(ctx context.Context, guard RestoreGuard, wsID int64, email, role string) (WorkspaceMemberChange, error)
	RevokeInvitationGuarded(ctx context.Context, guard RestoreGuard, wsID, invitationID int64) error
	// ListMyInvitations returns invitations addressed to the caller's email.
	ListMyInvitations(ctx context.Context, guard RestoreGuard) ([]WorkspaceInvitation, error)
	// RespondInvitationGuarded accepts (joins with the invited role) or
	// declines; either way the invitation is consumed.
	RespondInvitationGuarded(ctx context.Context, guard RestoreGuard, invitationID int64, accept bool) error

	CreateDepartmentGuarded(ctx context.Context, guard RestoreGuard, wsID int64, parentID *int64, name string, sortOrder int) (OrgDepartment, error)
	UpdateDepartmentGuarded(ctx context.Context, guard RestoreGuard, wsID, deptID int64, parentID *int64, moveParent bool, name *string, sortOrder *int) (OrgDepartment, error)
	DeleteDepartmentGuarded(ctx context.Context, guard RestoreGuard, wsID, deptID int64) error
	SetDepartmentMemberGuarded(ctx context.Context, guard RestoreGuard, wsID, deptID, userID int64, present, isLeader bool) error

	CreateUserGroupGuarded(ctx context.Context, guard RestoreGuard, wsID int64, name, description string) (OrgGroup, error)
	UpdateUserGroupGuarded(ctx context.Context, guard RestoreGuard, wsID, groupID int64, name, description *string) (OrgGroup, error)
	DeleteUserGroupGuarded(ctx context.Context, guard RestoreGuard, wsID, groupID int64) error
	SetUserGroupMemberGuarded(ctx context.Context, guard RestoreGuard, wsID, groupID, userID int64, present bool) error

	ListSubjectShares(ctx context.Context, docID int64) ([]SubjectShare, error)
	SetSubjectShareGuarded(ctx context.Context, guard RestoreGuard, docID int64, subjectType string, subjectID int64, role string) error
	SetNodeInheritParentACLGuarded(ctx context.Context, guard RestoreGuard, docID int64, inherit bool) error
}

func cleanOrgName(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	n := utf8.RuneCountInString(trimmed)
	return trimmed, n >= 1 && n <= 120
}

func cleanOrgDescription(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	return trimmed, utf8.RuneCountInString(trimmed) <= 500
}

func validSubjectType(t string) bool {
	return t == SubjectTypeDepartment || t == SubjectTypeGroup
}

func isWorkspaceAdminRole(role string) bool {
	return role == WorkspaceRoleOwner || role == WorkspaceRoleAdmin
}
