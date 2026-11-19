package store

import (
	"errors"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// ErrSheetValidation is returned when a cell write violates a strict
// data-validation rule configured on the worksheet.
var ErrSheetValidation = errors.New("store: cell value violates data validation")

const (
	sheetMaxValidationRules = 100
	sheetMaxCondFormatRules = 100
	sheetMaxProtectedRanges = 100
	sheetMaxValidationOpts  = 100
)

// SheetDataValidation defines an input constraint for a rectangular cell range.
type SheetDataValidation struct {
	ID      string   `json:"id"`
	Top     int      `json:"top"`
	Left    int      `json:"left"`
	Bottom  int      `json:"bottom"`
	Right   int      `json:"right"`
	Type    string   `json:"type"` // list | number | date
	Options []string `json:"options,omitempty"`
	Min     string   `json:"min,omitempty"`
	Max     string   `json:"max,omitempty"`
	Strict  bool     `json:"strict"`
	Hint    string   `json:"hint,omitempty"`
}

// SheetConditionalFormat defines a dynamic style rule evaluated against cell values.
type SheetConditionalFormat struct {
	ID     string `json:"id"`
	Top    int    `json:"top"`
	Left   int    `json:"left"`
	Bottom int    `json:"bottom"`
	Right  int    `json:"right"`
	Op     string `json:"op"` // gt | gte | lt | lte | eq | neq | between | contains | empty | not_empty
	Value1 string `json:"value1,omitempty"`
	Value2 string `json:"value2,omitempty"`
	Bg     string `json:"bg,omitempty"`
	Color  string `json:"color,omitempty"`
	Bold   bool   `json:"bold,omitempty"`
}

// SheetProtectedRange restricts edits inside a cell range to managers and listed editors.
type SheetProtectedRange struct {
	ID             string  `json:"id"`
	Top            int     `json:"top"`
	Left           int     `json:"left"`
	Bottom         int     `json:"bottom"`
	Right          int     `json:"right"`
	Description    string  `json:"description,omitempty"`
	AllowedUserIDs []int64 `json:"allowedUserIds,omitempty"`
}

func validRuleID(id string) (string, bool) {
	id = strings.TrimSpace(id)
	if id == "" || utf8.RuneCountInString(id) > 64 {
		return "", false
	}
	return id, true
}

func normalizeRect(top, left, bottom, right, rowCount, colCount int) (int, int, int, int, bool) {
	if top > bottom {
		top, bottom = bottom, top
	}
	if left > right {
		left, right = right, left
	}
	if top < 0 || left < 0 || bottom >= rowCount || right >= colCount {
		return 0, 0, 0, 0, false
	}
	return top, left, bottom, right, true
}

func validateAndNormalizeSheetValidations(rules []SheetDataValidation, rowCount, colCount int) ([]SheetDataValidation, bool) {
	if len(rules) > sheetMaxValidationRules {
		return nil, false
	}
	out := make([]SheetDataValidation, 0, len(rules))
	seen := make(map[string]bool, len(rules))
	for _, r := range rules {
		id, ok := validRuleID(r.ID)
		if !ok || seen[id] {
			return nil, false
		}
		seen[id] = true
		t, l, b, ri, ok := normalizeRect(r.Top, r.Left, r.Bottom, r.Right, rowCount, colCount)
		if !ok {
			return nil, false
		}
		hint := strings.TrimSpace(r.Hint)
		if utf8.RuneCountInString(hint) > 200 {
			return nil, false
		}
		norm := SheetDataValidation{
			ID:     id,
			Top:    t,
			Left:   l,
			Bottom: b,
			Right:  ri,
			Type:   r.Type,
			Strict: r.Strict,
			Hint:   hint,
		}
		switch r.Type {
		case "list":
			if len(r.Options) == 0 || len(r.Options) > sheetMaxValidationOpts {
				return nil, false
			}
			opts := make([]string, 0, len(r.Options))
			optSeen := map[string]bool{}
			for _, rawOpt := range r.Options {
				opt := strings.TrimSpace(rawOpt)
				if opt == "" || utf8.RuneCountInString(opt) > 100 || optSeen[opt] {
					continue
				}
				optSeen[opt] = true
				opts = append(opts, opt)
			}
			if len(opts) == 0 {
				return nil, false
			}
			norm.Options = opts
		case "number":
			minStr := strings.TrimSpace(r.Min)
			maxStr := strings.TrimSpace(r.Max)
			var minVal, maxVal float64
			var hasMin, hasMax bool
			if minStr != "" {
				v, err := strconv.ParseFloat(minStr, 64)
				if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
					return nil, false
				}
				minVal, hasMin = v, true
			}
			if maxStr != "" {
				v, err := strconv.ParseFloat(maxStr, 64)
				if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
					return nil, false
				}
				maxVal, hasMax = v, true
			}
			if hasMin && hasMax && minVal > maxVal {
				return nil, false
			}
			norm.Min = minStr
			norm.Max = maxStr
		case "date":
			minStr := strings.TrimSpace(r.Min)
			maxStr := strings.TrimSpace(r.Max)
			var minDate, maxDate time.Time
			var hasMin, hasMax bool
			if minStr != "" {
				d, err := time.Parse("2006-01-02", minStr)
				if err != nil {
					return nil, false
				}
				minDate, hasMin = d, true
			}
			if maxStr != "" {
				d, err := time.Parse("2006-01-02", maxStr)
				if err != nil {
					return nil, false
				}
				maxDate, hasMax = d, true
			}
			if hasMin && hasMax && minDate.After(maxDate) {
				return nil, false
			}
			norm.Min = minStr
			norm.Max = maxStr
		default:
			return nil, false
		}
		out = append(out, norm)
	}
	return out, true
}

