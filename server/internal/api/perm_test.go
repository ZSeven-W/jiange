package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestLockedViewRowColumnPerms(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "own@x.com", "name": "Own", "password": "password123"})
	gj0, _ := cookiejar.New(nil)
	guest := &http.Client{Jar: gj0}
	if res := post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "guest@x.com", "name": "Guest", "password": "password123"}); res.StatusCode != 201 {
		t.Fatalf("guest register: %d", res.StatusCode)
	}
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)

	// guest = edit share
	if res := send(t, c, "PUT", ts.URL+"/api/docs/"+strconv.FormatInt(b.ID, 10)+"/shares", map[string]any{"email": "guest@x.com", "role": "edit"}); res.StatusCode != 200 {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("share: %d %s", res.StatusCode, body)
	}

	// fields: 密级(text) + 内容(text)
	var sec, body store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "密级", "type": "text"}).Body).Decode(&sec)
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "内容", "type": "text"}).Body).Decode(&body)
	sk, bk := strconv.FormatInt(sec.ID, 10), strconv.FormatInt(body.ID, 10)
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{sk: "公开", bk: "公开内容"}}).Body).Decode(&store.Record{})
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{sk: "机密", bk: "机密内容"}}).Body).Decode(&store.Record{})

	// 默认视图上锁：只显示 密级=公开 的行；内容字段对 guest 隐藏
	views := cGet(t, c, u)
	var v0 struct {
		Views []store.View
	}
	json.NewDecoder(views.Body).Decode(&v0)
	grid := v0.Views[0]
	cfg := map[string]any{
		"locked":  true,
		"filters": map[string]any{"conj": "and", "rules": []map[string]any{{"f": json.Number(sk), "op": "is", "v": "公开"}}},
		"hidden":  []int64{body.ID},
	}
	if res := send(t, c, "PATCH", u+"/views/"+strconv.FormatInt(grid.ID, 10), map[string]any{"config": cfg}); res.StatusCode != 200 {
		t.Fatalf("lock view: %d", res.StatusCode)
	}

	// 确认 locked 保存了
	vr := cGet(t, c, u)
	var vv struct{ Views []store.View }
	json.NewDecoder(vr.Body).Decode(&vv)
	t.Logf("views: %d, config=%s", len(vv.Views), vv.Views[0].Config)

	// guest 看到的：只有公开行 + 内容字段被剔除
	post(t, guest, ts.URL+"/api/auth/login", map[string]string{"email": "guest@x.com", "password": "password123"})
	var full struct {
		Fields  []store.Field
		Records []store.Record
	}
	r := cGet(t, guest, u)
	t.Logf("guest GET status=%d", r.StatusCode)
	json.NewDecoder(r.Body).Decode(&full)
	if len(full.Records) != 1 || full.Records[0].Cells[sk] == nil {
		t.Fatalf("guest rows: %+v", full.Records)
	}
	if _, leaked := full.Records[0].Cells[bk]; leaked {
		t.Fatal("hidden field leaked to guest")
	}
	for _, f := range full.Fields {
		if f.ID == body.ID {
			t.Fatal("hidden field still listed")
		}
	}

	// owner（manage）不受限
	var own struct {
		Fields  []store.Field
		Records []store.Record
	}
	r = cGet(t, c, u)
	json.NewDecoder(r.Body).Decode(&own)
	if len(own.Records) != 5 || len(own.Fields) != 3 { // 3 个默认空行 + 2 条数据；标题 + 密级 + 内容
		t.Fatalf("owner view: %d fields %d records", len(own.Fields), len(own.Records))
	}

	// guest 写隐藏字段 → 403
	res := send(t, guest, "PATCH", u+"/records/"+strconv.FormatInt(own.Records[0].ID, 10),
		map[string]any{"cells": map[string]any{bk: "篡改"}})
	if res.StatusCode != 403 {
		t.Fatalf("hidden write: %d", res.StatusCode)
	}
	// guest 写可见字段 → 200
	res = send(t, guest, "PATCH", u+"/records/"+strconv.FormatInt(own.Records[0].ID, 10),
		map[string]any{"cells": map[string]any{sk: "公开（改）"}})
	if res.StatusCode != 200 {
		t.Fatalf("visible write: %d", res.StatusCode)
	}
}
