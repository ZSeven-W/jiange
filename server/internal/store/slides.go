package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// SlidesPage is one ordered page of a slides (presentation) node. The first
// slice carries plain title/bullet-body/background; rich collaborative
// content follows the table sub-CRDT integration path.
var ErrSlideClientOutdated = errors.New("store: slide client does not support layout")

func ValidSlideLayout(layout string) bool {
	return layout == "" || layout == "title" || layout == "blank" || layout == "blank-title"
}

// SlideCreationLayout maps a creation preset to existing persisted primitives.
// Two columns are ordinary editable text shapes on a blank page; the preset
// name itself is never stored as a new layout protocol value.
func SlideCreationLayout(preset string) (string, json.RawMessage, bool) {
	if preset == "two-column" {
		return "blank", json.RawMessage(`[{"id":"preset-two-title","kind":"text","x":7,"y":8,"width":86,"height":12,"color":"#1f2329","text":"","fontSize":36,"bold":true},{"id":"preset-two-left","kind":"text","x":7,"y":27,"width":40,"height":57,"color":"#1f2329","text":"","fontSize":24},{"id":"preset-two-right","kind":"text","x":53,"y":27,"width":40,"height":57,"color":"#1f2329","text":"","fontSize":24}]`), true
	}
	if !ValidSlideLayout(preset) {
		return "", nil, false
	}
	return preset, json.RawMessage(`[]`), true
}

type SlidesPage struct {
	ID         int64           `json:"id"`
	SlidesID   int64           `json:"slidesId"`
	Pos        float64         `json:"pos"`
	Title      string          `json:"title"`
	Body       string          `json:"body"`
	Background string          `json:"background"`
	Layout     string          `json:"layout"`
	Notes      string          `json:"notes"`
	Shapes     json.RawMessage `json:"shapes"`
	Hidden     bool            `json:"hidden"`
	Revision   int64           `json:"revision"`
	UpdatedAt  time.Time       `json:"updatedAt"`
}

// SlidesStore manages presentation pages. Mutations revalidate the session
// (guard) and require edit access on the owning slides node.
type SlidesStore interface {
	CreateSlidesFile(ctx context.Context, guard RestoreGuard, slidesID int64, file FileMeta) (FileMeta, error)
	CreateSlidesPage(ctx context.Context, guard RestoreGuard, slidesID int64, title string) (SlidesPage, error)
	// Insert after the verified anchor; pageID=0 creates the first page only
	// when the deck is still empty.
	InsertSlidesPage(ctx context.Context, guard RestoreGuard, slidesID, pageID, expectedRevision int64) (SlidesPage, error)
	// Insert a page and its initial layout under the same authorization and anchor lock.
	InsertSlidesPageWithLayout(ctx context.Context, guard RestoreGuard, slidesID, pageID, expectedRevision int64, layout string) (SlidesPage, error)
	DuplicateSlidesPage(ctx context.Context, guard RestoreGuard, slidesID, pageID, expectedRevision int64) (SlidesPage, error)
	ListSlidesPages(ctx context.Context, userID, slidesID int64) ([]SlidesPage, error)
	UpdateSlidesPage(ctx context.Context, guard RestoreGuard, pageID int64, title, body, background string, notes *string, shapes *json.RawMessage, expectedRevision int64) (SlidesPage, error)
	UpdateSlidesPageV3(ctx context.Context, guard RestoreGuard, slidesID, pageID int64, title, body, background, layout string, notes *string, shapes *json.RawMessage, expectedRevision int64) (SlidesPage, error)
	SetSlidesPageHidden(ctx context.Context, guard RestoreGuard, slidesID, pageID, expectedRevision int64, hidden bool) (SlidesPage, error)
	DeleteSlidesPage(ctx context.Context, guard RestoreGuard, pageID int64) error
	// Delete only the specified version from the expected deck.
	DeleteSlidesPageVersion(ctx context.Context, guard RestoreGuard, slidesID, pageID, expectedRevision int64) error
	// MoveSlidesPage repositions a page (pos ordering; the client sends the
	// midpoint between neighbours).
	MoveSlidesPage(ctx context.Context, guard RestoreGuard, pageID int64, pos float64) error
	// CopySlidesDeck publishes a full deck copy — node, remapped image
	// references and every page — as one critical section. It returns the new
	// node metadata and the copied pages with their fresh ids.
	CopySlidesDeck(ctx context.Context, c SlidesDeckCopy) (DocMeta, []SlidesPage, error)
}

// SlidesShapesV4Store fences clients that cannot render expanded shape kinds.
type SlidesShapesV4Store interface {
	UpdateSlidesPageV4(context.Context, RestoreGuard, int64, int64, string, string, string, string, *string, *json.RawMessage, int64) (SlidesPage, error)
}

// SlidesShapesV5Store fences line shapes from clients that only know V4.
type SlidesShapesV5Store interface {
	UpdateSlidesPageV5(context.Context, RestoreGuard, int64, int64, string, string, string, string, *string, *json.RawMessage, int64) (SlidesPage, error)
}

func HasSlidesV5Shapes(raw json.RawMessage) bool {
	var shapes []struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal(raw, &shapes) != nil {
		return true
	}
	for _, shape := range shapes {
		switch shape.Kind {
		case "rectangle", "ellipse", "triangle", "rounded-rectangle", "right-triangle", "diamond", "pentagon", "hexagon", "star", "parallelogram", "trapezoid", "arrow-right", "text", "image":
		default:
			return true
		}
	}
	return false
}

func HasModernSlideShapes(raw json.RawMessage) bool {
	var shapes []struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal(raw, &shapes) != nil {
		return true
	}
	for _, shape := range shapes {
		switch shape.Kind {
		case "rectangle", "ellipse", "triangle", "text", "image":
		default:
			return true
		}
	}
	return false
}

// SlidesDeckCopy carries the caller-verified destination for a full deck copy.
// Guard is required by authenticated request handlers; a nil guard is reserved
// for trusted internal callers.
type SlidesDeckCopy struct {
	SourceID, UserID, WorkspaceID int64
	ParentID                      *int64
	Personal                      *bool
	Title                         string
	Guard                         *RestoreGuard
	// Non-nil binds the copy to the image ids whose blobs were verified by the caller.
	VerifiedImageIDs []int64
}

func sameSlideImageIDs(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	seen := make(map[int64]bool, len(a))
	for _, id := range a {
		if seen[id] {
			return false
		}
		seen[id] = true
	}
	for _, id := range b {
		if !seen[id] {
			return false
		}
		delete(seen, id)
	}
	return len(seen) == 0
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
	var items []map[string]json.RawMessage
	if err := json.Unmarshal(shapes, &items); err != nil {
		return nil, ErrConflict
	}
	for _, item := range items {
		var kind string
		if err := json.Unmarshal(item["kind"], &kind); err != nil {
			return nil, ErrConflict
		}
		if kind != "image" {
			continue
		}
		var raw int64
		if err := json.Unmarshal(item["fileId"], &raw); err != nil || raw <= 0 {
			return nil, ErrConflict
		}
		mapped, ok := mapping[raw]
		if !ok {
			return nil, ErrNotFound
		}
		encoded, err := json.Marshal(mapped)
		if err != nil {
			return nil, err
		}
		item["fileId"] = encoded
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
