package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const (
	AuditLogDefaultLimit = 50
	AuditLogMaxLimit     = 200
	AuditLogExportLimit  = 5000

	DefaultWatermarkOpacity = 0.07
	MinWatermarkOpacity     = 0.02
	MaxWatermarkOpacity     = 0.25
	MaxWatermarkTextRunes   = 80

	DLPActionWarn      = "warn"
	DLPActionBlock     = "block"
	MaxDLPKeywords     = 100
	MaxDLPKeywordRunes = 120
	MinRetentionDays   = 0
	MaxRetentionDays   = 3650

	maxAuditActionRunes        = 100
	maxAuditActorNameRunes     = 120
	maxAuditActorEmailRunes    = 320
	maxAuditResourceTypeRunes  = 64
	maxAuditResourceTitleRunes = 300
	maxAuditIPRunes            = 128
	maxAuditUserAgentRunes     = 512
	maxAuditDetailBytes        = 16384
)

// ErrInvalidSecurityPolicy reports invalid DLP or data-retention policy values.
var ErrInvalidSecurityPolicy = fmt.Errorf("store: invalid workspace security policy: %w", ErrConflict)

// memEnterprise holds in-memory audit logs, workspace security policies, and passkey state for Memory store.
type memEnterprise struct {
	nextAuditID    int64
	auditLogs      []AuditLogEntry
	policies       map[int64]WorkspaceSecurityPolicy
	trashDeletedAt map[int64]time.Time
	passkeys       memPasskeys
}

// AuditLogEntry records a security-relevant event inside a workspace.
type AuditLogEntry struct {
	ID            int64           `json:"id"`
	WorkspaceID   int64           `json:"workspaceId"`
	ActorID       int64           `json:"actorId"`
	ActorName     string          `json:"actorName"`
	ActorEmail    string          `json:"actorEmail"`
	Action        string          `json:"action"`
	ResourceType  string          `json:"resourceType"`
	ResourceID    int64           `json:"resourceId"`
	ResourceTitle string          `json:"resourceTitle"`
	Detail        json.RawMessage `json:"detail"`
	IPAddress     string          `json:"ipAddress"`
	UserAgent     string          `json:"userAgent"`
	CreatedAt     time.Time       `json:"createdAt"`
}

// AuditLogFilter narrows workspace audit log queries.
type AuditLogFilter struct {
	WorkspaceID  int64
	Action       string
	ResourceType string
	ActorID      int64
	Query        string
	From         *time.Time
	To           *time.Time
	Limit        int
	Offset       int
	// Export lifts the page limit ceiling from AuditLogMaxLimit (200) to
	// AuditLogExportLimit (5000) for admin CSV exports.
	Export bool
}

// AuditLogPage is one paginated slice of workspace audit logs.
type AuditLogPage struct {
	Items   []AuditLogEntry `json:"items"`
	Total   int             `json:"total"`
	Actions []string        `json:"actions"`
}

// WorkspaceSecurityPolicy configures enterprise suite-wide document security
// controls such as diagonal user watermarks, DLP sensitive-word rules, and data retention.
type WorkspaceSecurityPolicy struct {
	WorkspaceID         int64     `json:"workspaceId"`
	WatermarkEnabled    bool      `json:"watermarkEnabled"`
	WatermarkText       string    `json:"watermarkText"`
	WatermarkShowUser   bool      `json:"watermarkShowUser"`
	WatermarkShowEmail  bool      `json:"watermarkShowEmail"`
	WatermarkShowDate   bool      `json:"watermarkShowDate"`
	WatermarkOpacity    float64   `json:"watermarkOpacity"`
	DLPEnabled          bool      `json:"dlpEnabled"`
	DLPKeywords         []string  `json:"dlpKeywords"`
	DLPAction           string    `json:"dlpAction"`
	DLPBlockPublicShare bool      `json:"dlpBlockPublicShare"`
	RetentionDays       int       `json:"retentionDays"`
	RequireMFA          bool      `json:"requireMfa"`
	UpdatedBy           int64     `json:"updatedBy"`
	UpdatedAt           time.Time `json:"updatedAt"`
}

// WorkspaceSecurityPolicyPatch partially updates a workspace's security policy.
type WorkspaceSecurityPolicyPatch struct {
	WatermarkEnabled    *bool     `json:"watermarkEnabled,omitempty"`
	WatermarkText       *string   `json:"watermarkText,omitempty"`
	WatermarkShowUser   *bool     `json:"watermarkShowUser,omitempty"`
	WatermarkShowEmail  *bool     `json:"watermarkShowEmail,omitempty"`
	WatermarkShowDate   *bool     `json:"watermarkShowDate,omitempty"`
	WatermarkOpacity    *float64  `json:"watermarkOpacity,omitempty"`
	DLPEnabled          *bool     `json:"dlpEnabled,omitempty"`
	DLPKeywords         *[]string `json:"dlpKeywords,omitempty"`
	DLPAction           *string   `json:"dlpAction,omitempty"`
	DLPBlockPublicShare *bool     `json:"dlpBlockPublicShare,omitempty"`
	RetentionDays       *int      `json:"retentionDays,omitempty"`
	RequireMFA          *bool     `json:"requireMfa,omitempty"`
}

// RetentionPurgeStats summarizes one workspace data-retention cleanup run.
type RetentionPurgeStats struct {
	WorkspaceID      int64     `json:"workspaceId"`
	RetentionDays    int       `json:"retentionDays"`
	PurgedAuditLogs  int64     `json:"purgedAuditLogs"`
	PurgedTrashNodes int64     `json:"purgedTrashNodes"`
	RanAt            time.Time `json:"ranAt"`
}

