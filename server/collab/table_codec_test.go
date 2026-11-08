package collab

import "testing"

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
