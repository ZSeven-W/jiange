package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestPublicTableViewRemovesHiddenAndDeletedData(t *testing.T) {
	mirror := `[["可见","状态"],["合并隐藏","完成"]]`
	props := map[string]string{
		"tbl.v": "2", "tbl.rows": `["r1","r0"]`, "tbl.cols": `["c0","c1"]`,
		"tbl.base":    `[["合并隐藏","完成"],["可见","状态"],["已删除秘密","旧"]]`,
		"tbl.c.r9.c0": "迟到删除秘密", "tbl.fill.r1.c0": "#e3ecff", "tbl.halign.r1.c0": "center",
		"tbl.valign.r1.c0": "bottom", "tableData": mirror, "tbl.m": tableHash(mirror),
		"tableMerges": `[[0,0,2,1]]`, "tableWidths": `[140,"宽度秘密",220]`, "fc.graph": "转换前秘密", "align": "right", "indent": "2",
	}
	input := collab.DocView{Blocks: []collab.BlockView{
		{Type: "table", Props: props, Spans: []collab.Span{{Text: "表格块隐藏文字"}}},
		{Type: "paragraph", Props: map[string]string{"tableData": `[["已转换秘密"]]`, "tbl.base": "旧表秘密", "indent": "1"}, Spans: []collab.Span{{Text: "可见段落"}}},
	}}
	out, err := publicTableView(input)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(out)
	for _, secret := range []string{"合并隐藏", "已删除秘密", "迟到删除秘密", "宽度秘密", "转换前秘密", "表格块隐藏文字", "已转换秘密", "旧表秘密"} {
		if bytes.Contains(encoded, []byte(secret)) {
			t.Fatalf("public projection leaked %q: %s", secret, encoded)
		}
	}
	p := out.Blocks[0].Props
	if p["tableData"] != `[["可见","状态"],["","完成"]]` || p["tableMerges"] != `[[0,0,2,1]]` || p["tableWidths"] != `[140,null]` {
		t.Fatalf("incorrect visible grid: %#v", p)
	}
	if p["tbl.fill.r0.c0"] != "#e3ecff" || p["tbl.halign.r0.c0"] != "center" || p["tbl.valign.r0.c0"] != "bottom" || p["tbl.v"] != "" || p["tbl.base"] != "" {
		t.Fatalf("visible formatting lost or internal state retained: %#v", p)
	}
	if p["align"] != "right" || p["indent"] != "2" {
		t.Fatalf("visible block layout lost: %#v", p)
	}
	if out.Blocks[1].Spans[0].Text != "可见段落" || out.Blocks[1].Props["indent"] != "1" || props["tbl.c.r9.c0"] != "迟到删除秘密" {
		t.Fatal("projection changed source data or visible paragraph")
	}
}

func TestPublicTableViewFailsClosedForAmbiguousState(t *testing.T) {
	mirror := `[["可见"]]`
	valid := map[string]string{"tbl.v": "2", "tbl.rows": `["r0"]`, "tbl.cols": `["c0"]`, "tbl.base": mirror, "tbl.m": tableHash(mirror), "tableData": mirror}
	for name, mutate := range map[string]func(map[string]string){
		"stale mirror":      func(p map[string]string) { p["tableData"] = `[["旧客户端"]]` },
		"duplicate axis":    func(p map[string]string) { p["tbl.rows"] = `["r0","r0"]` },
		"partial migration": func(p map[string]string) { p["tbl.v"] = "" },
		"unknown version":   func(p map[string]string) { p["tbl.v"] = "3" },
		"unknown register":  func(p map[string]string) { p["tbl.rich.r0.c0"] = "future content" },
		"invalid merge":     func(p map[string]string) { p["tableMerges"] = `[[0,0,2,1],"bad"]` },
		"truncated merge":   func(p map[string]string) { p["tableMerges"] = `[[0,0,2,1]` },
		"oversized merge":   func(p map[string]string) { p["tableMerges"] = strings.Repeat(" ", 256*1024+1) },
	} {
		t.Run(name, func(t *testing.T) {
			p := make(map[string]string, len(valid))
			for key, value := range valid {
				p[key] = value
			}
			mutate(p)
			if _, err := publicTableProps(p); err == nil {
				t.Fatal("ambiguous table was projected")
			}
		})
	}
}

func TestPublicTableViewSupportsLegacyVisibleFormatting(t *testing.T) {
	props := map[string]string{"tableData": `[["旧表","内容"],["任务","完成"]]`, "tbl.fill.r1.c1": "#E5F5E8", "tbl.halign.r1.c1": "right", "tableHeader": "none"}
	out, err := publicTableProps(props)
	if err != nil {
		t.Fatal(err)
	}
	if out["tableData"] != props["tableData"] || out["tbl.fill.r1.c1"] != "#E5F5E8" || out["tbl.halign.r1.c1"] != "right" || out["tableHeader"] != "none" {
		t.Fatalf("legacy formatting: %#v", out)
	}
}

func TestPublicTableViewKeepsEmptyBlocksArray(t *testing.T) {
	out, err := publicTableView(collab.DocView{})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(out)
	if string(encoded) != `{"blocks":[]}` {
		t.Fatalf("empty document shape changed: %s", encoded)
	}
}