// AuditLogStore persists enterprise security audit logs and workspace security policies.
type AuditLogStore interface {
	AppendAuditLog(ctx context.Context, entry AuditLogEntry) error
	ListAuditLogsGuarded(ctx context.Context, guard RestoreGuard, wsID int64, filter AuditLogFilter) (AuditLogPage, error)
	GetWorkspaceSecurityPolicy(ctx context.Context, userID, wsID int64) (WorkspaceSecurityPolicy, error)
	UpdateWorkspaceSecurityPolicyGuarded(ctx context.Context, guard RestoreGuard, wsID int64, patch WorkspaceSecurityPolicyPatch) (WorkspaceSecurityPolicy, error)
	UserHasMFARequiredWorkspace(ctx context.Context, userID int64) (bool, []string, error)
	ListRetentionPolicies(ctx context.Context) ([]WorkspaceSecurityPolicy, error)
	PurgeExpiredRetentionData(ctx context.Context, workspaceID int64, cutoff time.Time) (purgedAuditLogs int64, purgedTrashNodes int64, err error)
}

var (
	_ AuditLogStore = (*Memory)(nil)
	_ AuditLogStore = (*Postgres)(nil)
)

// DefaultWorkspaceSecurityPolicy returns the default policy when a workspace
// has not yet customized its security settings.
func DefaultWorkspaceSecurityPolicy(wsID int64) WorkspaceSecurityPolicy {
	return WorkspaceSecurityPolicy{
		WorkspaceID:         wsID,
		WatermarkEnabled:    false,
		WatermarkText:       "",
		WatermarkShowUser:   true,
		WatermarkShowEmail:  true,
		WatermarkShowDate:   true,
		WatermarkOpacity:    DefaultWatermarkOpacity,
		DLPEnabled:          false,
		DLPKeywords:         []string{},
		DLPAction:           DLPActionWarn,
		DLPBlockPublicShare: true,
		RetentionDays:       0,
		RequireMFA:          false,
	}
}

// NormalizeDLPAction validates and normalizes a DLP action string ("warn" | "block").
func NormalizeDLPAction(raw string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case DLPActionWarn:
		return DLPActionWarn, true
	case DLPActionBlock:
		return DLPActionBlock, true
	default:
		return "", false
	}
}

// NormalizeDLPKeywords trims, drops blanks, deduplicates preserving order, and enforces
// rule count (max 100) and per-rule rune length (1..120). Always returns a non-nil slice.
func NormalizeDLPKeywords(raw []string) ([]string, error) {
	out := make([]string, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))
	for _, entry := range raw {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		if utf8.RuneCountInString(trimmed) > MaxDLPKeywordRunes {
			return nil, ErrInvalidSecurityPolicy
		}
		if _, dup := seen[trimmed]; dup {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
		if len(out) > MaxDLPKeywords {
			return nil, ErrInvalidSecurityPolicy
		}
	}
	return out, nil
}

// ValidRetentionDays reports whether days is within [MinRetentionDays, MaxRetentionDays].
func ValidRetentionDays(days int) bool {
	return days >= MinRetentionDays && days <= MaxRetentionDays
}

func cloneSecurityPolicy(p WorkspaceSecurityPolicy) WorkspaceSecurityPolicy {
	if len(p.DLPKeywords) == 0 {
		p.DLPKeywords = []string{}
	} else {
		cp := make([]string, len(p.DLPKeywords))
		copy(cp, p.DLPKeywords)
		p.DLPKeywords = cp
	}
	if p.DLPAction == "" {
		p.DLPAction = DLPActionWarn
	}
	return p
}

func clampAuditRunes(raw string, maxRunes int) string {
	trimmed := strings.TrimSpace(raw)
	if maxRunes <= 0 || utf8.RuneCountInString(trimmed) <= maxRunes {
		return trimmed
	}
	var b strings.Builder
	b.Grow(len(trimmed))
	count := 0
	for _, r := range trimmed {
		if count >= maxRunes {
			break
		}
		b.WriteRune(r)
		count++
	}
	return b.String()
}

func clampWatermarkOpacity(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return DefaultWatermarkOpacity
	}
	if v < MinWatermarkOpacity {
		return MinWatermarkOpacity
	}
	if v > MaxWatermarkOpacity {
		return MaxWatermarkOpacity
	}
	return v
}

func normalizeAuditDetail(raw json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || !json.Valid(trimmed) {
		return json.RawMessage("{}")
	}
	if len(trimmed) > maxAuditDetailBytes {
		return json.RawMessage(`{"truncated":true}`)
	}
	cp := make([]byte, len(trimmed))
	copy(cp, trimmed)
	return json.RawMessage(cp)
}

