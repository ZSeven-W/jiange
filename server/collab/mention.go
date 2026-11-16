package collab

import (
	"container/heap"
	"math"
	"sort"
	"strconv"
	"strings"
)

// MentionRef identifies the exact mark being committed. IDs are scoped to a document.
type MentionRef struct{ Block, Mark OpID }

// MentionMatch contains only a user and a visible character identity, never copied content.
type MentionMatch struct {
	RecipientID int64
	FirstChar   OpID
}

type mentionInterval struct {
	mark     markRec
	from, to int
}
type mentionHeap []mentionInterval

func (h mentionHeap) Len() int           { return len(h) }
func (h mentionHeap) Less(i, j int) bool { return h[i].mark.id.Cmp(h[j].mark.id) > 0 }
func (h mentionHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *mentionHeap) Push(v any)        { *h = append(*h, v.(mentionInterval)) }
func (h *mentionHeap) Pop() any          { old := *h; n := len(old); v := old[n-1]; *h = old[:n-1]; return v }

type mentionVisibleChar struct {
	point  int
	id     OpID
	ch     rune
	winner OpID
	marked bool
	hidden bool
}

// MentionTargets resolves all requested marks in each block in one sweep. This
// keeps large offline batches linearithmic rather than rescanning a block for
// each mention. Deleted/overridden marks and inaccessible blocks never match.
func (d *Doc) MentionTargets(refs []MentionRef) map[MentionRef]MentionMatch {
	out := make(map[MentionRef]MentionMatch)
	byBlock := make(map[OpID]map[OpID]struct{})
	for _, ref := range refs {
		if byBlock[ref.Block] == nil {
			byBlock[ref.Block] = map[OpID]struct{}{}
		}
		byBlock[ref.Block][ref.Mark] = struct{}{}
	}
	for blockID, requested := range byBlock {
		b := d.blocks[blockID]
		if b == nil || len(b.chars) > 100000 || len(b.marks) > 10000 {
			continue
		}
		_, kind, visible := d.VisibleBlockText(blockID)
		if !visible {
			continue
		}
		switch kind {
		case "paragraph", "h1", "h2", "h3", "h4", "h5", "h6", "bullet", "ordered", "todo", "quote", "callout":
		default:
			continue
		}
		order := b.fullOrder()
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
			point := i * 4
			if a.Side == 1 {
				point += 2
			}
			return point, true
		}
		intervals := map[string][]mentionInterval{"mention": {}, "math": {}, "link": {}}
		targets := make(map[OpID]mentionInterval, len(requested))
		valid := true
		for _, mark := range b.marks {
			if mark.key != "mention" && mark.key != "math" && mark.key != "link" {
				continue
			}
			from, a := slot(mark.start)
			to, z := slot(mark.end)
			if !a || !z {
				valid = false
				break
			}
			interval := mentionInterval{mark, from, to}
			intervals[mark.key] = append(intervals[mark.key], interval)
			if _, ok := requested[mark.id]; ok && mark.key == "mention" {
				targets[mark.id] = interval
			}
		}
		if !valid || len(targets) == 0 {
			continue
		}
		keys := []string{"mention", "math", "link"}
		active := map[string]*mentionHeap{}
		next := map[string]int{}
		for _, key := range keys {
			list := intervals[key]
			sort.Slice(list, func(i, j int) bool { return list[i].from < list[j].from })
			intervals[key] = list
			active[key] = &mentionHeap{}
			heap.Init(active[key])
		}
		chars := make([]mentionVisibleChar, 0, len(order))
		for i, ch := range order {
			if ch.deleted {
				continue
			}
			point := i*4 + 1
			for _, key := range keys {
				list, h := intervals[key], active[key]
				for next[key] < len(list) && list[next[key]].from < point {
					heap.Push(h, list[next[key]])
					next[key]++
				}
				for h.Len() > 0 && (*h)[0].to <= point {
					heap.Pop(h)
				}
			}
			v := mentionVisibleChar{point: point, id: ch.id, ch: ch.ch}
			if h := active["mention"]; h.Len() > 0 {
				v.marked = true
				v.winner = (*h)[0].mark.id
			}
			if h := active["math"]; h.Len() > 0 && (*h)[0].mark.value != nil && *(*h)[0].mark.value != "" {
				v.hidden = true
			}
			if h := active["link"]; h.Len() > 0 && (*h)[0].mark.value != nil && strings.HasPrefix(*(*h)[0].mark.value, "#/doc/") {
				v.hidden = true
			}
			chars = append(chars, v)
		}
		for id, target := range targets {
			if target.mark.value == nil || target.from >= target.to {
				continue
			}
			uid, err := strconv.ParseUint(*target.mark.value, 10, 53)
			if err != nil || uid == 0 || strconv.FormatUint(uid, 10) != *target.mark.value {
				continue
			}
			start := sort.Search(len(chars), func(i int) bool { return chars[i].point > target.from })
			end := sort.Search(len(chars), func(i int) bool { return chars[i].point >= target.to })
			if end-start < 2 || end-start > 200 || chars[start].ch != '@' {
				continue
			}
			matches := true
			for _, ch := range chars[start:end] {
				if !ch.marked || ch.hidden || ch.winner != id {
					matches = false
					break
				}
			}
			if matches {
				out[MentionRef{Block: blockID, Mark: id}] = MentionMatch{RecipientID: int64(uid), FirstChar: chars[start].id}
			}
		}
	}
	return out
}

func (d *Doc) MentionTarget(blockID, markID OpID) int64 {
	return d.MentionTargets([]MentionRef{{Block: blockID, Mark: markID}})[MentionRef{Block: blockID, Mark: markID}].RecipientID
}
