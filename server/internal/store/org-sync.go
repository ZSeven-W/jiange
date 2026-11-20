package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	OrgSyncProviderSCIM     = "scim"
	OrgSyncProviderLDAP     = "ldap"
	OrgSyncProviderWeCom    = "wecom"
	OrgSyncProviderDingTalk = "dingtalk"
	OrgSyncProviderCustom   = "custom"

	OrgSyncTriggerManual = "manual"
	OrgSyncTriggerPush   = "push"
	OrgSyncTriggerSCIM   = "scim"

	maxSyncDepartments = 500
	maxSyncGroups      = 500
	maxSyncMembers     = 5000
	maxSyncDeptDepth   = 32
)

// OrgSyncSource configures an external directory connector (SCIM, LDAP, WeCom,
// DingTalk, or custom webhook) for a workspace.
type OrgSyncSource struct {
	ID                int64      `json:"id"`
	WorkspaceID       int64      `json:"workspaceId"`
	Name              string     `json:"name"`
	Provider          string     `json:"provider"`
	Enabled           bool       `json:"enabled"`
	TokenPrefix       string     `json:"tokenPrefix"`
	AutoInviteMissing bool       `json:"autoInviteMissing"`
	PruneMissing      bool       `json:"pruneMissing"`
	LastSyncAt        *time.Time `json:"lastSyncAt,omitempty"`
	LastStatus        string     `json:"lastStatus"`
	LastSummary       string     `json:"lastSummary"`
	CreatedBy         int64      `json:"createdBy"`
	CreatedAt         time.Time  `json:"createdAt"`
	UpdatedAt         time.Time  `json:"updatedAt"`
}

// OrgSyncSourceCreated returns the source plus the one-time raw Bearer token
// when creating a source or rotating its token.
type OrgSyncSourceCreated struct {
	Source OrgSyncSource `json:"source"`
	Token  string        `json:"token,omitempty"`
}

// OrgSyncSourcePatch mutates an existing sync source.
type OrgSyncSourcePatch struct {
	Name              *string
	Enabled           *bool
	AutoInviteMissing *bool
	PruneMissing      *bool
	RotateToken       bool
}

// OrgSyncDeptInput is one department node in an external directory payload.
type OrgSyncDeptInput struct {
	ExternalID       string `json:"externalId"`
	ParentExternalID string `json:"parentExternalId,omitempty"`
	Name             string `json:"name"`
	SortOrder        int    `json:"sortOrder,omitempty"`
}