func sanitizeAuditEntry(entry AuditLogEntry) (AuditLogEntry, error) {
	action := clampAuditRunes(entry.Action, maxAuditActionRunes)
	if action == "" {
		return AuditLogEntry{}, ErrConflict
	}
	if entry.WorkspaceID < 0 {
		entry.WorkspaceID = 0
	}
	if entry.ActorID < 0 {
		entry.ActorID = 0
	}
	if entry.ResourceID < 0 {
		entry.ResourceID = 0
	}
	entry.Action = action
	entry.ActorName = clampAuditRunes(entry.ActorName, maxAuditActorNameRunes)
	entry.ActorEmail = clampAuditRunes(entry.ActorEmail, maxAuditActorEmailRunes)
	entry.ResourceType = clampAuditRunes(entry.ResourceType, maxAuditResourceTypeRunes)
	entry.ResourceTitle = clampAuditRunes(entry.ResourceTitle, maxAuditResourceTitleRunes)
	entry.IPAddress = clampAuditRunes(entry.IPAddress, maxAuditIPRunes)
	entry.UserAgent = clampAuditRunes(entry.UserAgent, maxAuditUserAgentRunes)
	entry.Detail = normalizeAuditDetail(entry.Detail)
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = time.Now().UTC()
	} else {
		entry.CreatedAt = entry.CreatedAt.UTC()
	}
	return entry, nil
}

func normalizeAuditLimitOffset(filter AuditLogFilter) (int, int) {
	limit := filter.Limit
	if filter.Export {
		if limit <= 0 {
			limit = AuditLogExportLimit
		} else if limit > AuditLogExportLimit {
			limit = AuditLogExportLimit
		}
	} else {
		if limit <= 0 {
			limit = AuditLogDefaultLimit
		} else if limit > AuditLogMaxLimit {
			limit = AuditLogMaxLimit
		}
	}
	offset := filter.Offset
	if offset < 0 {
		offset = 0
	}
	return limit, offset
}

func applySecurityPolicyPatch(base WorkspaceSecurityPolicy, patch WorkspaceSecurityPolicyPatch, updatedBy int64, now time.Time) (WorkspaceSecurityPolicy, error) {
	out := cloneSecurityPolicy(base)
	if patch.WatermarkEnabled != nil {
		out.WatermarkEnabled = *patch.WatermarkEnabled
	}
	if patch.WatermarkText != nil {
		out.WatermarkText = clampAuditRunes(*patch.WatermarkText, MaxWatermarkTextRunes)
	}
	if patch.WatermarkShowUser != nil {
		out.WatermarkShowUser = *patch.WatermarkShowUser
	}
	if patch.WatermarkShowEmail != nil {
		out.WatermarkShowEmail = *patch.WatermarkShowEmail
	}
	if patch.WatermarkShowDate != nil {
		out.WatermarkShowDate = *patch.WatermarkShowDate
	}
	if patch.WatermarkOpacity != nil {
		out.WatermarkOpacity = clampWatermarkOpacity(*patch.WatermarkOpacity)
	} else {
		out.WatermarkOpacity = clampWatermarkOpacity(out.WatermarkOpacity)
	}
	if patch.DLPEnabled != nil {
		out.DLPEnabled = *patch.DLPEnabled
	}
	if patch.DLPKeywords != nil {
		clean, err := NormalizeDLPKeywords(*patch.DLPKeywords)
		if err != nil {
			return WorkspaceSecurityPolicy{}, err
		}
		out.DLPKeywords = clean
	}
	if patch.DLPAction != nil {
		act, ok := NormalizeDLPAction(*patch.DLPAction)
		if !ok {
			return WorkspaceSecurityPolicy{}, ErrInvalidSecurityPolicy
		}
		out.DLPAction = act
	}
	if patch.DLPBlockPublicShare != nil {
		out.DLPBlockPublicShare = *patch.DLPBlockPublicShare
	}
	if patch.RetentionDays != nil {
		if !ValidRetentionDays(*patch.RetentionDays) {
			return WorkspaceSecurityPolicy{}, ErrInvalidSecurityPolicy
		}
		out.RetentionDays = *patch.RetentionDays
	}
	if patch.RequireMFA != nil {
		out.RequireMFA = *patch.RequireMFA
	}
	out.UpdatedBy = updatedBy
	out.UpdatedAt = now.UTC()
	return cloneSecurityPolicy(out), nil
}

func nullablePositiveID(id int64) any {
	if id <= 0 {
		return nil
	}
	return id
}

func escapeAuditLike(q string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(q) + "%"
}

func cloneAuditEntry(e AuditLogEntry) AuditLogEntry {
	if len(e.Detail) > 0 {
		cp := make([]byte, len(e.Detail))
		copy(cp, e.Detail)
		e.Detail = cp
	} else {
		e.Detail = json.RawMessage("{}")
	}
	return e
}

// --- Memory implementation ---

func (m *Memory) AppendAuditLog(ctx context.Context, entry AuditLogEntry) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	clean, err := sanitizeAuditEntry(entry)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.enterprise.nextAuditID++
	clean.ID = m.enterprise.nextAuditID
	m.enterprise.auditLogs = append(m.enterprise.auditLogs, cloneAuditEntry(clean))
	return nil
}

