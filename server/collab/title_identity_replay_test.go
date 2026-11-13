package collab

import (
	"errors"
	"math/rand"
	"strings"
	"testing"
)

func TestTitleIdentityReplayRejectsBodyTitleOverlapAndRetries(t *testing.T) {
	r, err := NewTitleIdentityReplay(42, 3)
	if err != nil {
		t.Fatal(err)
	}
	title := Op{T: TBlockCreate, ID: projectedTitleID, Parent: Root, Pos: "U", Type: "title"}
	body := Op{T: TBlockCreate, ID: OpID{Client: 7, Clock: 1}, Parent: Root, Pos: "V", Type: "paragraph"}
	text := Op{T: TTextInsert, ID: OpID{Client: 7, Clock: 2}, Block: body.ID, Parent: Root, Side: 1, Text: "a😀b"}
	for i, op := range []Op{title, body, text} {
		if err := r.ApplyRecord(projectionRecord(t, uint64(i+1), op)); err != nil {
			t.Fatal(err)
		}
	}
	// The title projector omits body text, but its occupied IDs still matter.
	overlap := Op{T: TTextInsert, ID: OpID{Client: 7, Clock: 3}, Block: projectedTitleID, Parent: Root, Side: 1, Text: "新"}
	if err := r.ApplyRecord(projectionRecord(t, 4, overlap)); !errors.Is(err, ErrTitleReplayIdentity) {
		t.Fatal(err)
	}
	if _, err := r.CandidateAt(4); !errors.Is(err, ErrTitleProjectionOrder) {
		t.Fatal(err)
	}
	// Exactly adjacent to the three code points is safe, regardless of UTF-8 bytes.
	adjacent := Op{T: TTextInsert, ID: OpID{Client: 7, Clock: 5}, Block: projectedTitleID, Parent: Root, Side: 1, Text: "新"}
	if err := r.ApplyRecord(projectionRecord(t, 4, adjacent)); err != nil {
		t.Fatal(err)
	}
	got, err := r.CandidateAt(4)
	if err != nil || got.Text != "新" || !got.Visible {
		t.Fatalf("candidate %+v %v", got, err)
	}
	if err := r.ApplyRecord(projectionRecord(t, 5, adjacent)); !errors.Is(err, ErrTitleReplayIdentity) {
		t.Fatal(err)
	}
}

func TestTitleIdentityReplayHandlesOutOfOrderDisjointRanges(t *testing.T) {
	r, _ := NewTitleIdentityReplay(42, 3)
	title := Op{T: TBlockCreate, ID: projectedTitleID, Parent: Root, Pos: "U", Type: "title"}
	if err := r.ApplyRecord(projectionRecord(t, 1, title)); err != nil {
		t.Fatal(err)
	}
	rng := rand.New(rand.NewSource(97))
	for i, slot := range rng.Perm(5000) {
		op := Op{T: TTextInsert, ID: OpID{Client: 9, Clock: uint64(slot*4 + 1)}, Block: OpID{Client: 88, Clock: 1}, Parent: Root, Side: 1, Text: "😀字"}
		if err := r.ApplyRecord(projectionRecord(t, uint64(i+2), op)); err != nil {
			t.Fatalf("row %d: %v", i, err)
		}
	}
	if _, err := r.CandidateAt(5001); err != nil {
		t.Fatal(err)
	}
	// Even a body-only operation that the projection does not materialize must
	// not reuse the middle of a prior multi-character insertion.
	op := Op{T: TBlockCreate, ID: OpID{Client: 9, Clock: 2}, Parent: Root, Pos: "V", Type: "paragraph"}
	if err := r.ApplyRecord(projectionRecord(t, 5002, op)); !errors.Is(err, ErrTitleReplayIdentity) {
		t.Fatal(err)
	}
}

func TestTitleIdentityReplayRetainsSequenceOnFailure(t *testing.T) {
	r, _ := NewTitleIdentityReplay(42, 3)
	title := Op{T: TBlockCreate, ID: projectedTitleID, Parent: Root, Pos: "U", Type: "title"}
	row := projectionRecord(t, 1, title)
	wrong := row
	wrong.Epoch++
	if err := r.ApplyRecord(wrong); !errors.Is(err, ErrTitleProjectionScope) {
		t.Fatal(err)
	}
	wrong = row
	wrong.Seq++
	if err := r.ApplyRecord(wrong); !errors.Is(err, ErrTitleProjectionOrder) {
		t.Fatal(err)
	}
	wrong = row
	wrong.Bytes = append(append([]byte(nil), row.Bytes...), 0)
	if err := r.ApplyRecord(wrong); !errors.Is(err, ErrTitleProjectionRecord) {
		t.Fatal(err)
	}
	if r.count != 0 {
		t.Fatal("rejected row consumed an identity")
	}
	if err := r.ApplyRecord(row); err != nil {
		t.Fatal(err)
	}
	if _, err := r.CandidateAt(1); err != nil {
		t.Fatal(err)
	}
}

