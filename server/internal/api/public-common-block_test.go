package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestPublicCommonBlockOnlyIncludesRenderedProperties(t *testing.T) {
	view := collab.DocView{Blocks: []collab.BlockView{
		{ID: "1:1", Parent: "0:0", Type: "columns", Props: map[string]string{"columnWidths": `{"1:2":1500,"1:3":500,"9:9":777}`, "url": "旧链接秘密"}, Spans: []collab.Span{{Text: "旧分栏文字"}}},
		{ID: "1:2", Parent: "1:1", Type: "paragraph", Props: map[string]string{"indent": "2", "align": "right", "fc.n.old": "旧流程图秘密", "caption": "旧图片标题"}, Spans: []collab.Span{{Text: "公开文字", Marks: map[string]string{"bold": "anything", "color": "#AABBCC", "unknown": "隐藏标记秘密", "link": "javascript:隐藏链接秘密"}}}},
		{ID: "1:3", Parent: "1:1", Type: "paragraph", Props: map[string]string{}, Spans: []collab.Span{{Text: "第二栏"}}},
		{ID: "1:6", Parent: "0:0", Type: "image", Props: map[string]string{"fileId": "12", "name": "示意.png", "mime": "隐藏类型秘密", "caption": "示意图", "imageWidth": "150", "url": "旧网址秘密", "tbl.base": "旧表格秘密"}, Spans: []collab.Span{{Text: "图片旧文字秘密"}}},
		{ID: "1:4", Parent: "0:0", Type: "code", Props: map[string]string{"lang": "秘密不是语言", "wrap": "false"}, Spans: []collab.Span{{Text: "公开代码", Marks: map[string]string{"code": "true"}}}},
		{ID: "1:5", Parent: "0:0", Type: "paragraph", Props: map[string]string{}, Spans: []collab.Span{{Text: "x", Marks: map[string]string{"math": "x^2", "mathId": "1:12", "link": "https://example.test/旧链接秘密", "bold": "true"}}}},
	}}
	before, _ := json.Marshal(view)
	out, err := publicTableView(view)
	if err != nil {
		t.Fatal(err)
	}
	after, _ := json.Marshal(view)
	if !bytes.Equal(before, after) {
		t.Fatal("input changed")
	}
	encoded, _ := json.Marshal(out)
	for _, secret := range []string{"旧链接秘密", "旧分栏文字", "旧流程图秘密", "旧图片标题", "隐藏标记秘密", "隐藏链接秘密", "隐藏类型秘密", "旧网址秘密", "旧表格秘密", "图片旧文字秘密", "秘密不是语言", "9:9"} {
		if bytes.Contains(encoded, []byte(secret)) {
			t.Fatalf("leaked %q: %s", secret, encoded)
		}
	}
	if out.Blocks[0].Props["columnWidths"] != `{"1:2":1500,"1:3":500}` {
		t.Fatalf("widths: %#v", out.Blocks[0].Props)
	}
	if got := out.Blocks[1].Spans[0].Marks; !reflect.DeepEqual(got, map[string]string{"bold": "true", "color": "#AABBCC"}) {
		t.Fatalf("text marks: %#v", got)
	}
	if got := out.Blocks[3].Props; got["fileId"] != "12" || got["caption"] != "示意图" || got["imageWidth"] != "100" || len(out.Blocks[3].Spans) != 0 {
		t.Fatalf("image: %#v", out.Blocks[3])
	}
	if got := out.Blocks[4].Props; got["lang"] != "" || got["wrap"] != "false" {
		t.Fatalf("code: %#v", got)
	}
	if got := out.Blocks[5].Spans[0].Marks; !reflect.DeepEqual(got, map[string]string{"math": "x^2", "mathId": "1:12"}) {
		t.Fatalf("math marks: %#v", got)
	}
}

func TestPublicCommonBlockRejectsInvalidMetadata(t *testing.T) {
	if got := publicColumnWidths(`{"1:2":1500,"1:3":0}`, map[string]bool{"1:2": true}); got != "" {
		t.Fatalf("invalid widths: %q", got)
	}
	for _, id := range []string{"001:2", "2:9007199254740992", "1:2:3"} {
		if validPublicCharID(id) {
			t.Fatalf("accepted invalid id %q", id)
		}
	}
	for _, value := range []string{"javascript:secret", "https://", "not-url", "", "#/s/token?x=1", "#/s/../private"} {
		if publicSafeLink(value) {
			t.Fatalf("accepted %q", value)
		}
	}
	for _, value := range []string{"https://example.test/a", "#/doc/3", "#/s/valid_token", "#/p/valid_token"} {
		if !publicSafeLink(value) {
			t.Fatalf("rejected %q", value)
		}
	}
}

func TestPublicTextMarksPreserveOnlyKnownLinkKinds(t *testing.T) {
	got := publicTextMarks(map[string]string{"link": "#/doc/12", "linkKind": "text"})
	if got["link"] != "#/doc/12" || got["linkKind"] != "text" {
		t.Fatalf("text link: %#v", got)
	}
	got = publicTextMarks(map[string]string{"link": "#/doc/12", "linkKind": "unknown"})
	if _, ok := got["linkKind"]; ok {
		t.Fatalf("unknown kind leaked: %#v", got)
	}
	got = publicTextMarks(map[string]string{"link": "javascript:bad", "linkKind": "text"})
	if _, ok := got["linkKind"]; ok {
		t.Fatalf("kind without valid link: %#v", got)
	}
}

