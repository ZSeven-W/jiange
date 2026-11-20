package store

import (
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	SheetMergeModeStrict = "strict"
	SheetMergeModeAuto   = "auto"
)

// SheetStylePatch updates only the specified style attributes on a cell so
// concurrent formatting changes to orthogonal fields (e.g. bold vs bg) merge
// without conflicting.
type SheetStylePatch struct {
	Bold         *bool         `json:"bold,omitempty"`
	Italic       *bool         `json:"italic,omitempty"`
	Underline    *bool         `json:"underline,omitempty"`
	Strike       *bool         `json:"strike,omitempty"`
	FontFamily   *string       `json:"fontFamily,omitempty"`
	FontSize     *int          `json:"fontSize,omitempty"`
	Color        *string       `json:"color,omitempty"`
	Bg           *string       `json:"bg,omitempty"`
	Align        *string       `json:"align,omitempty"`
	VAlign       *string       `json:"valign,omitempty"`
	Wrap         *bool         `json:"wrap,omitempty"`
	Borders      *SheetBorders `json:"borders,omitempty"`
	ClearBorders bool          `json:"clearBorders,omitempty"`
	NumFmt       *string       `json:"numFmt,omitempty"`
}

// SheetCellConflict describes a true cell-level or merge-slave conflict in
// mergeMode="auto" so the client can preserve non-conflicting cells and resolve
// only the conflicting cells interactively.
type SheetCellConflict struct {
	RowID               int64            `json:"rowId"`
	ColumnID            int64            `json:"columnId"`
	Row                 int              `json:"row"`
	Col                 int              `json:"col"`
	ExpectedRevision    int64            `json:"expectedRevision"`
	CurrentRevision     int64            `json:"currentRevision"`
	CurrentRaw          string           `json:"currentRaw"`
	CurrentStyle        SheetCellStyle   `json:"currentStyle,omitempty"`
	AttemptedRaw        *string          `json:"attemptedRaw,omitempty"`
	AttemptedStyle      *SheetCellStyle  `json:"attemptedStyle,omitempty"`
	AttemptedStylePatch *SheetStylePatch `json:"attemptedStylePatch,omitempty"`
	ConflictingFields   []string         `json:"conflictingFields,omitempty"`
	Reason              string           `json:"reason"` // value_conflict | style_conflict | merge_slave_conflict
	UpdatedBy           int64            `json:"updatedBy,omitempty"`
	UpdatedByName       string           `json:"updatedByName,omitempty"`
	MergeRect           *SheetMerge      `json:"mergeRect,omitempty"`
	AnchorRowID         int64            `json:"anchorRowId,omitempty"`
	AnchorColumnID      int64            `json:"anchorColumnId,omitempty"`
	AnchorRaw           string           `json:"anchorRaw,omitempty"`
	AnchorRevision      int64            `json:"anchorRevision,omitempty"`
}

// SheetMergeOp applies a region-level merge or unmerge atomically against the
// latest worksheet merge list instead of replacing the entire merges array.
type SheetMergeOp struct {
	Op             string       `json:"op"` // merge | unmerge
	Rect           SheetMerge   `json:"rect"`
	Force          bool         `json:"force,omitempty"`
	ExpectedMerges []SheetMerge `json:"expectedMerges,omitempty"`
}

// SheetRegionConflictError is returned when a concurrent merge overlaps a newly
// created merge that the client had not yet observed.
type SheetRegionConflictError struct {
	Code              string         `json:"error"`
	Message           string         `json:"message"`
	ConflictingMerges []SheetMerge   `json:"conflictingMerges,omitempty"`
	Worksheet         SheetWorksheet `json:"worksheet"`
	WorkbookRevision  int64          `json:"workbookRevision"`
}

func (e *SheetRegionConflictError) Error() string { return e.Message }
func (e *SheetRegionConflictError) Unwrap() error { return ErrConflict }

var allStyleFieldNames = []string{
	"bold", "italic", "underline", "strike",
	"fontFamily", "fontSize", "color", "bg",
	"align", "valign", "wrap", "borders", "numFmt",
}