func (m *Memory) ListAuditLogsGuarded(ctx context.Context, guard RestoreGuard, wsID int64, filter AuditLogFilter) (AuditLogPage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return AuditLogPage{}, err
	}

	limit, offset := normalizeAuditLimitOffset(filter)
	actionFilter := strings.TrimSpace(filter.Action)
	resourceTypeFilter := strings.TrimSpace(filter.ResourceType)
	qLower := strings.ToLower(strings.TrimSpace(filter.Query))

	actionSet := map[string]struct{}{}
	matched := make([]AuditLogEntry, 0)
	for _, e := range m.enterprise.auditLogs {
		if e.WorkspaceID != wsID {
			continue
		}
		if e.Action != "" {
			actionSet[e.Action] = struct{}{}
		}
		if actionFilter != "" && e.Action != actionFilter {
			continue
		}
		if resourceTypeFilter != "" && e.ResourceType != resourceTypeFilter {
			continue
		}
		if filter.ActorID > 0 && e.ActorID != filter.ActorID {
			continue
		}
		if filter.From != nil && e.CreatedAt.Before(*filter.From) {
			continue
		}
		if filter.To != nil && e.CreatedAt.After(*filter.To) {
			continue
		}
		if qLower != "" {
			hit := strings.Contains(strings.ToLower(e.ActorName), qLower) ||
				strings.Contains(strings.ToLower(e.ActorEmail), qLower) ||
				strings.Contains(strings.ToLower(e.ResourceTitle), qLower) ||
				strings.Contains(strings.ToLower(e.Action), qLower) ||
				strings.Contains(strings.ToLower(e.IPAddress), qLower)
			if !hit {
				continue
			}
		}
		matched = append(matched, cloneAuditEntry(e))
	}

	sort.Slice(matched, func(i, j int) bool {
		if !matched[i].CreatedAt.Equal(matched[j].CreatedAt) {
			return matched[i].CreatedAt.After(matched[j].CreatedAt)
		}
		return matched[i].ID > matched[j].ID
	})

	actions := make([]string, 0, len(actionSet))
	for a := range actionSet {
		actions = append(actions, a)
	}
	sort.Strings(actions)

	total := len(matched)
	items := make([]AuditLogEntry, 0)
	if offset < total {
		end := offset + limit
		if end > total {
			end = total
		}
		items = matched[offset:end]
	}

	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return AuditLogPage{}, err
	}
	return AuditLogPage{
		Items:   items,
		Total:   total,
		Actions: actions,
	}, nil
}