func validateAndNormalizeSheetCondFormats(rules []SheetConditionalFormat, rowCount, colCount int) ([]SheetConditionalFormat, bool) {
	if len(rules) > sheetMaxCondFormatRules {
		return nil, false
	}
	out := make([]SheetConditionalFormat, 0, len(rules))
	seen := make(map[string]bool, len(rules))
	for _, r := range rules {
		id, ok := validRuleID(r.ID)
		if !ok || seen[id] {
			return nil, false
		}
		seen[id] = true
		t, l, b, ri, ok := normalizeRect(r.Top, r.Left, r.Bottom, r.Right, rowCount, colCount)
		if !ok {
			return nil, false
		}
		switch r.Op {
		case "gt", "gte", "lt", "lte", "eq", "neq", "between", "contains", "empty", "not_empty":
		default:
			return nil, false
		}
		v1 := strings.TrimSpace(r.Value1)
		v2 := strings.TrimSpace(r.Value2)
		if utf8.RuneCountInString(v1) > 200 || utf8.RuneCountInString(v2) > 200 {
			return nil, false
		}
		if r.Bg != "" && !sheetHexColorPattern.MatchString(r.Bg) {
			return nil, false
		}
		if r.Color != "" && !sheetHexColorPattern.MatchString(r.Color) {
			return nil, false
		}
		out = append(out, SheetConditionalFormat{
			ID:     id,
			Top:    t,
			Left:   l,
			Bottom: b,
			Right:  ri,
			Op:     r.Op,
			Value1: v1,
			Value2: v2,
			Bg:     r.Bg,
			Color:  r.Color,
			Bold:   r.Bold,
		})
	}
	return out, true
}

func validateAndNormalizeSheetProtectedRanges(rules []SheetProtectedRange, rowCount, colCount int) ([]SheetProtectedRange, bool) {
	if len(rules) > sheetMaxProtectedRanges {
		return nil, false
	}
	out := make([]SheetProtectedRange, 0, len(rules))
	seen := make(map[string]bool, len(rules))
	for _, r := range rules {
		id, ok := validRuleID(r.ID)
		if !ok || seen[id] {
			return nil, false
		}
		seen[id] = true
		t, l, b, ri, ok := normalizeRect(r.Top, r.Left, r.Bottom, r.Right, rowCount, colCount)
		if !ok {
			return nil, false
		}
		desc := strings.TrimSpace(r.Description)
		if utf8.RuneCountInString(desc) > 200 {
			return nil, false
		}
		allowed := make([]int64, 0, len(r.AllowedUserIDs))
		uSeen := map[int64]bool{}
		for _, uid := range r.AllowedUserIDs {
			if uid > 0 && !uSeen[uid] {
				uSeen[uid] = true
				allowed = append(allowed, uid)
			}
		}
		out = append(out, SheetProtectedRange{
			ID:             id,
			Top:            t,
			Left:           l,
			Bottom:         b,
			Right:          ri,
			Description:    desc,
			AllowedUserIDs: allowed,
		})
	}
	return out, true
}

