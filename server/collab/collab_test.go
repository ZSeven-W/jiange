package collab

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

type encVector struct {
	Name string `json:"name"`
	Ops  []Op   `json:"ops"`
	Hex  string `json:"hex"`
}

type scenario struct {
	Name     string          `json:"name"`
	Ops      []Op            `json:"ops"`
	Expected json.RawMessage `json:"expected"`
}

func load(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "spec", "vectors", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

func canon(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var x any
	if err := json.Unmarshal(b, &x); err != nil {
		t.Fatal(err)
	}
	b, _ = json.Marshal(x) // map keys sorted
	return string(b)
}

func TestEncodingVectors(t *testing.T) {
	var vs []encVector
	load(t, "encoding.json", &vs)
	if len(vs) == 0 {
		t.Fatal("no vectors")
	}
	for _, v := range vs {
		t.Run(v.Name, func(t *testing.T) {
			got, err := EncodeOps(v.Ops)
			if err != nil {
				t.Fatal(err)
			}
			if hex.EncodeToString(got) != v.Hex {
				t.Fatalf("encoding mismatch")
			}
			raw, _ := hex.DecodeString(v.Hex)
			dec, err := DecodeOps(raw)
			if err != nil {
				t.Fatal(err)
			}
			re, _ := EncodeOps(dec)
			if !bytes.Equal(re, raw) {
				t.Fatal("decode/encode not stable")
			}
			if canon(t, dec) != canon(t, v.Ops) {
				t.Fatal("decoded ops differ from JSON ops")
			}
		})
	}
}

func TestScenarioVectorsConverge(t *testing.T) {
	var ss []scenario
	load(t, "scenarios.json", &ss)
	for _, s := range ss {
		t.Run(s.Name, func(t *testing.T) {
			var want any
			_ = json.Unmarshal(s.Expected, &want)
			wantS := canon(t, want)
			r := rand.New(rand.NewSource(int64(len(s.Ops))))
			for k := 0; k < 25; k++ {
				ops := append([]Op(nil), s.Ops...)
				if k > 0 {
					r.Shuffle(len(ops), func(i, j int) { ops[i], ops[j] = ops[j], ops[i] })
					ops = append(ops, ops[:len(ops)/5]...) // duplicates
				}
				d := NewDoc()
				for _, op := range ops {
					d.Apply(op)
				}
				if d.Pending() != 0 {
					t.Fatalf("pending ops left: %d", d.Pending())
				}
				if got := canon(t, d.View()); got != wantS {
					t.Fatalf("permutation %d diverged from TS\n got: %.300s\nwant: %.300s", k, got, wantS)
				}
			}
		})
	}
}

func TestDecodeRejectsGarbage(t *testing.T) {
	for _, b := range [][]byte{{}, {0x00}, {0x4a, 2, 0}, {0x4a, 1, 1, 99, 1, 1}, {0x4a, 1, 5}} {
		if _, err := DecodeOps(b); err == nil {
			t.Fatalf("expected error for %x", b)
		}
	}
}

func FuzzDecode(f *testing.F) {
	var vs []encVector
	b, _ := os.ReadFile(filepath.Join("..", "..", "spec", "vectors", "encoding.json"))
	_ = json.Unmarshal(b, &vs)
	for _, v := range vs[:3] {
		raw, _ := hex.DecodeString(v.Hex)
		f.Add(raw)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		ops, err := DecodeOps(data)
		if err != nil {
			return
		}
		re, err := EncodeOps(ops)
		if err != nil {
			t.Fatal(err)
		}
		ops2, err := DecodeOps(re)
		if err != nil || len(ops2) != len(ops) {
			t.Fatal("re-decode failed")
		}
		d := NewDoc()
		for _, op := range ops {
			d.Apply(op) // must not panic on arbitrary (decodable) input
		}
		_ = d.View()
	})
}