func (m *Memory) GetWorkspaceSecurityPolicy(ctx context.Context, userID, wsID int64) (WorkspaceSecurityPolicy, error) {
	if err := ctx.Err(); err != nil {
		return WorkspaceSecurityPolicy{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if wsID <= 0 || int(wsID) > len(m.workspaces) {
		return WorkspaceSecurityPolicy{}, ErrNotFound
	}
	if m.workspaceRoleLocked(wsID, userID) == "" {
		return WorkspaceSecurityPolicy{}, ErrForbidden
	}
	if p, ok := m.enterprise.policies[wsID]; ok {
		return cloneSecurityPolicy(p), nil
	}
	return DefaultWorkspaceSecurityPolicy(wsID), nil
}

// GetWorkspaceSecurityPolicySystem loads a workspace's security policy without
// requiring workspace membership (used by server-side enforcement hooks such as DLP).
func (m *Memory) GetWorkspaceSecurityPolicySystem(ctx context.Context, wsID int64) (WorkspaceSecurityPolicy, error) {
	if err := ctx.Err(); err != nil {
		return WorkspaceSecurityPolicy{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if wsID <= 0 || int(wsID) > len(m.workspaces) {
		return WorkspaceSecurityPolicy{}, ErrNotFound
	}
	if p, ok := m.enterprise.policies[wsID]; ok {
		return cloneSecurityPolicy(p), nil
	}
	return DefaultWorkspaceSecurityPolicy(wsID), nil
}

func (m *Memory) UpdateWorkspaceSecurityPolicyGuarded(ctx context.Context, guard RestoreGuard, wsID int64, patch WorkspaceSecurityPolicyPatch) (WorkspaceSecurityPolicy, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return WorkspaceSecurityPolicy{}, err
	}
	if m.enterprise.policies == nil {
		m.enterprise.policies = map[int64]WorkspaceSecurityPolicy{}
	}
	cur, ok := m.enterprise.policies[wsID]
	if !ok {
		cur = DefaultWorkspaceSecurityPolicy(wsID)
	}
	next, err := applySecurityPolicyPatch(cur, patch, guard.UserID, guard.currentTime())
	if err != nil {
		return WorkspaceSecurityPolicy{}, err
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return WorkspaceSecurityPolicy{}, err
	}
	m.enterprise.policies[wsID] = cloneSecurityPolicy(next)
	return cloneSecurityPolicy(next), nil
}

// UserHasMFARequiredWorkspace reports whether any workspace the user belongs to
// enforces MFA (require_mfa = true) and returns the names of those workspaces.
func (m *Memory) UserHasMFARequiredWorkspace(ctx context.Context, userID int64) (bool, []string, error) {
	if err := ctx.Err(); err != nil {
		return false, nil, err
	}
	if userID <= 0 {
		return false, []string{}, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	wsIDs := m.members[userID]
	if len(wsIDs) == 0 || len(m.enterprise.policies) == 0 {
		return false, []string{}, nil
	}
	seen := make(map[int64]struct{}, len(wsIDs))
	matchedIDs := make([]int64, 0, len(wsIDs))
	for _, wsID := range wsIDs {
		if _, dup := seen[wsID]; dup {
			continue
		}
		seen[wsID] = struct{}{}
		if p, ok := m.enterprise.policies[wsID]; ok && p.RequireMFA {
			if wsID > 0 && int(wsID) <= len(m.workspaces) {
				matchedIDs = append(matchedIDs, wsID)
			}
		}
	}
	sort.Slice(matchedIDs, func(i, j int) bool { return matchedIDs[i] < matchedIDs[j] })
	names := make([]string, 0, len(matchedIDs))
	for _, wsID := range matchedIDs {
		names = append(names, m.workspaces[wsID-1].Name)
	}
	return len(names) > 0, names, nil
}

// SetMemoryNodeDeletedAt sets an explicit deletion timestamp on a node in Memory store
// (primarily used by retention sweeper tests to simulate historical trash timestamps).
func (m *Memory) SetMemoryNodeDeletedAt(nodeID int64, deletedAt time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.enterprise.trashDeletedAt == nil {
		m.enterprise.trashDeletedAt = map[int64]time.Time{}
	}
	m.enterprise.trashDeletedAt[nodeID] = deletedAt.UTC()
}

// ListRetentionPolicies returns all workspace security policies with retention_days > 0.
func (m *Memory) ListRetentionPolicies(ctx context.Context) ([]WorkspaceSecurityPolicy, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]WorkspaceSecurityPolicy, 0)
	for _, p := range m.enterprise.policies {
		if p.RetentionDays > 0 {
			out = append(out, cloneSecurityPolicy(p))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].WorkspaceID < out[j].WorkspaceID })
	return out, nil
}

// PurgeExpiredRetentionData deletes workspace audit logs older than cutoff and
// permanently purges soft-deleted nodes deleted before cutoff.
func (m *Memory) PurgeExpiredRetentionData(ctx context.Context, workspaceID int64, cutoff time.Time) (purgedAuditLogs int64, purgedTrashNodes int64, err error) {
	if err := ctx.Err(); err != nil {
		return 0, 0, err
	}
	if workspaceID <= 0 {
		return 0, 0, nil
	}
	cutoffUTC := cutoff.UTC()
	m.mu.Lock()
	defer m.mu.Unlock()

	if len(m.enterprise.auditLogs) > 0 {
		kept := make([]AuditLogEntry, 0, len(m.enterprise.auditLogs))
		for _, e := range m.enterprise.auditLogs {
			if e.WorkspaceID == workspaceID && e.CreatedAt.UTC().Before(cutoffUTC) {
				purgedAuditLogs++
				continue
			}
			kept = append(kept, e)
		}
		m.enterprise.auditLogs = kept
	}

	expired := map[int64]bool{}
	for _, d := range m.d.docs {
		if d.meta.WorkspaceID != workspaceID || !d.deleted || d.purged {
			continue
		}
		delAt := d.meta.UpdatedAt
		if ts, ok := m.enterprise.trashDeletedAt[d.meta.ID]; ok {
			delAt = ts
		} else if delAt.IsZero() {
			delAt = d.meta.CreatedAt
		}
		if delAt.UTC().Before(cutoffUTC) {
			expired[d.meta.ID] = true
		}
	}
	if len(expired) > 0 {
		changed := true
		for changed {
			changed = false
			for _, d := range m.d.docs {
				if d.meta.WorkspaceID != workspaceID || !d.deleted || d.purged || expired[d.meta.ID] {
					continue
				}
				if d.meta.ParentID != nil && expired[*d.meta.ParentID] {
					expired[d.meta.ID] = true
					changed = true
				}
			}
		}
		for i := range m.sh.files {
			if f := m.sh.files[i]; f.ID != 0 && expired[f.DocID] {
				m.sh.files[i] = FileMeta{}
			}
		}
		for _, d := range m.d.docs {
			if expired[d.meta.ID] {
				d.purged = true
				delete(m.sheets.books, d.meta.ID)
				delete(m.enterprise.trashDeletedAt, d.meta.ID)
				purgedTrashNodes++
			}
		}
	}
	return purgedAuditLogs, purgedTrashNodes, nil
}

// GetSheetWorkbookSystem loads a sheet workbook snapshot without requiring a
// user session guard (used by server-side enforcement hooks such as DLP).
func (m *Memory) GetSheetWorkbookSystem(ctx context.Context, nodeID int64) (SheetSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return SheetSnapshot{}, err
	}
	if !validSheetID(nodeID) {
		return SheetSnapshot{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(nodeID)
	wb := m.sheets.books[nodeID]
	if d == nil || d.deleted || d.purged || d.meta.Kind != "sheet" || wb == nil {
		return SheetSnapshot{}, ErrNotFound
	}
	return m.sheetSnapshotLocked(d, wb, RoleView), nil
}

// --- Postgres implementation ---

func (p *Postgres) AppendAuditLog(ctx context.Context, entry AuditLogEntry) error {
	clean, err := sanitizeAuditEntry(entry)
	if err != nil {
		return err
	}
	_, err = p.Pool.Exec(ctx, `INSERT INTO audit_logs (
		workspace_id, actor_id, actor_name, actor_email, action,
		resource_type, resource_id, resource_title, detail, ip_address, user_agent, created_at
	) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
		clean.WorkspaceID,
		nullablePositiveID(clean.ActorID),
		clean.ActorName,
		clean.ActorEmail,
		clean.Action,
		clean.ResourceType,
		clean.ResourceID,
		clean.ResourceTitle,
		string(clean.Detail),
		clean.IPAddress,
		clean.UserAgent,
		clean.CreatedAt,
	)
	return err
}

func (p *Postgres) ListAuditLogsGuarded(ctx context.Context, guard RestoreGuard, wsID int64, filter AuditLogFilter) (out AuditLogPage, err error) {
	limit, offset := normalizeAuditLimitOffset(filter)
	actionFilter := strings.TrimSpace(filter.Action)
	resourceTypeFilter := strings.TrimSpace(filter.ResourceType)
	q := strings.TrimSpace(filter.Query)

	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}

		where := []string{"workspace_id = $1"}
		args := []any{wsID}
		nextArg := func(v any) string {
			args = append(args, v)
			return fmt.Sprintf("$%d", len(args))
		}

		if actionFilter != "" {
			where = append(where, "action = "+nextArg(actionFilter))
		}
		if resourceTypeFilter != "" {
			where = append(where, "resource_type = "+nextArg(resourceTypeFilter))
		}
		if filter.ActorID > 0 {
			where = append(where, "actor_id = "+nextArg(filter.ActorID))
		}
		if filter.From != nil {
			where = append(where, "created_at >= "+nextArg(filter.From.UTC()))
		}
		if filter.To != nil {
			where = append(where, "created_at <= "+nextArg(filter.To.UTC()))
		}
		if q != "" {
			pat := nextArg(escapeAuditLike(q))
			where = append(where, fmt.Sprintf(
				`(actor_name ILIKE %s ESCAPE '\' OR actor_email ILIKE %s ESCAPE '\' OR resource_title ILIKE %s ESCAPE '\' OR action ILIKE %s ESCAPE '\' OR ip_address ILIKE %s ESCAPE '\')`,
				pat, pat, pat, pat, pat,
			))
		}

		whereSQL := strings.Join(where, " AND ")

		var total int
		if e = tx.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE `+whereSQL, args...).Scan(&total); e != nil {
			return e
		}

		limitPlaceholder := nextArg(limit)
		offsetPlaceholder := nextArg(offset)
		listSQL := `SELECT id, workspace_id, COALESCE(actor_id, 0), actor_name, actor_email, action,
			resource_type, resource_id, resource_title, detail, ip_address, user_agent, created_at
			FROM audit_logs WHERE ` + whereSQL + ` ORDER BY created_at DESC, id DESC LIMIT ` + limitPlaceholder + ` OFFSET ` + offsetPlaceholder

		rows, e := tx.Query(ctx, listSQL, args...)
		if e != nil {
			return e
		}
		items, e := pgx.CollectRows(rows, func(r pgx.CollectableRow) (item AuditLogEntry, err error) {
			var detailBytes []byte
			err = r.Scan(
				&item.ID, &item.WorkspaceID, &item.ActorID, &item.ActorName, &item.ActorEmail,
				&item.Action, &item.ResourceType, &item.ResourceID, &item.ResourceTitle,
				&detailBytes, &item.IPAddress, &item.UserAgent, &item.CreatedAt,
			)
			item.Detail = normalizeAuditDetail(detailBytes)
			return
		})
		if e != nil {
			return e
		}
		if items == nil {
			items = []AuditLogEntry{}
		}

		actRows, e := tx.Query(ctx, `SELECT DISTINCT action FROM audit_logs WHERE workspace_id = $1 ORDER BY action`, wsID)
		if e != nil {
			return e
		}
		actions, e := pgx.CollectRows(actRows, func(r pgx.CollectableRow) (a string, err error) {
			err = r.Scan(&a)
			return
		})
		if e != nil {
			return e
		}
		if actions == nil {
			actions = []string{}
		}

		out = AuditLogPage{
			Items:   items,
			Total:   total,
			Actions: actions,
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, orgPGError(err)
}

func (p *Postgres) GetWorkspaceSecurityPolicy(ctx context.Context, userID, wsID int64) (out WorkspaceSecurityPolicy, err error) {
	if wsID <= 0 {
		return out, ErrNotFound
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var exists int
		if e := tx.QueryRow(ctx, `SELECT 1 FROM workspaces WHERE id=$1`, wsID).Scan(&exists); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return e
		}
		var role string
		if e := tx.QueryRow(ctx, `SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, wsID, userID).Scan(&role); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrForbidden
			}
			return e
		}
		var pol WorkspaceSecurityPolicy
		e := tx.QueryRow(ctx, `SELECT workspace_id, watermark_enabled, watermark_text,
			watermark_show_user, watermark_show_email, watermark_show_date, watermark_opacity,
			dlp_enabled, dlp_keywords, dlp_action, dlp_block_public_share, retention_days, require_mfa,
			COALESCE(updated_by, 0), updated_at
			FROM workspace_security_policies WHERE workspace_id=$1`, wsID).Scan(
			&pol.WorkspaceID, &pol.WatermarkEnabled, &pol.WatermarkText,
			&pol.WatermarkShowUser, &pol.WatermarkShowEmail, &pol.WatermarkShowDate,
			&pol.WatermarkOpacity,
			&pol.DLPEnabled, &pol.DLPKeywords, &pol.DLPAction, &pol.DLPBlockPublicShare, &pol.RetentionDays, &pol.RequireMFA,
			&pol.UpdatedBy, &pol.UpdatedAt,
		)
		if errors.Is(e, pgx.ErrNoRows) {
			out = DefaultWorkspaceSecurityPolicy(wsID)
			return nil
		}
		if e != nil {
			return e
		}
		out = cloneSecurityPolicy(pol)
		return nil
	})
	return out, err
}

