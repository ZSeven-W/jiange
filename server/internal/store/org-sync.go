package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const (
	OrgSyncProviderSCIM     = "scim"
	OrgSyncProviderLDAP     = "ldap"
	OrgSyncProviderWeCom    = "wecom"
	OrgSyncProviderDingTalk = "dingtalk"
	OrgSyncProviderCustom   = "custom"

	OrgSyncTriggerManual    = "manual"
	OrgSyncTriggerPush      = "push"
	OrgSyncTriggerSCIM      = "scim"
	OrgSyncTriggerPull      = "pull"
	OrgSyncTriggerScheduled = "scheduled"

	maxSyncDepartments     = 500
	maxSyncGroups          = 500
	maxSyncMembers         = 5000
	maxSyncDeptDepth       = 32
	maxSyncIntervalMinutes = 10080
)

// OrgSyncSource configures an external directory connector (SCIM, LDAP, WeCom,
// DingTalk, or custom webhook) for a workspace.
type OrgSyncSource struct {
	ID                  int64      `json:"id"`
	WorkspaceID         int64      `json:"workspaceId"`
	Name                string     `json:"name"`
	Provider            string     `json:"provider"`
	Enabled             bool       `json:"enabled"`
	TokenPrefix         string     `json:"tokenPrefix"`
	AutoInviteMissing   bool       `json:"autoInviteMissing"`
	PruneMissing        bool       `json:"pruneMissing"`
	EndpointURL         string     `json:"endpointUrl"`
	ConnectorConfigEnc  []byte     `json:"-"`
	ConnectorConfigHint string     `json:"connectorConfigHint"`
	HasConnectorConfig  bool       `json:"hasConnectorConfig"`
	SyncIntervalMinutes int        `json:"syncIntervalMinutes"`
	LastAutoSyncAt      *time.Time `json:"lastAutoSyncAt,omitempty"`
	LastSyncAt          *time.Time `json:"lastSyncAt,omitempty"`
	LastStatus          string     `json:"lastStatus"`
	LastSummary         string     `json:"lastSummary"`
	CreatedBy           int64      `json:"createdBy"`
	CreatedAt           time.Time  `json:"createdAt"`
	UpdatedAt           time.Time  `json:"updatedAt"`
}

