package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestLinkFields(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "lk@x.com", "name": "LK", "password": "password123"})
	var tasks, projects store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", map[string]string{"title": "任务表"}).Body).Decode(&tasks)
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", map[string]string{"title": "项目表"}).Body).Decode(&projects)
	tu := ts.URL + "/api/bases/" + strconv.FormatInt(tasks.ID, 10)
	pu := ts.URL + "/api/bases/" + strconv.FormatInt(projects.ID, 10)

	// 项目表标题列写值；任务表加 link 字段指向项目表 + lookup 读项目标题
	var proj store.Record
	json.NewDecoder(post(t, c, pu+"/records", map[string]any{"cells": map[string]any{}}).Body).Decode(&proj)
	var pf struct {
		Fields []store.Field
	}
	json.NewDecoder(cGet(t, c, pu).Body).Decode(&pf)
	var pt store.Field
	for _, f := range pf.Fields {
		if f.Type == "text" {
			pt = f
		}
	}
	send(t, c, "PATCH", pu+"/records/"+strconv.FormatInt(proj.ID, 10), map[string]any{"cells": map[string]any{strconv.FormatInt(pt.ID, 10): "官网改版"}})

	var link, lookup store.Field
	json.NewDecoder(post(t, c, tu+"/fields", map[string]any{
		"name": "所属项目", "type": "link", "options": []string{strconv.FormatInt(projects.ID, 10)},
	}).Body).Decode(&link)
	json.NewDecoder(post(t, c, tu+"/fields", map[string]any{
		"name": "项目名", "type": "lookup",
		"options": []string{strconv.FormatInt(link.ID, 10), strconv.FormatInt(pt.ID, 10)},
	}).Body).Decode(&lookup)

	var task store.Record
	json.NewDecoder(post(t, c, tu+"/records", map[string]any{"cells": map[string]any{}}).Body).Decode(&task)

	// 写关联（cells 数组 + bt_links）
	res := send(t, c, "PATCH", tu+"/records/"+strconv.FormatInt(task.ID, 10),
		map[string]any{"cells": map[string]any{strconv.FormatInt(link.ID, 10): []int64{proj.ID}}})
	if res.StatusCode != 200 {
		t.Fatalf("link write: %d", res.StatusCode)
	}

	// GET 展开关联 + 查找引用
	var full struct {
		Fields     []store.Field
		Records    []store.Record
		Expansions map[string]any
	}
	r := cGet(t, c, tu)
	json.NewDecoder(r.Body).Decode(&full)
	raw, _ := json.Marshal(full.Expansions[strconv.FormatInt(link.ID, 10)])
	var links map[string][]int64
	_ = json.Unmarshal(raw, &links)
	if got := links[strconv.FormatInt(task.ID, 10)]; len(got) != 1 || got[0] != proj.ID {
		t.Fatalf("expanded links: %v", links)
	}
	// lookup 派生值由前端渲染（服务端展开 titles 供其使用）
	titles, _ := json.Marshal(full.Expansions[strconv.FormatInt(link.ID, 10)+":titles"])
	var tm map[string]string
	_ = json.Unmarshal(titles, &tm)
	if tm[strconv.FormatInt(proj.ID, 10)] != "官网改版" {
		t.Fatalf("titles: %v", tm)
	}

	// lookup 字段不允许直接写
	if res := send(t, c, "PATCH", tu+"/records/"+strconv.FormatInt(task.ID, 10),
		map[string]any{"cells": map[string]any{strconv.FormatInt(lookup.ID, 10): "x"}}); res.StatusCode != 400 {
		t.Fatalf("lookup write accepted: %d", res.StatusCode)
	}
}

func cGet(t *testing.T, c *http.Client, url string) *http.Response {
	t.Helper()
	r, err := c.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