// GetWorkspaceSecurityPolicySystem loads a workspace's security policy without
// requiring workspace membership (used by server-side enforcement hooks such as DLP).
func (p *Postgres) GetWorkspaceSecurityPolicySystem(ctx context.Context, wsID int64) (out WorkspaceSecurityPolicy, err error) {
	if wsID <= 0 {
		return out, ErrNotFound
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var exists int
		if e := tx.QueryRow(ctx, `SELECT 1 FROM workspaces WHERE id=$1`, wsID).Scan(&exists); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return e
		}
		var pol WorkspaceSecurityPolicy
		e := tx.QueryRow(ctx, `SELECT workspace_id, watermark_enabled, watermark_text,
			watermark_show_user, watermark_show_email, watermark_show_date, watermark_opacity,
			dlp_enabled, dlp_keywords, dlp_action, dlp_block_public_share, retention_days, require_mfa,
			COALESCE(updated_by, 0), updated_at
			FROM workspace_security_policies WHERE workspace_id=$1`, wsID).Scan(
			&pol.WorkspaceID, &pol.WatermarkEnabled, &pol.WatermarkText,
			&pol.WatermarkShowUser, &pol.WatermarkShowEmail, &pol.WatermarkShowDate,
			&pol.WatermarkOpacity,
			&pol.DLPEnabled, &pol.DLPKeywords, &pol.DLPAction, &pol.DLPBlockPublicShare, &pol.RetentionDays, &pol.RequireMFA,
			&pol.UpdatedBy, &pol.UpdatedAt,
		)
		if errors.Is(e, pgx.ErrNoRows) {
			out = DefaultWorkspaceSecurityPolicy(wsID)
			return nil
		}
		if e != nil {
			return e
		}
		out = cloneSecurityPolicy(pol)
		return nil
	})
	return out, err
}