// OrgSyncConnectorPatch holds optional updates for an active pull connector.
type OrgSyncConnectorPatch struct {
	EndpointURL         *string
	ConnectorConfigEnc  []byte
	ConnectorConfigHint string
	SyncIntervalMinutes *int
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
	TriggerMode        string    `json:"triggerMode"` // manual | push | scim | pull | scheduled
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

// OrgSyncConnectorStore extends OrgSyncStore with active directory pull connector
// persistence, scheduled sync lookups, and mode-aware sync execution.
type OrgSyncConnectorStore interface {
	UpdateOrgSyncConnector(ctx context.Context, guard RestoreGuard, wsID, sourceID int64, endpointURL string, configEnc []byte, configHint string, intervalMinutes int) (OrgSyncSource, error)
	GetOrgSyncSourceSystem(ctx context.Context, sourceID int64) (OrgSyncSource, error)
	ListDueScheduledOrgSyncSources(ctx context.Context, now time.Time) ([]OrgSyncSource, error)
	MarkOrgSyncAutoSyncAt(ctx context.Context, sourceID int64, at time.Time) error
	RunOrgDirectorySyncWithModeGuarded(ctx context.Context, guard RestoreGuard, wsID, sourceID int64, triggerMode string, payload OrgDirectorySyncPayload) (OrgSyncRun, error)
	RunOrgDirectorySyncSystem(ctx context.Context, sourceID int64, triggerMode string, payload OrgDirectorySyncPayload) (OrgSyncRun, error)
	EnrichOrgSyncSources(ctx context.Context, wsID int64, sources []OrgSyncSource) ([]OrgSyncSource, error)
}

// OrgSyncStore manages external directory connectors and transactional sync runs.
type OrgSyncStore interface {
	ListOrgSyncState(ctx context.Context, guard RestoreGuard, wsID int64) ([]OrgSyncSource, []OrgSyncRun, error)
	CreateOrgSyncSourceGuarded(ctx context.Context, guard RestoreGuard, wsID int64, name, provider string, autoInviteMissing, pruneMissing bool) (OrgSyncSourceCreated, error)
	UpdateOrgSyncSourceGuarded(ctx context.Context, guard RestoreGuard, wsID, sourceID int64, patch OrgSyncSourcePatch) (OrgSyncSourceCreated, error)
	DeleteOrgSyncSourceGuarded(ctx context.Context, guard RestoreGuard, wsID, sourceID int64) error
	RunOrgDirectorySyncGuarded(ctx context.Context, guard RestoreGuard, wsID, sourceID int64, payload OrgDirectorySyncPayload) (OrgSyncRun, error)
	PushOrgDirectorySyncByToken(ctx context.Context, tokenHash, triggerMode string, payload OrgDirectorySyncPayload) (OrgSyncRun, error)
	OrgSyncConnectorStore
}

var (
	_ OrgSyncConnectorStore = (*Memory)(nil)
	_ OrgSyncConnectorStore = (*Postgres)(nil)
)

func ValidOrgSyncProvider(p string) bool {
	switch p {
	case OrgSyncProviderSCIM, OrgSyncProviderLDAP, OrgSyncProviderWeCom, OrgSyncProviderDingTalk, OrgSyncProviderCustom:
		return true
	default:
		return false
	}
}

func IsPullOrgSyncProvider(p string) bool {
	switch p {
	case OrgSyncProviderLDAP, OrgSyncProviderWeCom, OrgSyncProviderDingTalk:
		return true
	default:
		return false
	}
}

func ValidOrgSyncTriggerMode(mode string) bool {
	switch mode {
	case OrgSyncTriggerManual, OrgSyncTriggerPush, OrgSyncTriggerSCIM, OrgSyncTriggerPull, OrgSyncTriggerScheduled:
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

func cloneOrgSyncSource(src OrgSyncSource) OrgSyncSource {
	cp := src
	if len(src.ConnectorConfigEnc) > 0 {
		cp.ConnectorConfigEnc = append([]byte(nil), src.ConnectorConfigEnc...)
	} else {
		cp.ConnectorConfigEnc = nil
	}
	cp.HasConnectorConfig = len(cp.ConnectorConfigEnc) > 0
	if src.LastSyncAt != nil {
		t := *src.LastSyncAt
		cp.LastSyncAt = &t
	}
	if src.LastAutoSyncAt != nil {
		t := *src.LastAutoSyncAt
		cp.LastAutoSyncAt = &t
	}
	return cp
}

func validateOrgSyncConnectorArgs(endpointURL, configHint string, intervalMinutes int) (string, string, error) {
	endpointURL = strings.TrimSpace(endpointURL)
	configHint = strings.TrimSpace(configHint)
	if len(endpointURL) > 1024 || len(configHint) > 256 {
		return "", "", ErrConflict
	}
	if intervalMinutes < 0 || intervalMinutes > maxSyncIntervalMinutes {
		return "", "", ErrConflict
	}
	return endpointURL, configHint, nil
}

// --- Memory OrgSyncConnectorStore implementation ---

func (m *Memory) UpdateOrgSyncConnector(ctx context.Context, guard RestoreGuard, wsID, sourceID int64, endpointURL string, configEnc []byte, configHint string, intervalMinutes int) (OrgSyncSource, error) {
	endpointURL, configHint, err := validateOrgSyncConnectorArgs(endpointURL, configHint, intervalMinutes)
	if err != nil {
		return OrgSyncSource{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.orgSyncAdminLocked(ctx, guard, wsID)
	if err != nil {
		return OrgSyncSource{}, err
	}
	src, ok := m.org.syncSources[sourceID]
	if !ok || src.WorkspaceID != wsID {
		return OrgSyncSource{}, ErrNotFound
	}
	src.EndpointURL = endpointURL
	if configEnc != nil {
		if len(configEnc) == 0 {
			src.ConnectorConfigEnc = nil
			src.ConnectorConfigHint = ""
		} else {
			src.ConnectorConfigEnc = append([]byte(nil), configEnc...)
			src.ConnectorConfigHint = configHint
		}
	}
	src.HasConnectorConfig = len(src.ConnectorConfigEnc) > 0
	src.SyncIntervalMinutes = intervalMinutes
	src.UpdatedAt = time.Now().UTC()
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return OrgSyncSource{}, err
	}
	m.org.syncSources[src.ID] = src
	return cloneOrgSyncSource(src), nil
}

func (m *Memory) GetOrgSyncSourceSystem(_ context.Context, sourceID int64) (OrgSyncSource, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	src, ok := m.org.syncSources[sourceID]
	if !ok {
		return OrgSyncSource{}, ErrNotFound
	}
	return cloneOrgSyncSource(src), nil
}

func (m *Memory) ListDueScheduledOrgSyncSources(_ context.Context, now time.Time) ([]OrgSyncSource, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	due := make([]OrgSyncSource, 0)
	for _, s := range m.org.syncSources {
		if !s.Enabled || s.SyncIntervalMinutes <= 0 || !IsPullOrgSyncProvider(s.Provider) || len(s.ConnectorConfigEnc) == 0 {
			continue
		}
		if s.LastAutoSyncAt != nil {
			nextDue := s.LastAutoSyncAt.Add(time.Duration(s.SyncIntervalMinutes) * time.Minute)
			if nextDue.After(now) {
				continue
			}
		}
		due = append(due, cloneOrgSyncSource(s))
	}
	sort.Slice(due, func(i, j int) bool {
		a, b := due[i].LastAutoSyncAt, due[j].LastAutoSyncAt
		if a == nil && b != nil {
			return true
		}
		if a != nil && b == nil {
			return false
		}
		if a != nil && b != nil && !a.Equal(*b) {
			return a.Before(*b)
		}
		return due[i].ID < due[j].ID
	})
	return due, nil
}

func (m *Memory) MarkOrgSyncAutoSyncAt(_ context.Context, sourceID int64, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	src, ok := m.org.syncSources[sourceID]
	if !ok {
		return ErrNotFound
	}
	t := at.UTC()
	src.LastAutoSyncAt = &t
	src.UpdatedAt = time.Now().UTC()
	m.org.syncSources[sourceID] = src
	return nil
}

func (m *Memory) RunOrgDirectorySyncWithModeGuarded(ctx context.Context, guard RestoreGuard, wsID, sourceID int64, triggerMode string, payload OrgDirectorySyncPayload) (OrgSyncRun, error) {
	if triggerMode == "" {
		triggerMode = OrgSyncTriggerManual
	}
	if !ValidOrgSyncTriggerMode(triggerMode) {
		return OrgSyncRun{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.orgSyncAdminLocked(ctx, guard, wsID)
	if err != nil {
		return OrgSyncRun{}, err
	}
	src, ok := m.org.syncSources[sourceID]
	if !ok || src.WorkspaceID != wsID {
		return OrgSyncRun{}, ErrNotFound
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return OrgSyncRun{}, err
	}
	actor := guard.UserID
	return m.applyOrgSyncLocked(src, &actor, triggerMode, payload)
}

func (m *Memory) RunOrgDirectorySyncSystem(_ context.Context, sourceID int64, triggerMode string, payload OrgDirectorySyncPayload) (OrgSyncRun, error) {
	if triggerMode == "" {
		triggerMode = OrgSyncTriggerScheduled
	}
	if !ValidOrgSyncTriggerMode(triggerMode) {
		return OrgSyncRun{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	src, ok := m.org.syncSources[sourceID]
	if !ok {
		return OrgSyncRun{}, ErrNotFound
	}
	if !src.Enabled {
		return OrgSyncRun{}, ErrForbidden
	}
	return m.applyOrgSyncLocked(src, nil, triggerMode, payload)
}

func (m *Memory) EnrichOrgSyncSources(_ context.Context, wsID int64, sources []OrgSyncSource) ([]OrgSyncSource, error) {
	if len(sources) == 0 {
		return sources, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]OrgSyncSource, len(sources))
	for i, s := range sources {
		if full, ok := m.org.syncSources[s.ID]; ok && full.WorkspaceID == wsID {
			s.EndpointURL = full.EndpointURL
			s.ConnectorConfigHint = full.ConnectorConfigHint
			s.HasConnectorConfig = len(full.ConnectorConfigEnc) > 0
			s.SyncIntervalMinutes = full.SyncIntervalMinutes
			if full.LastAutoSyncAt != nil {
				t := *full.LastAutoSyncAt
				s.LastAutoSyncAt = &t
			} else {
				s.LastAutoSyncAt = nil
			}
		} else {
			s.HasConnectorConfig = len(s.ConnectorConfigEnc) > 0
		}
		out[i] = s
	}
	return out, nil
}

// --- Postgres OrgSyncConnectorStore implementation ---

const orgSyncSourceFullColumns = `id, workspace_id, name, provider, enabled, token_prefix,
	auto_invite_missing, prune_missing,
	endpoint_url, connector_config_enc, connector_config_hint, sync_interval_minutes, last_auto_sync_at,
	last_sync_at, last_status, last_summary,
	created_by, created_at, updated_at`

func scanOrgSyncSourceFull(row pgx.Row) (s OrgSyncSource, err error) {
	err = row.Scan(
		&s.ID, &s.WorkspaceID, &s.Name, &s.Provider, &s.Enabled, &s.TokenPrefix,
		&s.AutoInviteMissing, &s.PruneMissing,
		&s.EndpointURL, &s.ConnectorConfigEnc, &s.ConnectorConfigHint, &s.SyncIntervalMinutes, &s.LastAutoSyncAt,
		&s.LastSyncAt, &s.LastStatus, &s.LastSummary,
		&s.CreatedBy, &s.CreatedAt, &s.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return s, ErrNotFound
	}
	if err == nil {
		s.HasConnectorConfig = len(s.ConnectorConfigEnc) > 0
	}
	return s, err
}

func (p *Postgres) UpdateOrgSyncConnector(ctx context.Context, guard RestoreGuard, wsID, sourceID int64, endpointURL string, configEnc []byte, configHint string, intervalMinutes int) (out OrgSyncSource, err error) {
	endpointURL, configHint, err = validateOrgSyncConnectorArgs(endpointURL, configHint, intervalMinutes)
	if err != nil {
		return OrgSyncSource{}, err
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		var updated OrgSyncSource
		if configEnc != nil {
			var encArg []byte
			var hintArg string
			if len(configEnc) > 0 {
				encArg = configEnc
				hintArg = configHint
			}
			updated, e = scanOrgSyncSourceFull(tx.QueryRow(ctx, `UPDATE org_sync_sources
				SET endpoint_url=$3, connector_config_enc=$4, connector_config_hint=$5, sync_interval_minutes=$6, updated_at=now()
				WHERE id=$1 AND workspace_id=$2
				RETURNING `+orgSyncSourceFullColumns,
				sourceID, wsID, endpointURL, encArg, hintArg, intervalMinutes))
		} else {
			updated, e = scanOrgSyncSourceFull(tx.QueryRow(ctx, `UPDATE org_sync_sources
				SET endpoint_url=$3, sync_interval_minutes=$4, updated_at=now()
				WHERE id=$1 AND workspace_id=$2
				RETURNING `+orgSyncSourceFullColumns,
				sourceID, wsID, endpointURL, intervalMinutes))
		}
		if e != nil {
			return e
		}
		if e := drivePGEnd(ctx, guard, expires); e != nil {
			return e
		}
		out = updated
		return nil
	})
	return out, orgPGError(err)
}

func (p *Postgres) GetOrgSyncSourceSystem(ctx context.Context, sourceID int64) (OrgSyncSource, error) {
	src, err := scanOrgSyncSourceFull(p.Pool.QueryRow(ctx, `SELECT `+orgSyncSourceFullColumns+`
		FROM org_sync_sources WHERE id=$1`, sourceID))
	return src, orgPGError(err)
}

func (p *Postgres) ListDueScheduledOrgSyncSources(ctx context.Context, now time.Time) ([]OrgSyncSource, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+orgSyncSourceFullColumns+`
		FROM org_sync_sources
		WHERE enabled = true
		  AND sync_interval_minutes > 0
		  AND provider IN ('ldap', 'wecom', 'dingtalk')
		  AND connector_config_enc IS NOT NULL
		  AND octet_length(connector_config_enc) > 0
		  AND (
		    last_auto_sync_at IS NULL
		    OR last_auto_sync_at + (sync_interval_minutes * interval '1 minute') <= $1
		  )
		ORDER BY COALESCE(last_auto_sync_at, to_timestamp(0)) ASC, id ASC`, now.UTC())
	if err != nil {
		return nil, orgPGError(err)
	}
	sources, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (OrgSyncSource, error) {
		return scanOrgSyncSourceFull(r)
	})
	if err != nil {
		return nil, orgPGError(err)
	}
	if sources == nil {
		sources = []OrgSyncSource{}
	}
	return sources, nil
}

func (p *Postgres) MarkOrgSyncAutoSyncAt(ctx context.Context, sourceID int64, at time.Time) error {
	tag, err := p.Pool.Exec(ctx, `UPDATE org_sync_sources
		SET last_auto_sync_at=$2, updated_at=now()
		WHERE id=$1`, sourceID, at.UTC())
	if err != nil {
		return orgPGError(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) RunOrgDirectorySyncWithModeGuarded(ctx context.Context, guard RestoreGuard, wsID, sourceID int64, triggerMode string, payload OrgDirectorySyncPayload) (out OrgSyncRun, err error) {
	if triggerMode == "" {
		triggerMode = OrgSyncTriggerManual
	}
	if !ValidOrgSyncTriggerMode(triggerMode) {
		return OrgSyncRun{}, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		src, e := scanOrgSyncSourceFull(tx.QueryRow(ctx, `SELECT `+orgSyncSourceFullColumns+`
			FROM org_sync_sources WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, sourceID, wsID))
		if e != nil {
			return e
		}
		actor := guard.UserID
		out, e = p.applyOrgSyncTx(ctx, tx, src, &actor, triggerMode, payload)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, orgPGError(err)
}

func (p *Postgres) RunOrgDirectorySyncSystem(ctx context.Context, sourceID int64, triggerMode string, payload OrgDirectorySyncPayload) (out OrgSyncRun, err error) {
	if triggerMode == "" {
		triggerMode = OrgSyncTriggerScheduled
	}
	if !ValidOrgSyncTriggerMode(triggerMode) {
		return OrgSyncRun{}, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		src, e := scanOrgSyncSourceFull(tx.QueryRow(ctx, `SELECT `+orgSyncSourceFullColumns+`
			FROM org_sync_sources WHERE id=$1 FOR UPDATE`, sourceID))
		if e != nil {
			return e
		}
		if !src.Enabled {
			return ErrForbidden
		}
		out, e = p.applyOrgSyncTx(ctx, tx, src, nil, triggerMode, payload)
		return e
	})
	return out, orgPGError(err)
}

func (p *Postgres) EnrichOrgSyncSources(ctx context.Context, wsID int64, sources []OrgSyncSource) ([]OrgSyncSource, error) {
	if len(sources) == 0 {
		return sources, nil
	}
	rows, err := p.Pool.Query(ctx, `SELECT id, endpoint_url,
		(connector_config_enc IS NOT NULL AND octet_length(connector_config_enc) > 0),
		connector_config_hint, sync_interval_minutes, last_auto_sync_at
		FROM org_sync_sources WHERE workspace_id=$1`, wsID)
	if err != nil {
		return nil, orgPGError(err)
	}
	defer rows.Close()
	type meta struct {
		endpointURL         string
		hasConfig           bool
		configHint          string
		syncIntervalMinutes int
		lastAutoSyncAt      *time.Time
	}
	byID := make(map[int64]meta, len(sources))
	for rows.Next() {
		var id int64
		var m meta
		if err := rows.Scan(&id, &m.endpointURL, &m.hasConfig, &m.configHint, &m.syncIntervalMinutes, &m.lastAutoSyncAt); err != nil {
			return nil, orgPGError(err)
		}
		byID[id] = m
	}
	if err := rows.Err(); err != nil {
		return nil, orgPGError(err)
	}
	out := make([]OrgSyncSource, len(sources))
	for i, s := range sources {
		if m, ok := byID[s.ID]; ok {
			s.EndpointURL = m.endpointURL
			s.HasConnectorConfig = m.hasConfig
			s.ConnectorConfigHint = m.configHint
			s.SyncIntervalMinutes = m.syncIntervalMinutes
			s.LastAutoSyncAt = m.lastAutoSyncAt
		}
		out[i] = s
	}
	return out, nil
}
