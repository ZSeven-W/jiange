package collab

import (
	"bytes"
	"errors"
	"math/rand"
	"strings"
	"testing"
)

func projectionRecord(t *testing.T, seq uint64, op Op) TitleProjectionRecord {
	t.Helper()
	raw, err := EncodeOps([]Op{op})
	if err != nil {
		t.Fatal(err)
	}
	return TitleProjectionRecord{DocumentID: 42, Epoch: 3, Seq: seq, ClientID: op.ID.Client, Clock: op.ID.Clock, Bytes: raw}
}

func feedProjection(t *testing.T, p *TitleProjection, seq *uint64, op Op) {
	t.Helper()
	*seq++
	if err := p.ApplyRecord(projectionRecord(t, *seq, op)); err != nil {
		t.Fatalf("seq %d %s: %v", *seq, op.T, err)
	}
}

func compareTitleProjection(t *testing.T, full *Doc, p *TitleProjection, seq uint64) {
	t.Helper()
	got, err := p.Candidate()
	if err != nil {
		t.Fatal(err)
	}
	text, kind, visible := full.VisibleBlockText(projectedTitleID)
	if got.Text != text || got.Kind != kind || got.Visible != visible || got.Head != seq || got.DocumentID != 42 || got.Epoch != 3 {
		t.Fatalf("seq %d got %+v; want text=%q kind=%q visible=%v", seq, got, text, kind, visible)
	}
}

func TestTitleProjectionTracksTopologyAndKeepsTombstones(t *testing.T) {
	full := NewDoc()
	p, err := NewTitleProjection(42, 3)
	if err != nil {
		t.Fatal(err)
	}
	var seq uint64
	title := full.CreateBlock(0, Root, "U", "title")
	feedProjection(t, p, &seq, title)
	body := full.CreateBlock(0, Root, "V", "paragraph")
	feedProjection(t, p, &seq, body)
	insert := full.InsertText(7, title.ID, 0, "A😀B")
	feedProjection(t, p, &seq, insert)
	largeBody := full.InsertText(7, body.ID, 0, strings.Repeat("正文", 20000))
	feedProjection(t, p, &seq, largeBody)
	for _, op := range full.DeleteText(7, title.ID, 0, 1) {
		feedProjection(t, p, &seq, op)
	}
	compareTitleProjection(t, full, p, seq)
	cp, err := p.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	if len(cp.State) >= len(full.EncodeState())/10 {
		t.Fatal("checkpoint retained body text")
	}
	p, err = RestoreTitleProjection(42, 3, cp)
	if err != nil {
		t.Fatal(err)
	}
	// A late collaborator can still anchor an insertion to the deleted A.
	late := Op{T: TTextInsert, ID: full.next(8, 1), Block: title.ID, Parent: insert.ID, Side: 1, Text: "晚"}
	full.Apply(late)
	feedProjection(t, p, &seq, late)
	compareTitleProjection(t, full, p, seq)
	move := Op{T: TBlockMove, ID: full.next(7, 1), Block: title.ID, Parent: body.ID, Pos: "U"}
	full.Apply(move)
	feedProjection(t, p, &seq, move)
	compareTitleProjection(t, full, p, seq)
	remove := Op{T: TBlockDelete, ID: full.next(7, 1), Block: body.ID}
	full.Apply(remove)
	feedProjection(t, p, &seq, remove)
	compareTitleProjection(t, full, p, seq)
	got, _ := p.Candidate()
	if got.Visible || got.Text != "" {
		t.Fatalf("hidden title leaked: %+v", got)
	}
}

