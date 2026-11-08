package store

import (
	"context"
	"encoding/json"
	"time"
)

// SlidesPage is one ordered page of a slides (presentation) node. The first
// slice carries plain title/bullet-body/background; rich collaborative
// content follows the table sub-CRDT integration path.
type SlidesPage struct {
	ID         int64           `json:"id"`
	SlidesID   int64           `json:"slidesId"`
	Pos        float64         `json:"pos"`
	Title      string          `json:"title"`
	Body       string          `json:"body"`
	Background string          `json:"background"`
	Notes      string          `json:"notes"`
	Shapes     json.RawMessage `json:"shapes"`
	Revision   int64           `json:"revision"`
	UpdatedAt  time.Time       `json:"updatedAt"`
}

// SlidesStore manages presentation pages. Mutations revalidate the session
// (guard) and require edit access on the owning slides node.
type SlidesStore interface {
	CreateSlidesPage(ctx context.Context, guard RestoreGuard, slidesID int64, title string) (SlidesPage, error)
	ListSlidesPages(ctx context.Context, userID, slidesID int64) ([]SlidesPage, error)
	UpdateSlidesPage(ctx context.Context, guard RestoreGuard, pageID int64, title, body, background string, notes *string, shapes *json.RawMessage, expectedRevision int64) (SlidesPage, error)
	DeleteSlidesPage(ctx context.Context, guard RestoreGuard, pageID int64) error
	// MoveSlidesPage repositions a page (pos ordering; the client sends the
	// midpoint between neighbours).
	MoveSlidesPage(ctx context.Context, guard RestoreGuard, pageID int64, pos float64) error
}
