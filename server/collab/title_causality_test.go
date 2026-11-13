package collab

import (
	"context"
	"errors"
	"math/rand"
	"testing"
)

func replayCausality(t *testing.T, ops []Op) (*TitleIdentityReplay, *Doc) {
	t.Helper()
	replay, err := NewTitleIdentityReplay(42, 3)
	if err != nil {
		t.Fatal(err)
	}
	full := NewDoc()
	for index, op := range ops {
		full.Apply(op)
		if err := replay.ApplyRecord(projectionRecord(t, uint64(index+1), op)); err != nil {
			t.Fatalf("row %d: %v", index+1, err)
		}
	}
	return replay, full
}

func TestTitleCausalityRejectsBodyCyclesAndWrongBlockOrigins(t *testing.T) {
	title := Op{T: TBlockCreate, ID: projectedTitleID, Parent: Root, Pos: "U", Type: "title"}
	body := Op{T: TBlockCreate, ID: OpID{Client: 4, Clock: 1}, Parent: Root, Pos: "V", Type: "paragraph"}
	cycleA := Op{T: TTextInsert, ID: OpID{Client: 7, Clock: 1}, Block: body.ID, Parent: OpID{Client: 7, Clock: 2}, Side: 1, Text: "甲"}
	cycleB := Op{T: TTextInsert, ID: OpID{Client: 7, Clock: 2}, Block: body.ID, Parent: cycleA.ID, Side: 1, Text: "乙"}
	replay, full := replayCausality(t, []Op{title, body, cycleA, cycleB})
	if full.Pending() != 2 {
		t.Fatalf("expected cycle to remain pending: %d", full.Pending())
	}
	if _, err := replay.CandidateAt(4); err != nil {
		t.Fatalf("title-only candidate: %v", err)
	}
	if _, err := replay.CausallyCheckedCandidate(context.Background(), 4); !errors.Is(err, ErrTitleReplayCausality) {
		t.Fatalf("cycle: %v", err)
	}
	other := Op{T: TBlockCreate, ID: OpID{Client: 4, Clock: 2}, Parent: Root, Pos: "W", Type: "paragraph"}
	first := Op{T: TTextInsert, ID: OpID{Client: 8, Clock: 1}, Block: body.ID, Parent: Root, Side: 1, Text: "甲"}
	wrong := Op{T: TTextInsert, ID: OpID{Client: 8, Clock: 2}, Block: other.ID, Parent: first.ID, Side: 1, Text: "乙"}
	replay, full = replayCausality(t, []Op{title, body, other, first, wrong})
	if full.Pending() != 1 {
		t.Fatalf("expected wrong-block origin pending: %d", full.Pending())
	}
	if err := replay.ValidateFullCausality(context.Background(), 5); !errors.Is(err, ErrTitleReplayCausality) {
		t.Fatalf("wrong block: %v", err)
	}
}

func TestTitleCausalityAcceptsForwardDependencies(t *testing.T) {
	title := Op{T: TBlockCreate, ID: projectedTitleID, Parent: Root, Pos: "U", Type: "title"}
	body := Op{T: TBlockCreate, ID: OpID{Client: 4, Clock: 1}, Parent: Root, Pos: "V", Type: "paragraph"}
	parent := Op{T: TTextInsert, ID: OpID{Client: 7, Clock: 1}, Block: body.ID, Parent: Root, Side: 1, Text: "甲"}
	child := Op{T: TTextInsert, ID: OpID{Client: 7, Clock: 2}, Block: body.ID, Parent: parent.ID, Side: 1, Text: "乙"}
	move := Op{T: TBlockMove, ID: OpID{Client: 8, Clock: 1}, Block: body.ID, Parent: Root, Pos: "W"}
	replay, full := replayCausality(t, []Op{title, child, move, parent, body})
	if full.Pending() != 0 {
		t.Fatalf("dependencies should resolve: %d", full.Pending())
	}
	candidate, err := replay.CausallyCheckedCandidate(context.Background(), 5)
	if err != nil || !candidate.Visible || candidate.Kind != "title" {
		t.Fatalf("forward dependencies: %+v %v", candidate, err)
	}
}