func TestTitleProjectionRandomizedAgainstFullReplica(t *testing.T) {
	for seed := int64(0); seed < 20; seed++ {
		rng, full := rand.New(rand.NewSource(seed)), NewDoc()
		p, _ := NewTitleProjection(42, 3)
		var seq uint64
		title := full.CreateBlock(0, Root, "U", "title")
		feedProjection(t, p, &seq, title)
		blocks := []OpID{title.ID}
		for step := 0; step < 150; step++ {
			var ops []Op
			switch rng.Intn(7) {
			case 0:
				parent := Root
				if rng.Intn(2) == 0 {
					parent = blocks[rng.Intn(len(blocks))]
				}
				op := full.CreateBlock(7, parent, "V", "paragraph")
				blocks = append(blocks, op.ID)
				ops = []Op{op}
			case 1:
				block := blocks[rng.Intn(len(blocks))]
				ops = []Op{full.InsertText(7, block, len(full.visible(full.blocks[block])), "正文😀")}
			case 2:
				ops = []Op{full.InsertText(7, title.ID, len(full.visible(full.blocks[title.ID])), "标😀")}
			case 3:
				chars := full.visible(full.blocks[title.ID])
				if len(chars) != 0 {
					ops = full.DeleteText(7, title.ID, rng.Intn(len(chars)), 1)
				}
			case 4:
				block, parent := blocks[rng.Intn(len(blocks))], blocks[rng.Intn(len(blocks))]
				op := Op{T: TBlockMove, ID: full.next(7, 1), Block: block, Parent: parent, Pos: "V"}
				full.Apply(op)
				ops = []Op{op}
			case 5:
				block := blocks[rng.Intn(len(blocks))]
				op := Op{T: TBlockDelete, ID: full.next(7, 1), Block: block}
				full.Apply(op)
				ops = []Op{op}
			case 6:
				value := "title"
				if rng.Intn(2) == 0 {
					value = "paragraph"
				}
				op := Op{T: TBlockSet, ID: full.next(7, 1), Block: title.ID, Key: "type", Value: &value}
				full.Apply(op)
				ops = []Op{op}
			}
			for _, op := range ops {
				feedProjection(t, p, &seq, op)
			}
			compareTitleProjection(t, full, p, seq)
			if step%31 == 0 {
				cp, err := p.Checkpoint()
				if err != nil {
					t.Fatal(err)
				}
				p, err = RestoreTitleProjection(42, 3, cp)
				if err != nil {
					t.Fatal(err)
				}
			}
		}
	}
}

func TestTitleProjectionVisibilityMatchesMaterializedView(t *testing.T) {
	full := NewDoc()
	p, _ := NewTitleProjection(42, 3)
	var seq uint64
	apply := func(op Op) { full.Apply(op); feedProjection(t, p, &seq, op) }
	check := func() {
		got, err := p.Candidate()
		if err != nil {
			t.Fatal(err)
		}
		var text, kind string
		visible := false
		for _, block := range full.View().Blocks {
			if block.ID != projectedTitleID.Key() {
				continue
			}
			visible, kind = true, block.Type
			for _, span := range block.Spans {
				text += span.Text
			}
		}
		if got.Visible != visible || got.Kind != kind || got.Text != text {
			t.Fatalf("projection %+v; view %q %q %v", got, text, kind, visible)
		}
	}
	title := Op{T: TBlockCreate, ID: projectedTitleID, Parent: Root, Pos: "U", Type: "title"}
	apply(title)
	insert := Op{T: TTextInsert, ID: OpID{Client: 7, Clock: 2}, Block: projectedTitleID, Parent: Root, Side: 1, Text: "标题"}
	apply(insert)
	check()
	parent := Op{T: TBlockCreate, ID: OpID{Client: 7, Clock: 5}, Parent: Root, Pos: "V", Type: "paragraph"}
	apply(parent)
	apply(Op{T: TBlockMove, ID: OpID{Client: 7, Clock: 6}, Block: projectedTitleID, Parent: parent.ID, Pos: "U"})
	check()
	apply(Op{T: TBlockMove, ID: OpID{Client: 7, Clock: 7}, Block: parent.ID, Parent: projectedTitleID, Pos: "V"})
	check()
	apply(Op{T: TBlockDelete, ID: OpID{Client: 7, Clock: 8}, Block: parent.ID})
	check()
	missing := OpID{Client: 8, Clock: 3}
	apply(Op{T: TBlockMove, ID: OpID{Client: 7, Clock: 9}, Block: projectedTitleID, Parent: missing, Pos: "U"})
	check()
	apply(Op{T: TBlockCreate, ID: missing, Parent: Root, Pos: "W", Type: "paragraph"})
	check()
	other := "paragraph"
	apply(Op{T: TBlockSet, ID: OpID{Client: 7, Clock: 10}, Block: projectedTitleID, Key: "type", Value: &other})
	check()
}

