package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func flowProjectionFixture() map[string]string {
	return map[string]string{
		"fc.theme": "classic", "fc.h": "420", "align": "center", "caption": "HIDDEN-OLD-CAPTION",
		"fc.n.a":            `{"shape":"rect","x":12,"y":18,"w":150,"h":70,"text":"需求评审","fill":"#E1EAFF","stroke":"#3370FF","size":15,"align":"left","z":3,"private":"HIDDEN-NODE-EXTRA"}`,
		"fc.n.b":            `{"shape":"image","x":220,"y":18,"w":160,"h":120,"fileId":42,"text":"HIDDEN-IMAGE-LABEL"}`,
		"fc.n.invalid-key!": `{"shape":"image","fileId":777,"text":"HIDDEN-INVALID-NODE"}`,
		"fc.e.live":         `{"from":"a","to":"b","label":"通过","kind":"curve","dashed":true,"color":"#3370FF","arrow":"both","mid":123,"pts":[{"x":100,"y":80,"private":"HIDDEN-POINT-EXTRA"}],"private":"HIDDEN-EDGE-EXTRA"}`,
		"fc.e.orphan":       `{"from":"a","to":"missing","label":"HIDDEN-ORPHAN-EDGE"}`,
		"fc.s.ink":          `{"points":[{"x":10,"y":20,"hidden":"HIDDEN-STROKE-EXTRA"},{"x":80,"y":60}],"color":"#3370FF","width":3,"marker":true}`,
		"fc.marker.ink":     "1", "fc.marker.missing": "1",
		"fc.m.root":   `{"parent":null,"order":0,"text":"项目计划","x":5,"y":6,"private":"HIDDEN-TOPIC-EXTRA"}`,
		"fc.m.child":  `{"parent":"root","order":0,"text":"执行阶段","x":999,"y":999}`,
		"fc.m.orphan": `{"parent":"missing","order":0,"text":"HIDDEN-ORPHAN-TOPIC"}`,
		"fc.md.child": `"工作说明"`, "fc.md.orphan": `"HIDDEN-ORPHAN-DESCRIPTION"`,
		"fc.mc.root": "1", "fc.mc.orphan": "1",
		"fc.ms.child":  `{"shape":"rect","size":18,"color":"#D83931"}`,
		"fc.mp.child":  `{"fill":"#E1EAFF","fillOpacity":80,"stroke":"#3370FF","line":"dashed","width":2,"opacity":90}`,
		"fc.mt.child":  `{"bold":true,"italic":true,"highlight":"#FFF5C7","align":"left"}`,
		"fc.mds.child": `{"size":14,"color":"#646A73"}`,
		"fc.ms.orphan": `{"size":18}`, "fc.future": "HIDDEN-UNKNOWN-REGISTER",
	}
}

