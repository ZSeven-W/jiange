package store

import (
	"context"
	"encoding/json"
	"strings"
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
	CreateSlidesFile(ctx context.Context, guard RestoreGuard, slidesID int64, file FileMeta) (FileMeta, error)
	CreateSlidesPage(ctx context.Context, guard RestoreGuard, slidesID int64, title string) (SlidesPage, error)
	ListSlidesPages(ctx context.Context, userID, slidesID int64) ([]SlidesPage, error)
	UpdateSlidesPage(ctx context.Context, guard RestoreGuard, pageID int64, title, body, background string, notes *string, shapes *json.RawMessage, expectedRevision int64) (SlidesPage, error)
	DeleteSlidesPage(ctx context.Context, guard RestoreGuard, pageID int64) error
	// MoveSlidesPage repositions a page (pos ordering; the client sends the
	// midpoint between neighbours).
	MoveSlidesPage(ctx context.Context, guard RestoreGuard, pageID int64, pos float64) error
	// CopySlidesDeck publishes a full deck copy — node, remapped image
	// references and every page — as one critical section. It returns the new
	// node metadata and the copied pages with their fresh ids.
	CopySlidesDeck(ctx context.Context, c SlidesDeckCopy) (DocMeta, []SlidesPage, error)
}

// SlidesDeckCopy carries the caller-verified destination for a full deck copy.
// Guard is required by authenticated request handlers; a nil guard is reserved
// for trusted internal callers.
type SlidesDeckCopy struct {
	SourceID, UserID, WorkspaceID int64
	ParentID                      *int64
	Title                         string
	Guard                         *RestoreGuard
}

// slideImageIDs is also checked in the write transaction, so a client cannot
// attach another document's file by guessing its id.
func slideImageIDs(shapes json.RawMessage) ([]int64, error) {
	var items []struct {
		Kind   string `json:"kind"`
		FileID int64  `json:"fileId"`
	}
	if err := json.Unmarshal(shapes, &items); err != nil {
		return nil, ErrConflict
	}
	var ids []int64
	seen := map[int64]bool{}
	for _, item := range items {
		if item.Kind == "image" {
			if item.FileID <= 0 {
				return nil, ErrConflict
			}
			if !seen[item.FileID] {
				ids = append(ids, item.FileID)
				seen[item.FileID] = true
			}
		}
	}
	return ids, nil
}

// SlideImageIDs extracts the distinct image attachment ids referenced by a
// shapes payload, for callers outside the store package.
func SlideImageIDs(shapes json.RawMessage) ([]int64, error) { return slideImageIDs(shapes) }

// remapSlideShapes rewrites image fileIds through mapping while preserving
// every other field of the payload.
func remapSlideShapes(shapes json.RawMessage, mapping map[int64]int64) (json.RawMessage, error) {
	if len(mapping) == 0 {
		return shapes, nil
	}
	var items []map[string]any
	if err := json.Unmarshal(shapes, &items); err != nil {
		return nil, ErrConflict
	}
	for _, item := range items {
		if kind, _ := item["kind"].(string); kind != "image" {
			continue
		}
		raw, ok := item["fileId"].(float64)
		if !ok || raw <= 0 {
			return nil, ErrConflict
		}
		mapped, ok := mapping[int64(raw)]
		if !ok {
			return nil, ErrNotFound
		}
		item["fileId"] = mapped
	}
	out, err := json.Marshal(items)
	if err != nil {
		return nil, err
	}
	return out, nil
}

func slideImageMIME(mime string) bool {
	switch strings.ToLower(mime) {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp":
		return true
	}
	return false
}