func TestTitleProjectionRejectsBadRecordsWithoutAdvancing(t *testing.T) {
	p, _ := NewTitleProjection(42, 3)
	op := Op{T: TBlockCreate, ID: projectedTitleID, Parent: Root, Pos: "U", Type: "title"}
	row := projectionRecord(t, 1, op)
	wrong := row
	wrong.DocumentID = 43
	if err := p.ApplyRecord(wrong); !errors.Is(err, ErrTitleProjectionScope) {
		t.Fatal(err)
	}
	wrong = row
	wrong.Seq = 2
	if err := p.ApplyRecord(wrong); !errors.Is(err, ErrTitleProjectionOrder) {
		t.Fatal(err)
	}
	wrong = row
	wrong.ClientID = 99
	if err := p.ApplyRecord(wrong); !errors.Is(err, ErrTitleProjectionRecord) {
		t.Fatal(err)
	}
	wrong = row
	wrong.Bytes = append(bytes.Clone(row.Bytes), 0)
	if err := p.ApplyRecord(wrong); !errors.Is(err, ErrTitleProjectionRecord) {
		t.Fatal(err)
	}
	if err := p.ApplyRecord(row); err != nil {
		t.Fatal(err)
	}
	row.Seq = 2
	if err := p.ApplyRecord(row); !errors.Is(err, ErrTitleProjectionRecord) {
		t.Fatal(err)
	}
	got, err := p.Candidate()
	if err != nil || got.Head != 1 {
		t.Fatalf("advanced on rejection: %+v %v", got, err)
	}
}

func TestTitleProjectionPendingAndFullValidationAreSeparate(t *testing.T) {
	p, _ := NewTitleProjection(42, 3)
	orphan := Op{T: TTextInsert, ID: OpID{Client: 7, Clock: 1}, Block: projectedTitleID, Parent: Root, Side: 1, Text: "标题"}
	if err := p.ApplyRecord(projectionRecord(t, 1, orphan)); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Candidate(); !errors.Is(err, ErrTitleProjectionPending) {
		t.Fatal(err)
	}
	if _, err := p.Checkpoint(); !errors.Is(err, ErrTitleProjectionPending) {
		t.Fatal(err)
	}
	title := Op{T: TBlockCreate, ID: projectedTitleID, Parent: Root, Pos: "U", Type: "title"}
	if err := p.ApplyRecord(projectionRecord(t, 2, title)); err != nil {
		t.Fatal(err)
	}
	got, err := p.Candidate()
	if err != nil || got.Text != "标题" {
		t.Fatalf("pending recovery: %+v %v", got, err)
	}
	// An ignored body operation may be unresolved even when the title candidate
	// is ready; a caller must independently validate the complete replica.
	full := NewDoc()
	full.Apply(title)
	other := Op{T: TTextInsert, ID: OpID{Client: 8, Clock: 3}, Block: OpID{Client: 9, Clock: 9}, Parent: Root, Side: 1, Text: "body"}
	full.Apply(other)
	if err := p.ApplyRecord(projectionRecord(t, 3, other)); err != nil {
		t.Fatal(err)
	}
	if full.Pending() != 1 {
		t.Fatal("expected unresolved full-document operation")
	}
	if _, err := p.Candidate(); err != nil {
		t.Fatalf("body-only dependency should not alter candidate: %v", err)
	}
}

func TestTitleProjectionCheckpointRejectsWrongScopeAndCorruption(t *testing.T) {
	p, _ := NewTitleProjection(42, 3)
	op := Op{T: TBlockCreate, ID: projectedTitleID, Parent: Root, Pos: "U", Type: "title"}
	if err := p.ApplyRecord(projectionRecord(t, 1, op)); err != nil {
		t.Fatal(err)
	}
	cp, err := p.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = RestoreTitleProjection(43, 3, cp); !errors.Is(err, ErrTitleProjectionScope) {
		t.Fatal(err)
	}
	if _, err = RestoreTitleProjection(42, 4, cp); !errors.Is(err, ErrTitleProjectionScope) {
		t.Fatal(err)
	}
	bad := cp
	bad.State = bytes.Clone(cp.State)
	bad.State[len(bad.State)-1] ^= 1
	if _, err = RestoreTitleProjection(42, 3, bad); !errors.Is(err, ErrTitleProjectionState) {
		t.Fatal(err)
	}
	bad = cp
	bad.Head++
	if _, err = RestoreTitleProjection(42, 3, bad); !errors.Is(err, ErrTitleProjectionState) {
		t.Fatal(err)
	}
	full := NewDoc()
	full.Apply(op)
	body := full.CreateBlock(7, Root, "V", "paragraph")
	full.InsertText(7, body.ID, 0, "body")
	bad = cp
	bad.State = full.EncodeState()
	bad.Digest = titleCheckpointDigest(bad.DocumentID, bad.Epoch, bad.Head, bad.State)
	if _, err = RestoreTitleProjection(42, 3, bad); !errors.Is(err, ErrTitleProjectionState) {
		t.Fatal(err)
	}
	// The budget is checked before serializing an oversized projected topology.
	p.doc.blocks[projectedTitleID].pos = strings.Repeat("x", titleProjectionMaxState)
	if _, err = p.Checkpoint(); !errors.Is(err, ErrTitleProjectionLimit) {
		t.Fatal(err)
	}
}

