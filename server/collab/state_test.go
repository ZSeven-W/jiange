package collab

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"math/rand"
	"testing"
)

type stateVector struct {
	Name string `json:"name"`
	Hex  string `json:"hex"`
}

func TestStateVectors(t *testing.T) {
	var ss []scenario
	var st []stateVector
	load(t, "scenarios.json", &ss)
	load(t, "state.json", &st)
	for i, s := range ss {
		t.Run(s.Name, func(t *testing.T) {
			raw, _ := hex.DecodeString(st[i].Hex)
			d := NewDoc()
			for _, op := range s.Ops {
				d.Apply(op)
			}
			if got := hex.EncodeToString(d.EncodeState()); got != st[i].Hex {
				t.Fatalf("Go state encoding differs from TS")
			}
			d2, err := DecodeState(raw)
			if err != nil {
				t.Fatal(err)
			}
			var want any
			_ = json.Unmarshal(s.Expected, &want)
			if canon(t, d2.View()) != canon(t, want) {
				t.Fatal("decoded state view differs")
			}
			if !bytes.Equal(d2.EncodeState(), raw) {
				t.Fatal("state re-encode differs")
			}
		})
	}
}

// Compaction must not change the view, and later ops must still apply on top.
func TestCompactPreservesViewAndFutureOps(t *testing.T) {
	var ss []scenario
	load(t, "scenarios.json", &ss)
	for _, s := range ss {
		t.Run(s.Name, func(t *testing.T) {
			cut := len(s.Ops) * 2 / 3
			full := NewDoc()
			for _, op := range s.Ops {
				full.Apply(op)
			}
			want := canon(t, full.View())

			base := NewDoc()
			for _, op := range s.Ops[:cut] {
				base.Apply(op)
			}
			before := canon(t, base.View())
			base.Compact()
			if canon(t, base.View()) != before {
				t.Fatal("compaction changed the view")
			}
			restored, err := DecodeState(base.EncodeState())
			if err != nil {
				t.Fatal(err)
			}
			// ops after the horizon whose dependencies were compacted away are only
			// possible from clients that never acknowledged the horizon; the scenario
			// ops were all generated causally, so count how many still apply.
			for _, op := range s.Ops[cut:] {
				restored.Apply(op)
			}
			if restored.Pending() != 0 || canon(t, restored.View()) != want {
				t.Fatal("ops after compaction diverged")
			}
		})
	}
}

// Regression (doc 9): a slash query is typed and deleted, the snapshot is
// compacted, then the live replica (which still holds the tombstones) types
// the block text with a deleted query character as its Fugue origin. A cold
// load from the snapshot plus the tail must resolve it exactly.
func TestCompactRetainsTombstonesReferencedLater(t *testing.T) {
	live := NewDoc()
	b := live.CreateBlock(1, Root, "V", "callout")
	q := live.InsertText(1, b.ID, 0, "/gl")
	live.DeleteText(1, b.ID, 0, 3)
	snap, err := DecodeState(live.EncodeState())
	if err != nil {
		t.Fatal(err)
	}
	legacy, _ := DecodeState(live.EncodeState())
	if n := snap.Compact(); n != 0 {
		t.Fatalf("compact removed %d tombstones", n)
	}
	if legacy.CompactLegacyTombstones() == 0 {
		t.Fatal("fixture: legacy GC removed nothing")
	}
	tail := []Op{
		{T: TTextInsert, ID: OpID{Client: 1, Clock: 50}, Block: b.ID, Parent: q.ID, Side: 0, Text: "注意"},
		{T: TTextDelete, ID: OpID{Client: 2, Clock: 60}, Block: b.ID, Target: OpID{Client: q.ID.Client, Clock: q.ID.Clock + 2}, Len: 1},
		{T: TMark, ID: OpID{Client: 1, Clock: 70}, Block: b.ID, Key: "bold", Value: ptr("true"), Start: Anchor{Char: q.ID, Side: 0}, End: Anchor{Char: OpID{Client: 1, Clock: 51}, Side: 1}},
	}
	for _, op := range tail {
		live.Apply(op)
		snap.Apply(op)
		legacy.Apply(op)
	}
	if snap.Pending() != 0 || canon(t, snap.View()) != canon(t, live.View()) || snap.Text(b.ID) != "注意" {
		t.Fatalf("cold load diverged: pending %d text %q", snap.Pending(), snap.Text(b.ID))
	}
	if legacy.Pending() == 0 {
		t.Fatal("legacy GC no longer reproduces the unresolved dependency")
	}
}