func cloneSheetStylePatch(p *SheetStylePatch) *SheetStylePatch {
	if p == nil {
		return nil
	}
	cp := *p
	if p.Bold != nil {
		v := *p.Bold
		cp.Bold = &v
	}
	if p.Italic != nil {
		v := *p.Italic
		cp.Italic = &v
	}
	if p.Underline != nil {
		v := *p.Underline
		cp.Underline = &v
	}
	if p.Strike != nil {
		v := *p.Strike
		cp.Strike = &v
	}
	if p.FontFamily != nil {
		v := *p.FontFamily
		cp.FontFamily = &v
	}
	if p.FontSize != nil {
		v := *p.FontSize
		cp.FontSize = &v
	}
	if p.Color != nil {
		v := *p.Color
		cp.Color = &v
	}
	if p.Bg != nil {
		v := *p.Bg
		cp.Bg = &v
	}
	if p.Align != nil {
		v := *p.Align
		cp.Align = &v
	}
	if p.VAlign != nil {
		v := *p.VAlign
		cp.VAlign = &v
	}
	if p.Wrap != nil {
		v := *p.Wrap
		cp.Wrap = &v
	}
	if p.Borders != nil {
		b := *p.Borders
		cp.Borders = &b
	}
	if p.NumFmt != nil {
		v := *p.NumFmt
		cp.NumFmt = &v
	}
	return &cp
}

func normalizeSheetStylePatch(p SheetStylePatch) (SheetStylePatch, bool) {
	touched := false
	if p.Bold != nil {
		touched = true
	}
	if p.Italic != nil {
		touched = true
	}
	if p.Underline != nil {
		touched = true
	}
	if p.Strike != nil {
		touched = true
	}
	if p.FontFamily != nil {
		touched = true
		ff := strings.TrimSpace(*p.FontFamily)
		if len(ff) > 64 || !utf8.ValidString(ff) {
			return SheetStylePatch{}, false
		}
		for _, r := range ff {
			if r < 32 {
				return SheetStylePatch{}, false
			}
		}
		p.FontFamily = &ff
	}
	if p.FontSize != nil {
		touched = true
		fs := *p.FontSize
		if fs != 0 && (fs < 8 || fs > 72) {
			return SheetStylePatch{}, false
		}
	}
	if p.Color != nil {
		touched = true
		c := strings.TrimSpace(*p.Color)
		if c != "" && !sheetHexColorPattern.MatchString(c) {
			return SheetStylePatch{}, false
		}
		p.Color = &c
	}
	if p.Bg != nil {
		touched = true
		bg := strings.TrimSpace(*p.Bg)
		if bg != "" && !sheetHexColorPattern.MatchString(bg) {
			return SheetStylePatch{}, false
		}
		p.Bg = &bg
	}
	if p.Align != nil {
		touched = true
		switch *p.Align {
		case "", "left", "center", "right":
		default:
			return SheetStylePatch{}, false
		}
	}
	if p.VAlign != nil {
		touched = true
		switch *p.VAlign {
		case "", "top", "middle", "bottom":
		default:
			return SheetStylePatch{}, false
		}
	}
	if p.Wrap != nil {
		touched = true
	}
	if p.ClearBorders {
		touched = true
		p.Borders = nil
	} else if p.Borders != nil {
		touched = true
		b := *p.Borders
		if b.Color != "" && !sheetHexColorPattern.MatchString(b.Color) {
			return SheetStylePatch{}, false
		}
		if !b.Top && !b.Right && !b.Bottom && !b.Left {
			p.Borders = nil
			p.ClearBorders = true
		} else {
			p.Borders = &b
		}
	}
	if p.NumFmt != nil {
		touched = true
		switch *p.NumFmt {
		case "", "general", "currency", "percent", "decimal2", "decimal1", "integer", "date":
		default:
			return SheetStylePatch{}, false
		}
	}
	return p, touched
}