func TestPublicTableMergesRejectsOverlappingRanges(t *testing.T) {
	if _, _, err := publicTableMerges(`[[0,0,2,1],[1,0,1,2]]`, 2, 2); err == nil {
		t.Fatal("overlapping merges must not reveal hidden cells")
	}
}

func TestPublicEndpointDoesNotExposeDeletedTableRegisters(t *testing.T) {
	e := newCopyTestEnv(t)
	ctx := context.Background()
	state, _, err := StateAtHead(ctx, e.store, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	block := state.CreateBlock(17, collab.Root, "Z", "table")
	mirror := `[["公开","状态"]]`
	props := map[string]string{"tbl.v": "2", "tbl.rows": `["r1"]`, "tbl.cols": `["c0","c1"]`, "tbl.base": `[["已删除敏感内容","旧"],["公开","状态"]]`, "tbl.c.r0.c0": "迟到的敏感编辑", "tableData": mirror, "tbl.m": tableHash(mirror)}
	ops := []collab.Op{block}
	for key, value := range props {
		v := value
		op := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 17, Clock: state.Clock() + 1}, Block: block.ID, Key: key, Value: &v}
		state.Apply(op)
		ops = append(ops, op)
	}
	for _, op := range ops {
		encoded, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.store.AppendOps(ctx, e.source.ID, []store.RawOp{{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: encoded}}); err != nil {
			t.Fatal(err)
		}
	}
	linkResponse := send(t, e.owner, "PUT", e.url()+"/link", map[string]string{"role": "anon"})
	var link store.Link
	if err := json.NewDecoder(linkResponse.Body).Decode(&link); err != nil || linkResponse.StatusCode != http.StatusOK {
		t.Fatalf("link: %d %v", linkResponse.StatusCode, err)
	}
	linkResponse.Body.Close()
	response, err := http.Get(e.server.URL + "/api/public/" + link.Token)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !bytes.Contains(body, []byte("公开")) || bytes.Contains(body, []byte("敏感")) || bytes.Contains(body, []byte("tbl.base")) {
		t.Fatalf("unsafe public response: %d %s", response.StatusCode, body)
	}
	legacy := `[["过期镜像秘密","旧"]]`
	op := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 17, Clock: state.Clock() + 1}, Block: block.ID, Key: "tableData", Value: &legacy}
	encoded, err := collab.EncodeOps([]collab.Op{op})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.AppendOps(ctx, e.source.ID, []store.RawOp{{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: encoded}}); err != nil {
		t.Fatal(err)
	}
	response, err = http.Get(e.server.URL + "/api/public/" + link.Token)
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusConflict || !bytes.Contains(body, []byte("table_unavailable")) || bytes.Contains(body, []byte("秘密")) || bytes.Contains(body, []byte(`"view"`)) {
		t.Fatalf("stale mirror should fail closed: %d %s", response.StatusCode, body)
	}
}

type afterProjectionStore struct {
	store.Store
	calls   atomic.Int32
	started chan struct{}
	release chan struct{}
}

func (s *afterProjectionStore) GetDocSystem(ctx context.Context, id int64) (store.DocMeta, error) {
	meta, err := s.Store.GetDocSystem(ctx, id)
	if s.calls.Add(1) == 4 {
		close(s.started)
		select {
		case <-s.release:
		case <-ctx.Done():
			return store.DocMeta{}, ctx.Err()
		}
	}
	return meta, err
}

func TestPublicEndpointRechecksRevocationAfterProjection(t *testing.T) {
	e := newCopyTestEnv(t)
	linkResponse := send(t, e.owner, "PUT", e.url()+"/link", map[string]string{"role": "anon"})
	var link store.Link
	if err := json.NewDecoder(linkResponse.Body).Decode(&link); err != nil || linkResponse.StatusCode != http.StatusOK {
		t.Fatalf("link: %d %v", linkResponse.StatusCode, err)
	}
	linkResponse.Body.Close()
	wrapper := &afterProjectionStore{Store: e.store, started: make(chan struct{}), release: make(chan struct{})}
	server := httptest.NewServer((&Server{Store: wrapper, Blobs: e.blobs, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}).Handler())
	defer server.Close()
	defer func() {
		select {
		case <-wrapper.release:
		default:
			close(wrapper.release)
		}
	}()
	result, failure := make(chan *http.Response, 1), make(chan error, 1)
	go func() {
		response, err := http.Get(server.URL + "/api/public/" + link.Token)
		if err != nil {
			failure <- err
			return
		}
		result <- response
	}()
	select {
	case <-wrapper.started:
	case <-time.After(5 * time.Second):
		t.Fatal("final metadata read did not start")
	}
	if err := e.store.SetLink(context.Background(), e.source.ID, store.Link{Role: "none"}); err != nil {
		t.Fatal(err)
	}
	close(wrapper.release)
	select {
	case err := <-failure:
		t.Fatal(err)
	case response := <-result:
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusNotFound || bytes.Contains(body, []byte(`"view"`)) {
			t.Fatalf("revoked snapshot returned: %d %s", response.StatusCode, body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("public response did not finish")
	}
}
