package btformula

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ecmaDateTime is the standardized ECMAScript interchange format, not the
// browser-specific fallback accepted by Date.parse for arbitrary strings.
// Browsers also accept fractional seconds beyond three digits, truncating
// them to milliseconds; this is included because NOW() produces milliseconds
// and imported timestamp values often carry additional precision.
var ecmaDateTime = regexp.MustCompile(`^([+-][0-9]{6}|[0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:[Tt]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?([Zz]|[+-][0-9]{2}:[0-9]{2})?)?$`)

// ecmaDate parses a portable subset of Date.parse. Ambiguous or nonstandard
// strings return ErrUnsupported rather than selecting a server-specific guess.
// Date-only values are UTC; date-time without a zone is interpreted in loc.
func ecmaDate(value string, loc *time.Location) (time.Time, error) {
	if loc == nil || len(value) > 1024 {
		return time.Time{}, ErrUnsupported
	}
	m := ecmaDateTime.FindStringSubmatch(value)
	if m == nil || m[1] == "-000000" {
		return time.Time{}, ErrUnsupported
	}
	parse := func(s string, fallback int) int {
		if s == "" {
			return fallback
		}
		n, _ := strconv.Atoi(s)
		return n
	}
	year, month, day := parse(m[1], 0), parse(m[2], 1), parse(m[3], 1)
	hour, minute, second := parse(m[4], 0), parse(m[5], 0), parse(m[6], 0)
	if month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || minute > 59 || second > 59 {
		return time.Time{}, ErrUnsupported
	}
	if hour == 24 && (minute != 0 || second != 0 || strings.Trim(m[7], "0") != "") {
		return time.Time{}, ErrUnsupported
	}
	ms := 0
	if m[7] != "" {
		fraction := m[7]
		if len(fraction) > 3 {
			fraction = fraction[:3]
		}
		for len(fraction) < 3 {
			fraction += "0"
		}
		ms, _ = strconv.Atoi(fraction)
	}
	// time.Date intentionally normalizes a day such as February 30, matching
	// V8's handling of syntactically in-range days in ISO date strings.
	wall := time.Date(year, time.Month(month), day, hour, minute, second, ms*int(time.Millisecond), time.UTC)
	var instant time.Time
	switch {
	case m[4] == "": // standardized date-only form, always UTC
		instant = wall
	case m[8] == "": // date-time without offset, local wall time
		var ok bool
		instant, ok = ecmaLocalInstant(wall, loc)
		if !ok {
			return time.Time{}, ErrUnsupported
		}
	case m[8] == "Z" || m[8] == "z":
		instant = wall
	default:
		zh, _ := strconv.Atoi(m[8][1:3])
		zm, _ := strconv.Atoi(m[8][4:6])
		if zh > 23 || zm > 59 {
			return time.Time{}, ErrUnsupported
		}
		offset := zh*3600 + zm*60
		if m[8][0] == '-' {
			offset = -offset
		}
		instant = wall.Add(-time.Duration(offset) * time.Second)
	}
	// ECMAScript's TimeClip range is ±8.64e15 milliseconds. Use seconds
	// rather than time.Duration, which overflows for expanded years.
	seconds := instant.Unix()
	if seconds < -8_640_000_000_000 || seconds > 8_640_000_000_000 ||
		(seconds == 8_640_000_000_000 && instant.Nanosecond() != 0) {
		return time.Time{}, ErrUnsupported
	}
	return instant, nil
}

// ecmaLocalInstant implements the ECMAScript "compatible" disambiguation:
// choose the earlier instant for repeated wall times; for skipped wall times
// advance by the size of the positive transition. Sampling nearby offsets
// avoids time.Date's platform-dependent choice at a transition. If the zone
// has an unusual unresolved transition, fail explicitly instead of guessing.
func ecmaLocalInstant(wall time.Time, loc *time.Location) (time.Time, bool) {
	naive := wall.Unix()
	offsets := map[int]struct{}{}
	for hours := -72; hours <= 72; hours += 6 {
		_, offset := time.Unix(naive+int64(hours)*3600, 0).In(loc).Zone()
		offsets[offset] = struct{}{}
	}
	var exact, forward time.Time
	hasExact, hasForward := false, false
	var smallestForward int64
	for offset := range offsets {
		candidate := time.Unix(naive-int64(offset), int64(wall.Nanosecond())).In(loc)
		localAsUTC := time.Date(candidate.Year(), candidate.Month(), candidate.Day(), candidate.Hour(), candidate.Minute(), candidate.Second(), candidate.Nanosecond(), time.UTC)
		delta := localAsUTC.Unix() - naive
		if delta == 0 && localAsUTC.Nanosecond() == wall.Nanosecond() {
			if !hasExact || candidate.Before(exact) {
				exact = candidate
				hasExact = true
			}
		} else if delta > 0 && (!hasForward || delta < smallestForward || delta == smallestForward && candidate.Before(forward)) {
			forward, smallestForward = candidate, delta
			hasForward = true
		}
	}
	if hasExact {
		return exact, true
	}
	if hasForward {
		return forward, true
	}
	return time.Time{}, false
}