// OrgSyncGroupInput is one user group in an external directory payload.
type OrgSyncGroupInput struct {
	ExternalID  string `json:"externalId"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// OrgSyncMemberInput binds an email to workspace role, departments, and groups.
type OrgSyncMemberInput struct {
	Email                       string   `json:"email"`
	Name                        string   `json:"name,omitempty"`
	Role                        string   `json:"role,omitempty"` // "" | member | admin
	DepartmentExternalIDs       []string `json:"departmentExternalIds,omitempty"`
	LeaderDepartmentExternalIDs []string `json:"leaderDepartmentExternalIds,omitempty"`
	GroupExternalIDs            []string `json:"groupExternalIds,omitempty"`
}

// OrgDirectorySyncPayload is an idempotent external directory snapshot.
type OrgDirectorySyncPayload struct {
	Departments  []OrgSyncDeptInput   `json:"departments"`
	Groups       []OrgSyncGroupInput  `json:"groups"`
	Members      []OrgSyncMemberInput `json:"members"`
	DryRun       bool                 `json:"dryRun,omitempty"`
	PruneMissing *bool                `json:"pruneMissing,omitempty"`
}

// OrgSyncRun is an audit record of one directory sync execution or dry-run.
type OrgSyncRun struct {
	ID                 int64     `json:"id"`
	WorkspaceID        int64     `json:"workspaceId"`
	SourceID           int64     `json:"sourceId"`
	SourceName         string    `json:"sourceName,omitempty"`
	ActorUserID        *int64    `json:"actorUserId,omitempty"`
	TriggerMode        string    `json:"triggerMode"` // manual | push | scim
	DryRun             bool      `json:"dryRun"`
	Status             string    `json:"status"` // ok | failed
	DepartmentsCreated int       `json:"departmentsCreated"`
	DepartmentsUpdated int       `json:"departmentsUpdated"`
	DepartmentsRemoved int       `json:"departmentsRemoved"`
	GroupsCreated      int       `json:"groupsCreated"`
	GroupsUpdated      int       `json:"groupsUpdated"`
	GroupsRemoved      int       `json:"groupsRemoved"`
	MembersLinked      int       `json:"membersLinked"`
	MembersInvited     int       `json:"membersInvited"`
	MembershipsUpdated int       `json:"membershipsUpdated"`
	ErrorMessage       string    `json:"errorMessage,omitempty"`
	Warnings           []string  `json:"warnings,omitempty"`
	CreatedAt          time.Time `json:"createdAt"`
}

// OrgSyncStore manages external directory connectors and transactional sync runs.
type OrgSyncStore interface {
	ListOrgSyncState(ctx context.Context, guard RestoreGuard, wsID int64) ([]OrgSyncSource, []OrgSyncRun, error)
	CreateOrgSyncSourceGuarded(ctx context.Context, guard RestoreGuard, wsID int64, name, provider string, autoInviteMissing, pruneMissing bool) (OrgSyncSourceCreated, error)
	UpdateOrgSyncSourceGuarded(ctx context.Context, guard RestoreGuard, wsID, sourceID int64, patch OrgSyncSourcePatch) (OrgSyncSourceCreated, error)
	DeleteOrgSyncSourceGuarded(ctx context.Context, guard RestoreGuard, wsID, sourceID int64) error
	RunOrgDirectorySyncGuarded(ctx context.Context, guard RestoreGuard, wsID, sourceID int64, payload OrgDirectorySyncPayload) (OrgSyncRun, error)
	PushOrgDirectorySyncByToken(ctx context.Context, tokenHash, triggerMode string, payload OrgDirectorySyncPayload) (OrgSyncRun, error)
}

func ValidOrgSyncProvider(p string) bool {
	switch p {
	case OrgSyncProviderSCIM, OrgSyncProviderLDAP, OrgSyncProviderWeCom, OrgSyncProviderDingTalk, OrgSyncProviderCustom:
		return true
	default:
		return false
	}
}

// HashOrgSyncToken hashes a raw Bearer token with SHA-256 hex for storage lookup.
func HashOrgSyncToken(raw string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(raw)))
	return hex.EncodeToString(sum[:])
}

// GenerateOrgSyncToken creates a cryptographically random connector token.
func GenerateOrgSyncToken() (raw, prefix, hash string, err error) {
	buf := make([]byte, 24)
	if _, err = rand.Read(buf); err != nil {
		return "", "", "", err
	}
	raw = "jg_sync_" + hex.EncodeToString(buf)
	prefix = raw[:16] + "…"
	hash = HashOrgSyncToken(raw)
	return raw, prefix, hash, nil
}

func cleanExternalID(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	n := utf8.RuneCountInString(trimmed)
	return trimmed, n >= 1 && n <= 120 && !strings.ContainsAny(trimmed, "\r\n\t")
}

type validatedOrgSyncPayload struct {
	departments []OrgSyncDeptInput
	groups      []OrgSyncGroupInput
	members     []OrgSyncMemberInput
	deptSet     map[string]bool
	groupSet    map[string]bool
}

// validateAndSortOrgSyncPayload validates limits, identifiers, emails, and
// department DAG topology (parents before children, no cycles).
func validateAndSortOrgSyncPayload(in OrgDirectorySyncPayload) (validatedOrgSyncPayload, string, error) {
	if len(in.Departments) > maxSyncDepartments {
		return validatedOrgSyncPayload{}, "单次最多同步 500 个部门", ErrConflict
	}
	if len(in.Groups) > maxSyncGroups {
		return validatedOrgSyncPayload{}, "单次最多同步 500 个用户组", ErrConflict
	}
	if len(in.Members) > maxSyncMembers {
		return validatedOrgSyncPayload{}, "单次最多同步 5000 名成员", ErrConflict
	}

	deptMap := make(map[string]OrgSyncDeptInput, len(in.Departments))
	deptOrder := make([]string, 0, len(in.Departments))
	for _, d := range in.Departments {
		extID, ok := cleanExternalID(d.ExternalID)
		if !ok {
			return validatedOrgSyncPayload{}, "部门 externalId 不能为空且不超过 120 字", ErrConflict
		}
		if _, dup := deptMap[extID]; dup {
			return validatedOrgSyncPayload{}, fmt.Sprintf("部门 externalId 重复：%s", extID), ErrConflict
		}
		name, ok := cleanOrgName(d.Name)
		if !ok {
			return validatedOrgSyncPayload{}, fmt.Sprintf("部门 %s 名称无效", extID), ErrConflict
		}
		parentExt := strings.TrimSpace(d.ParentExternalID)
		if parentExt == extID {
			return validatedOrgSyncPayload{}, fmt.Sprintf("部门 %s 不能将自身设为上级", extID), ErrConflict
		}
		d.ExternalID = extID
		d.ParentExternalID = parentExt
		d.Name = name
		deptMap[extID] = d
		deptOrder = append(deptOrder, extID)
	}

	// Verify parent references and topological order (cycle + depth guard).
	for _, id := range deptOrder {
		d := deptMap[id]
		if d.ParentExternalID != "" {
			if _, ok := deptMap[d.ParentExternalID]; !ok {
				return validatedOrgSyncPayload{}, fmt.Sprintf("部门 %s 的上级部门 %s 不存在", id, d.ParentExternalID), ErrConflict
			}
		}
	}
	state := make(map[string]int, len(deptOrder)) // 0=unvisited, 1=visiting, 2=done
	sortedDepts := make([]OrgSyncDeptInput, 0, len(deptOrder))
	var visit func(id string, depth int) (string, error)
	visit = func(id string, depth int) (string, error) {
		if depth > maxSyncDeptDepth {
			return "部门层级过深（超过 32 层）", ErrConflict
		}
		switch state[id] {
		case 1:
			return fmt.Sprintf("部门层级存在循环引用：%s", id), ErrConflict
		case 2:
			return "", nil
		}
		state[id] = 1
		d := deptMap[id]
		if d.ParentExternalID != "" {
			if msg, err := visit(d.ParentExternalID, depth+1); err != nil {
				return msg, err
			}
		}
		state[id] = 2
		sortedDepts = append(sortedDepts, d)
		return "", nil
	}
	for _, id := range deptOrder {
		if msg, err := visit(id, 0); err != nil {
			return validatedOrgSyncPayload{}, msg, err
		}
	}

	deptSet := make(map[string]bool, len(sortedDepts))
	for _, d := range sortedDepts {
		deptSet[d.ExternalID] = true
	}

	groupSet := make(map[string]bool, len(in.Groups))
	groups := make([]OrgSyncGroupInput, 0, len(in.Groups))
	for _, g := range in.Groups {
		extID, ok := cleanExternalID(g.ExternalID)
		if !ok {
			return validatedOrgSyncPayload{}, "用户组 externalId 不能为空且不超过 120 字", ErrConflict
		}
		if groupSet[extID] {
			return validatedOrgSyncPayload{}, fmt.Sprintf("用户组 externalId 重复：%s", extID), ErrConflict
		}
		name, ok := cleanOrgName(g.Name)
		if !ok {
			return validatedOrgSyncPayload{}, fmt.Sprintf("用户组 %s 名称无效", extID), ErrConflict
		}
		desc, ok := cleanOrgDescription(g.Description)
		if !ok {
			return validatedOrgSyncPayload{}, fmt.Sprintf("用户组 %s 说明过长", extID), ErrConflict
		}
		groupSet[extID] = true
		groups = append(groups, OrgSyncGroupInput{ExternalID: extID, Name: name, Description: desc})
	}

	memberByEmail := make(map[string]OrgSyncMemberInput, len(in.Members))
	memberOrder := make([]string, 0, len(in.Members))
	for _, mem := range in.Members {
		email, ok := NormalizeInviteEmail(mem.Email)
		if !ok {
			return validatedOrgSyncPayload{}, fmt.Sprintf("成员邮箱无效：%s", mem.Email), ErrConflict
		}
		role := strings.TrimSpace(strings.ToLower(mem.Role))
		if role != "" && role != WorkspaceRoleMember && role != WorkspaceRoleAdmin {
			return validatedOrgSyncPayload{}, fmt.Sprintf("成员 %s 角色无效（仅支持 member/admin）", email), ErrConflict
		}
		depts := dedupeStrings(mem.DepartmentExternalIDs)
		leaders := dedupeStrings(mem.LeaderDepartmentExternalIDs)
		for _, lid := range leaders {
			if !containsString(depts, lid) {
				depts = append(depts, lid)
			}
		}
		for _, did := range depts {
			if !deptSet[did] {
				return validatedOrgSyncPayload{}, fmt.Sprintf("成员 %s 引用的部门 %s 不存在", email, did), ErrConflict
			}
		}
		gids := dedupeStrings(mem.GroupExternalIDs)
		for _, gid := range gids {
			if !groupSet[gid] {
				return validatedOrgSyncPayload{}, fmt.Sprintf("成员 %s 引用的用户组 %s 不存在", email, gid), ErrConflict
			}
		}
		cleaned := OrgSyncMemberInput{
			Email:                       email,
			Name:                        strings.TrimSpace(mem.Name),
			Role:                        role,
			DepartmentExternalIDs:       depts,
			LeaderDepartmentExternalIDs: leaders,
			GroupExternalIDs:            gids,
		}
		if _, exists := memberByEmail[email]; !exists {
			memberOrder = append(memberOrder, email)
		}
		memberByEmail[email] = cleaned
	}
	members := make([]OrgSyncMemberInput, 0, len(memberOrder))
	for _, email := range memberOrder {
		members = append(members, memberByEmail[email])
	}

	return validatedOrgSyncPayload{
		departments: sortedDepts,
		groups:      groups,
		members:     members,
		deptSet:     deptSet,
		groupSet:    groupSet,
	}, "", nil
}

func dedupeStrings(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		trimmed := strings.TrimSpace(s)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	return out
}

func containsString(list []string, target string) bool {
	for _, s := range list {
		if s == target {
			return true
		}
	}
	return false
}

func orgSyncRunSummary(run OrgSyncRun) string {
	prefix := ""
	if run.DryRun {
		prefix = "[预演] "
	}
	return fmt.Sprintf("%s部门 +%d/~%d/-%d，用户组 +%d/~%d/-%d，成员匹配 %d / 待邀 %d，归属更新 %d",
		prefix,
		run.DepartmentsCreated, run.DepartmentsUpdated, run.DepartmentsRemoved,
		run.GroupsCreated, run.GroupsUpdated, run.GroupsRemoved,
		run.MembersLinked, run.MembersInvited, run.MembershipsUpdated,
	)
}
