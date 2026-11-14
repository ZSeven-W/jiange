package sheetstore

import (
	"errors"
	"strings"
)

// ErrReference indicates invalid syntax or a reference outside the current
// worksheet. Formula callers can map this to the spreadsheet's #REF! error.
var ErrReference = errors.New("sheet: invalid cell reference")

// ReferenceBounds is supplied by the actual worksheet, not an assumed product
// limit. Coordinates are one-based and remain within JavaScript-safe integers.
type ReferenceBounds struct{ Rows, Columns int64 }

func (b ReferenceBounds) valid() bool {
	return b.Rows > 0 && b.Columns > 0 && b.Rows <= maxSafeInteger && b.Columns <= maxSafeInteger
}

// A1Reference is a positional reference. Mapping positions to stable row and
// column identities must be performed by the workbook integration layer.
type A1Reference struct {
	Row, Column                 int64
	AbsoluteRow, AbsoluteColumn bool
}

func (r A1Reference) valid(b ReferenceBounds) bool {
	return b.valid() && r.Row >= 1 && r.Row <= b.Rows && r.Column >= 1 && r.Column <= b.Columns
}

// ParseA1Reference parses a single A1 reference, including mixed $ markers.
// It intentionally does not parse formulas, sheet names, or external links.
func ParseA1Reference(input string, bounds ReferenceBounds) (A1Reference, error) {
	var result A1Reference
	if !bounds.valid() || len(input) == 0 || len(input) > 40 {
		return result, ErrReference
	}
	i := 0
	if input[i] == '$' {
		result.AbsoluteColumn = true
		i++
	}
	start := i
	for i < len(input) {
		ch := input[i]
		if ch >= 'a' && ch <= 'z' {
			ch -= 'a' - 'A'
		}
		if ch < 'A' || ch > 'Z' {
			break
		}
		digit := int64(ch - 'A' + 1)
		if result.Column > (bounds.Columns-digit)/26 {
			return A1Reference{}, ErrReference
		}
		result.Column = result.Column*26 + digit
		i++
	}
	if i == start || i >= len(input) {
		return A1Reference{}, ErrReference
	}
	if input[i] == '$' {
		result.AbsoluteRow = true
		i++
	}
	start = i
	for i < len(input) && input[i] >= '0' && input[i] <= '9' {
		digit := int64(input[i] - '0')
		if result.Row > (bounds.Rows-digit)/10 {
			return A1Reference{}, ErrReference
		}
		result.Row = result.Row*10 + digit
		i++
	}
	if i == start || i != len(input) || !result.valid(bounds) {
		return A1Reference{}, ErrReference
	}
	return result, nil
}

// Format returns a canonical uppercase reference after validating its bounds.
func (r A1Reference) Format(bounds ReferenceBounds) (string, error) {
	if !r.valid(bounds) {
		return "", ErrReference
	}
	var reverse [16]byte
	n, count := r.Column, 0
	for n > 0 {
		n--
		reverse[count] = byte('A' + n%26)
		count++
		n /= 26
	}
	var out strings.Builder
	if r.AbsoluteColumn {
		out.WriteByte('$')
	}
	for i := count - 1; i >= 0; i-- {
		out.WriteByte(reverse[i])
	}
	if r.AbsoluteRow {
		out.WriteByte('$')
	}
	var digits [20]byte
	row, length := r.Row, 0
	for row > 0 {
		digits[length] = byte('0' + row%10)
		length++
		row /= 10
	}
	for i := length - 1; i >= 0; i-- {
		out.WriteByte(digits[i])
	}
	return out.String(), nil
}

// Shift applies a fill/copy offset only to relative coordinates. It checks the
// result before arithmetic so extreme offsets cannot overflow.
func (r A1Reference) Shift(rowDelta, columnDelta int64, bounds ReferenceBounds) (A1Reference, error) {
	if !r.valid(bounds) {
		return A1Reference{}, ErrReference
	}
	if !r.AbsoluteRow {
		if rowDelta < 1-r.Row || rowDelta > bounds.Rows-r.Row {
			return A1Reference{}, ErrReference
		}
		r.Row += rowDelta
	}
	if !r.AbsoluteColumn {
		if columnDelta < 1-r.Column || columnDelta > bounds.Columns-r.Column {
			return A1Reference{}, ErrReference
		}
		r.Column += columnDelta
	}
	return r, nil
}

type A1Range struct{ Start, End A1Reference }

// ParseA1Range preserves endpoint order and does not expand large ranges.
func ParseA1Range(input string, bounds ReferenceBounds) (A1Range, error) {
	if len(input) > 81 {
		return A1Range{}, ErrReference
	}
	left, right, found := strings.Cut(input, ":")
	if !found || strings.Contains(right, ":") {
		return A1Range{}, ErrReference
	}
	start, err := ParseA1Reference(left, bounds)
	if err != nil {
		return A1Range{}, err
	}
	end, err := ParseA1Reference(right, bounds)
	if err != nil {
		return A1Range{}, err
	}
	return A1Range{Start: start, End: end}, nil
}

func (r A1Range) Shift(rowDelta, columnDelta int64, bounds ReferenceBounds) (A1Range, error) {
	start, err := r.Start.Shift(rowDelta, columnDelta, bounds)
	if err != nil {
		return A1Range{}, err
	}
	end, err := r.End.Shift(rowDelta, columnDelta, bounds)
	if err != nil {
		return A1Range{}, err
	}
	return A1Range{Start: start, End: end}, nil
}
