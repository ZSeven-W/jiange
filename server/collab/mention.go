package collab

import (
	"math"
	"strconv"
	"strings"
)

// MentionTarget verifies that this exact mark still produces a visible @ run.
// It bounds work and returns no candidate for malformed or very large blocks.
func (d *Doc) MentionTarget(blockID, markID OpID) int64 {
	b := d.blocks[blockID]
	if b == nil || len(b.chars) > 100000 || len(b.marks) > 10000 {
		return 0
	}
	_, kind, visible := d.VisibleBlockText(blockID)
	if !visible {
		return 0
	}
	switch kind {
	case "paragraph", "h1", "h2", "h3", "h4", "h5", "h6", "bullet", "ordered", "todo", "quote", "callout":
	default:
		return 0
	}
	var target *markRec
	for i := range b.marks {
		if b.marks[i].id == markID {
			target = &b.marks[i]
			break
		}
	}
	if target == nil || target.key != "mention" || target.value == nil {
		return 0
	}
	uid, err := strconv.ParseUint(*target.value, 10, 53)
	if err != nil || uid == 0 || strconv.FormatUint(uid, 10) != *target.value {
		return 0
	}
	order := b.fullOrder()
	if len(order) > 100000 || len(b.marks) > 10000 {
		return 0
	}
	positions := make(map[OpID]int, len(order))
	for i, ch := range order {
		positions[ch.id] = i
	}
	slot := func(a Anchor) (int, bool) {
		if a.Side == 0 && a.Char == Root {
			return math.MaxInt, true
		}
		i, ok := positions[a.Char]
		if !ok {
			return 0, false
		}
		value := i * 4
		if a.Side == 1 {
			value += 2
		}
		return value, true
	}
	start, ok := slot(target.start)
	if !ok {
		return 0
	}
	end, ok := slot(target.end)
	if !ok || start >= end {
		return 0
	}
	type interval struct {
		mark     markRec
		from, to int
	}
	var relevant []interval
	for _, m := range b.marks {
		if m.key != "mention" {
			continue
		}
		from, a := slot(m.start)
		to, z := slot(m.end)
		if !a || !z {
			return 0
		}
		relevant = append(relevant, interval{m, from, to})
	}
	var text strings.Builder
	count := 0
	for i, ch := range order {
		point := i*4 + 1
		if ch.deleted || point <= start || point >= end {
			continue
		}
		count++
		if count > 200 || count*len(relevant) > 1000000 {
			return 0
		}
		var winner *markRec
		for j := range relevant {
			m := &relevant[j]
			if m.from < point && point < m.to && (winner == nil || winner.id.Cmp(m.mark.id) < 0) {
				winner = &m.mark
			}
		}
		if winner == nil || winner.id != markID || winner.value == nil || *winner.value != *target.value {
			return 0
		}
		text.WriteRune(ch.ch)
	}
	if count < 2 || !strings.HasPrefix(text.String(), "@") {
		return 0
	}
	return int64(uid)
}
