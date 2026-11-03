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
	Title       string    `json:"title"`
	Icon        string    `json:"icon"`
	CreatorID   int64     `json:"creatorId"`
	CreatorName string    `json:"creatorName"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
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

// DocStore persists documents, their op logs and snapshots.
type DocStore interface {
	ShareStore
	// CreateDoc creates a doc node; initial ops get seqs 1..n.
	CreateDoc(ctx context.Context, workspaceID, creatorID int64, parentID *int64, title string, initial []RawOp) (DocMeta, error)
	ListDocs(ctx context.Context, userID int64) ([]DocMeta, error)
	// GetDoc returns the doc if userID is a member of its workspace, else ErrNotFound.
	GetDoc(ctx context.Context, userID, docID int64) (DocMeta, error)
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
	OpsAfter(ctx context.Context, docID, after int64, limit int) ([]SeqOp, error)
	Head(ctx context.Context, docID int64) (int64, error)
	LatestSnapshot(ctx context.Context, docID int64) (seq int64, state []byte, err error) // ErrNotFound if none
	SaveSnapshot(ctx context.Context, docID, seq int64, state []byte) error
	// Listen calls fn(docID, head) whenever any instance appends ops; blocks until ctx ends.
	Listen(ctx context.Context, fn func(docID, head int64)) error
}
