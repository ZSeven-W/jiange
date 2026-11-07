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
	// The two action policies apply only after document access is established.
	// CopyProtected remains a conservative compatibility projection.
	CopyMinRole         string `json:"copyMinRole,omitempty"`
	DownloadMinRole     string `json:"downloadMinRole,omitempty"`
	CommentMinRole      string `json:"commentMinRole,omitempty"`
	PermissionsRevision int64  `json:"permissionsRevision"`
	// Role is the caller's access (view/edit/manage), set by GetDoc.
	Role string `json:"role,omitempty"`
	// DriveRevision is the optimistic-concurrency version of directory
	// mutations (move/trash/restore); nodes never touched by the versioned
	// drive API stay at 0.
	DriveRevision int64 `json:"driveRevision"`
	// TrashBatchID groups the subtree of one guarded trash operation; 0 when
	// the node was deleted by the legacy unversioned endpoint.
	TrashBatchID int64 `json:"trashBatchId,omitempty"`
}

func documentActionAllowed(meta DocMeta, role, threshold string) bool {
	if role == "anon" {
		role = RoleView
	}
	if RoleRank(role) == 0 {
		return false
	}
	// Base and pre-migration metadata retain the legacy combined policy.
	if meta.Kind == "base" || threshold == "" {
		threshold = RoleView
		if meta.CopyProtected {
			threshold = RoleManage
		}
	}
	if RoleRank(threshold) == 0 {
		return false
	}
	return RoleRank(role) >= RoleRank(threshold)
}

// These helpers do not grant access: callers must authorize the document first.
func DocumentCopyAllowed(meta DocMeta, role string) bool {
	return documentActionAllowed(meta, role, meta.CopyMinRole)
}

func DocumentDownloadAllowed(meta DocMeta, role string) bool {
	return documentActionAllowed(meta, role, meta.DownloadMinRole)
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
	// Guard is required by authenticated request handlers. A nil guard is
	// reserved for trusted internal callers, such as direct store operations.
	Guard *RestoreGuard
	// Cover is the preflight source cover; the transaction rechecks its revision
	// and remaps any attachment into the newly created document.
	Cover *DocCover
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
	DocCoverGuarded(ctx context.Context, guard RestoreGuard, docID int64) (DocCover, error)
	SetDocCoverGuarded(ctx context.Context, guard RestoreGuard, docID int64, cover DocCover, expectedRevision int64) (DocCover, error)
	DocCoverSystem(ctx context.Context, docID int64) (DocCover, error)
	// DocIconGuarded reads a document icon after revalidating the caller.
	DocIconGuarded(ctx context.Context, guard RestoreGuard, docID int64) (DocIcon, error)
	// SetDocIconGuarded checks edit access and the expected icon revision in the same write transaction.
	SetDocIconGuarded(ctx context.Context, guard RestoreGuard, docID int64, icon string, expectedRevision int64) (DocIcon, error)
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
	// ExistingOpIDs checks operation start IDs in the durable log. It is a
	// read-only hint: a subsequent write must use AppendOpsAtHead to fence
	// concurrent changes between this lookup and that write.
	ExistingOpIDs(ctx context.Context, docID int64, ops []RawOp) ([]bool, error)
	// AppendOpsAtHead performs the ordinary append only if the locked head
	// still equals expectedHead; otherwise it returns ErrConflict.
	AppendOpsAtHead(ctx context.Context, docID, expectedHead int64, ops []RawOp) ([]int64, error)
	// AppendRestoreOps atomically verifies the current edit grant and head before
	// appending a restore plan derived from that exact head. It returns
	// ErrConflict when concurrent edits invalidate the plan, or ErrForbidden
	// when the caller no longer has edit access.
	AppendRestoreOps(ctx context.Context, guard RestoreGuard, docID, expectedHead int64, ops []RawOp) (seqs []int64, err error)
	OpsAfter(ctx context.Context, docID, after int64, limit int) ([]SeqOp, error)
	Head(ctx context.Context, docID int64) (int64, error)
	// HeadVersion returns the history epoch and head; the epoch is an
	// independent log generation (rollback/restore detection).
	HeadVersion(ctx context.Context, docID int64) (epoch, head int64, err error)
	// BumpHistoryEpoch starts a new log generation (restore tooling).
	BumpHistoryEpoch(ctx context.Context, docID int64) error
	LatestSnapshot(ctx context.Context, docID int64) (seq int64, state []byte, err error) // ErrNotFound if none
	ReadTitleSnapshot(ctx context.Context, docID int64) (TitleSnapshot, error)
	SaveSnapshot(ctx context.Context, docID, seq int64, state []byte) error
	// Listen calls fn(docID, head) whenever any instance appends ops; blocks until ctx ends.
	Listen(ctx context.Context, fn func(docID, head int64)) error
}
