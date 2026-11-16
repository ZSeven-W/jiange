package store

import "math"

// slideCopyPosition places a copy immediately after the source. Reject a
// saturated or equal position rather than silently misordering a page.
func slideCopyPosition(source float64, next *float64) (float64, error) {
	if !isFinitePos(source) {
		return 0, ErrConflict
	}
	if next == nil {
		pos := source + 1
		if pos == source {
			pos = math.Nextafter(source, math.Inf(1))
		}
		if !isFinitePos(pos) {
			return 0, ErrConflict
		}
		return pos, nil
	}
	if !isFinitePos(*next) || *next <= source {
		return 0, ErrConflict
	}
	pos := source + (*next-source)/2
	if pos <= source || pos >= *next {
		return 0, ErrConflict
	}
	return pos, nil
}