func TestTitleProjectionLimitsUntrustedWork(t *testing.T) {
	p, _ := NewTitleProjection(42, 3)
	title := Op{T: TBlockCreate, ID: projectedTitleID, Parent: Root, Pos: "U", Type: "title"}
	if err := p.ApplyRecord(projectionRecord(t, 1, title)); err != nil {
		t.Fatal(err)
	}
	insert := Op{T: TTextInsert, ID: OpID{Client: 7, Clock: 2}, Block: projectedTitleID, Parent: Root, Side: 1, Text: strings.Repeat("a", titleProjectionMaxChars+1)}
	if err := p.ApplyRecord(projectionRecord(t, 2, insert)); !errors.Is(err, ErrTitleProjectionLimit) {
		t.Fatal(err)
	}
	deletion := Op{T: TTextDelete, ID: OpID{Client: 7, Clock: 3}, Block: projectedTitleID, Target: OpID{Client: 7, Clock: 1}, Len: titleProjectionMaxDelete + 1}
	if err := p.ApplyRecord(projectionRecord(t, 2, deletion)); !errors.Is(err, ErrTitleProjectionLimit) {
		t.Fatal(err)
	}
	got, err := p.Candidate()
	if err != nil || got.Head != 1 {
		t.Fatalf("limit advanced state: %+v %v", got, err)
	}
	oversizedPosition := Op{T: TBlockMove, ID: OpID{Client: 7, Clock: 4}, Block: projectedTitleID, Parent: Root, Pos: strings.Repeat("x", titleProjectionMaxPositionBytes+1)}
	if err := p.ApplyRecord(projectionRecord(t, 2, oversizedPosition)); !errors.Is(err, ErrTitleProjectionLimit) {
		t.Fatal(err)
	}
	// Reject a forged multi-operation row before DecodeOps can preallocate it.
	bomb := &writer{}
	bomb.u8(Magic)
	bomb.u8(Version)
	bomb.uvar(50000)
	bomb.b = append(bomb.b, make([]byte, 50000)...)
	if err := p.ApplyRecord(TitleProjectionRecord{DocumentID: 42, Epoch: 3, Seq: 2, ClientID: 7, Clock: 1, Bytes: bomb.b}); !errors.Is(err, ErrTitleProjectionRecord) {
		t.Fatal(err)
	}

	// An excessive count in a checkpoint is rejected before state allocation.
	w := &writer{}
	w.u8(Magic)
	w.u8(StateTag)
	w.u8(Version)
	w.uvar(0)
	w.uvar(titleProjectionMaxBlocks + 1)
	cp := TitleProjectionCheckpoint{DocumentID: 42, Epoch: 3, Head: 1, State: w.b}
	cp.Digest = titleCheckpointDigest(cp.DocumentID, cp.Epoch, cp.Head, cp.State)
	if _, err := RestoreTitleProjection(42, 3, cp); !errors.Is(err, ErrTitleProjectionState) {
		t.Fatal(err)
	}
}

