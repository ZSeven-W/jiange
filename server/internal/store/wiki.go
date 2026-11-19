package store

import (
	"context"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	WikiVisibilityWorkspace = "workspace"
	WikiVisibilityPrivate   = "private"
	SubjectTypeUser         = "user"
)

// WikiSpace is an independent knowledge space inside a workspace.
type WikiSpace struct {
	ID          int64     `json:"id"`
	WorkspaceID int64     `json:"workspaceId"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Icon        string    `json:"icon"`
	Visibility  string    `json:"visibility"` // workspace | private
	CreatorID   int64     `json:"creatorId"`
	CreatorName string    `json:"creatorName"`
	CallerRole  string    `json:"callerRole"` // view | edit | manage
	NodeCount   int       `json:"nodeCount"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// WikiSpaceGrant grants a user, department (including sub-departments), or
// user group a role across a Wiki space.
type WikiSpaceGrant struct {
	SubjectType string `json:"subjectType"` // user | department | group
	SubjectID   int64  `json:"subjectId"`
	Name        string `json:"name"`
	Email       string `json:"email,omitempty"`
	MemberCount int    `json:"memberCount,omitempty"`
	Role        string `json:"role"` // view | edit | manage
}

// WikiNodeEntry is one visible node in a Wiki space's hierarchical tree.
type WikiNodeEntry struct {
	ID               int64     `json:"id"`
	WorkspaceID      int64     `json:"workspaceId"`
	WikiSpaceID      int64     `json:"wikiSpaceId"`
	ParentID         *int64    `json:"parentId"`
	Kind             string    `json:"kind"` // doc | sheet | base | slides | folder
	DocType          string    `json:"docType,omitempty"`
	Title            string    `json:"title"`
	Icon             string    `json:"icon,omitempty"`
	CreatorID        int64     `json:"creatorId"`
	CreatorName      string    `json:"creatorName"`
	Role             string    `json:"role"` // view | edit | manage
	Revision         int64     `json:"revision"`
	InheritParentACL bool      `json:"inheritParentAcl"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

// WikiSpaceDetail bundles a Wiki space's metadata, grants (for managers), and
// all active nodes visible to the caller.
type WikiSpaceDetail struct {
	Space  WikiSpace        `json:"space"`
	Grants []WikiSpaceGrant `json:"grants"`
	Nodes  []WikiNodeEntry  `json:"nodes"`
}

// WikiStore manages independent Wiki knowledge spaces, space-level ACL grants,
// hierarchical page trees, cross-space moves, and Drive-to-Wiki migration.
type WikiStore interface {
	ListWikiSpaces(ctx context.Context, guard RestoreGuard, wsID int64) ([]WikiSpace, error)
	GetWikiSpaceDetail(ctx context.Context, guard RestoreGuard, spaceID int64) (WikiSpaceDetail, error)
	CreateWikiSpaceGuarded(ctx context.Context, guard RestoreGuard, wsID int64, name, description, icon, visibility string) (WikiSpace, error)
	UpdateWikiSpaceGuarded(ctx context.Context, guard RestoreGuard, spaceID int64, name, description, icon, visibility *string) (WikiSpace, error)
	DeleteWikiSpaceGuarded(ctx context.Context, guard RestoreGuard, spaceID int64) ([]string, error)
	SetWikiSpaceGrantGuarded(ctx context.Context, guard RestoreGuard, spaceID int64, subjectType string, subjectID int64, role string) ([]WikiSpaceGrant, error)
	CreateWikiNodeGuarded(ctx context.Context, guard RestoreGuard, spaceID int64, parentID *int64, kind, docType, title string) (WikiNodeEntry, error)
	MoveWikiNodeGuarded(ctx context.Context, guard RestoreGuard, nodeID, targetSpaceID int64, targetParentID *int64, expectedRevision int64) (WikiNodeEntry, error)
	ImportDriveNodeToWikiGuarded(ctx context.Context, guard RestoreGuard, sourceNodeID, targetSpaceID int64, targetParentID *int64, expectedRevision int64) (WikiNodeEntry, error)
}

func cleanWikiName(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	n := utf8.RuneCountInString(trimmed)
	return trimmed, n >= 1 && n <= 100
}

func cleanWikiDescription(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	return trimmed, utf8.RuneCountInString(trimmed) <= 500
}

func cleanWikiIcon(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	return trimmed, utf8.RuneCountInString(trimmed) <= 64
}

func validWikiVisibility(v string) bool {
	return v == WikiVisibilityWorkspace || v == WikiVisibilityPrivate
}

func validWikiGrantSubjectType(t string) bool {
	return t == SubjectTypeUser || t == SubjectTypeDepartment || t == SubjectTypeGroup
}

func validWikiNodeKind(kind string) bool {
	return kind == "doc" || kind == "sheet" || kind == "base" || kind == "slides" || kind == "folder"
}

func roleFromRank(rank int) string {
	switch rank {
	case 3:
		return RoleManage
	case 2:
		return RoleEdit
	case 1:
		return RoleView
	default:
		return ""
	}
}
