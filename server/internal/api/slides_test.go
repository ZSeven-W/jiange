package api

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestSlideShapeGeometryValidation(t *testing.T) {
	for _, tc := range []struct {
		name, raw string
		valid     bool
	}{
		{"legacy defaults", `[{"id":"a","kind":"ellipse","x":84,"y":80,"color":"#3370ff"}]`, true},
		{"resized and rotated", `[{"id":"a","kind":"rectangle","x":40,"y":50,"width":60,"height":50,"rotation":90,"color":"#3370ff"}]`, true},
		{"overflow", `[{"id":"a","kind":"rectangle","x":41,"y":50,"width":60,"height":50,"rotation":90,"color":"#3370ff"}]`, false},
		{"angle out of bounds", `[{"id":"a","kind":"rectangle","x":0,"y":0,"rotation":360,"color":"#3370ff"}]`, false},
		{"duplicate ids", `[{"id":"a","kind":"ellipse","x":0,"y":0,"color":"#3370ff"},{"id":"a","kind":"ellipse","x":1,"y":1,"color":"#3370ff"}]`, false},
		{"text box", `[{"id":"a","kind":"text","x":10,"y":20,"width":35,"height":15,"color":"#1f2329","text":"协作\n计划","fontSize":32,"bold":true,"align":"center"}]`, true},
		{"missing text", `[{"id":"a","kind":"text","x":0,"y":0,"color":"#1f2329"}]`, false},
		{"invalid text size", `[{"id":"a","kind":"text","x":0,"y":0,"color":"#1f2329","text":"x","fontSize":100}]`, false},
		{"invalid text alignment", `[{"id":"a","kind":"text","x":0,"y":0,"color":"#1f2329","text":"x","align":"justify"}]`, false},
		{"text too long", `[{"id":"a","kind":"text","x":0,"y":0,"color":"#1f2329","text":"` + strings.Repeat("文", 1001) + `"}]`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := validSlideShapes(json.RawMessage(tc.raw)); got != tc.valid {
				t.Fatalf("valid=%v, want %v", got, tc.valid)
			}
		})
	}
}

func TestSlideTextBoxRoundTrip(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "text@x.com", "name": "Text", "password": "password123"})
	var deck store.DriveEntry
	json.NewDecoder(post(t, c, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "文本"}).Body).Decode(&deck)
	var pages struct{ Pages []store.SlidesPage }
	json.NewDecoder(cGet(t, c, ts.URL+"/api/slides/"+strconv64(deck.ID)+"/pages").Body).Decode(&pages)
	if len(pages.Pages) != 1 {
		t.Fatal("missing initial page")
	}
	p := pages.Pages[0]
	text := map[string]any{"id": "text-1", "kind": "text", "x": 12, "y": 55, "width": 35, "height": 15, "color": "#1f2329", "text": "第一行\n第二行", "fontSize": 32, "bold": true, "align": "center"}
	res := send(t, c, "PATCH", ts.URL+"/api/slides/pages/"+strconv64(p.ID), map[string]any{"title": "", "body": "", "background": "", "shapes": []any{text}, "expectedRevision": p.Revision})
	if res.StatusCode != 200 {
		t.Fatalf("save text: %d", res.StatusCode)
	}
	json.NewDecoder(cGet(t, c, ts.URL+"/api/slides/"+strconv64(deck.ID)+"/pages").Body).Decode(&pages)
	var shapes []map[string]any
	if err := json.Unmarshal(pages.Pages[0].Shapes, &shapes); err != nil || len(shapes) != 1 || shapes[0]["text"] != "第一行\n第二行" || shapes[0]["align"] != "center" || shapes[0]["fontSize"] != float64(32) || shapes[0]["bold"] != true {
		t.Fatalf("text box lost on reload: %s %v", pages.Pages[0].Shapes, err)
	}
}

