package store

import (
	"context"
	"time"
)

const MaxRecentDocs = 100

// RecentDoc embeds current metadata and records when this user last opened it.
type RecentDoc struct {
	DocMeta
	ViewedAt time.Time `json:"viewedAt"`
}

type RecentStore interface {
	// RecordVisit must check access at the point of recording, not rely on a
	// previous API check. Repeated visits never move the timestamp backwards.
	RecordVisit(ctx context.Context, userID, docID int64, at time.Time) error
	// RecentDocs returns only live documents the user can still access.
	RecentDocs(ctx context.Context, userID int64, limit int) ([]RecentDoc, error)
}

func recentLimit(limit int) int {
	if limit <= 0 || limit > MaxRecentDocs {
		return MaxRecentDocs
	}
	return limit
}
