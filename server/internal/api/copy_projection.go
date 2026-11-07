package api

import (
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

const maxCopyClock = uint64(1<<53 - 1)

// collectCopyFileIDs returns only visible attachment blocks. Empty placeholders
// are retained as-is; a malformed nonempty reference is rejected before create.
func collectCopyFileIDs(src *collab.Doc) ([]int64, error) {
	if src == nil || src.Pending() != 0 {
		return nil, fmt.Errorf("copy source is unavailable or incomplete")
	}
	seen := map[int64]bool{}
	for _, b := range src.View().Blocks {
		if b.Type != "image" && b.Type != "file" {
			continue
		}
		if b.Props["fileId"] == "" {
			continue
		}
		id, err := parseCopyFileID(b.Props["fileId"])
		if err != nil {
			return nil, fmt.Errorf("invalid attachment reference in block %s: %w", b.ID, err)
		}
		seen[id] = true
	}
	ids := make([]int64, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids, nil
}

func parseCopyFileID(value string) (int64, error) {
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != value {
		return 0, fmt.Errorf("fileId must be a canonical positive integer")
	}
	return id, nil
}

func parseCopyBlockID(value string) (collab.OpID, error) {
	client, clock, ok := strings.Cut(value, ":")
	if !ok {
		return collab.OpID{}, fmt.Errorf("invalid block ID")
	}
	c, err := strconv.ParseUint(client, 10, 64)
	if err != nil || c > maxCopyClock {
		return collab.OpID{}, fmt.Errorf("invalid block client")
	}
	k, err := strconv.ParseUint(clock, 10, 64)
	if err != nil || k > maxCopyClock || c == 0 && k == 0 {
		return collab.OpID{}, fmt.Errorf("invalid block clock")
	}
	id := collab.OpID{Client: c, Clock: k}
	if id.Key() != value {
		return collab.OpID{}, fmt.Errorf("noncanonical block ID")
	}
	return id, nil
}

// buildCopyOps constructs a complete initial operation log without mutating
// src. It verifies the result before the caller commits the destination node.
func buildCopyOps(src *collab.Doc, title string, files map[int64]int64) ([]store.RawOp, error) {
	ids, err := collectCopyFileIDs(src)
	if err != nil {
		return nil, err
	}
	if len(ids) != len(files) {
		return nil, fmt.Errorf("incomplete attachment mapping")
	}
	sources := make(map[int64]bool, len(ids))
	for _, id := range ids {
		sources[id] = true
	}
	destinations := map[int64]bool{}
	for _, id := range ids {
		mapped := files[id]
		if mapped <= 0 || destinations[mapped] || sources[mapped] {
			return nil, fmt.Errorf("invalid destination attachment mapping")
		}
		destinations[mapped] = true
	}
	if !utf8.ValidString(title) {
		return nil, fmt.Errorf("invalid title encoding")
	}
	target, err := collab.DecodeState(src.EncodeState())
	if err != nil {
		return nil, fmt.Errorf("clone source: %w", err)
	}
	blocks := target.View().Blocks
	standardTitle := false
	for _, b := range blocks {
		if b.ID == "0:1" && b.Parent == "0:0" && b.Type == "title" {
			standardTitle = true
		}
	}
	if !standardTitle {
		return nil, fmt.Errorf("source does not have a visible standard title")
	}
	titleID := collab.OpID{Client: 0, Clock: 1}
	// Deleting a character run can consume one operation per character; keep
	// enough room for title changes and attachment rewrites in the wire clock.
	reserve := uint64(utf8.RuneCountInString(target.Text(titleID))) + uint64(utf8.RuneCountInString(title)) + uint64(len(blocks)) + 2
	if target.Clock() > maxCopyClock || reserve > maxCopyClock-target.Clock() {
		return nil, fmt.Errorf("source clock has no room for copy projection")
	}
	if old := target.Text(titleID); old != title {
		if n := utf8.RuneCountInString(old); n != 0 {
			target.DeleteText(0, titleID, 0, n)
		}
		if title != "" {
			target.InsertText(0, titleID, 0, title)
		}
	}
	for _, b := range blocks {
		if b.Type != "image" && b.Type != "file" {
			continue
		}
		if b.Props["fileId"] == "" {
			continue
		}
		id, _ := parseCopyFileID(b.Props["fileId"])
		blockID, err := parseCopyBlockID(b.ID)
		if err != nil {
			return nil, fmt.Errorf("attachment block ID: %w", err)
		}
		value := strconv.FormatInt(files[id], 10)
		op := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 0, Clock: target.Clock() + 1}, Block: blockID, Key: "fileId", Value: &value}
		if !target.Apply(op) || target.Pending() != 0 {
			return nil, fmt.Errorf("cannot rewrite attachment reference")
		}
	}
	initial := syncsrv.InitialOps(title)
	current := collab.NewDoc()
	for _, raw := range initial {
		ops, err := collab.DecodeOps(raw.Bytes)
		if err != nil || len(ops) != 1 || !current.Apply(ops[0]) {
			return nil, fmt.Errorf("invalid initial document operations")
		}
	}
	generated, err := collab.RestoreOpsChecked(current, target, 0)
	if err != nil {
		return nil, fmt.Errorf("copy projection: %w", err)
	}
	if current.Pending() != 0 || !sameCopyShape(current.View(), target.View()) {
		return nil, fmt.Errorf("copy projection did not preserve document content")
	}
	out := append([]store.RawOp(nil), initial...)
	for _, op := range generated {
		if op.ID.Client > maxCopyClock || op.ID.Clock > maxCopyClock {
			return nil, fmt.Errorf("copy operation exceeds wire clock limit")
		}
		encoded, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			return nil, fmt.Errorf("encode copy operation: %w", err)
		}
		// Decode once as a guard against unsupported values in the wire format.
		if decoded, err := collab.DecodeOps(encoded); err != nil || len(decoded) != 1 {
			return nil, fmt.Errorf("copy operation is not wire compatible")
		}
		out = append(out, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: encoded})
	}
	return out, nil
}

// sameCopyShape compares the complete visible tree, including sibling order,
// text formatting and props, while ignoring only replica-specific block IDs.
func sameCopyShape(a, b collab.DocView) bool {
	if len(a.Blocks) != len(b.Blocks) {
		return false
	}
	// View is depth-first with every parent preceding its children. Comparing
	// each parent by its ordinal preserves nesting without recursive traversal.
	aIndex, bIndex := map[string]int{"0:0": -1}, map[string]int{"0:0": -1}
	for i, x := range a.Blocks {
		y := b.Blocks[i]
		xParent, xOK := aIndex[x.Parent]
		yParent, yOK := bIndex[y.Parent]
		_, xDuplicate := aIndex[x.ID]
		_, yDuplicate := bIndex[y.ID]
		if !xOK || !yOK || xDuplicate || yDuplicate || xParent != yParent || x.Type != y.Type || !reflect.DeepEqual(x.Props, y.Props) || !reflect.DeepEqual(x.Spans, y.Spans) {
			return false
		}
		aIndex[x.ID], bIndex[y.ID] = i, i
	}
	return true
}
