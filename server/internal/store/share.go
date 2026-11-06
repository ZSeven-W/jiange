package store

import (
	"context"
	"time"
)

// Roles, weakest first. "" means no access.
const (
	RoleView   = "view"
	RoleEdit   = "edit"
	RoleManage = "manage"
)

// RoleRank orders roles: none 0 < view 1 < edit 2 < manage 3.
func RoleRank(r string) int {
	switch r {
	case RoleView:
		return 1
	case RoleEdit:
		return 2
	case RoleManage:
		return 3
	}
	return 0
}

// Share is an explicit per-doc grant to a user (inherited by sub-docs).
type Share struct {
	UserID int64  `json:"userId"`
	Name   string `json:"name"`
	Email  string `json:"email"`
	Role   string `json:"role"`
}

// Link is a doc's link-sharing setting.
type Link struct {
	Role  string `json:"role"` // none | view | edit
	Token string `json:"token,omitempty"`
}

// FileMeta is an attachment stored in the blob store under ObjectKey.
type FileMeta struct {
	ID         int64     `json:"id"`
	DocID      int64     `json:"docId"`
	UploaderID int64     `json:"uploaderId"`
	Name       string    `json:"name"`
	Mime       string    `json:"mime"`
	Size       int64     `json:"size"`
	ObjectKey  string    `json:"-"`
	CreatedAt  time.Time `json:"createdAt"`
}

// ShareStore manages access to docs. GetDoc fills DocMeta.Role:
// workspace owner/admin or creator → manage, workspace member → edit,
// otherwise the strongest share on the doc or an ancestor.
type ShareStore interface {
	ListShares(ctx context.Context, docID int64) ([]Share, error)
	// SetShare grants role ("" revokes) to a user.
	SetShare(ctx context.Context, docID, userID int64, role string) error
	GetLink(ctx context.Context, docID int64) (Link, error)
	SetLink(ctx context.Context, docID int64, l Link) error
	// ChangeLinkRole atomically changes a setting and rotates the token when a
	// disabled link is enabled. candidate is a freshly generated secret.
	ChangeLinkRole(ctx context.Context, docID int64, role, candidate string) (Link, error)
	// DocByToken resolves a share link to its doc and role (ErrNotFound if off).
	DocByToken(ctx context.Context, token string) (docID int64, role string, err error)
	// JoinLink records that this user presented the currently valid token.
	// The grant follows the link's current role and is separate from invitations.
	JoinLink(ctx context.Context, token string, userID int64) (docID int64, err error)
	// SharedWithMe lists docs shared to the user from outside their workspaces.
	SharedWithMe(ctx context.Context, userID int64) ([]DocMeta, error)
	// WorkspaceMembers lists a workspace's users (for person fields and share dialogs).
	WorkspaceMembers(ctx context.Context, workspaceID int64) ([]User, error)
	CreateFile(ctx context.Context, f FileMeta) (FileMeta, error)
	GetFile(ctx context.Context, id int64) (FileMeta, error)
}