func TestTitleCausalityChecksDeleteCoverageAndMarkAnchors(t *testing.T) {
	title := Op{T: TBlockCreate, ID: projectedTitleID, Parent: Root, Pos: "U", Type: "title"}
	body := Op{T: TBlockCreate, ID: OpID{Client: 4, Clock: 1}, Parent: Root, Pos: "V", Type: "paragraph"}
	a := Op{T: TTextInsert, ID: OpID{Client: 7, Clock: 1}, Block: body.ID, Parent: Root, Side: 1, Text: "甲乙"}
	b := Op{T: TTextInsert, ID: OpID{Client: 7, Clock: 3}, Block: body.ID, Parent: OpID{Client: 7, Clock: 2}, Side: 1, Text: "😀丁"}
	del := Op{T: TTextDelete, ID: OpID{Client: 8, Clock: 1}, Block: body.ID, Target: a.ID, Len: 4}
	value := "true"
	mark := Op{T: TMark, ID: OpID{Client: 8, Clock: 2}, Block: body.ID, Key: "bold", Value: &value, Start: Anchor{Char: Root}, End: Anchor{Char: OpID{Client: 7, Clock: 4}, Side: 1}}
	replay, full := replayCausality(t, []Op{title, body, a, b, del, mark})
	if full.Pending() != 0 {
		t.Fatalf("valid range pending: %d", full.Pending())
	}
	if err := replay.ValidateFullCausality(context.Background(), 6); err != nil {
		t.Fatal(err)
	}
	missing := Op{T: TTextDelete, ID: OpID{Client: 8, Clock: 3}, Block: body.ID, Target: OpID{Client: 7, Clock: 4}, Len: 2}
	full.Apply(missing)
	if err := replay.ApplyRecord(projectionRecord(t, 7, missing)); err != nil {
		t.Fatal(err)
	}
	if full.Pending() != 1 {
		t.Fatalf("missing deletion target: %d", full.Pending())
	}
	if err := replay.ValidateFullCausality(context.Background(), 7); !errors.Is(err, ErrTitleReplayCausality) {
		t.Fatalf("missing range: %v", err)
	}
}

func TestTitleCausalityAgreesWithFullReplicaAcrossReorderedHistory(t *testing.T) {
	title := Op{T: TBlockCreate, ID: projectedTitleID, Parent: Root, Pos: "U", Type: "title"}
	body := Op{T: TBlockCreate, ID: OpID{Client: 4, Clock: 1}, Parent: Root, Pos: "V", Type: "paragraph"}
	first := Op{T: TTextInsert, ID: OpID{Client: 7, Clock: 1}, Block: body.ID, Parent: Root, Side: 1, Text: "😀甲"}
	second := Op{T: TTextInsert, ID: OpID{Client: 7, Clock: 3}, Block: body.ID, Parent: OpID{Client: 7, Clock: 2}, Side: 1, Text: "乙"}
	del := Op{T: TTextDelete, ID: OpID{Client: 8, Clock: 1}, Block: body.ID, Target: first.ID, Len: 2}
	value := "true"
	mark := Op{T: TMark, ID: OpID{Client: 8, Clock: 2}, Block: body.ID, Key: "bold", Value: &value, Start: Anchor{Char: first.ID}, End: Anchor{Char: second.ID, Side: 1}}
	move := Op{T: TBlockMove, ID: OpID{Client: 8, Clock: 3}, Block: body.ID, Parent: Root, Pos: "W"}
	all := []Op{title, body, first, second, del, mark, move}
	for seed := int64(0); seed < 100; seed++ {
		permutation := rand.New(rand.NewSource(seed)).Perm(len(all))
		ops := make([]Op, len(all))
		for i, index := range permutation {
			ops[i] = all[index]
		}
		replay, full := replayCausality(t, ops)
		if full.Pending() != 0 {
			t.Fatalf("seed %d full pending: %d", seed, full.Pending())
		}
		if err := replay.ValidateFullCausality(context.Background(), uint64(len(ops))); err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
	}
}

