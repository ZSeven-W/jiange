package collab

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

// 表格子 CRDT 载荷 op（ttable）线格式 roundtrip，与 TS 端字节兼容（tag 8）。
func TestTableOpRoundtrip(t *testing.T) {
	op := Op{T: TTable, ID: OpID{Client: 7, Clock: 9}, Block: OpID{Client: 1, Clock: 1}, Payload: []byte{1, 2, 3, 250, 0}}
	b, encErr := EncodeOps([]Op{op})
	if encErr != nil {
		t.Fatal(encErr)
	}
	ops, err := DecodeOps(b)
	if err != nil || len(ops) != 1 {
		t.Fatalf("roundtrip: %+v %v", ops, err)
	}
	got := ops[0]
	if got.T != TTable || got.ID != op.ID || got.Block != op.Block || string(got.Payload) != string(op.Payload) {
		t.Fatalf("mismatch: %+v", got)
	}
}

// ttable 进入快照：状态 v2 段持久化载荷，v2 roundtrip 保内容；无表格文档保持 v1 字节。
func TestTableStateRoundtrip(t *testing.T) {
	d := NewDoc()
	b := d.CreateBlock(1, Root, "V", "p")
	if err := d.TryApply(Op{T: TTable, ID: OpID{Client: 7, Clock: 9}, Block: b.ID, Payload: []byte(`{"kind":"axis-insert"}`)}); err != nil {
		t.Fatal(err)
	}
	raw := d.EncodeState()
	if raw[2] != StateVersion {
		t.Fatalf("table-bearing state must be v2, got %d", raw[2])
	}
	loaded, err := DecodeState(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !loaded.HasTables() {
		t.Fatal("payloads lost in state roundtrip")
	}
	again := loaded.EncodeState()
	if string(again) != string(raw) {
		t.Fatal("v2 state re-encode not deterministic")
	}
	plain := NewDoc()
	pb := plain.CreateBlock(1, Root, "V", "p")
	plain.TryApply(Op{T: TTextInsert, ID: OpID{Client: 2, Clock: 1}, Block: pb.ID, Parent: Root, Side: 1, Text: "字"})
	if raw := plain.EncodeState(); raw[2] != Version {
		t.Fatalf("table-free state must stay v1, got %d", raw[2])
	}
}

// 跨语言一致性：解码 TS 生成的 ttable 状态向量并重编码为相同字节。
func TestTableStateVectorFromTS(t *testing.T) {
	raw, err := os.ReadFile("../../packages/collab/testdata/ttable-state-vector.json")
	if err != nil {
		t.Skip("vector fixture missing")
	}
	var fixture struct {
		Hex    string `json:"hex"`
		OpsHex string `json:"opsHex"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	state, err := hex.DecodeString(fixture.Hex)
	if err != nil {
		t.Fatal(err)
	}
	d, err := DecodeState(state)
	if err != nil {
		t.Fatalf("TS state: %v", err)
	}
	if !d.HasTables() {
		t.Fatal("TS table payloads lost")
	}
	if string(d.EncodeState()) != string(state) {
		t.Fatal("Go re-encode differs from TS bytes")
	}
	opsBytes, err := hex.DecodeString(fixture.OpsHex)
	if err != nil {
		t.Fatal(err)
	}
	ops, err := DecodeOps(opsBytes)
	if err != nil {
		t.Fatalf("TS ops: %v", err)
	}
	mirror := NewDoc()
	for _, op := range ops {
		if err := mirror.TryApply(op); err != nil {
			t.Fatalf("apply %s: %v", op.T, err)
		}
	}
	if string(mirror.EncodeState()) != string(state) {
		t.Fatal("replayed ops diverge from TS state")
	}
}