func TestTitleIdentityReplayBoundsAndCausalityLimit(t *testing.T) {
	r, _ := NewTitleIdentityReplay(42, 3)
	title := Op{T: TBlockCreate, ID: projectedTitleID, Parent: Root, Pos: "U", Type: "title"}
	r.count = titleReplayMaxRecords
	if err := r.ApplyRecord(projectionRecord(t, 1, title)); !errors.Is(err, ErrTitleReplayLimit) {
		t.Fatal(err)
	}
	if _, err := r.CandidateAt(1); !errors.Is(err, ErrTitleProjectionOrder) {
		t.Fatal(err)
	}

	r, _ = NewTitleIdentityReplay(42, 3)
	var chain *titleIdentityNode
	for i := titleReplayMaxTreeDepth; i >= 0; i-- {
		chain = &titleIdentityNode{start: uint64(i*2 + 1), end: uint64(i*2 + 1), right: chain}
	}
	r.clients[0] = chain
	deep := Op{T: TBlockCreate, ID: OpID{Client: 0, Clock: 10000}, Parent: Root, Pos: "U", Type: "title"}
	if err := r.ApplyRecord(projectionRecord(t, 1, deep)); !errors.Is(err, ErrTitleReplayLimit) {
		t.Fatal(err)
	}

	r, _ = NewTitleIdentityReplay(42, 3)
	if err := r.ApplyRecord(projectionRecord(t, 1, title)); err != nil {
		t.Fatal(err)
	}
	orphan := Op{T: TTextInsert, ID: OpID{Client: 8, Clock: 1}, Block: OpID{Client: 9, Clock: 1}, Parent: Root, Side: 1, Text: "body"}
	if err := r.ApplyRecord(projectionRecord(t, 2, orphan)); err != nil {
		t.Fatal(err)
	}
	full := NewDoc()
	full.Apply(title)
	full.Apply(orphan)
	if full.Pending() != 1 {
		t.Fatal("expected an unresolved body dependency")
	}
	if _, err := r.CandidateAt(2); err != nil {
		t.Fatalf("identity replay does not claim full causality: %v", err)
	}
}

func FuzzTitleIdentityIntervals(f *testing.F) {
	f.Add([]byte{1, 2, 3, 4, 2, 1})
	f.Fuzz(func(t *testing.T, values []byte) {
		if len(values) > 512 {
			values = values[:512]
		}
		r, _ := NewTitleIdentityReplay(42, 3)
		seen := make(map[uint64]bool)
		var seq uint64
		for _, value := range values {
			clock := uint64(value) + 1
			op := Op{T: TBlockSet, ID: OpID{Client: 7, Clock: clock}, Block: projectedTitleID, Key: "other", Value: new(string)}
			err := r.ApplyRecord(projectionRecord(t, seq+1, op))
			if seen[clock] {
				if !errors.Is(err, ErrTitleReplayIdentity) {
					t.Fatalf("missed duplicate %d: %v", clock, err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				seen[clock] = true
				seq++
			}
		}
	})
}

func FuzzTitleIdentityRanges(f *testing.F) {
	f.Add([]byte{1, 2, 2, 3, 12, 1})
	f.Fuzz(func(t *testing.T, values []byte) {
		if len(values) > 512 {
			values = values[:512]
		}
		r, _ := NewTitleIdentityReplay(42, 3)
		occupied := make(map[uint64]bool)
		var seq uint64
		for i := 0; i+1 < len(values); i += 2 {
			start, length := uint64(values[i])+1, uint64(values[i+1]%5)+1
			overlap := false
			for tick := start; tick < start+length; tick++ {
				overlap = overlap || occupied[tick]
			}
			op := Op{T: TTextInsert, ID: OpID{Client: 7, Clock: start}, Block: OpID{Client: 9, Clock: 1}, Parent: Root, Side: 1, Text: strings.Repeat("😀", int(length))}
			err := r.ApplyRecord(projectionRecord(t, seq+1, op))
			if overlap {
				if !errors.Is(err, ErrTitleReplayIdentity) {
					t.Fatalf("missed overlap %d..%d: %v", start, start+length-1, err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				for tick := start; tick < start+length; tick++ {
					occupied[tick] = true
				}
				seq++
			}
		}
	})
}
