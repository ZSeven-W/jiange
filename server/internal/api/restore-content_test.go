package api

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestVersionRestorePreservesNestedContentAndFormatting(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	ts, client := newTestServer(t, st, nil)
	post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "restore-content@example.test", "name": "测试", "password": "password123"})
	var meta store.DocMeta
	if err := json.NewDecoder(post(t, client, ts.URL+"/api/docs", map[string]string{"title": "原文档"}).Body).Decode(&meta); err != nil {
		t.Fatal(err)
	}
	state, _, err := StateAtHead(ctx, st, meta.ID)
	if err != nil {
		t.Fatal(err)
	}
	parent := state.CreateBlock(9, collab.Root, "W", "columns")
	left := state.CreateBlock(9, parent.ID, "A", "paragraph")
	text := state.InsertText(9, left.ID, 0, "粗体😀内容")
	bold := "true"
	mark := collab.Op{T: collab.TMark, ID: collab.OpID{Client: 9, Clock: state.Clock() + 1}, Block: left.ID, Key: "bold", Value: &bold,
		Start: collab.Anchor{Char: text.ID, Side: 0}, End: collab.Anchor{Char: collab.OpID{Client: text.ID.Client, Clock: text.ID.Clock + 2}, Side: 1}}
	state.Apply(mark)
	right := state.CreateBlock(9, parent.ID, "B", "paragraph")
	rightText := state.InsertText(9, right.ID, 0, "右栏")
	appendOps := func(ops ...collab.Op) {
		t.Helper()
		var raws []store.RawOp
		for _, op := range ops {
			b, err := collab.EncodeOps([]collab.Op{op})
			if err != nil {
				t.Fatal(err)
			}
			raws = append(raws, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
		}
		if _, err := st.AppendOps(ctx, meta.ID, raws); err != nil {
			t.Fatal(err)
		}
	}
	appendOps(parent, left, text, mark, right, rightText)
	url := ts.URL + "/api/docs/" + strconv.FormatInt(meta.ID, 10)
	resp := post(t, client, url+"/versions", map[string]string{"label": "分栏版本"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create version: %d", resp.StatusCode)
	}
	var version store.Version
	if err := json.NewDecoder(resp.Body).Decode(&version); err != nil {
		t.Fatal(err)
	}
	deleted := collab.Op{T: collab.TBlockDelete, ID: collab.OpID{Client: 9, Clock: state.Clock() + 1}, Block: parent.ID}
	state.Apply(deleted)
	appendOps(deleted)
	resp = post(t, client, url+"/versions/"+strconv.FormatInt(version.Seq, 10)+"/restore", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("restore: %d", resp.StatusCode)
	}
	restored, _, err := StateAtHead(ctx, st, meta.ID)
	if err != nil {
		t.Fatal(err)
	}
	blocks := restored.View().Blocks
	var parentID string
	var gotLeft, gotRight *collab.BlockView
	for i := range blocks {
		b := &blocks[i]
		if b.Type == "columns" {
			parentID = b.ID
		}
		if len(b.Spans) > 0 && b.Spans[0].Text == "粗体😀" {
			gotLeft = b
		}
		if len(b.Spans) > 0 && b.Spans[0].Text == "右栏" {
			gotRight = b
		}
	}
	if parentID == "" || gotLeft == nil || gotRight == nil || gotLeft.Parent != parentID || gotRight.Parent != parentID {
		t.Fatalf("restored hierarchy missing: %#v", blocks)
	}
	if !reflect.DeepEqual(gotLeft.Spans[0].Marks, map[string]string{"bold": "true"}) {
		t.Fatalf("restored marks missing: %#v", gotLeft.Spans)
	}
}