func pointInRange(row, col, top, left, bottom, right int) bool {
	return row >= top && row <= bottom && col >= left && col <= right
}

// checkProtectedCellWrite returns ErrForbidden if a non-manager writes into a
// protected range for which they are not an explicitly allowed editor.
func checkProtectedCellWrite(role string, userID int64, rowPos, colPos int, ranges []SheetProtectedRange) error {
	if role == RoleManage || len(ranges) == 0 {
		return nil
	}
	for _, pr := range ranges {
		if pointInRange(rowPos, colPos, pr.Top, pr.Left, pr.Bottom, pr.Right) {
			if !slices.Contains(pr.AllowedUserIDs, userID) {
				return ErrForbidden
			}
		}
	}
	return nil
}

// checkProtectedAxisDelete blocks non-managers from deleting rows/columns that
// intersect a protected range they cannot edit.
func checkProtectedAxisDelete(role string, userID int64, axis string, index, count int, ranges []SheetProtectedRange) error {
	if role == RoleManage || len(ranges) == 0 {
		return nil
	}
	delEnd := index + count - 1
	for _, pr := range ranges {
		if slices.Contains(pr.AllowedUserIDs, userID) {
			continue
		}
		if axis == "row" && pr.Top <= delEnd && pr.Bottom >= index {
			return ErrForbidden
		}
		if axis == "col" && pr.Left <= delEnd && pr.Right >= index {
			return ErrForbidden
		}
	}
	return nil
}

// checkCellValidationWrite enforces strict validation rules on non-empty,
// non-formula literal values written to cells.
func checkCellValidationWrite(raw string, rowPos, colPos int, rules []SheetDataValidation) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || strings.HasPrefix(trimmed, "=") || len(rules) == 0 {
		return nil
	}
	for _, r := range rules {
		if !r.Strict || !pointInRange(rowPos, colPos, r.Top, r.Left, r.Bottom, r.Right) {
			continue
		}
		switch r.Type {
		case "list":
			if !slices.Contains(r.Options, trimmed) {
				return ErrSheetValidation
			}
		case "number":
			v, err := strconv.ParseFloat(trimmed, 64)
			if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
				return ErrSheetValidation
			}
			if r.Min != "" {
				if minV, err := strconv.ParseFloat(r.Min, 64); err == nil && v < minV {
					return ErrSheetValidation
				}
			}
			if r.Max != "" {
				if maxV, err := strconv.ParseFloat(r.Max, 64); err == nil && v > maxV {
					return ErrSheetValidation
				}
			}
		case "date":
			d, err := time.Parse("2006-01-02", trimmed)
			if err != nil {
				return ErrSheetValidation
			}
			if r.Min != "" {
				if minD, err := time.Parse("2006-01-02", r.Min); err == nil && d.Before(minD) {
					return ErrSheetValidation
				}
			}
			if r.Max != "" {
				if maxD, err := time.Parse("2006-01-02", r.Max); err == nil && d.After(maxD) {
					return ErrSheetValidation
				}
			}
		}
	}
	return nil
}

func shiftRectInsert(top, left, bottom, right int, axis string, index, count int) (int, int, int, int) {
	if axis == "row" {
		if top >= index {
			top += count
		}
		if bottom >= index {
			bottom += count
		}
	} else {
		if left >= index {
			left += count
		}
		if right >= index {
			right += count
		}
	}
	return top, left, bottom, right
}