func TestTitleProjectionRejectsUnsortedCheckpointChildren(t *testing.T) {
	// A malicious checkpoint can have a valid checksum but reverse a large
	// sibling list, making the ordinary sorted-insert decoder quadratic.
	w := &writer{}
	w.u8(Magic)
	w.u8(StateTag)
	w.u8(Version)
	w.uvar(10)
	w.uvar(1)
	w.id(projectedTitleID)
	w.id(Root)
	w.str("U")
	w.id(projectedTitleID)
	w.u8(0)
	w.uvar(1)
	w.str("type")
	w.str("title")
	w.id(projectedTitleID)
	w.uvar(2)
	for _, id := range []OpID{{Client: 7, Clock: 4}, {Client: 7, Clock: 3}} {
		w.id(id)
		w.u8(1)
		w.uvar(0)
		w.u8(0)
		w.str("a")
	}
	w.uvar(0)
	cp := TitleProjectionCheckpoint{DocumentID: 42, Epoch: 3, Head: 1, State: w.b}
	cp.Digest = titleCheckpointDigest(cp.DocumentID, cp.Epoch, cp.Head, cp.State)
	if _, err := RestoreTitleProjection(42, 3, cp); !errors.Is(err, ErrTitleProjectionState) {
		t.Fatal(err)
	}
}

func TestTitleProjectionPendingLimitFailsClosed(t *testing.T) {
	p, _ := NewTitleProjection(42, 3)
	for i := uint64(1); i <= titleProjectionMaxPending+1; i++ {
		op := Op{T: TBlockMove, ID: OpID{Client: 7, Clock: i}, Block: OpID{Client: 8, Clock: 1}, Parent: Root, Pos: "U"}
		err := p.ApplyRecord(projectionRecord(t, i, op))
		if i <= titleProjectionMaxPending && err != nil {
			t.Fatal(err)
		}
		if i == titleProjectionMaxPending+1 && !errors.Is(err, ErrTitleProjectionLimit) {
			t.Fatal(err)
		}
	}
	if _, err := p.Candidate(); !errors.Is(err, ErrTitleProjectionLimit) {
		t.Fatal(err)
	}
	if _, err := p.Checkpoint(); !errors.Is(err, ErrTitleProjectionLimit) {
		t.Fatal(err)
	}
}

func TestTitleProjectionPreservesNULAndUnicode(t *testing.T) {
	full := NewDoc()
	p, _ := NewTitleProjection(42, 3)
	var seq uint64
	title := full.CreateBlock(0, Root, "U", "title")
	feedProjection(t, p, &seq, title)
	op := full.InsertText(7, title.ID, 0, "甲\x00😀乙")
	feedProjection(t, p, &seq, op)
	got, err := p.Candidate()
	if err != nil || got.Text != "甲\x00😀乙" {
		t.Fatalf("lossy title: %+v %v", got, err)
	}
	cp, err := p.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	restored, err := RestoreTitleProjection(42, 3, cp)
	if err != nil {
		t.Fatal(err)
	}
	got, err = restored.Candidate()
	if err != nil || got.Text != "甲\x00😀乙" {
		t.Fatalf("lossy restored title: %+v %v", got, err)
	}
}

func FuzzTitleProjectionRecord(f *testing.F) {
	seed, _ := EncodeOps([]Op{{T: TBlockCreate, ID: projectedTitleID, Parent: Root, Pos: "U", Type: "title"}})
	f.Add(seed, uint64(0), uint64(1))
	f.Add([]byte{Magic, Version, 0}, uint64(0), uint64(1))
	f.Fuzz(func(t *testing.T, raw []byte, client, clock uint64) {
		p, _ := NewTitleProjection(42, 3)
		if err := p.ApplyRecord(TitleProjectionRecord{DocumentID: 42, Epoch: 3, Seq: 1, ClientID: client, Clock: clock, Bytes: raw}); err == nil {
			_, _ = p.Candidate()
			_, _ = p.Checkpoint()
		}
	})
}

func FuzzTitleProjectionCheckpoint(f *testing.F) {
	p, _ := NewTitleProjection(42, 3)
	cp, _ := p.Checkpoint()
	f.Add(cp.State, uint64(0))
	f.Add([]byte{Magic, StateTag, Version}, uint64(1))
	f.Fuzz(func(t *testing.T, raw []byte, head uint64) {
		if len(raw) > titleProjectionMaxState {
			return
		}
		checkpoint := TitleProjectionCheckpoint{DocumentID: 42, Epoch: 3, Head: head, State: raw}
		checkpoint.Digest = titleCheckpointDigest(42, 3, head, raw)
		if restored, err := RestoreTitleProjection(42, 3, checkpoint); err == nil {
			_, _ = restored.Candidate()
		}
	})
}