func (p *Postgres) UpdateWorkspaceSecurityPolicyGuarded(ctx context.Context, guard RestoreGuard, wsID int64, patch WorkspaceSecurityPolicyPatch) (out WorkspaceSecurityPolicy, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, wsID); e != nil {
			return e
		}
		cur := DefaultWorkspaceSecurityPolicy(wsID)
		e = tx.QueryRow(ctx, `SELECT workspace_id, watermark_enabled, watermark_text,
			watermark_show_user, watermark_show_email, watermark_show_date, watermark_opacity,
			dlp_enabled, dlp_keywords, dlp_action, dlp_block_public_share, retention_days, require_mfa,
			COALESCE(updated_by, 0), updated_at
			FROM workspace_security_policies WHERE workspace_id=$1 FOR UPDATE`, wsID).Scan(
			&cur.WorkspaceID, &cur.WatermarkEnabled, &cur.WatermarkText,
			&cur.WatermarkShowUser, &cur.WatermarkShowEmail, &cur.WatermarkShowDate,
			&cur.WatermarkOpacity,
			&cur.DLPEnabled, &cur.DLPKeywords, &cur.DLPAction, &cur.DLPBlockPublicShare, &cur.RetentionDays, &cur.RequireMFA,
			&cur.UpdatedBy, &cur.UpdatedAt,
		)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}

		next, e := applySecurityPolicyPatch(cur, patch, guard.UserID, guard.currentTime())
		if e != nil {
			return e
		}
		e = tx.QueryRow(ctx, `INSERT INTO workspace_security_policies (
			workspace_id, watermark_enabled, watermark_text,
			watermark_show_user, watermark_show_email, watermark_show_date,
			watermark_opacity, dlp_enabled, dlp_keywords, dlp_action,
			dlp_block_public_share, retention_days, require_mfa, updated_by, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
		ON CONFLICT (workspace_id) DO UPDATE SET
			watermark_enabled      = EXCLUDED.watermark_enabled,
			watermark_text         = EXCLUDED.watermark_text,
			watermark_show_user    = EXCLUDED.watermark_show_user,
			watermark_show_email   = EXCLUDED.watermark_show_email,
			watermark_show_date    = EXCLUDED.watermark_show_date,
			watermark_opacity      = EXCLUDED.watermark_opacity,
			dlp_enabled            = EXCLUDED.dlp_enabled,
			dlp_keywords           = EXCLUDED.dlp_keywords,
			dlp_action             = EXCLUDED.dlp_action,
			dlp_block_public_share = EXCLUDED.dlp_block_public_share,
			retention_days         = EXCLUDED.retention_days,
			require_mfa            = EXCLUDED.require_mfa,
			updated_by             = EXCLUDED.updated_by,
			updated_at             = EXCLUDED.updated_at
		RETURNING workspace_id, watermark_enabled, watermark_text,
			watermark_show_user, watermark_show_email, watermark_show_date,
			watermark_opacity, dlp_enabled, dlp_keywords, dlp_action,
			dlp_block_public_share, retention_days, require_mfa, COALESCE(updated_by, 0), updated_at`,
			next.WorkspaceID,
			next.WatermarkEnabled,
			next.WatermarkText,
			next.WatermarkShowUser,
			next.WatermarkShowEmail,
			next.WatermarkShowDate,
			next.WatermarkOpacity,
			next.DLPEnabled,
			next.DLPKeywords,
			next.DLPAction,
			next.DLPBlockPublicShare,
			next.RetentionDays,
			next.RequireMFA,
			nullablePositiveID(next.UpdatedBy),
			next.UpdatedAt,
		).Scan(
			&out.WorkspaceID, &out.WatermarkEnabled, &out.WatermarkText,
			&out.WatermarkShowUser, &out.WatermarkShowEmail, &out.WatermarkShowDate,
			&out.WatermarkOpacity,
			&out.DLPEnabled, &out.DLPKeywords, &out.DLPAction, &out.DLPBlockPublicShare, &out.RetentionDays, &out.RequireMFA,
			&out.UpdatedBy, &out.UpdatedAt,
		)
		if e != nil {
			return e
		}
		out = cloneSecurityPolicy(out)
		return drivePGEnd(ctx, guard, expires)
	})
	return out, orgPGError(err)
}