func shiftRectDelete(top, left, bottom, right int, axis string, index, count int) (int, int, int, int, bool) {
	if axis == "row" {
		nt, nb, keep := adjustIntervalDelete(top, bottom, index, count)
		if !keep {
			return 0, 0, 0, 0, false
		}
		return nt, left, nb, right, true
	}
	nl, nr, keep := adjustIntervalDelete(left, right, index, count)
	if !keep {
		return 0, 0, 0, 0, false
	}
	return top, nl, bottom, nr, true
}

func adjustSheetValidationsInsert(rules []SheetDataValidation, axis string, index, count int) []SheetDataValidation {
	out := cloneSheetValidations(rules)
	for i := range out {
		out[i].Top, out[i].Left, out[i].Bottom, out[i].Right = shiftRectInsert(out[i].Top, out[i].Left, out[i].Bottom, out[i].Right, axis, index, count)
	}
	return out
}

func adjustSheetValidationsDelete(rules []SheetDataValidation, axis string, index, count int) []SheetDataValidation {
	out := make([]SheetDataValidation, 0, len(rules))
	for _, r := range rules {
		t, l, b, ri, keep := shiftRectDelete(r.Top, r.Left, r.Bottom, r.Right, axis, index, count)
		if !keep {
			continue
		}
		r.Top, r.Left, r.Bottom, r.Right = t, l, b, ri
		r.Options = slices.Clone(r.Options)
		out = append(out, r)
	}
	return out
}

func adjustSheetCondFormatsInsert(rules []SheetConditionalFormat, axis string, index, count int) []SheetConditionalFormat {
	out := cloneSheetCondFormats(rules)
	for i := range out {
		out[i].Top, out[i].Left, out[i].Bottom, out[i].Right = shiftRectInsert(out[i].Top, out[i].Left, out[i].Bottom, out[i].Right, axis, index, count)
	}
	return out
}

func adjustSheetCondFormatsDelete(rules []SheetConditionalFormat, axis string, index, count int) []SheetConditionalFormat {
	out := make([]SheetConditionalFormat, 0, len(rules))
	for _, r := range rules {
		t, l, b, ri, keep := shiftRectDelete(r.Top, r.Left, r.Bottom, r.Right, axis, index, count)
		if !keep {
			continue
		}
		r.Top, r.Left, r.Bottom, r.Right = t, l, b, ri
		out = append(out, r)
	}
	return out
}

func adjustSheetProtectedInsert(rules []SheetProtectedRange, axis string, index, count int) []SheetProtectedRange {
	out := cloneSheetProtectedRanges(rules)
	for i := range out {
		out[i].Top, out[i].Left, out[i].Bottom, out[i].Right = shiftRectInsert(out[i].Top, out[i].Left, out[i].Bottom, out[i].Right, axis, index, count)
	}
	return out
}

func adjustSheetProtectedDelete(rules []SheetProtectedRange, axis string, index, count int) []SheetProtectedRange {
	out := make([]SheetProtectedRange, 0, len(rules))
	for _, r := range rules {
		t, l, b, ri, keep := shiftRectDelete(r.Top, r.Left, r.Bottom, r.Right, axis, index, count)
		if !keep {
			continue
		}
		r.Top, r.Left, r.Bottom, r.Right = t, l, b, ri
		r.AllowedUserIDs = slices.Clone(r.AllowedUserIDs)
		out = append(out, r)
	}
	return out
}

func cloneSheetValidations(rules []SheetDataValidation) []SheetDataValidation {
	if len(rules) == 0 {
		return []SheetDataValidation{}
	}
	out := make([]SheetDataValidation, len(rules))
	for i, r := range rules {
		r.Options = slices.Clone(r.Options)
		out[i] = r
	}
	return out
}

func cloneSheetCondFormats(rules []SheetConditionalFormat) []SheetConditionalFormat {
	if len(rules) == 0 {
		return []SheetConditionalFormat{}
	}
	return slices.Clone(rules)
}

func cloneSheetProtectedRanges(rules []SheetProtectedRange) []SheetProtectedRange {
	if len(rules) == 0 {
		return []SheetProtectedRange{}
	}
	out := make([]SheetProtectedRange, len(rules))
	for i, r := range rules {
		r.AllowedUserIDs = slices.Clone(r.AllowedUserIDs)
		out[i] = r
	}
	return out
}