func TestPublicFlowProjectionOnPublicAndSavedVersion(t *testing.T) {
	ctx := context.Background()
	e := newCopyTestEnv(t)
	e.share(t)
	doc, _, err := StateAtHead(ctx, e.store, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	create := doc.CreateBlock(23, collab.Root, "Z", "flowchart")
	ops := []collab.Op{create}
	props := flowProjectionFixture()
	keys := make([]string, 0, len(props))
	for key := range props {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := props[key]
		op := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 23, Clock: doc.Clock() + 1}, Block: create.ID, Key: key, Value: &value}
		if !doc.Apply(op) {
			t.Fatalf("apply %s", key)
		}
		ops = append(ops, op)
	}
	rows := make([]store.RawOp, 0, len(ops))
	for _, op := range ops {
		data, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		rows = append(rows, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: data})
	}
	if _, err = e.store.AppendOps(ctx, e.source.ID, rows); err != nil {
		t.Fatal(err)
	}
	current, seq, err := StateAtHead(ctx, e.store, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = e.store.SaveSnapshot(ctx, e.source.ID, seq, current.EncodeState()); err != nil {
		t.Fatal(err)
	}
	if err = e.store.SaveVersion(ctx, e.source.ID, seq, "保存版", e.ownerUser.ID); err != nil {
		t.Fatal(err)
	}
	r := send(t, e.owner, "PUT", e.url()+"/link", map[string]string{"role": "anon"})
	var link store.Link
	if err = json.NewDecoder(r.Body).Decode(&link); err != nil || r.StatusCode != 200 {
		t.Fatalf("link: %d %v", r.StatusCode, err)
	}
	r.Body.Close()
	version := e.url() + "/versions/" + strconv.FormatInt(seq, 10)
	for _, tc := range []struct {
		name   string
		client *http.Client
		url    string
		editor bool
	}{{"public", &http.Client{}, e.server.URL + "/api/public/" + link.Token, false}, {"reader", e.guest, version, false}, {"editor", e.owner, version, true}} {
		t.Run(tc.name, func(t *testing.T) {
			r, err := tc.client.Get(tc.url)
			if err != nil {
				t.Fatal(err)
			}
			defer r.Body.Close()
			body, _ := io.ReadAll(r.Body)
			if r.StatusCode != 200 || !bytes.Contains(body, []byte("需求评审")) || !bytes.Contains(body, []byte("项目计划")) {
				t.Fatalf("missing visible graph: %d %s", r.StatusCode, body)
			}
			if got := bytes.Contains(body, []byte("HIDDEN-")); got != tc.editor {
				t.Fatalf("unexpected private field presence %v: %s", got, body)
			}
		})
	}
	projected, err := publicTableView(current.View())
	if err != nil {
		t.Fatal(err)
	}
	readOnly, err := current.ReadOnlyProjection(projected)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(readOnly.EncodeState(), []byte("HIDDEN-")) {
		t.Fatal("read-only state retained hidden graph metadata")
	}
}