func ptr(s string) *string { return &s }

func TestTryApply(t *testing.T) {
	d := NewDoc()
	b := d.CreateBlock(1, Root, "V", "p")
	if err := d.TryApply(b); err != ErrDuplicate {
		t.Fatalf("want dup, got %v", err)
	}
	orphan := Op{T: TTextInsert, ID: OpID{2, 10}, Block: b.ID, Parent: OpID{9, 9}, Side: 1, Text: "x"}
	if err := d.TryApply(orphan); err != ErrNotReady || d.Pending() != 0 {
		t.Fatalf("want not ready, got %v", err)
	}
}

type msgVector struct {
	Dir string         `json:"dir"`
	Msg map[string]any `json:"msg"`
	Hex string         `json:"hex"`
}

func TestMessageVectors(t *testing.T) {
	var ms []msgVector
	load(t, "messages.json", &ms)
	num := func(m map[string]any, k string) uint64 { return uint64(m[k].(float64)) }
	hx := func(m map[string]any, k string) []byte { b, _ := hex.DecodeString(m[k].(string)); return b }
	for _, v := range ms {
		var got []byte
		switch v.Dir + ":" + v.Msg["type"].(string) {
		case "c2s:hello":
			if epoch, ok := v.Msg["historyEpoch"]; ok {
				got = EncodeHelloV2(num(v.Msg, "docId"), num(v.Msg, "clientId"), num(v.Msg, "lastSeq"), uint64(epoch.(float64)))
			} else {
				got = EncodeHello(num(v.Msg, "docId"), num(v.Msg, "clientId"), num(v.Msg, "lastSeq"))
			}
		case "c2s:ops":
			got = EncodeClientOps(hx(v.Msg, "batchHex"))
		case "c2s:ack":
			got = EncodeClientAck(num(v.Msg, "seq"))
		case "c2s:aware":
			got = EncodeClientAware(v.Msg["state"].(string))
		case "s2c:welcome":
			epoch, hasEpoch := v.Msg["historyEpoch"]
			if _, ok := v.Msg["stateHex"]; ok {
				if hasEpoch {
					got = EncodeWelcomeV2(num(v.Msg, "clientId"), num(v.Msg, "headSeq"), num(v.Msg, "snapSeq"), hx(v.Msg, "stateHex"), uint64(epoch.(float64)))
				} else {
					got = EncodeWelcome(num(v.Msg, "clientId"), num(v.Msg, "headSeq"), num(v.Msg, "snapSeq"), hx(v.Msg, "stateHex"))
				}
			} else if hasEpoch {
				got = EncodeWelcomeV2(num(v.Msg, "clientId"), num(v.Msg, "headSeq"), 0, nil, uint64(epoch.(float64)))
			} else {
				got = EncodeWelcome(num(v.Msg, "clientId"), num(v.Msg, "headSeq"), 0, nil)
			}
		case "s2c:ops":
			got = EncodeServerOps(num(v.Msg, "firstSeq"), hx(v.Msg, "batchHex"))
		case "s2c:ack":
			got = EncodeServerAck(num(v.Msg, "firstSeq"), num(v.Msg, "count"))
		case "s2c:aware":
			got = EncodeServerAware(num(v.Msg, "clientId"), v.Msg["state"].(string))
		case "s2c:error":
			got = EncodeError(v.Msg["code"].(string), v.Msg["message"].(string))
		}
		if hex.EncodeToString(got) != v.Hex {
			t.Fatalf("%s %v: encoding mismatch", v.Dir, v.Msg["type"])
		}
		raw, _ := hex.DecodeString(v.Hex)
		var err error
		if v.Dir == "c2s" {
			_, err = DecodeClientMsg(raw)
		} else {
			_, err = DecodeServerMsg(raw)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
}

func FuzzDecodeState(f *testing.F) {
	d := NewDoc()
	b := d.CreateBlock(1, Root, "V", "p")
	d.InsertText(1, b.ID, 0, "héllo")
	f.Add(d.EncodeState())
	f.Fuzz(func(t *testing.T, data []byte) {
		d, err := DecodeState(data)
		if err != nil {
			return
		}
		_ = d.View()
		r := rand.New(rand.NewSource(1))
		_ = r
		d.Compact()
		_ = d.EncodeState()
	})
}
