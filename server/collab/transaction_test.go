package collab

import (
	"bytes"
	"fmt"
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

func TestTryTransactionRollbackRestoresAllOperationKinds(t *testing.T) {
	d := NewDoc()
	block := OpID{Client: 1, Clock: 1}
	inserted := OpID{Client: 1, Clock: 2}
	d.Apply(Op{T: TBlockCreate, ID: block, Parent: Root, Pos: "a", Type: "paragraph"})
	d.Apply(Op{T: TTextInsert, ID: inserted, Block: block, Parent: Root, Side: 1, Text: "abc"})
	_ = d.View()
	d.Apply(Op{T: TTextInsert, ID: OpID{Client: 2, Clock: 1}, Block: OpID{Client: 99, Clock: 1}, Parent: Root, Side: 1, Text: "pending"})
	before := d.EncodeState()
	oldSeen := make(map[OpID]bool, len(d.seen))
	for id, seen := range d.seen {
		oldSeen[id] = seen
	}
	oldPending := append([]Op(nil), d.pending...)
	clock := d.clock
	d.ensureOccupied()
	oldOccupied := make(map[OpID]uint32, len(d.occupied))
	for id, count := range d.occupied {
		oldOccupied[id] = count
	}
	child := OpID{Client: 3, Clock: 1}
	value := "updated"
	mark := "bold"
	ops := []Op{
		{T: TBlockCreate, ID: child, Parent: Root, Pos: "b", Type: "paragraph"},
		{T: TTextInsert, ID: OpID{Client: 3, Clock: 2}, Block: child, Parent: Root, Side: 1, Text: "你好"},
		{T: TBlockMove, ID: OpID{Client: 3, Clock: 4}, Block: block, Parent: child, Pos: "c"},
		{T: TBlockSet, ID: OpID{Client: 3, Clock: 5}, Block: block, Key: "color", Value: &value},
		{T: TTextDelete, ID: OpID{Client: 3, Clock: 6}, Block: block, Target: inserted, Len: 2},
		{T: TMark, ID: OpID{Client: 3, Clock: 7}, Block: block, Key: "bold", Value: &mark, Start: Anchor{Char: Root, Side: 1}, End: Anchor{Char: Root, Side: 0}},
		{T: TBlockDelete, ID: OpID{Client: 3, Clock: 8}, Block: child},
	}
	tx := d.BeginTryTransaction()
	for _, op := range ops {
		if err := tx.TryApply(op); err != nil {
			t.Fatalf("%s: %v", op.T, err)
		}
	}
	if err := tx.TryApply(ops[0]); err != ErrDuplicate {
		t.Fatalf("expected duplicate, got %v", err)
	}
	tx.Rollback()
	if !bytes.Equal(d.EncodeState(), before) || d.clock != clock || !reflect.DeepEqual(d.seen, oldSeen) || !reflect.DeepEqual(d.pending, oldPending) || !reflect.DeepEqual(d.occupied, oldOccupied) {
		t.Fatal("rollback did not restore the original replica, including seen/pending state")
	}
	tx = d.BeginTryTransaction()
	for _, op := range ops {
		if err := tx.TryApply(op); err != nil {
			t.Fatalf("retry %s: %v", op.T, err)
		}
	}
	tx.Commit()
	if err := d.TryApply(ops[0]); err != ErrDuplicate {
		t.Fatalf("committed operation forgotten: %v", err)
	}
}

func TestOccupiedIndexFollowsSnapshotApplyAndCompaction(t *testing.T) {
	d := NewDoc()
	b := OpID{Client: 1, Clock: 1}
	start := OpID{Client: 1, Clock: 2}
	d.Apply(Op{T: TBlockCreate, ID: b, Parent: Root, Pos: "a", Type: "paragraph"})
	d.Apply(Op{T: TTextInsert, ID: start, Block: b, Parent: Root, Side: 1, Text: "甲乙"})
	loaded, err := DecodeState(d.EncodeState())
	if err != nil {
		t.Fatal(err)
	}
	// An overlapping range is detected even when it belongs to another block.
	other := OpID{Client: 2, Clock: 1}
	if err := loaded.TryApply(Op{T: TBlockCreate, ID: other, Parent: Root, Pos: "b", Type: "paragraph"}); err != nil {
		t.Fatal(err)
	}
	if err := loaded.TryApply(Op{T: TTextInsert, ID: OpID{Client: 1, Clock: 3}, Block: other, Parent: Root, Side: 1, Text: "冲突"}); err != ErrIdentityOverlap {
		t.Fatalf("snapshot overlap: %v", err)
	}
	// Apply (the log-replay path) must maintain the already-built index.
	replayed := Op{T: TTextInsert, ID: OpID{Client: 3, Clock: 1}, Block: other, Parent: Root, Side: 1, Text: "丙丁"}
	loaded.Apply(replayed)
	if err := loaded.TryApply(Op{T: TTextInsert, ID: OpID{Client: 3, Clock: 2}, Block: b, Parent: Root, Side: 1, Text: "冲突"}); err != ErrIdentityOverlap {
		t.Fatalf("replayed overlap: %v", err)
	}
	loaded.Apply(Op{T: TTextDelete, ID: OpID{Client: 4, Clock: 1}, Block: other, Target: OpID{Client: 3, Clock: 2}, Len: 1})
	if loaded.CompactLegacyTombstones() == 0 || loaded.occupied[OpID{Client: 3, Clock: 2}] != 0 {
		t.Fatal("compaction retained the removed character in index")
	}
	// The accelerator may now allow this ID; the durable log still rejects
	// reused historical identities before an operation can be acknowledged.
}

func TestOccupiedIndexMatchesReplicaAcrossMutations(t *testing.T) {
	for seed := int64(0); seed < 40; seed++ {
		rng := rand.New(rand.NewSource(seed))
		d := NewDoc()
		blocks := []OpID{d.CreateBlock(1, Root, "a", "paragraph").ID}
		d.ensureOccupied()
		for step := 0; step < 120; step++ {
			block := blocks[rng.Intn(len(blocks))]
			switch rng.Intn(6) {
			case 0:
				blocks = append(blocks, d.CreateBlock(1, Root, "a", "paragraph").ID)
			case 1:
				d.InsertText(1, block, len([]rune(d.Text(block))), "甲b")
			case 2:
				if len(d.visible(d.blocks[block])) > 0 {
					d.DeleteText(1, block, 0, 1)
				}
			case 3:
				d.Compact()
			case 4:
				tx := d.BeginTryTransaction()
				op := Op{T: TTextInsert, ID: OpID{Client: 99, Clock: uint64(step*10 + 1)}, Block: block, Parent: Root, Side: 1, Text: "新"}
				if err := tx.TryApply(op); err != nil {
					t.Fatalf("seed %d step %d: %v", seed, step, err)
				}
				if rng.Intn(2) == 0 {
					tx.Rollback()
				} else {
					tx.Commit()
				}
			case 5:
				loaded, err := DecodeState(d.EncodeState())
				if err != nil {
					t.Fatal(err)
				}
				d = loaded
				d.ensureOccupied()
			}
			expected := make(map[OpID]uint32)
			for id, b := range d.blocks {
				if id != Root {
					expected[id]++
				}
				for id := range b.chars {
					if id != Root {
						expected[id]++
					}
				}
			}
			if !reflect.DeepEqual(d.occupied, expected) {
				t.Fatalf("seed %d step %d: occupied index diverged", seed, step)
			}
		}
	}
}

func TestOccupiedIndexTracksLegacyOverlappingReplay(t *testing.T) {
	d := NewDoc()
	block := OpID{Client: 1, Clock: 1}
	d.Apply(Op{T: TBlockCreate, ID: block, Parent: Root, Pos: "a", Type: "paragraph"})
	d.Apply(Op{T: TTextInsert, ID: OpID{Client: 2, Clock: 10}, Block: block, Parent: Root, Side: 1, Text: "旧"})
	d.ensureOccupied()
	// Historical overlapping inserts are invalid, but Apply may encounter them
	// when replaying an old, already-corrupt log. The index must still reflect
	// the actual map; it cannot repair or validate the historical tree.
	d.Apply(Op{T: TTextInsert, ID: OpID{Client: 2, Clock: 9}, Block: block, Parent: Root, Side: 1, Text: "甲乙"})
	if got := d.occupied[OpID{Client: 2, Clock: 10}]; got != 1 {
		t.Fatalf("overwritten character count: %d", got)
	}
}

// A speculative single-character edit should not copy the existing document.
// This benchmark intentionally leaves prior text in one long paragraph.
func BenchmarkTryTransactionRollback(b *testing.B) {
	for _, size := range []int{1000, 50000} {
		b.Run(fmt.Sprintf("%d_chars", size), func(b *testing.B) {
			d := NewDoc()
			block := OpID{Client: 1, Clock: 1}
			d.Apply(Op{T: TBlockCreate, ID: block, Parent: Root, Pos: "a", Type: "paragraph"})
			d.Apply(Op{T: TTextInsert, ID: OpID{Client: 1, Clock: 2}, Block: block, Parent: Root, Side: 1, Text: strings.Repeat("a", size)})
			op := Op{T: TTextInsert, ID: OpID{Client: 2, Clock: 1}, Block: block, Parent: Root, Side: 1, Text: "x"}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				tx := d.BeginTryTransaction()
				if err := tx.TryApply(op); err != nil {
					b.Fatal(err)
				}
				tx.Rollback()
			}
		})
	}
}