// 幻灯片纵切：建 slides 节点 → 页面 CRUD → 排序 → 删除。
func TestSlidesVerticalSlice(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "sl@x.com", "name": "SL", "password": "password123"})

	var deck store.DriveEntry
	if res := post(t, c, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "季度汇报"}); res.StatusCode != 201 {
		t.Fatalf("create slides: %d", res.StatusCode)
	} else {
		json.NewDecoder(res.Body).Decode(&deck)
	}
	if deck.Kind != "slides" || deck.Revision != 1 {
		t.Fatalf("deck: %+v", deck)
	}

	// 新演示文稿自带一张空白页，再创建第二页。
	var p1, p2 store.SlidesPage
	var initial struct{ Pages []store.SlidesPage }
	if err := json.NewDecoder(cGet(t, c, ts.URL+"/api/slides/"+strconv64(deck.ID)+"/pages").Body).Decode(&initial); err != nil || len(initial.Pages) != 1 || initial.Pages[0].Title != "" {
		t.Fatalf("initial slide: %+v %v", initial.Pages, err)
	}
	p1 = initial.Pages[0]
	if res := post(t, c, ts.URL+"/api/slides/"+strconv64(deck.ID)+"/pages", map[string]any{"title": "议程"}); res.StatusCode != 201 {
		t.Fatalf("page2: %d", res.StatusCode)
	} else {
		json.NewDecoder(res.Body).Decode(&p2)
	}

	// 列表按 pos 排序
	var list struct{ Pages []store.SlidesPage }
	json.NewDecoder(cGet(t, c, ts.URL+"/api/slides/"+strconv64(deck.ID)+"/pages").Body).Decode(&list)
	if len(list.Pages) != 2 || list.Pages[0].ID != p1.ID || list.Pages[1].ID != p2.ID {
		t.Fatalf("list: %+v", list.Pages)
	}

	// 更新内容
	p1u, err := store.SlidesPage{}, error(nil)
	_ = p1u
	_ = err
	if res := send(t, c, "PATCH", ts.URL+"/api/slides/pages/"+strconv64(p1.ID), map[string]any{"title": "季度汇报", "body": "要点一\n要点二", "background": "#111", "notes": "提醒听众", "shapes": []any{map[string]any{"id": "shape-1", "kind": "ellipse", "x": 60, "y": 50, "color": "#3370ff"}}, "expectedRevision": p1.Revision}); res.StatusCode != 200 {
		t.Fatalf("patch: %d", res.StatusCode)
	} else {
		var got store.SlidesPage
		json.NewDecoder(res.Body).Decode(&got)
		if got.Title != "季度汇报" || got.Body != "要点一\n要点二" || got.Background != "#111" || got.Notes != "提醒听众" || !json.Valid(got.Shapes) || string(got.Shapes) == "[]" {
			t.Fatalf("patched: %+v", got)
		}
	}
	if res := send(t, c, "PATCH", ts.URL+"/api/slides/pages/"+strconv64(p1.ID), map[string]any{"title": "旧内容", "body": "", "background": "#111", "expectedRevision": p1.Revision}); res.StatusCode != 409 {
		t.Fatalf("stale patch must be rejected: %d", res.StatusCode)
	}
	// 旧客户端没有 notes 字段，更新页面时不得清除演示者备注。
	if res := send(t, c, "PATCH", ts.URL+"/api/slides/pages/"+strconv64(p1.ID), map[string]any{"title": "新版标题", "body": "要点", "background": "#111", "expectedRevision": p1.Revision + 1}); res.StatusCode != 200 {
		t.Fatalf("legacy patch: %d", res.StatusCode)
	} else {
		var got store.SlidesPage
		json.NewDecoder(res.Body).Decode(&got)
		if got.Notes != "提醒听众" || string(got.Shapes) == "[]" {
			t.Fatalf("legacy patch lost notes: %+v", got)
		}
	}
	if res := send(t, c, "PATCH", ts.URL+"/api/slides/pages/"+strconv64(p1.ID), map[string]any{"shapes": []any{map[string]any{"id": "bad", "kind": "ellipse", "x": 900, "y": 0, "color": "#3370ff"}}, "expectedRevision": p1.Revision + 2}); res.StatusCode != 400 {
		t.Fatalf("invalid shape must be rejected: %d", res.StatusCode)
	}

	// 排序：把第二页移到最前（pos 取 0.5）
	if res := send(t, c, "POST", ts.URL+"/api/slides/pages/"+strconv64(p2.ID)+"/move", map[string]any{"pos": 0.5}); res.StatusCode != 204 {
		t.Fatalf("move: %d", res.StatusCode)
	}
	json.NewDecoder(cGet(t, c, ts.URL+"/api/slides/"+strconv64(deck.ID)+"/pages").Body).Decode(&list)
	if len(list.Pages) != 2 || list.Pages[0].ID != p2.ID {
		t.Fatalf("after move: %+v", list.Pages)
	}

	// 删除一页
	if res := send(t, c, "DELETE", ts.URL+"/api/slides/pages/"+strconv64(p2.ID), nil); res.StatusCode != 204 {
		t.Fatalf("delete: %d", res.StatusCode)
	}
	json.NewDecoder(cGet(t, c, ts.URL+"/api/slides/"+strconv64(deck.ID)+"/pages").Body).Decode(&list)
	if len(list.Pages) != 1 || list.Pages[0].ID != p1.ID {
		t.Fatalf("after delete: %+v", list.Pages)
	}

	// 非 slides 节点 → 404
	if res := post(t, c, ts.URL+"/api/slides/999/pages", map[string]any{"title": "x"}); res.StatusCode != 404 {
		t.Fatalf("unknown deck: %d", res.StatusCode)
	}
}