func TestTitleCausalityHonorsContextAndHead(t *testing.T) {
	title := Op{T: TBlockCreate, ID: projectedTitleID, Parent: Root, Pos: "U", Type: "title"}
	replay, _ := replayCausality(t, []Op{title})
	if err := replay.ValidateFullCausality(context.Background(), 2); !errors.Is(err, ErrTitleProjectionOrder) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := replay.ValidateFullCausality(ctx, 1); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestTitleCausalityHandlesLongForwardChainIteratively(t *testing.T) {
	title := Op{T: TBlockCreate, ID: projectedTitleID, Parent: Root, Pos: "U", Type: "title"}
	body := Op{T: TBlockCreate, ID: OpID{Client: 4, Clock: 1}, Parent: Root, Pos: "V", Type: "paragraph"}
	replay, err := NewTitleIdentityReplay(42, 3)
	if err != nil {
		t.Fatal(err)
	}
	if err = replay.ApplyRecord(projectionRecord(t, 1, title)); err != nil {
		t.Fatal(err)
	}
	if err = replay.ApplyRecord(projectionRecord(t, 2, body)); err != nil {
		t.Fatal(err)
	}
	const count = 10000
	for index := count; index >= 1; index-- {
		origin := Root
		if index > 1 {
			origin = OpID{Client: 7, Clock: uint64(index - 1)}
		}
		op := Op{T: TTextInsert, ID: OpID{Client: 7, Clock: uint64(index)}, Block: body.ID, Parent: origin, Side: 1, Text: "字"}
		if err = replay.ApplyRecord(projectionRecord(t, uint64(count-index+3), op)); err != nil {
			t.Fatal(err)
		}
	}
	if err = replay.ValidateFullCausality(context.Background(), count+2); err != nil {
		t.Fatal(err)
	}
}

func FuzzTitleCausalityAgainstFullReplica(f *testing.F) {
	f.Add([]byte{0, 0, 1, 2, 0, 3, 4, 1, 1, 5, 2, 3})
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 160 {
			data = data[:160]
		}
		count := len(data) / 4
		title := Op{T: TBlockCreate, ID: projectedTitleID, Parent: Root, Pos: "U", Type: "title"}
		body := Op{T: TBlockCreate, ID: OpID{Client: 4, Clock: 1}, Parent: Root, Pos: "V", Type: "paragraph"}
		ops := []Op{title, body}
		for index := 0; index < count; index++ {
			chunk := data[index*4 : index*4+4]
			id := OpID{Client: uint64(index + 10), Clock: 1}
			block := body.ID
			if chunk[1]&1 != 0 {
				block = OpID{Client: 99, Clock: 1}
			}
			ref := Root
			if count > 0 && chunk[2]&1 != 0 {
				ref = OpID{Client: uint64(int(chunk[3])%count + 10), Clock: 1}
			}
			var op Op
			switch chunk[0] % 6 {
			case 0:
				op = Op{T: TTextInsert, ID: id, Block: block, Parent: ref, Side: 1, Text: "字"}
			case 1:
				op = Op{T: TTextDelete, ID: id, Block: block, Target: ref, Len: 1}
			case 2:
				op = Op{T: TMark, ID: id, Block: block, Key: "bold", Start: Anchor{Char: ref}, End: Anchor{Char: Root}}
			case 3:
				op = Op{T: TBlockMove, ID: id, Block: block, Parent: Root, Pos: "W"}
			case 4:
				value := "x"
				op = Op{T: TBlockSet, ID: id, Block: block, Key: "x", Value: &value}
			case 5:
				op = Op{T: TBlockDelete, ID: id, Block: block}
			}
			ops = append(ops, op)
		}
		replay, full := replayCausality(t, ops)
		err := replay.ValidateFullCausality(context.Background(), uint64(len(ops)))
		if full.Pending() == 0 && err != nil {
			t.Fatalf("complete full replica rejected: %v", err)
		}
		if full.Pending() != 0 && !errors.Is(err, ErrTitleReplayCausality) && !errors.Is(err, ErrTitleProjectionPending) {
			t.Fatalf("unresolved full replica accepted: pending=%d err=%v", full.Pending(), err)
		}
	})
}
