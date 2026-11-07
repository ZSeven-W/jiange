package store

import (
	"context"
	"errors"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
)

// ErrBaseSnapshotTooLarge is returned instead of silently truncating a
// response whose complete authorization scope cannot be represented safely.
var ErrBaseSnapshotTooLarge = errors.New("store: base snapshot too large")

// BaseSnapshotReader exposes only the reads needed to construct one Base
// response. Every method observes the same database snapshot. Implementations
// must not retain the reader after the callback returns.
type BaseSnapshotReader interface {
	GetDoc(context.Context, int64, int64) (DocMeta, error)
	Fields(context.Context, int64) ([]Field, error)
	Views(context.Context, int64) ([]View, error)
	QueryRecordsConstrained(context.Context, int64, []Field, []btquery.Config, btquery.Config, int) ([]Record, error)
	// RecordsConstrainedByIDs returns the authorized subset of the exact IDs,
	// without applying the page limit used by the main table view.
	RecordsConstrainedByIDs(context.Context, int64, []int64, []Field, []btquery.Config) ([]Record, error)
	BtHead(context.Context, int64) (int64, error)
	WorkspaceMembers(context.Context, int64) ([]User, error)
	// VisibleMemberNames returns only requested users belonging to the specified
	// workspace; callers must derive IDs from already-authorized records.
	VisibleMemberNames(context.Context, int64, []int64) (map[int64]string, error)
	Workspaces(context.Context, int64) ([]Workspace, error)
	LinksForRecords(context.Context, int64, []int64) (map[int64][]int64, error)
	// LinksToRecords maps each requested target ID to its referring source IDs.
	LinksToRecords(context.Context, int64, []int64) (map[int64][]int64, error)
	LinksForRecordsConstrained(context.Context, int64, []int64, int64, []Field, []btquery.Config) (map[int64][]int64, error)
	LinksToRecordsConstrained(context.Context, int64, []int64, int64, []Field, []btquery.Config) (map[int64][]int64, error)
	LinkFieldsTargeting(context.Context, int64) ([]LinkFieldRef, error)
}

// BaseSnapshotStore acquires a single, read-only snapshot for one response.
// The callback must not perform writes, external I/O, or retain its reader.
type BaseSnapshotStore interface {
	WithBaseReadSnapshot(context.Context, int64, int64, func(BaseSnapshotReader) error) error
}
