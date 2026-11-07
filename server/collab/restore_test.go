package collab

import (
	"encoding/json"
	"errors"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func restoreTestProp(d *Doc, block OpID, key, value string) {
	op := Op{T: TBlockSet, ID: d.next(7, 1), Block: block, Key: key, Value: &value}
	d.Apply(op)
}

func restoreTestMark(d *Doc, block OpID, from, to int, key string, value *string) {
	vis := d.visible(d.blocks[block])
	op := Op{T: TMark, ID: d.next(7, 1), Block: block, Key: key, Value: value,
		Start: Anchor{Char: vis[from].id, Side: 0}, End: Anchor{Char: vis[to-1].id, Side: 1}}
	d.Apply(op)
}

// Ignore replica-specific block IDs while retaining hierarchy, order, types,
// properties, text, and per-span formatting.
func restoreShape(v DocView) []any {
	index := map[string]int{Root.Key(): -1}
	out := make([]any, 0, len(v.Blocks))
	for i, block := range v.Blocks {
		index[block.ID] = i
		out = append(out, []any{index[block.Parent], block.Type, block.Props, block.Spans})
	}
	return out
}

func restoreFixture() *Doc {
	d := NewDoc()
	parent := d.CreateBlock(7, Root, "U", "columns")
	left := d.CreateBlock(7, parent.ID, "A", "paragraph")
	d.InsertText(7, left.ID, 0, "中文😀AB")
	bold, link := "true", "https://example.com"
	restoreTestMark(d, left.ID, 0, 3, "bold", &bold)
	restoreTestMark(d, left.ID, 3, 5, "link", &link)
	right := d.CreateBlock(7, parent.ID, "B", "paragraph")
	d.InsertText(7, right.ID, 0, "右侧")
	nested := d.CreateBlock(7, right.ID, "U", "h2")
	d.InsertText(7, nested.ID, 0, "嵌套内容")
	restoreTestProp(d, nested.ID, "indent", "1")
	return d
}

func TestRestoreOpsRecreatesNestedBlocksAndMarks(t *testing.T) {
	target := restoreFixture()
	cur := NewDoc()
	ops := RestoreOps(cur, target, 19)
	if cur.Pending() != 0 || !reflect.DeepEqual(restoreShape(cur.View()), restoreShape(target.View())) {
		t.Fatalf("restored hierarchy/marks mismatch:\n got %#v\nwant %#v", restoreShape(cur.View()), restoreShape(target.View()))
	}
	for seed := int64(0); seed < 12; seed++ {
		shuffled := append([]Op(nil), ops...)
		rand.New(rand.NewSource(seed)).Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
		replica := NewDoc()
		for _, op := range shuffled {
			replica.Apply(op)
		}
		if replica.Pending() != 0 || !reflect.DeepEqual(restoreShape(replica.View()), restoreShape(target.View())) {
			t.Fatalf("shuffled replay seed %d: %#v", seed, restoreShape(replica.View()))
		}
	}
}

func TestRestoreOpsRecreatesDeletedParentAndChildren(t *testing.T) {
	target := restoreFixture()
	cur, err := DecodeState(target.EncodeState())
	if err != nil {
		t.Fatal(err)
	}
	parent, _ := parseID(target.View().Blocks[0].ID)
	cur.Apply(Op{T: TBlockDelete, ID: cur.next(3, 1), Block: parent})
	if len(cur.View().Blocks) != 0 {
		t.Fatal("expected deleted subtree hidden")
	}
	RestoreOps(cur, target, 19)
	if cur.Pending() != 0 || !reflect.DeepEqual(restoreShape(cur.View()), restoreShape(target.View())) {
		t.Fatalf("restored deleted subtree: %#v", restoreShape(cur.View()))
	}
}

func TestRestoreOpsMovesExistingChildIntoRecreatedParent(t *testing.T) {
	target := restoreFixture()
	cur, err := DecodeState(target.EncodeState())
	if err != nil {
		t.Fatal(err)
	}
	blocks := target.View().Blocks
	parent, _ := parseID(blocks[0].ID)
	child, _ := parseID(blocks[1].ID)
	cur.Apply(Op{T: TBlockMove, ID: cur.next(3, 1), Block: child, Parent: Root, Pos: "V"})
	cur.Apply(Op{T: TBlockDelete, ID: cur.next(3, 1), Block: parent})
	RestoreOps(cur, target, 19)
	if cur.Pending() != 0 || !reflect.DeepEqual(restoreShape(cur.View()), restoreShape(target.View())) {
		t.Fatalf("existing child was not moved into the recreated parent: %#v", restoreShape(cur.View()))
	}
	if !cur.blocks[child].deleted && cur.Text(child) != "中文😀AB" {
		t.Fatal("existing child content was changed")
	}
}

func TestRestoreOpsPreservesTiedSiblingOrder(t *testing.T) {
	for _, noncanonical := range []bool{false, true} {
		target := NewDoc()
		parent := target.CreateBlock(7, Root, "U", "columns")
		before := target.CreateBlock(7, parent.ID, "A", "paragraph")
		target.InsertText(7, before.ID, 0, "before")
		first := target.CreateBlock(7, parent.ID, "U", "paragraph")
		target.InsertText(7, first.ID, 0, "FIRST")
		second := target.CreateBlock(7, parent.ID, "U", "paragraph")
		target.InsertText(7, second.ID, 0, "SECOND")
		next := "U01"
		if noncanonical {
			next = "U0"
		}
		after := target.CreateBlock(7, parent.ID, next, "paragraph")
		target.InsertText(7, after.ID, 0, "after")
		cur, err := DecodeState(target.EncodeState())
		if err != nil {
			t.Fatal(err)
		}
		cur.Apply(Op{T: TBlockDelete, ID: cur.next(3, 1), Block: first.ID})
		beforeRestore := cur.EncodeState()
		ops := RestoreOps(cur, target, 19)
		if got, want := restoreShape(cur.View()), restoreShape(target.View()); !reflect.DeepEqual(got, want) {
			t.Fatalf("noncanonical=%v: got %#v want %#v", noncanonical, got, want)
		}
		var prev string
		for _, b := range cur.View().Blocks {
			if b.Parent != parent.ID.Key() {
				continue
			}
			id, _ := parseID(b.ID)
			pos := cur.blocks[id].pos
			if !validRestorePosition(pos) || (prev != "" && pos <= prev) {
				t.Fatalf("noncanonical=%v: invalid sibling order %q >= %q", noncanonical, prev, pos)
			}
			prev = pos
		}
		for seed := int64(0); seed < 12; seed++ {
			replica, err := DecodeState(beforeRestore)
			if err != nil {
				t.Fatal(err)
			}
			shuffled := append([]Op(nil), ops...)
			rand.New(rand.NewSource(seed)).Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
			for _, op := range shuffled {
				replica.Apply(op)
			}
			if replica.Pending() != 0 || !reflect.DeepEqual(replica.View(), cur.View()) {
				t.Fatalf("noncanonical=%v seed=%d: replay mismatch", noncanonical, seed)
			}
		}
	}
}

func TestRestoreOpsReconcilesMarksAfterReplacingText(t *testing.T) {
	target := NewDoc()
	block := target.CreateBlock(7, Root, "U", "paragraph")
	target.InsertText(7, block.ID, 0, "前😀后")
	bold := "true"
	restoreTestMark(target, block.ID, 0, 2, "bold", &bold)
	cur, err := DecodeState(target.EncodeState())
	if err != nil {
		t.Fatal(err)
	}
	cur.DeleteText(3, block.ID, 0, 3)
	cur.InsertText(3, block.ID, 0, "替换内容")
	italic := "true"
	restoreTestMark(cur, block.ID, 0, 4, "italic", &italic)
	RestoreOps(cur, target, 19)
	if got, want := cur.View().Blocks[0].Spans, target.View().Blocks[0].Spans; !reflect.DeepEqual(got, want) {
		t.Fatalf("replaced text has wrong formatting: got %#v want %#v", got, want)
	}
}

func TestRestoreOpsReconcilesExistingMarksTypeAndClearsStaleProps(t *testing.T) {
	target := NewDoc()
	block := target.CreateBlock(7, Root, "U", "h1")
	target.InsertText(7, block.ID, 0, "甲😀乙")
	bold := "true"
	restoreTestMark(target, block.ID, 0, 2, "bold", &bold)
	cur, err := DecodeState(target.EncodeState())
	if err != nil {
		t.Fatal(err)
	}
	restoreTestProp(cur, block.ID, "type", "paragraph")
	restoreTestProp(cur, block.ID, "checked", "true")
	color := "red"
	restoreTestMark(cur, block.ID, 1, 3, "color", &color)
	restoreTestMark(cur, block.ID, 0, 2, "bold", nil)
	ops := RestoreOps(cur, target, 19)
	got := cur.View().Blocks[0]
	want := target.View().Blocks[0]
	if got.Type != "h1" || got.Props["checked"] != "" || !reflect.DeepEqual(got.Spans, want.Spans) {
		t.Fatalf("restored content: got %#v want %#v", got, want)
	}
	if len(ops) == 0 {
		t.Fatal("expected restore operations")
	}
	if again := RestoreOps(cur, target, 19); len(again) != 0 {
		b, _ := json.Marshal(again)
		t.Fatalf("repeating same restore should not add operations: %s", b)
	}
}

func TestRestoreOpsKeepsLateTextInRetainedBlock(t *testing.T) {
	target := NewDoc()
	block := target.CreateBlock(7, Root, "U", "paragraph")
	target.InsertText(7, block.ID, 0, "旧")
	cur, _ := DecodeState(target.EncodeState())
	cur.InsertText(3, block.ID, 1, "当前")
	peer, _ := DecodeState(cur.EncodeState())
	late := peer.InsertText(5, block.ID, len([]rune(peer.Text(block.ID))), "远端")
	RestoreOps(cur, target, 19)
	cur.Apply(late)
	if got := cur.Text(block.ID); got != "旧远端" {
		t.Fatalf("late remote text lost: %q", got)
	}
}

func TestRestorePreservesExplicitMarkExpansion(t *testing.T) {
	for _, expanding := range []bool{false, true} {
		target := NewDoc()
		block := target.CreateBlock(7, Root, "U", "paragraph")
		ins := target.InsertText(7, block.ID, 0, "A")
		bold := "true"
		end := Anchor{Char: ins.ID, Side: 1}
		if expanding {
			end = Anchor{Char: Root, Side: 0}
		}
		target.Apply(Op{T: TMark, ID: target.next(7, 1), Block: block.ID, Key: "bold", Value: &bold, Start: Anchor{Char: ins.ID, Side: 0}, End: end})
		for _, reuse := range []bool{false, true} {
			cur := NewDoc()
			if reuse {
				var err error
				cur, err = DecodeState(target.EncodeState())
				if err != nil {
					t.Fatal(err)
				}
				// Same rendered style, opposite future insertion behavior.
				opposite := Anchor{Char: Root, Side: 0}
				if expanding {
					opposite = Anchor{Char: ins.ID, Side: 1}
				}
				cur.Apply(Op{T: TMark, ID: cur.next(3, 1), Block: block.ID, Key: "bold", Value: &bold, Start: Anchor{Char: ins.ID, Side: 0}, End: opposite})
			}
			if _, err := RestoreOpsChecked(cur, target, 19); err != nil {
				t.Fatalf("expanding=%v reuse=%v: %v", expanding, reuse, err)
			}
			id, _ := parseID(cur.View().Blocks[0].ID)
			cur.InsertText(19, id, 1, "B")
			expected, _ := DecodeState(target.EncodeState())
			expected.InsertText(18, block.ID, 1, "B")
			if got, want := cur.View().Blocks[0].Spans, expected.View().Blocks[0].Spans; !reflect.DeepEqual(got, want) {
				t.Fatalf("expanding=%v reuse=%v: got %#v want %#v", expanding, reuse, got, want)
			}
		}
	}
}

func TestRestoreClonesDeletedMarkAnchorsForNewBlocks(t *testing.T) {
	target := NewDoc()
	block := target.CreateBlock(7, Root, "U", "paragraph")
	target.InsertText(7, block.ID, 0, "ABC")
	bold := "true"
	restoreTestMark(target, block.ID, 1, 2, "bold", &bold)
	target.DeleteText(7, block.ID, 1, 1)
	cur := NewDoc()
	if _, err := RestoreOpsChecked(cur, target, 19); err != nil {
		t.Fatal(err)
	}
	id, _ := parseID(cur.View().Blocks[0].ID)
	for offset := 0; offset <= 2; offset++ {
		a, _ := DecodeState(target.EncodeState())
		b, _ := DecodeState(cur.EncodeState())
		a.InsertText(18, block.ID, offset, "X")
		b.InsertText(19, id, offset, "X")
		if got, want := b.View().Blocks[0].Spans, a.View().Blocks[0].Spans; !reflect.DeepEqual(got, want) {
			t.Fatalf("offset %d: got %#v want %#v", offset, got, want)
		}
	}
}

func TestRestoreClonesHiddenAnchorsIntoUntouchedExistingBlock(t *testing.T) {
	target := NewDoc()
	block := target.CreateBlock(0, Root, "U", "paragraph")
	target.InsertText(7, block.ID, 0, "ABC")
	bold := "true"
	restoreTestMark(target, block.ID, 1, 2, "bold", &bold)
	target.DeleteText(7, block.ID, 1, 1)
	cur := NewDoc()
	initial := cur.CreateBlock(0, Root, "U", "paragraph")
	if initial.ID != block.ID {
		t.Fatal("expected canonical initial block ID")
	}
	if _, err := RestoreOpsChecked(cur, target, 19); err != nil {
		t.Fatal(err)
	}
	if again, err := RestoreOpsChecked(cur, target, 19); err != nil || len(again) != 0 {
		t.Fatalf("identical cloned history should be a no-op: ops=%v err=%v", again, err)
	}
	for offset := 0; offset <= 2; offset++ {
		a, _ := DecodeState(target.EncodeState())
		b, _ := DecodeState(cur.EncodeState())
		a.InsertText(18, block.ID, offset, "X")
		b.InsertText(19, block.ID, offset, "X")
		if got, want := b.View().Blocks[0].Spans, a.View().Blocks[0].Spans; !reflect.DeepEqual(got, want) {
			t.Fatalf("offset %d: got %#v want %#v", offset, got, want)
		}
	}
}

func TestRestoreRejectsDynamicRootMarkWithoutMutation(t *testing.T) {
	target := NewDoc()
	block := target.CreateBlock(7, Root, "U", "paragraph")
	target.InsertText(7, block.ID, 0, "ABC")
	cur, _ := DecodeState(target.EncodeState())
	value := "red"
	cur.Apply(Op{T: TMark, ID: cur.next(3, 1), Block: block.ID, Key: "color", Value: &value,
		Start: Anchor{Char: Root, Side: 1}, End: Anchor{Char: Root, Side: 0}})
	before := cur.EncodeState()
	ops, err := RestoreOpsChecked(cur, target, 19)
	if !errors.Is(err, ErrRestoreUnrepresentable) || len(ops) != 0 || !reflect.DeepEqual(before, cur.EncodeState()) {
		t.Fatalf("dynamic root anchor must fail without mutation: ops=%v err=%v", ops, err)
	}
}

func TestRestoreRejectsUnmappableHiddenAnchorsWithoutMutation(t *testing.T) {
	target := NewDoc()
	block := target.CreateBlock(7, Root, "U", "paragraph")
	target.InsertText(7, block.ID, 0, "ABC")
	bold := "true"
	restoreTestMark(target, block.ID, 1, 2, "bold", &bold)
	target.DeleteText(7, block.ID, 1, 1)
	cur, _ := DecodeState(target.EncodeState())
	italic := "true"
	restoreTestMark(cur, block.ID, 0, 1, "italic", &italic)
	before := cur.EncodeState()
	ops, err := RestoreOpsChecked(cur, target, 19)
	if !errors.Is(err, ErrRestoreUnrepresentable) || len(ops) != 0 || !reflect.DeepEqual(before, cur.EncodeState()) {
		t.Fatalf("restore must fail without mutation: ops=%v error=%v", ops, err)
	}
}

func TestRestoreRejectsIncompletePlanWithoutMutation(t *testing.T) {
	cur := NewDoc()
	block := cur.CreateBlock(7, Root, "U", "paragraph")
	cur.InsertText(7, block.ID, 0, "原文")
	before := cur.EncodeState()
	working, err := DecodeState(before)
	if err != nil {
		t.Fatal(err)
	}
	orphan := Op{T: TTextInsert, ID: working.next(19, 1), Block: OpID{Client: 99, Clock: 99}, Parent: Root, Side: 1, Text: "X"}
	working.Apply(orphan)
	if err := applyRestorePlan(cur, working, []Op{orphan}); !errors.Is(err, ErrRestoreUnrepresentable) {
		t.Fatalf("expected incomplete plan to be rejected, got %v", err)
	}
	if !reflect.DeepEqual(before, cur.EncodeState()) || cur.Pending() != 0 {
		t.Fatal("failed plan changed the original document")
	}
}

func TestRestoreRejectsExpensiveMarksBeforeMaterializingView(t *testing.T) {
	target := NewDoc()
	parent := target.CreateBlock(7, Root, "U", "columns")
	block := target.CreateBlock(7, parent.ID, "U", "paragraph")
	ins := target.InsertText(7, block.ID, 0, strings.Repeat("字", 50_000))
	value := "true"
	for i := 0; i < 101; i++ {
		target.Apply(Op{T: TMark, ID: target.next(7, 1), Block: block.ID, Key: "bold", Value: &value,
			Start: Anchor{Char: ins.ID, Side: 0}, End: Anchor{Char: Root, Side: 0}})
	}
	if target.blocks[block.ID].order != nil {
		t.Fatal("test requires an unmaterialized block")
	}
	cur := NewDoc()
	before := cur.EncodeState()
	ops, err := RestoreOpsChecked(cur, target, 19)
	if !errors.Is(err, ErrRestoreUnrepresentable) || len(ops) != 0 || !reflect.DeepEqual(before, cur.EncodeState()) {
		t.Fatalf("expected safe complexity refusal: ops=%d err=%v", len(ops), err)
	}
	if target.blocks[block.ID].order != nil {
		t.Fatal("complexity check materialized the expensive target view")
	}
	// The same expensive text under a deleted parent is not in the visible
	// document and must not make an otherwise empty restore fail.
	target.Apply(Op{T: TBlockDelete, ID: target.next(7, 1), Block: parent.ID})
	if ops, err := RestoreOpsChecked(cur, target, 19); err != nil || len(ops) != 0 {
		t.Fatalf("hidden subtree should not count toward cost: ops=%d err=%v", len(ops), err)
	}
}

func TestRestoreRejectsSeenIDCollisionWithoutMutation(t *testing.T) {
	cur := NewDoc()
	block := cur.CreateBlock(7, Root, "U", "paragraph")
	// Empty inserts enter seen but do not advance the stored Lamport clock;
	// that historical ID is absent from EncodeState/DecodeState.
	collision := Op{T: TTextInsert, ID: OpID{Client: 19, Clock: cur.Clock() + 1}, Block: block.ID, Parent: Root, Side: 1, Text: ""}
	cur.Apply(collision)
	target := NewDoc()
	target.CreateBlock(7, Root, "U", "h1")
	before := cur.EncodeState()
	ops, err := RestoreOpsChecked(cur, target, 19)
	if !errors.Is(err, ErrRestoreUnrepresentable) || len(ops) != 0 || !reflect.DeepEqual(before, cur.EncodeState()) || cur.Pending() != 0 {
		t.Fatalf("seen collision must fail before mutation: ops=%v err=%v", ops, err)
	}
}

func TestRestoreMarkEvaluatorMatchesRealInsertion(t *testing.T) {
	target := restoreFixture()
	blocks := target.View().Blocks
	block, _ := parseID(blocks[1].ID)
	// A deleted node makes the physical order differ from visible offsets.
	target.DeleteText(7, block, 1, 1)
	b := target.blocks[block]
	eval, err := newRestoreMarkEvaluator(b)
	if err != nil {
		t.Fatal(err)
	}
	for offset := 0; offset <= len(eval.visible); offset++ {
		clone, _ := DecodeState(target.EncodeState())
		ins := clone.InsertText(33, block, offset, "X")
		var chars []map[string]string
		for _, span := range clone.View().Blocks[1].Spans {
			for range span.Text {
				chars = append(chars, span.Marks)
			}
		}
		vis := clone.visible(clone.blocks[block])
		idx := -1
		for i, n := range vis {
			if n.id == ins.ID {
				idx = i
				break
			}
		}
		if idx < 0 || !reflect.DeepEqual(eval.at(offset), chars[idx]) {
			t.Fatalf("offset=%d got=%v want=%v", offset, eval.at(offset), chars[idx])
		}
	}
}

func TestRestoreMarkEvaluatorRandomized(t *testing.T) {
	for seed := int64(0); seed < 200; seed++ {
		rng := rand.New(rand.NewSource(seed))
		doc := NewDoc()
		block := doc.CreateBlock(7, Root, "U", "paragraph").ID
		for i := 0; i < 12; i++ {
			visible := doc.visible(doc.blocks[block])
			if len(visible) > 0 && rng.Intn(3) == 0 {
				doc.DeleteText(7, block, rng.Intn(len(visible)), 1)
			} else {
				doc.InsertText(7, block, rng.Intn(len(visible)+1), string(rune('a'+i)))
			}
		}
		order := doc.blocks[block].fullOrder()
		if len(order) == 0 {
			continue
		}
		for i := 0; i < 8; i++ {
			pick := func() Anchor {
				if rng.Intn(8) == 0 {
					return Anchor{Char: Root, Side: uint8(rng.Intn(2))}
				}
				return Anchor{Char: order[rng.Intn(len(order))].id, Side: uint8(rng.Intn(2))}
			}
			value := "yes"
			var val *string
			if rng.Intn(3) != 0 {
				val = &value
			}
			doc.Apply(Op{T: TMark, ID: doc.next(7, 1), Block: block, Key: []string{"bold", "color"}[rng.Intn(2)], Value: val, Start: pick(), End: pick()})
		}
		eval, err := newRestoreMarkEvaluator(doc.blocks[block])
		if err != nil {
			t.Fatal(err)
		}
		for offset := 0; offset <= len(eval.visible); offset++ {
			clone, err := DecodeState(doc.EncodeState())
			if err != nil {
				t.Fatal(err)
			}
			ins := clone.InsertText(33, block, offset, "X")
			var marks []map[string]string
			for _, span := range clone.blocks[block].view(Root).Spans {
				for range span.Text {
					marks = append(marks, span.Marks)
				}
			}
			idx := -1
			for i, n := range clone.visible(clone.blocks[block]) {
				if n.id == ins.ID {
					idx = i
					break
				}
			}
			if idx < 0 || !reflect.DeepEqual(eval.at(offset), marks[idx]) {
				t.Fatalf("seed=%d offset=%d got=%v want=%v", seed, offset, eval.at(offset), marks[idx])
			}
		}
	}
}

// Run UPDATE_RESTORE_VECTOR=1 go test ./collab -run TestRestoreOpsCrossLanguageVector
// after intentionally changing the generated restore operations.
func TestRestoreOpsCrossLanguageVector(t *testing.T) {
	type vector struct {
		State    []byte  `json:"state"`
		Ops      []Op    `json:"ops"`
		Expected DocView `json:"expected"`
	}
	name := filepath.Join("..", "..", "spec", "vectors", "restore.json")
	if os.Getenv("UPDATE_RESTORE_VECTOR") == "1" {
		target := restoreFixture()
		root := target.CreateBlock(7, Root, "V", "h1")
		target.InsertText(7, root.ID, 0, "标题😀")
		bold := "true"
		restoreTestMark(target, root.ID, 0, 2, "bold", &bold)
		tie1 := target.CreateBlock(7, Root, "W", "paragraph")
		target.InsertText(7, tie1.ID, 0, "FIRST")
		tie2 := target.CreateBlock(7, Root, "W", "paragraph")
		target.InsertText(7, tie2.ID, 0, "SECOND")
		hidden := target.CreateBlock(7, Root, "X", "paragraph")
		target.InsertText(7, hidden.ID, 0, "ABC")
		blue := "blue"
		restoreTestMark(target, hidden.ID, 1, 2, "color", &blue)
		target.DeleteText(7, hidden.ID, 1, 1)
		cur, err := DecodeState(target.EncodeState())
		if err != nil {
			t.Fatal(err)
		}
		parent, _ := parseID(target.View().Blocks[0].ID)
		cur.Apply(Op{T: TBlockDelete, ID: cur.next(3, 1), Block: parent})
		cur.Apply(Op{T: TBlockDelete, ID: cur.next(3, 1), Block: tie1.ID})
		cur.Apply(Op{T: TBlockDelete, ID: cur.next(3, 1), Block: hidden.ID})
		restoreTestProp(cur, root.ID, "type", "paragraph")
		restoreTestMark(cur, root.ID, 0, 2, "bold", nil)
		initial := cur.EncodeState()
		ops := RestoreOps(cur, target, 19)
		data, err := json.MarshalIndent(vector{State: initial, Ops: ops, Expected: cur.View()}, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(name, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	var v vector
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	for seed := int64(0); seed < 12; seed++ {
		doc, err := DecodeState(v.State)
		if err != nil {
			t.Fatal(err)
		}
		ops := append([]Op(nil), v.Ops...)
		rand.New(rand.NewSource(seed)).Shuffle(len(ops), func(i, j int) { ops[i], ops[j] = ops[j], ops[i] })
		for _, op := range ops {
			doc.Apply(op)
		}
		if doc.Pending() != 0 || !reflect.DeepEqual(doc.View(), v.Expected) {
			t.Fatalf("restore vector mismatch for seed %d: got %#v want %#v", seed, doc.View(), v.Expected)
		}
	}
}