func sheetStylePatchFields(p *SheetStylePatch) []string {
	if p == nil {
		return nil
	}
	out := make([]string, 0, 4)
	if p.Bold != nil {
		out = append(out, "bold")
	}
	if p.Italic != nil {
		out = append(out, "italic")
	}
	if p.Underline != nil {
		out = append(out, "underline")
	}
	if p.Strike != nil {
		out = append(out, "strike")
	}
	if p.FontFamily != nil {
		out = append(out, "fontFamily")
	}
	if p.FontSize != nil {
		out = append(out, "fontSize")
	}
	if p.Color != nil {
		out = append(out, "color")
	}
	if p.Bg != nil {
		out = append(out, "bg")
	}
	if p.Align != nil {
		out = append(out, "align")
	}
	if p.VAlign != nil {
		out = append(out, "valign")
	}
	if p.Wrap != nil {
		out = append(out, "wrap")
	}
	if p.ClearBorders || p.Borders != nil {
		out = append(out, "borders")
	}
	if p.NumFmt != nil {
		out = append(out, "numFmt")
	}
	return out
}

func applySheetStylePatch(base SheetCellStyle, p *SheetStylePatch) SheetCellStyle {
	out := cloneSheetStyle(base)
	if p == nil {
		return out
	}
	if p.Bold != nil {
		out.Bold = *p.Bold
	}
	if p.Italic != nil {
		out.Italic = *p.Italic
	}
	if p.Underline != nil {
		out.Underline = *p.Underline
	}
	if p.Strike != nil {
		out.Strike = *p.Strike
	}
	if p.FontFamily != nil {
		out.FontFamily = *p.FontFamily
	}
	if p.FontSize != nil {
		out.FontSize = *p.FontSize
	}
	if p.Color != nil {
		out.Color = *p.Color
	}
	if p.Bg != nil {
		out.Bg = *p.Bg
	}
	if p.Align != nil {
		out.Align = *p.Align
	}
	if p.VAlign != nil {
		out.VAlign = *p.VAlign
	}
	if p.Wrap != nil {
		out.Wrap = *p.Wrap
	}
	if p.ClearBorders {
		out.Borders = nil
	} else if p.Borders != nil {
		b := *p.Borders
		out.Borders = &b
	}
	if p.NumFmt != nil {
		out.NumFmt = *p.NumFmt
	}
	return out
}

func sameSheetBorders(a, b *SheetBorders) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

func sameStyleField(a, b SheetCellStyle, field string) bool {
	switch field {
	case "bold":
		return a.Bold == b.Bold
	case "italic":
		return a.Italic == b.Italic
	case "underline":
		return a.Underline == b.Underline
	case "strike":
		return a.Strike == b.Strike
	case "fontFamily":
		return a.FontFamily == b.FontFamily
	case "fontSize":
		return a.FontSize == b.FontSize
	case "color":
		return a.Color == b.Color
	case "bg":
		return a.Bg == b.Bg
	case "align":
		return a.Align == b.Align
	case "valign":
		return a.VAlign == b.VAlign
	case "wrap":
		return a.Wrap == b.Wrap
	case "borders":
		return sameSheetBorders(a.Borders, b.Borders)
	case "numFmt":
		return a.NumFmt == b.NumFmt
	default:
		return false
	}
}

