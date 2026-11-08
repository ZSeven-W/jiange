package api

import (
	"encoding/json"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

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

	// 页面：建两页
	var p1, p2 store.SlidesPage
	if res := post(t, c, ts.URL+"/api/slides/"+strconv64(deck.ID)+"/pages", map[string]any{"title": "封面"}); res.StatusCode != 201 {
		t.Fatalf("page1: %d", res.StatusCode)
	} else {
		json.NewDecoder(res.Body).Decode(&p1)
	}
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
	if res := send(t, c, "PATCH", ts.URL+"/api/slides/pages/"+strconv64(p1.ID), map[string]any{"title": "季度汇报", "body": "要点一\n要点二", "background": "#111", "expectedRevision": p1.Revision}); res.StatusCode != 200 {
		t.Fatalf("patch: %d", res.StatusCode)
	} else {
		var got store.SlidesPage
		json.NewDecoder(res.Body).Decode(&got)
		if got.Title != "季度汇报" || got.Body != "要点一\n要点二" || got.Background != "#111" {
			t.Fatalf("patched: %+v", got)
		}
	}
	if res := send(t, c, "PATCH", ts.URL+"/api/slides/pages/"+strconv64(p1.ID), map[string]any{"title": "旧内容", "body": "", "background": "#111", "expectedRevision": p1.Revision}); res.StatusCode != 409 {
		t.Fatalf("stale patch must be rejected: %d", res.StatusCode)
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
