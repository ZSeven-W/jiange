package store

import (
	"context"
	"time"
)

// DocMeta is a document node in a workspace's directory tree.
type DocMeta struct {
	ID          int64     `json:"id"`
	WorkspaceID int64     `json:"workspaceId"`
	ParentID    *int64    `json:"parentId"`
	Kind        string    `json:"kind"` // doc | base
	Title       string    `json:"title"`
	Icon        string    `json:"icon"`
	CreatorID   int64     `json:"creatorId"`
	CreatorName string    `json:"creatorName"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
	// WorkspaceName is the owning workspace's name (bread crumbs for shared docs).
	WorkspaceName string `json:"workspaceName,omitempty"`
	// CopyProtected docs watermark and disable copy/download for non-manage roles.
	CopyProtected bool `json:"copyProtected,omitempty"`
	// Role is the caller's access (view/edit/manage), set by GetDoc.
	Role string `json:"role,omitempty"`
}

// RawOp is one encoded operation (a single-op batch) and its identity.
type RawOp struct {
	ClientID int64
	Clock    int64
	Bytes    []byte
}

// SeqOp is a persisted op with its server sequence number.
type SeqOp struct {
	Seq      int64
	ClientID int64
	Bytes    []byte
}

// TitleSnapshot is one consistent database observation of a node and its
// collaborative history. It is not an authorization decision.
type TitleSnapshot struct {
	DirectoryTitle    string
	Head, SnapshotSeq int64
	Snapshot          []byte
	Ops               []SeqOp
}

// DocCopy describes one snapshot-based copy. FileIDs are the distinct source
// attachments referenced by that snapshot. Build runs inside the creation
// transaction and must be deterministic, side-effect-free, and must not call
// the Store; it receives freshly allocated attachment IDs for the new doc.
type DocCopy struct {
	SourceID, UserID, WorkspaceID int64
	ParentID                      *int64
	Title                         string
	FileIDs                       []int64
}

type DocCopyBuilder func(map[int64]int64) ([]RawOp, error)

// RestoreGuard identifies the already-authenticated caller without storing a
// raw session token. Now is evaluated after locks are acquired.
type RestoreGuard struct {
	UserID      int64
	SessionHash []byte
	Now         func() time.Time
}

func (g RestoreGuard) currentTime() time.Time {
	if g.Now != nil {
		return g.Now()
	}
	return time.Now()
}

// DocStore persists documents, their op logs and snapshots.
type DocStore interface {
	ShareStore
	BaseStore
	// CreateDoc creates a doc node; initial ops get seqs 1..n.
	CreateDoc(ctx context.Context, workspaceID, creatorID int64, parentID *int64, title string, initial []RawOp) (DocMeta, error)
	// CopyDoc atomically creates the document, its file references and all ops.
	// Referenced blobs are immutable and shared; any future blob garbage
	// collector must retain an object while any attachment references it.
	CopyDoc(ctx context.Context, copy DocCopy, build DocCopyBuilder) (DocMeta, error)
	ListDocs(ctx context.Context, userID int64) ([]DocMeta, error)
	// SearchDocs is legacy and must not be used for current-content search:
	// implementations may inspect history rather than materialized state.
	SearchDocs(ctx context.Context, userID int64, q string) ([]DocMeta, error)
	// SearchCandidates pages all currently accessible, non-deleted nodes in ID
	// order. Search itself is performed on the materialized collaborative state.
	SearchCandidates(ctx context.Context, userID, afterID int64, limit int) ([]DocMeta, error)
	// Favorites (stars): user-scoped, survive doc moves.
	ListFavorites(ctx context.Context, userID int64) ([]DocMeta, error)
	AddFavorite(ctx context.Context, userID, docID int64) error
	RemoveFavorite(ctx context.Context, userID, docID int64) error
	// Ancestors returns parent chain from the doc up to the root (bread crumbs).
	Ancestors(ctx context.Context, userID, docID int64) ([]DocMeta, error)
	// GetDoc returns the doc if userID is a member of its workspace, else ErrNotFound.
	GetDoc(ctx context.Context, userID, docID int64) (DocMeta, error)
	// GetDocSystem fetches meta without any user-scoped access check (public
	// share snapshots, system sweeps).
	GetDocSystem(ctx context.Context, docID int64) (DocMeta, error)
	SetCopyProtected(ctx context.Context, docID int64, on bool) error
	UpdateTitle(ctx context.Context, docID int64, title string) (DocMeta, error)
	// Trash soft-deletes a doc and its descendants; Restore undoes it.
	Trash(ctx context.Context, docID int64) error
	Restore(ctx context.Context, docID int64) error
	ListTrash(ctx context.Context, userID int64) ([]DocMeta, error)
	// Move re-parents a doc (nil = workspace root); ErrConflict on cycles.
	Move(ctx context.Context, docID int64, parentID *int64) error
	CanCreateIn(ctx context.Context, userID, workspaceID int64) (bool, error)

	AllocClient(ctx context.Context, userID, docID int64) (int64, error)
	// ClientOwner returns the user and doc a replica id was issued to.
	ClientOwner(ctx context.Context, clientID int64) (userID, docID int64, err error)
	SetAck(ctx context.Context, clientID, seq int64, now time.Time) error
	// Horizon is the smallest acked seq among clients seen since `since`
	// (or head when there are none): every op at or below it is known everywhere.
	Horizon(ctx context.Context, docID int64, since time.Time) (int64, error)

	// AppendOps assigns consecutive seqs to ops not already stored (by
	// client/clock identity). seqs[i] is 0 for duplicates.
	AppendOps(ctx context.Context, docID int64, ops []RawOp) (seqs []int64, err error)
	// AppendRestoreOps atomically verifies the current edit grant and head before
	// appending a restore plan derived from that exact head. It returns
	// ErrConflict when concurrent edits invalidate the plan, or ErrForbidden
	// when the caller no longer has edit access.
	AppendRestoreOps(ctx context.Context, guard RestoreGuard, docID, expectedHead int64, ops []RawOp) (seqs []int64, err error)
	OpsAfter(ctx context.Context, docID, after int64, limit int) ([]SeqOp, error)
	Head(ctx context.Context, docID int64) (int64, error)
	LatestSnapshot(ctx context.Context, docID int64) (seq int64, state []byte, err error) // ErrNotFound if none
	ReadTitleSnapshot(ctx context.Context, docID int64) (TitleSnapshot, error)
	SaveSnapshot(ctx context.Context, docID, seq int64, state []byte) error
	// Listen calls fn(docID, head) whenever any instance appends ops; blocks until ctx ends.
	Listen(ctx context.Context, fn func(docID, head int64)) error
}