func TestPublicColumnChildUsesTextRenderer(t *testing.T) {
	view := collab.DocView{Blocks: []collab.BlockView{
		{ID: "1:1", Parent: "0:0", Type: "columns", Props: map[string]string{}},
		{ID: "1:2", Parent: "1:1", Type: "image", Props: map[string]string{"caption": "未显示的图片标题", "align": "right"}, Spans: []collab.Span{{Text: "栏中文字", Marks: map[string]string{"bold": "true"}}}},
		{ID: "1:3", Parent: "1:1", Type: "table", Props: map[string]string{"tableData": `[["未显示的表格"]]`}, Spans: []collab.Span{{Text: "第二栏文字"}}},
	}}
	out, err := publicTableView(view)
	if err != nil {
		t.Fatal(err)
	}
	if out.Blocks[1].Spans[0].Text != "栏中文字" || out.Blocks[1].Spans[0].Marks["bold"] != "true" || out.Blocks[1].Props["align"] != "right" || out.Blocks[1].Props["caption"] != "" {
		t.Fatalf("image column child: %#v", out.Blocks[1])
	}
	if out.Blocks[2].Spans[0].Text != "第二栏文字" || out.Blocks[2].Props["tableData"] != "" {
		t.Fatalf("table column child: %#v", out.Blocks[2])
	}
}

func TestCommonBlockProjectionAppliesToPublicAndSavedVersion(t *testing.T) {
	ctx := context.Background()
	e := newCopyTestEnv(t)
	e.share(t)
	doc, _, err := StateAtHead(ctx, e.store, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	para := collab.OpID{Client: 0, Clock: 2}
	insert := doc.InsertText(18, para, 0, "公开正文")
	secret := "HIDDEN-ATTRIBUTE-VALUE"
	property := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 18, Clock: doc.Clock() + 1}, Block: para, Key: "caption", Value: &secret}
	doc.Apply(property)
	markSecret := "HIDDEN-MARK-VALUE"
	mark := collab.Op{T: collab.TMark, ID: collab.OpID{Client: 18, Clock: doc.Clock() + 1}, Block: para, Key: "custom", Value: &markSecret, Start: collab.Anchor{Char: insert.ID}, End: collab.Anchor{Char: collab.OpID{Client: insert.ID.Client, Clock: insert.ID.Clock + 3}, Side: 1}}
	doc.Apply(mark)
	var rows []store.RawOp
	for _, op := range []collab.Op{insert, property, mark} {
		raw, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		rows = append(rows, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: raw})
	}
	if _, err = e.store.AppendOps(ctx, e.source.ID, rows); err != nil {
		t.Fatal(err)
	}
	current, seq, err := StateAtHead(ctx, e.store, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	sanitized, err := publicTableView(current.View())
	if err != nil {
		t.Fatal(err)
	}
	projection, err := current.ReadOnlyProjection(sanitized)
	if err != nil {
		t.Fatalf("read-only state projection: %v", err)
	}
	if bytes.Contains(projection.EncodeState(), []byte(secret)) || bytes.Contains(projection.EncodeState(), []byte(markSecret)) {
		t.Fatal("sanitized read-only state retained hidden properties or marks")
	}
	if err = e.store.SaveSnapshot(ctx, e.source.ID, seq, current.EncodeState()); err != nil {
		t.Fatal(err)
	}
	if err = e.store.SaveVersion(ctx, e.source.ID, seq, "公开版本", e.ownerUser.ID); err != nil {
		t.Fatal(err)
	}
	resp := send(t, e.owner, "PUT", e.url()+"/link", map[string]string{"role": "anon"})
	var link store.Link
	if err = json.NewDecoder(resp.Body).Decode(&link); err != nil || resp.StatusCode != 200 {
		t.Fatalf("public link: %d %v", resp.StatusCode, err)
	}
	resp.Body.Close()
	versionPath := e.url() + "/versions/" + strconv.FormatInt(seq, 10)
	for _, tc := range []struct {
		name         string
		client       *http.Client
		url          string
		expectSecret bool
	}{
		{"public", &http.Client{}, e.server.URL + "/api/public/" + link.Token, false},
		{"reader version", e.guest, versionPath, false},
		{"editor version", e.owner, versionPath, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, err := tc.client.Get(tc.url)
			if err != nil {
				t.Fatal(err)
			}
			defer r.Body.Close()
			body, _ := io.ReadAll(r.Body)
			if r.StatusCode != 200 || !bytes.Contains(body, []byte("公开正文")) {
				t.Fatalf("visible response %d: %s", r.StatusCode, body)
			}
			found := strings.Contains(string(body), secret) || strings.Contains(string(body), markSecret)
			if found != tc.expectSecret {
				t.Fatal(fmt.Sprintf("secret presence=%v: %s", found, body))
			}
		})
	}
}
