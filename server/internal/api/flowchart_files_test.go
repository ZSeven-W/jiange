package api

import (
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

func TestFlowchartReferencesImage(t *testing.T) {
	props := map[string]string{
		"fc.v":    "1",
		"fc.n.a":  `{"shape":"image","fileId":42,"x":0,"y":0,"w":100,"h":80,"text":""}`,
		"fc.n.b":  `{"shape":"rect","fileId":7,"text":"x"}`,
		"fc.n.c":  "",
		"fc.e.e1": `{"from":"a","to":"b","fileId":9}`,
	}
	if !flowchartReferencesImage(props, "42") {
		t.Fatal("image node not found")
	}
	for _, id := range []string{"7", "9", "0", "abc", "43"} {
		if flowchartReferencesImage(props, id) {
			t.Fatalf("unexpected reference for %s", id)
		}
	}
}

func TestBuildCopyOpsRewritesFlowchartImages(t *testing.T) {
	d := collab.NewDoc()
	for _, raw := range syncsrv.InitialOps("画板") {
		ops, err := collab.DecodeOps(raw.Bytes)
		if err != nil || len(ops) != 1 || !d.Apply(ops[0]) {
			t.Fatalf("initial operations: %v", err)
		}
	}
	block := d.CreateBlock(7, collab.Root, "X", "flowchart")
	for key, value := range map[string]string{
		"fc.n.img": `{"shape":"image","fileId":42,"x":0,"y":0,"w":100,"h":80,"text":""}`,
		"fc.n.box": `{"shape":"rect","x":200,"y":0,"w":100,"h":60,"text":"框"}`,
	} {
		v := value
		if !d.Apply(collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 7, Clock: d.Clock() + 1}, Block: block.ID, Key: key, Value: &v}) {
			t.Fatal("could not set node")
		}
	}
	if ids, err := collectCopyFileIDs(d); err != nil || len(ids) != 1 || ids[0] != 42 {
		t.Fatalf("file IDs: %v %v", ids, err)
	}
	ops, err := buildCopyOps(d, "副本", map[int64]int64{42: 500})
	if err != nil {
		t.Fatal(err)
	}
	replica := collab.NewDoc()
	for _, raw := range ops {
		decoded, _ := collab.DecodeOps(raw.Bytes)
		replica.Apply(decoded[0])
	}
	for _, b := range replica.View().Blocks {
		if b.Type != "flowchart" {
			continue
		}
		if !flowchartReferencesImage(b.Props, "500") || flowchartReferencesImage(b.Props, "42") {
			t.Fatalf("image not remapped: %v", b.Props["fc.n.img"])
		}
		if b.Props["fc.n.box"] != `{"shape":"rect","x":200,"y":0,"w":100,"h":60,"text":"框"}` {
			t.Fatalf("other node changed: %v", b.Props["fc.n.box"])
		}
		return
	}
	t.Fatal("flowchart block missing")
}