// UserHasMFARequiredWorkspace reports whether any workspace the user belongs to
// enforces MFA (require_mfa = true) and returns the names of those workspaces.
func (p *Postgres) UserHasMFARequiredWorkspace(ctx context.Context, userID int64) (bool, []string, error) {
	if userID <= 0 {
		return false, []string{}, nil
	}
	rows, err := p.Pool.Query(ctx, `SELECT w.name
		FROM workspace_members m
		JOIN workspaces w ON w.id = m.workspace_id
		JOIN workspace_security_policies p ON p.workspace_id = m.workspace_id
		WHERE m.user_id = $1 AND p.require_mfa = true
		ORDER BY w.id ASC`, userID)
	if err != nil {
		return false, nil, err
	}
	names, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (name string, err error) {
		err = r.Scan(&name)
		return
	})
	if err != nil {
		return false, nil, err
	}
	if names == nil {
		names = []string{}
	}
	return len(names) > 0, names, nil
}

// ListRetentionPolicies returns all workspace security policies with retention_days > 0.
func (p *Postgres) ListRetentionPolicies(ctx context.Context) ([]WorkspaceSecurityPolicy, error) {
	rows, err := p.Pool.Query(ctx, `SELECT workspace_id, watermark_enabled, watermark_text,
		watermark_show_user, watermark_show_email, watermark_show_date, watermark_opacity,
		dlp_enabled, dlp_keywords, dlp_action, dlp_block_public_share, retention_days, require_mfa,
		COALESCE(updated_by, 0), updated_at
		FROM workspace_security_policies
		WHERE retention_days > 0
		ORDER BY workspace_id ASC`)
	if err != nil {
		return nil, err
	}
	items, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (pol WorkspaceSecurityPolicy, err error) {
		err = r.Scan(
			&pol.WorkspaceID, &pol.WatermarkEnabled, &pol.WatermarkText,
			&pol.WatermarkShowUser, &pol.WatermarkShowEmail, &pol.WatermarkShowDate,
			&pol.WatermarkOpacity,
			&pol.DLPEnabled, &pol.DLPKeywords, &pol.DLPAction, &pol.DLPBlockPublicShare, &pol.RetentionDays, &pol.RequireMFA,
			&pol.UpdatedBy, &pol.UpdatedAt,
		)
		if err == nil {
			pol = cloneSecurityPolicy(pol)
		}
		return
	})
	if err != nil {
		return nil, err
	}
	if items == nil {
		items = []WorkspaceSecurityPolicy{}
	}
	return items, nil
}

// PurgeExpiredRetentionData deletes workspace audit logs older than cutoff and
// permanently deletes soft-deleted nodes whose deleted_at < cutoff.
func (p *Postgres) PurgeExpiredRetentionData(ctx context.Context, workspaceID int64, cutoff time.Time) (purgedAuditLogs int64, purgedTrashNodes int64, err error) {
	if workspaceID <= 0 {
		return 0, 0, nil
	}
	cutoffUTC := cutoff.UTC()
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		if e := drivePGLockWorkspace(ctx, tx, workspaceID); e != nil {
			return e
		}
		auditTag, e := tx.Exec(ctx,
			`DELETE FROM audit_logs WHERE workspace_id = $1 AND created_at < $2`,
			workspaceID, cutoffUTC,
		)
		if e != nil {
			return e
		}
		purgedAuditLogs = auditTag.RowsAffected()

		var deletedNodes int64
		e = tx.QueryRow(ctx,
			`WITH RECURSIVE expired(id) AS (
				SELECT id FROM nodes
				 WHERE workspace_id = $1 AND deleted_at IS NOT NULL AND deleted_at < $2
				UNION
				SELECT n.id FROM nodes n
				  JOIN expired e ON n.parent_id = e.id
				 WHERE n.workspace_id = $1 AND n.deleted_at IS NOT NULL
			),
			removed AS (
				DELETE FROM nodes WHERE id IN (SELECT id FROM expired) RETURNING id
			)
			SELECT COUNT(*) FROM removed`,
			workspaceID, cutoffUTC,
		).Scan(&deletedNodes)
		if e != nil {
			return e
		}
		purgedTrashNodes = deletedNodes
		return nil
	})
	return purgedAuditLogs, purgedTrashNodes, err
}

// GetSheetWorkbookSystem loads a sheet workbook snapshot without requiring a
// user session guard (used by server-side enforcement hooks such as DLP).
func (p *Postgres) GetSheetWorkbookSystem(ctx context.Context, nodeID int64) (snap SheetSnapshot, err error) {
	if !validSheetID(nodeID) {
		return SheetSnapshot{}, ErrNotFound
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var info pgSheetNode
		var kind string
		var deleted bool
		e := tx.QueryRow(ctx,
			`SELECT n.id, n.workspace_id, n.parent_id, n.title, n.kind, n.creator_id,
			        COALESCE((SELECT u.name FROM users u WHERE u.id = n.creator_id), ''),
			        n.drive_revision, n.deleted_at IS NOT NULL, n.updated_at
			   FROM nodes n WHERE n.id = $1`, nodeID).
			Scan(&info.nodeID, &info.workspaceID, &info.parentID, &info.title, &kind,
				&info.creatorID, &info.creatorName, &info.driveRevision, &deleted, &info.updatedAt)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if kind != "sheet" || deleted {
			return ErrNotFound
		}
		e = tx.QueryRow(ctx, `SELECT revision FROM sheet_workbooks WHERE node_id = $1`, nodeID).Scan(&info.workbookRevision)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		info.role = RoleView
		snap, e = loadSheetSnapshotPG(ctx, tx, info)
		return e
	})
	return snap, err
}
