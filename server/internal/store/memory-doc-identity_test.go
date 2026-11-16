package store

import (
	"math/rand"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
)

// Compare indexed acceptance to a simple full-scan oracle with random ranges,
// including reversed clock order and exact retries.
func TestMemoryIdentityIndexAgainstFullScan(t *testing.T) {
	random := rand.New(rand.NewSource(71))
	d := &memDoc{}
	var accepted []RawOp
	encode := func(client, clock uint64, text string) RawOp {
		op := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: client, Clock: clock}, Block: collab.OpID{Client: 1, Clock: 1}, Parent: collab.Root, Side: 1, Text: text}
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		return RawOp{ClientID: int64(client), Clock: int64(clock), Bytes: b}
	}
	for i := 0; i < 3000; i++ {
		var op RawOp
		if len(accepted) > 0 && random.Intn(5) == 0 {
			op = accepted[random.Intn(len(accepted))]
		} else {
			text := []string{"a", "😀中", "abcd", ""}[random.Intn(4)]
			op = encode(uint64(2+random.Intn(3)), uint64(random.Intn(1800)), text)
		}
		expectedDuplicate := false
		var expectedErr error
		for _, old := range accepted {
			dup, err := compareIdentity(op, old)
			if err != nil {
				expectedErr = err
				break
			}
			expectedDuplicate = expectedDuplicate || dup
		}
		batch, err := prepareMemoryIdentityBatch(d, []RawOp{op})
		if (err != nil) != (expectedErr != nil) {
			t.Fatalf("step %d: expected error %v, got %v for %#v", i, expectedErr, err, op)
		}
		if err != nil {
			continue
		}
		if batch.duplicate[0] != expectedDuplicate {
			t.Fatalf("step %d: expected duplicate %v, got %v", i, expectedDuplicate, batch.duplicate[0])
		}
		batch.commit(d)
		if !expectedDuplicate {
			accepted = append(accepted, op)
		}
	}
}
