package collab

import (
	"math/rand"
	"testing"
)

// Property: two replicas edit concurrently (inserts land next to tombstones,
// deletes race on the same characters, marks anchor on deleted characters).
// A snapshot taken at any cut, compacted and reloaded, plus the remaining ops
// must resolve completely and match the replica that saw everything.
func TestSnapshotAtAnyCutMatchesFullReplay(t *testing.T) {
	legacyLost := 0
	for seed := int64(1); seed <= 150; seed++ {
		rng := rand.New(rand.NewSource(seed))
		reps := []*Doc{NewDoc(), NewDoc()}
		blk := reps[0].CreateBlock(1, Root, "V", "paragraph")
		reps[1].Apply(blk)
		var log []Op
		log = append(log, blk)
		var inflight [2][]Op
		for step := 0; step < 120; step++ {
			i := rng.Intn(2)
			d, id := reps[i], uint64(i+1)
			n := len([]rune(d.Text(blk.ID)))
			var ops []Op
			k := rng.Intn(10)
			if len(d.blocks[blk.ID].fullOrder()) < 2 {
				k = 0
			}
			switch {
			case k < 5 || n == 0 && k < 8:
				ops = []Op{d.InsertText(id, blk.ID, rng.Intn(n+1), string(rune('a'+rng.Intn(26))))}
			case k < 8:
				at := rng.Intn(n)
				ops = d.DeleteText(id, blk.ID, at, 1+rng.Intn(min(3, n-at)))
			default:
				order := d.blocks[blk.ID].fullOrder()
				a, b := order[1+rng.Intn(len(order)-1)], order[1+rng.Intn(len(order)-1)]
				v := "true"
				op := Op{T: TMark, ID: OpID{Client: id, Clock: d.Clock() + 1}, Block: blk.ID, Key: "bold", Value: &v, Start: Anchor{Char: a.id}, End: Anchor{Char: b.id, Side: 1}}
				d.Apply(op)
				ops = []Op{op}
			}
			inflight[i] = append(inflight[i], ops...)
			if rng.Intn(3) == 0 { // deliver one replica's queue to the other
				for _, op := range inflight[i] {
					reps[1-i].Apply(op)
				}
				log = append(log, inflight[i]...)
				inflight[i] = nil
			}
		}
		for i := range inflight {
			for _, op := range inflight[i] {
				reps[1-i].Apply(op)
			}
			log = append(log, inflight[i]...)
		}
		want := canon(t, reps[0].View())
		if canon(t, reps[1].View()) != want {
			t.Fatalf("seed %d: replicas diverged", seed)
		}
		cut := 1 + rng.Intn(len(log)-1)
		for _, legacy := range []bool{false, true} {
			base := NewDoc()
			for _, op := range log[:cut] {
				base.Apply(op)
			}
			if legacy {
				base.CompactLegacyTombstones()
			} else {
				base.Compact()
			}
			snap, err := DecodeState(base.EncodeState())
			if err != nil {
				t.Fatal(err)
			}
			for _, op := range log[cut:] {
				snap.Apply(op)
			}
			ok := snap.Pending() == 0 && canon(t, snap.View()) == want
			if legacy {
				if !ok {
					legacyLost++
				}
			} else if !ok {
				t.Fatalf("seed %d cut %d/%d: pending %d, view matches %v", seed, cut, len(log), snap.Pending(), canon(t, snap.View()) == want)
			}
		}
	}
	if legacyLost == 0 {
		t.Fatal("the property no longer exercises references to tombstones")
	}
	t.Logf("legacy GC broke %d/150 seeds", legacyLost)
}
