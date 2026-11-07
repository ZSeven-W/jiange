package store

import (
	"slices"
	"sort"
)

type memoryOpRange struct {
	raw     RawOp
	end     int64
	decoded bool
}

type memoryIdentityBatch struct {
	additions map[int64][]memoryOpRange
	opaque    map[int64]bool
	duplicate []bool
}

// prepareMemoryIdentityBatch checks a whole batch without changing the live
// ledger. The stored and pending lists are sorted, disjoint ranges, so only
// the predecessor of the incoming range's end can overlap.
func prepareMemoryIdentityBatch(d *memDoc, ops []RawOp) (*memoryIdentityBatch, error) {
	batch := &memoryIdentityBatch{additions: make(map[int64][]memoryOpRange), opaque: make(map[int64]bool), duplicate: make([]bool, len(ops))}
	for i, op := range ops {
		end, _, decoded, err := opIdentity(op)
		if err != nil {
			return nil, err
		}
		if decoded && (d.opaqueIDs[op.ClientID] || batch.opaque[op.ClientID]) {
			return nil, ErrOpIdentityConflict
		}
		for _, ranges := range [][]memoryOpRange{d.ranges[op.ClientID], batch.additions[op.ClientID]} {
			j := sort.Search(len(ranges), func(j int) bool { return ranges[j].raw.Clock > end }) - 1
			if j < 0 || ranges[j].end < op.Clock {
				continue
			}
			duplicate, err := compareIdentity(op, ranges[j].raw)
			if err != nil {
				return nil, err
			}
			batch.duplicate[i] = batch.duplicate[i] || duplicate
		}
		if batch.duplicate[i] {
			continue
		}
		op.Bytes = slices.Clone(op.Bytes)
		item := memoryOpRange{raw: op, end: end, decoded: decoded}
		pending := batch.additions[op.ClientID]
		j := sort.Search(len(pending), func(j int) bool { return pending[j].raw.Clock >= op.Clock })
		pending = append(pending, memoryOpRange{})
		copy(pending[j+1:], pending[j:])
		pending[j] = item
		batch.additions[op.ClientID] = pending
		batch.opaque[op.ClientID] = batch.opaque[op.ClientID] || !decoded
	}
	return batch, nil
}

func (b *memoryIdentityBatch) commit(d *memDoc) {
	if d.ranges == nil {
		d.ranges = make(map[int64][]memoryOpRange)
	}
	if d.opaqueIDs == nil {
		d.opaqueIDs = make(map[int64]bool)
	}
	for client, incoming := range b.additions {
		old := d.ranges[client]
		if len(old) == 0 || old[len(old)-1].end < incoming[0].raw.Clock {
			d.ranges[client] = append(old, incoming...)
		} else {
			merged := make([]memoryOpRange, 0, len(old)+len(incoming))
			i, j := 0, 0
			for i < len(old) && j < len(incoming) {
				if old[i].raw.Clock < incoming[j].raw.Clock {
					merged = append(merged, old[i])
					i++
				} else {
					merged = append(merged, incoming[j])
					j++
				}
			}
			merged = append(merged, old[i:]...)
			merged = append(merged, incoming[j:]...)
			d.ranges[client] = merged
		}
		d.opaqueIDs[client] = d.opaqueIDs[client] || b.opaque[client]
	}
}
