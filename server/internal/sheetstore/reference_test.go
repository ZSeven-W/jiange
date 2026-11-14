package sheetstore

import (
	"errors"
	"math"
	"strings"
	"testing"
)

func TestA1ReferenceParseAndFormat(t *testing.T) {
	bounds := ReferenceBounds{Rows: 10000, Columns: 20000}
	for _, tc := range []struct {
		text, canonical string
		row, col        int64
		absRow, absCol  bool
	}{
		{"A1", "A1", 1, 1, false, false}, {"$d$2", "$D$2", 2, 4, true, true},
		{"D$2", "D$2", 2, 4, true, false}, {"$D2", "$D2", 2, 4, false, true},
		{"AA10", "AA10", 10, 27, false, false}, {"ZZ100", "ZZ100", 100, 702, false, false},
		{"AAA001", "AAA1", 1, 703, false, false},
	} {
		got, err := ParseA1Reference(tc.text, bounds)
		if err != nil || got != (A1Reference{Row: tc.row, Column: tc.col, AbsoluteRow: tc.absRow, AbsoluteColumn: tc.absCol}) {
			t.Fatalf("parse %q: %+v %v", tc.text, got, err)
		}
		formatted, err := got.Format(bounds)
		if err != nil || formatted != tc.canonical {
			t.Fatalf("format %q: %q %v", tc.text, formatted, err)
		}
	}
}

func TestA1ReferenceRejectsInvalidAndOversized(t *testing.T) {
	bounds := ReferenceBounds{Rows: 50, Columns: 26}
	for _, input := range []string{"", "A", "1", "A0", "$A$", "$$A1", "A$$1", "A1B", " A1", "A1 ", "A-1", "A1:B2", "Sheet!A1", "Ａ1", "AA1", "A51", "ZZZZZZZZZZZZZZZZZZZZ99999999999999999999"} {
		if _, err := ParseA1Reference(input, bounds); !errors.Is(err, ErrReference) {
			t.Fatalf("accepted %q: %v", input, err)
		}
	}
	for _, invalid := range []ReferenceBounds{{0, 1}, {1, 0}, {-1, 3}, {maxSafeInteger + 1, 1}} {
		if _, err := ParseA1Reference("A1", invalid); !errors.Is(err, ErrReference) {
			t.Fatalf("accepted bounds %+v: %v", invalid, err)
		}
	}
}

func TestA1FillRespectsMixedReferencesAndBounds(t *testing.T) {
	bounds := ReferenceBounds{Rows: 100, Columns: 100}
	for _, tc := range []struct{ input, output string }{{"D2", "F5"}, {"$D$2", "$D$2"}, {"D$2", "F$2"}, {"$D2", "$D5"}} {
		ref, err := ParseA1Reference(tc.input, bounds)
		if err != nil {
			t.Fatal(err)
		}
		shifted, err := ref.Shift(3, 2, bounds)
		if err != nil {
			t.Fatal(err)
		}
		text, err := shifted.Format(bounds)
		if err != nil || text != tc.output {
			t.Fatalf("%s: %s %v", tc.input, text, err)
		}
	}
	ref, _ := ParseA1Reference("A1", bounds)
	for _, delta := range [][2]int64{{-1, 0}, {0, -1}, {math.MaxInt64, 0}, {0, math.MinInt64}, {100, 0}} {
		if _, err := ref.Shift(delta[0], delta[1], bounds); !errors.Is(err, ErrReference) {
			t.Fatalf("accepted offset %+v: %v", delta, err)
		}
	}
	fixed, _ := ParseA1Reference("$A$1", bounds)
	if got, err := fixed.Shift(math.MinInt64, math.MaxInt64, bounds); err != nil || got != fixed {
		t.Fatalf("absolute moved: %+v %v", got, err)
	}
}

func TestA1RangesPreserveEndpointsAndFailAtomically(t *testing.T) {
	bounds := ReferenceBounds{Rows: 100, Columns: 100}
	r, err := ParseA1Range("$D2:B$4", bounds)
	if err != nil {
		t.Fatal(err)
	}
	shifted, err := r.Shift(1, 2, bounds)
	if err != nil {
		t.Fatal(err)
	}
	start, _ := shifted.Start.Format(bounds)
	end, _ := shifted.End.Format(bounds)
	if start != "$D3" || end != "D$4" {
		t.Fatalf("shifted: %s:%s", start, end)
	}
	if _, err = r.Shift(-2, 0, bounds); !errors.Is(err, ErrReference) {
		t.Fatalf("partially invalid range: %v", err)
	}
	for _, input := range []string{"A1", ":A1", "A1:", "A1:B2:C3", strings.Repeat(":", 100000)} {
		if _, err = ParseA1Range(input, bounds); !errors.Is(err, ErrReference) {
			t.Fatalf("accepted range %q", input)
		}
	}
}

func TestA1ReferenceRoundTripsAcrossColumnBoundaries(t *testing.T) {
	bounds := ReferenceBounds{Rows: maxSafeInteger, Columns: maxSafeInteger}
	for _, col := range []int64{1, 26, 27, 52, 53, 702, 703, 18278, maxSafeInteger} {
		original := A1Reference{Row: maxSafeInteger, Column: col, AbsoluteRow: true, AbsoluteColumn: true}
		text, err := original.Format(bounds)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := ParseA1Reference(text, bounds)
		if err != nil || parsed != original {
			t.Fatalf("round trip %d: %q %+v %v", col, text, parsed, err)
		}
	}
}

func FuzzA1Reference(f *testing.F) {
	for _, seed := range []string{"A1", "$D$2", "D$2", "$D2", "ZZ999", "", "A0", "表!A1"} {
		f.Add(seed)
	}
	bounds := ReferenceBounds{Rows: 100000, Columns: 10000}
	f.Fuzz(func(t *testing.T, input string) {
		ref, err := ParseA1Reference(input, bounds)
		if err != nil {
			return
		}
		encoded, err := ref.Format(bounds)
		if err != nil {
			t.Fatalf("valid reference failed to format: %+v", ref)
		}
		again, err := ParseA1Reference(encoded, bounds)
		if err != nil || again != ref {
			t.Fatalf("round trip %q => %q: %+v %v", input, encoded, again, err)
		}
	})
}
