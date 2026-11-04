package store

import (
	"context"
	"time"
)

// Version is a named snapshot users can restore to.
type Version struct {
	Seq           int64     `json:"seq"`
	Label         string    `json:"label"`
	CreatedBy     int64     `json:"createdBy"`
	CreatedByName string    `json:"createdByName"`
	CreatedAt     time.Time `json:"createdAt"`
}

type VersionStore interface {
	// SaveVersion marks the snapshot at seq as a named version (the snapshot
	// must already exist; SaveSnapshot writes it first).
	SaveVersion(ctx context.Context, doc, seq int64, label string, userID int64) error
	// Versions lists a doc's versions, newest first.
	Versions(ctx context.Context, doc int64) ([]Version, error)
	// VersionState returns the encoded state of one version snapshot.
	VersionState(ctx context.Context, doc, seq int64) ([]byte, error)
	// RecentDocIDs lists docs with ops persisted after `since` (auto-version sweep).
	RecentDocIDs(ctx context.Context, since time.Time) ([]int64, error)
}
