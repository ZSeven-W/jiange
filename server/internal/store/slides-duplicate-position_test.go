package store

import (
	"errors"
	"math"
	"testing"
)

func TestSlideCopyPosition(t *testing.T) {
	next := 4.0
	if got, err := slideCopyPosition(2, &next); err != nil || got != 3 {
		t.Fatalf("middle: %v %v", got, err)
	}
	if got, err := slideCopyPosition(2, nil); err != nil || got != 3 {
		t.Fatalf("last: %v %v", got, err)
	}
	adjacent := math.Nextafter(2, math.Inf(1))
	for _, value := range []float64{2, adjacent, math.NaN(), math.Inf(1)} {
		if _, err := slideCopyPosition(2, &value); !errors.Is(err, ErrConflict) {
			t.Fatalf("unsafe gap %v: %v", value, err)
		}
	}
}