func BenchmarkTryTransactionAcrossBlocks(b *testing.B) {
	for _, count := range []int{10, 5000} {
		b.Run(fmt.Sprintf("%d_blocks", count), func(b *testing.B) {
			d := NewDoc()
			for i := 1; i <= count; i++ {
				d.Apply(Op{T: TBlockCreate, ID: OpID{Client: 1, Clock: uint64(i)}, Parent: Root, Pos: "a", Type: "paragraph"})
			}
			d.ensureOccupied()
			op := Op{T: TTextInsert, ID: OpID{Client: 2, Clock: 1}, Block: OpID{Client: 1, Clock: 1}, Parent: Root, Side: 1, Text: strings.Repeat("a", 1024)}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				tx := d.BeginTryTransaction()
				if err := tx.TryApply(op); err != nil {
					b.Fatal(err)
				}
				tx.Rollback()
			}
		})
	}
}

func TestTryTransactionRollbackPreservesDeletedCharsAndInsertedBranches(t *testing.T) {
	d := NewDoc()
	b := OpID{Client: 1, Clock: 1}
	start := OpID{Client: 1, Clock: 2}
	d.Apply(Op{T: TBlockCreate, ID: b, Parent: Root, Pos: "a", Type: "paragraph"})
	d.Apply(Op{T: TTextInsert, ID: start, Block: b, Parent: Root, Side: 1, Text: "abc"})
	d.Apply(Op{T: TTextDelete, ID: OpID{Client: 1, Clock: 5}, Block: b, Target: start, Len: 1})
	before := d.EncodeState()
	tx := d.BeginTryTransaction()
	ops := []Op{
		{T: TTextDelete, ID: OpID{Client: 2, Clock: 1}, Block: b, Target: start, Len: 2},
		{T: TTextInsert, ID: OpID{Client: 2, Clock: 2}, Block: b, Parent: start, Side: 0, Text: "x"},
		{T: TTextInsert, ID: OpID{Client: 2, Clock: 3}, Block: b, Parent: OpID{Client: 2, Clock: 2}, Side: 1, Text: "y"},
	}
	for _, op := range ops {
		if err := tx.TryApply(op); err != nil {
			t.Fatal(err)
		}
	}
	tx.Rollback()
	if !bytes.Equal(d.EncodeState(), before) || d.Text(b) != "bc" {
		t.Fatal("rollback changed deletion or branch order")
	}
}