func cloneFieldRevs(m map[string]int64) map[string]int64 {
	if len(m) == 0 {
		return map[string]int64{}
	}
	out := make(map[string]int64, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func effectiveFieldRev(curRev int64, fieldRevs map[string]int64, field string) int64 {
	if curRev == 0 {
		return 0
	}
	if len(fieldRevs) == 0 {
		// Pre-migration cell without per-field revision tracking: conservatively
		// assume every field changed at curRev.
		return curRev
	}
	return fieldRevs[field]
}

type resolvedCellWrite struct {
	nextRaw       string
	nextStyle     SheetCellStyle
	nextRev       int64
	nextFieldRevs map[string]int64
	merged        bool
	conflict      *SheetCellConflict
}

// resolveSheetCellWrite resolves a single cell write against current persisted
// state. In strict mode, any revision mismatch returns nil conflict with ok=false
// (caller returns ErrConflict). In auto mode, orthogonal field writes (e.g. raw
// vs bold vs bg) or identical convergent writes auto-merge cleanly; true
// same-field collisions populate resolved.conflict.
func resolveSheetCellWrite(
	cur SheetCell,
	curFieldRevs map[string]int64,
	curUpdatedBy int64,
	curUpdatedByName string,
	rPos, cPos int,
	w SheetCellWrite,
	autoMerge bool,
) (resolvedCellWrite, bool) {
	if cur.Revision >= sheetMaxRevision {
		return resolvedCellWrite{}, false
	}
	// Expected revision ahead of server state is always invalid.
	if w.ExpectedRevision > cur.Revision {
		return resolvedCellWrite{}, false
	}
	if !autoMerge && cur.Revision != w.ExpectedRevision {
		return resolvedCellWrite{}, false
	}

	nextRaw := cur.Raw
	if w.Raw != nil {
		nextRaw = *w.Raw
	}
	nextStyle := cloneSheetStyle(cur.Style)
	touchedFields := make([]string, 0, 4)
	if w.Raw != nil {
		touchedFields = append(touchedFields, "raw")
	}
	if w.StylePatch != nil {
		nextStyle = applySheetStylePatch(cur.Style, w.StylePatch)
		touchedFields = append(touchedFields, sheetStylePatchFields(w.StylePatch)...)
	} else if w.Style != nil {
		nextStyle = cloneSheetStyle(*w.Style)
		touchedFields = append(touchedFields, allStyleFieldNames...)
	}

	// Fast path: exact revision match.
	if cur.Revision == w.ExpectedRevision {
		nextRev := cur.Revision + 1
		nextRevs := cloneFieldRevs(curFieldRevs)
		for _, f := range touchedFields {
			nextRevs[f] = nextRev
		}
		return resolvedCellWrite{
			nextRaw:       nextRaw,
			nextStyle:     nextStyle,
			nextRev:       nextRev,
			nextFieldRevs: nextRevs,
			merged:        false,
		}, true
	}

	// Auto-merge path: cur.Revision > w.ExpectedRevision.
	// Check each touched field for a real concurrent collision.
	conflicting := make([]string, 0)
	for _, f := range touchedFields {
		fRev := effectiveFieldRev(cur.Revision, curFieldRevs, f)
		if fRev <= w.ExpectedRevision {
			continue
		}
		// Convergent same-value write is never a conflict.
		if f == "raw" {
			if nextRaw == cur.Raw {
				continue
			}
		} else if sameStyleField(nextStyle, cur.Style, f) {
			continue
		}
		conflicting = append(conflicting, f)
	}

	if len(conflicting) > 0 {
		reason := "style_conflict"
		if slices.Contains(conflicting, "raw") {
			reason = "value_conflict"
		}
		var attemptedRaw *string
		if w.Raw != nil {
			v := *w.Raw
			attemptedRaw = &v
		}
		var attemptedStyle *SheetCellStyle
		if w.Style != nil {
			st := cloneSheetStyle(*w.Style)
			attemptedStyle = &st
		}
		return resolvedCellWrite{
			conflict: &SheetCellConflict{
				RowID:               w.RowID,
				ColumnID:            w.ColumnID,
				Row:                 rPos,
				Col:                 cPos,
				ExpectedRevision:    w.ExpectedRevision,
				CurrentRevision:     cur.Revision,
				CurrentRaw:          cur.Raw,
				CurrentStyle:        cloneSheetStyle(cur.Style),
				AttemptedRaw:        attemptedRaw,
				AttemptedStyle:      attemptedStyle,
				AttemptedStylePatch: cloneSheetStylePatch(w.StylePatch),
				ConflictingFields:   conflicting,
				Reason:              reason,
				UpdatedBy:           curUpdatedBy,
				UpdatedByName:       curUpdatedByName,
			},
		}, true
	}

	// Orthogonal or convergent auto-merge succeeded!
	nextRev := cur.Revision + 1
	nextRevs := cloneFieldRevs(curFieldRevs)
	if len(nextRevs) == 0 && cur.Revision > 0 {
		// Preserve conservative baseline for untouched legacy fields.
		nextRevs["raw"] = cur.Revision
		for _, f := range allStyleFieldNames {
			nextRevs[f] = cur.Revision
		}
	}
	for _, f := range touchedFields {
		nextRevs[f] = nextRev
	}
	return resolvedCellWrite{
		nextRaw:       nextRaw,
		nextStyle:     nextStyle,
		nextRev:       nextRev,
		nextFieldRevs: nextRevs,
		merged:        true,
	}, true
}

func sameSheetMerge(a, b SheetMerge) bool {
	return a.Top == b.Top && a.Left == b.Left && a.Bottom == b.Bottom && a.Right == b.Right
}

func mergesOverlap(a, b SheetMerge) bool {
	return a.Left <= b.Right && b.Left <= a.Right && a.Top <= b.Bottom && b.Top <= a.Bottom
}

func findMergeCovering(merges []SheetMerge, row, col int) (SheetMerge, bool) {
	for _, m := range merges {
		if row >= m.Top && row <= m.Bottom && col >= m.Left && col <= m.Right {
			return m, true
		}
	}
	return SheetMerge{}, false
}

func checkProtectedRectWrite(role string, userID int64, rect SheetMerge, ranges []SheetProtectedRange) error {
	if role == RoleManage || len(ranges) == 0 {
		return nil
	}
	for _, pr := range ranges {
		if rect.Left <= pr.Right && pr.Left <= rect.Right && rect.Top <= pr.Bottom && pr.Top <= rect.Bottom {
			if !slices.Contains(pr.AllowedUserIDs, userID) {
				return ErrForbidden
			}
		}
	}
	return nil
}

// applySheetMergeOp executes a region-level merge or unmerge against live
// worksheet merges. Disjoint concurrent merges always survive; overlapping
// merges unseen by the caller return overlaps so the store can emit a
// structured SheetRegionConflictError instead of silently overwriting.
func applySheetMergeOp(current []SheetMerge, op SheetMergeOp, rowCount, colCount int) (next []SheetMerge, overlaps []SheetMerge, changed bool, ok bool) {
	r := op.Rect
	if r.Top < 0 || r.Left < 0 || r.Bottom >= rowCount || r.Right >= colCount || r.Bottom < r.Top || r.Right < r.Left {
		return nil, nil, false, false
	}
	switch op.Op {
	case "merge":
		if r.Top == r.Bottom && r.Left == r.Right {
			return nil, nil, false, false
		}
		foundOverlap := make([]SheetMerge, 0)
		kept := make([]SheetMerge, 0, len(current)+1)
		for _, m := range current {
			if mergesOverlap(m, r) {
				foundOverlap = append(foundOverlap, m)
			} else {
				kept = append(kept, m)
			}
		}
		// Exact same merge already exists -> idempotent convergence.
		if len(foundOverlap) == 1 && sameSheetMerge(foundOverlap[0], r) {
			return slices.Clone(current), nil, false, true
		}
		if len(foundOverlap) > 0 && !op.Force {
			unseen := make([]SheetMerge, 0, len(foundOverlap))
			for _, ov := range foundOverlap {
				known := false
				for _, exp := range op.ExpectedMerges {
					if sameSheetMerge(ov, exp) {
						known = true
						break
					}
				}
				if !known {
					unseen = append(unseen, ov)
				}
			}
			if len(unseen) > 0 {
				return nil, unseen, false, true
			}
		}
		kept = append(kept, r)
		normalized, valid := validateAndNormalizeSheetMerges(kept, rowCount, colCount)
		if !valid {
			return nil, nil, false, false
		}
		return normalized, nil, true, true

	case "unmerge":
		kept := make([]SheetMerge, 0, len(current))
		removed := false
		for _, m := range current {
			if mergesOverlap(m, r) {
				removed = true
			} else {
				kept = append(kept, m)
			}
		}
		if !removed {
			return slices.Clone(current), nil, false, true
		}
		normalized, valid := validateAndNormalizeSheetMerges(kept, rowCount, colCount)
		if !valid {
			return nil, nil, false, false
		}
		return normalized, nil, true, true

	default:
		return nil, nil, false, false
	}
}