func TestPublicFlowProjectionFiltersHiddenData(t *testing.T) {
	input := flowProjectionFixture()
	before, _ := json.Marshal(input)
	out := publicFlowProps(input)
	after, _ := json.Marshal(input)
	if string(before) != string(after) {
		t.Fatal("projection mutated input")
	}
	encoded, _ := json.Marshal(out)
	if strings.Contains(string(encoded), "HIDDEN-") {
		t.Fatalf("hidden data leaked: %s", encoded)
	}
	for _, key := range []string{"fc.n.a", "fc.n.b", "fc.e.live", "fc.s.ink", "fc.marker.ink", "fc.m.root", "fc.m.child", "fc.md.child", "fc.mc.root", "fc.ms.child", "fc.mp.child", "fc.mt.child", "fc.mds.child"} {
		if out[key] == "" {
			t.Errorf("visible %s omitted", key)
		}
	}
	for _, key := range []string{"fc.e.orphan", "fc.m.orphan", "fc.md.orphan", "fc.mc.orphan", "fc.ms.orphan", "fc.marker.missing", "fc.future"} {
		if out[key] != "" {
			t.Errorf("hidden %s retained", key)
		}
	}
	if !flowchartReferencesImage(out, "42") || flowchartReferencesImage(input, "777") {
		t.Fatal("image references do not match renderable nodes")
	}
	fixture := struct {
		Input  map[string]string `json:"input"`
		Output map[string]string `json:"output"`
	}{input, out}
	data, err := json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if path := os.Getenv("JIANGE_FLOW_VECTOR_PATH"); path != "" {
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if path := "../../../packages/whiteboard-sdk/test/fixtures/public-flow-projection.json"; os.Getenv("JIANGE_FLOW_VECTOR_PATH") == "" {
		stored, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var expected any
		var actual any
		if json.Unmarshal(stored, &expected) != nil || json.Unmarshal(data, &actual) != nil || !reflect.DeepEqual(actual, expected) {
			t.Fatal("cross-language flow projection fixture drifted")
		}
	}
}

func TestPublicFlowProjectionRejectsInvisibleOrMalformedEntries(t *testing.T) {
	input := map[string]string{
		"fc.n.a":        `{"shape":"rect","text":"visible"}`,
		"fc.n.array":    `[]`,
		"fc.e.bad":      `{"from":"a","to":"missing","label":"secret"}`,
		"fc.s.bad":      `{"points":[{"x":0,"y":0},{"x":99999,"y":0}],"color":"#3370FF","width":3}`,
		"fc.m.cycle1":   `{"parent":"cycle2","order":0,"text":"secret1"}`,
		"fc.m.cycle2":   `{"parent":"cycle1","order":0,"text":"secret2"}`,
		"fc.m.invalid":  `{"parent":null,"order":0,"text":"secret3","x":99999,"y":0}`,
		"fc.ms.missing": `{"size":12}`,
	}
	out := publicFlowProps(input)
	if out["fc.n.a"] == "" || out["fc.n.array"] == "" {
		t.Fatalf("valid default nodes omitted: %#v", out)
	}
	for _, key := range []string{"fc.e.bad", "fc.s.bad", "fc.m.cycle1", "fc.m.cycle2", "fc.m.invalid", "fc.ms.missing"} {
		if out[key] != "" {
			t.Fatalf("unexpected %s: %#v", key, out)
		}
	}
}

func TestPublicFlowProjectionCorpus(t *testing.T) {
	inputs := []map[string]string{
		{"fc.n.a": `[]`, "fc.n.b": `{"shape":"unknown","x":30000,"y":-30000,"w":1,"h":9999,"text":"边界","size":12.7,"rot":-90.5,"align":"right","z":1.2}`, "fc.theme": "invalid"},
		{"fc.n.a": `{"shape":"rect","text":"起点"}`, "fc.n.b": `{"shape":"ellipse","text":"终点"}`, "fc.e.e": `{"from":"a","to":"b","fromPort":"top","toPort":"left","label":"条件","kind":"straight","arrow":"none","mid":-1.5,"pts":[{"x":100001,"y":-100001},{"x":"bad","y":0},{"x":2.4,"y":-2.5}]}`, "fc.s.s": `{"points":[{"x":-1.5,"y":1.5}],"width":2.5,"color":"#aabbcc","marker":true}`, "fc.marker.s": "1"},
		{"fc.m.root": `{"parent":null,"order":1,"text":"中心","x":-1.5,"y":2.5}`, "fc.m.child": `{"parent":"root","order":1.5,"text":"子项","x":1,"y":2}`, "fc.md.child": `"描述\n第二行"`, "fc.ms.child": `{"shape":"oval","size":24,"color":"#AABBCC"}`, "fc.mp.child": `{"fill":"none","stroke":"#AABBCC","width":4,"opacity":25}`, "fc.mt.child": `{"underline":true,"strike":true,"align":"right"}`, "fc.mds.child": `{"size":18,"highlight":"#AABBCC"}`},
		{"fc.m.good": `{"parent":null,"order":0,"text":"有效","x":0,"y":0}`, "fc.m.bad": `{"parent":"missing","order":0,"text":"不可见"}`, "fc.md.good": `""`, "fc.ms.good": `{"size":12,"unknown":"x"}`, "fc.mt.good": `{"bold":false}`, "fc.mds.good": `{"size":300}`, "fc.mp.good": `{"fill":"invalid"}`},
		{"fc.m.root": `{"parent":null,"order":0,"text":"空样式","x":0,"y":0}`, "fc.ms.root": `{}`, "fc.mp.root": `{}`, "fc.mt.root": `{}`, "fc.mds.root": `{}`},
	}
	type pair struct {
		Input  map[string]string `json:"input"`
		Output map[string]string `json:"output"`
	}
	corpus := make([]pair, 0, len(inputs))
	for _, input := range inputs {
		corpus = append(corpus, pair{input, publicFlowProps(input)})
	}
	data, err := json.Marshal(corpus)
	if err != nil {
		t.Fatal(err)
	}
	if path := os.Getenv("JIANGE_FLOW_CORPUS_PATH"); path != "" {
		if err = os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		return
	}
	stored, err := os.ReadFile("../../../packages/whiteboard-sdk/test/fixtures/public-flow-projection-corpus.json")
	if err != nil {
		t.Fatal(err)
	}
	var got, want any
	if json.Unmarshal(data, &got) != nil || json.Unmarshal(stored, &want) != nil || !reflect.DeepEqual(got, want) {
		t.Fatal("flow projection corpus drifted")
	}
}

func TestPublicFlowProjectionFramesMindLayoutAndRelations(t *testing.T) {
	input := map[string]string{
		"fc.theme": "feishu",
		"fc.ml":    "fishbone",
		// Valid frames
		"fc.fr.fr_1": `{"id":"fr_1","title":"  登录流程  ","x":100.4,"y":200.6,"w":520,"h":340,"bg":"#F8FAFF","private":"HIDDEN-FRAME-EXTRA"}`,
		"fc.fr.fr_2": `{"id":"fr_2","title":"","x":-400,"y":0,"w":240,"h":160,"bg":"rgba(0,0,0,0.5)"}`,
		// Invalid / malformed / oversized frames
		"fc.fr.deleted":   "",
		"fc.fr.bad key!":  `{"id":"bad key!","title":"HIDDEN-BAD-KEY","x":0,"y":0,"w":300,"h":200}`,
		"fc.fr.corrupt":   `{bad`,
		"fc.fr.array":     `[]`,
		"fc.fr.mismatch":  `{"id":"other","title":"HIDDEN-MISMATCH","x":0,"y":0,"w":300,"h":200}`,
		"fc.fr.oob_x":     `{"id":"oob_x","title":"HIDDEN-OOB","x":25000,"y":0,"w":300,"h":200}`,
		"fc.fr.small_w":   `{"id":"small_w","title":"HIDDEN-SMALL","x":0,"y":0,"w":80,"h":200}`,
		"fc.fr.huge_h":    `{"id":"huge_h","title":"HIDDEN-HUGE","x":0,"y":0,"w":300,"h":9000}`,
		"fc.fr.longtitle": `{"id":"longtitle","title":"` + strings.Repeat("A", 121) + `","x":0,"y":0,"w":300,"h":200}`,
		"fc.fr.nul":       `{"id":"nul","title":"bad\u0000title","x":0,"y":0,"w":300,"h":200}`,
		"fc.fr.oversized": `{"id":"oversized","title":"ok","x":0,"y":0,"w":300,"h":200,"pad":"` + strings.Repeat("x", 4100) + `"}`,
		// Live mind topics + orphan/cyclic mind topics
		"fc.m.root":   `{"parent":null,"order":0,"text":"核心目标","x":100,"y":100}`,
		"fc.m.b1":     `{"parent":"root","order":0,"text":"需求分析"}`,
		"fc.m.b2":     `{"parent":"root","order":1,"text":"技术方案"}`,
		"fc.m.orphan": `{"parent":"missing","order":0,"text":"HIDDEN-ORPHAN-TOPIC"}`,
		"fc.m.c1":     `{"parent":"c2","order":0,"text":"HIDDEN-CYCLE-1"}`,
		"fc.m.c2":     `{"parent":"c1","order":0,"text":"HIDDEN-CYCLE-2"}`,
		// Valid relations
		"fc.mr.mr_1": `{"id":"mr_1","fromId":"b1","toId":"b2","label":"  强依赖  ","private":"HIDDEN-REL-EXTRA"}`,
		"fc.mr.mr_2": `{"id":"mr_2","fromId":"root","toId":"b2"}`,
		// Invalid / orphan / oversized relations
		"fc.mr.deleted":    "",
		"fc.mr.bad!id":     `{"id":"bad!id","fromId":"b1","toId":"b2","label":"HIDDEN-BAD-REL-ID"}`,
		"fc.mr.mismatch":   `{"id":"other","fromId":"b1","toId":"b2","label":"HIDDEN-REL-MISMATCH"}`,
		"fc.mr.self":       `{"id":"self","fromId":"b1","toId":"b1","label":"HIDDEN-SELF"}`,
		"fc.mr.missing":    `{"id":"missing","fromId":"b1","toId":"nope","label":"HIDDEN-MISSING"}`,
		"fc.mr.to_orphan":  `{"id":"to_orphan","fromId":"b1","toId":"orphan","label":"HIDDEN-TO-ORPHAN"}`,
		"fc.mr.to_cycle":   `{"id":"to_cycle","fromId":"b1","toId":"c1","label":"HIDDEN-TO-CYCLE"}`,
		"fc.mr.longlabel":  `{"id":"longlabel","fromId":"b1","toId":"b2","label":"` + strings.Repeat("Z", 81) + `"}`,
		"fc.mr.nul":        `{"id":"nul","fromId":"b1","toId":"b2","label":"a\u0000b"}`,
		"fc.mr.oversized":  `{"id":"oversized","fromId":"b1","toId":"b2","pad":"` + strings.Repeat("y", 2100) + `"}`,
	}

	before, _ := json.Marshal(input)
	out := publicFlowProps(input)
	after, _ := json.Marshal(input)
	if string(before) != string(after) {
		t.Fatal("publicFlowProps mutated input")
	}

	encoded, _ := json.Marshal(out)
	if strings.Contains(string(encoded), "HIDDEN-") {
		t.Fatalf("hidden data leaked: %s", encoded)
	}

	if out["fc.ml"] != "fishbone" {
		t.Fatalf("expected fc.ml=fishbone, got %q", out["fc.ml"])
	}

	var fr1 map[string]any
	if err := json.Unmarshal([]byte(out["fc.fr.fr_1"]), &fr1); err != nil {
		t.Fatalf("expected valid fc.fr.fr_1, got %q (%v)", out["fc.fr.fr_1"], err)
	}
	wantFr1 := map[string]any{"id": "fr_1", "title": "登录流程", "x": float64(100), "y": float64(201), "w": float64(520), "h": float64(340), "bg": "#F8FAFF"}
	if !reflect.DeepEqual(fr1, wantFr1) {
		t.Fatalf("fc.fr.fr_1 mismatch:\n got %#v\nwant %#v", fr1, wantFr1)
	}

	var fr2 map[string]any
	if err := json.Unmarshal([]byte(out["fc.fr.fr_2"]), &fr2); err != nil {
		t.Fatalf("expected valid fc.fr.fr_2, got %q (%v)", out["fc.fr.fr_2"], err)
	}
	if _, hasBg := fr2["bg"]; hasBg {
		t.Fatalf("expected non-hex bg to be omitted, got %#v", fr2)
	}
	if fr2["title"] != "Frame" {
		t.Fatalf("expected empty title to default to Frame, got %#v", fr2["title"])
	}

	var mr1 map[string]any
	if err := json.Unmarshal([]byte(out["fc.mr.mr_1"]), &mr1); err != nil {
		t.Fatalf("expected valid fc.mr.mr_1, got %q (%v)", out["fc.mr.mr_1"], err)
	}
	wantMr1 := map[string]any{"id": "mr_1", "fromId": "b1", "toId": "b2", "label": "强依赖"}
	if !reflect.DeepEqual(mr1, wantMr1) {
		t.Fatalf("fc.mr.mr_1 mismatch:\n got %#v\nwant %#v", mr1, wantMr1)
	}

	var mr2 map[string]any
	if err := json.Unmarshal([]byte(out["fc.mr.mr_2"]), &mr2); err != nil {
		t.Fatalf("expected valid fc.mr.mr_2, got %q (%v)", out["fc.mr.mr_2"], err)
	}
	if _, hasLabel := mr2["label"]; hasLabel {
		t.Fatalf("expected omitted label to stay omitted, got %#v", mr2)
	}

	for _, key := range []string{
		"fc.fr.deleted", "fc.fr.bad key!", "fc.fr.corrupt", "fc.fr.array",
		"fc.fr.mismatch", "fc.fr.oob_x", "fc.fr.small_w", "fc.fr.huge_h",
		"fc.fr.longtitle", "fc.fr.nul", "fc.fr.oversized",
		"fc.mr.deleted", "fc.mr.bad!id", "fc.mr.mismatch", "fc.mr.self",
		"fc.mr.missing", "fc.mr.to_orphan", "fc.mr.to_cycle",
		"fc.mr.longlabel", "fc.mr.nul", "fc.mr.oversized",
	} {
		if out[key] != "" {
			t.Errorf("expected invalid/orphan/oversized prop %s to be stripped, got %q", key, out[key])
		}
	}

	// Verify fc.ml accepts all four valid layouts and strips unknown values.
	for _, valid := range []string{"logic", "org", "fishbone", "timeline"} {
		if got := publicFlowProps(map[string]string{"fc.ml": valid})["fc.ml"]; got != valid {
			t.Errorf("fc.ml=%q was not forwarded, got %q", valid, got)
		}
	}
	for _, invalid := range []string{"", "radial", "HIDDEN-LAYOUT", "LOGIC"} {
		if got := publicFlowProps(map[string]string{"fc.ml": invalid})["fc.ml"]; got != "" {
			t.Errorf("invalid fc.ml=%q should be stripped, got %q", invalid, got)
		}
	}
}

func TestPublicFlowProjectionFramesAndRelationsOnPublicLink(t *testing.T) {
	ctx := context.Background()
	e := newCopyTestEnv(t)
	e.share(t)
	doc, _, err := StateAtHead(ctx, e.store, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	create := doc.CreateBlock(29, collab.Root, "Z", "flowchart")
	ops := []collab.Op{create}
	props := map[string]string{
		"fc.v":          "1",
		"fc.theme":      "feishu",
		"fc.ml":         "timeline",
		"fc.fr.fr_1":    `{"id":"fr_1","title":"规划分区","x":40,"y":60,"w":480,"h":300,"bg":"#F8FAFF","secret":"HIDDEN-FRAME-SECRET"}`,
		"fc.fr.bad!":    `{"id":"bad!","title":"HIDDEN-BAD-FRAME","x":0,"y":0,"w":300,"h":200}`,
		"fc.m.root":     `{"parent":null,"order":0,"text":"里程碑","x":80,"y":80}`,
		"fc.m.m1":       `{"parent":"root","order":0,"text":"阶段一"}`,
		"fc.m.m2":       `{"parent":"root","order":1,"text":"阶段二"}`,
		"fc.mr.mr_live": `{"id":"mr_live","fromId":"m1","toId":"m2","label":"前置依赖","secret":"HIDDEN-REL-SECRET"}`,
		"fc.mr.mr_dead": `{"id":"mr_dead","fromId":"m1","toId":"ghost","label":"HIDDEN-ORPHAN-REL"}`,
	}
	keys := make([]string, 0, len(props))
	for k := range props {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		val := props[k]
		op := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 29, Clock: doc.Clock() + 1}, Block: create.ID, Key: k, Value: &val}
		if !doc.Apply(op) {
			t.Fatalf("apply %s", k)
		}
		ops = append(ops, op)
	}
	rows := make([]store.RawOp, 0, len(ops))
	for _, op := range ops {
		data, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		rows = append(rows, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: data})
	}
	if _, err = e.store.AppendOps(ctx, e.source.ID, rows); err != nil {
		t.Fatal(err)
	}
	r := send(t, e.owner, "PUT", e.url()+"/link", map[string]string{"role": "anon"})
	var link store.Link
	if err = json.NewDecoder(r.Body).Decode(&link); err != nil || r.StatusCode != 200 {
		t.Fatalf("link: %d %v", r.StatusCode, err)
	}
	r.Body.Close()

	resp, err := (&http.Client{}).Get(e.server.URL + "/api/public/" + link.Token)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("public view failed: %d %s", resp.StatusCode, body)
	}
	for _, want := range []string{"规划分区", "timeline", "前置依赖"} {
		if !bytes.Contains(body, []byte(want)) {
			t.Fatalf("public view missing %q: %s", want, body)
		}
	}
	if bytes.Contains(body, []byte("HIDDEN-")) {
		t.Fatalf("public view leaked hidden metadata: %s", body)
	}
}
