package api

import (
	"encoding/json"
	"io"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestBaseExtendedFieldsMultiGroupAndHierarchy(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "ext@x.com", "name": "Ext", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)

	mkField := func(body map[string]any) store.Field {
		res := post(t, c, u+"/fields", body)
		if res.StatusCode != 201 {
			raw, _ := io.ReadAll(res.Body)
			t.Fatalf("create field %v: status %d %s", body, res.StatusCode, raw)
		}
		var f store.Field
		json.NewDecoder(res.Body).Decode(&f)
		return f
	}

	curF := mkField(map[string]any{"name": "预算", "type": "currency", "options": []string{"USD", "2"}})
	progF := mkField(map[string]any{"name": "进度", "type": "progress", "options": []string{"bar"}})
	autoF := mkField(map[string]any{"name": "编号", "type": "autonumber", "options": []string{"TASK-", "4"}})
	btnF := mkField(map[string]any{"name": "操作", "type": "button", "options": []string{"打开", "open_url", "https://example.com/{编号}"}})
	locF := mkField(map[string]any{"name": "地点", "type": "location"})
	linkF := mkField(map[string]any{"name": "父任务", "type": "link", "options": []string{strconv.FormatInt(b.ID, 10)}})

	// Invalid extended field options are rejected.
	if res := post(t, c, u+"/fields", map[string]any{"name": "坏货币", "type": "currency", "options": []string{"BTC", "2"}}); res.StatusCode != 400 {
		t.Fatalf("invalid currency code accepted: %d", res.StatusCode)
	}
	if res := post(t, c, u+"/fields", map[string]any{"name": "坏进度", "type": "progress", "options": []string{"pie"}}); res.StatusCode != 400 {
		t.Fatalf("invalid progress style accepted: %d", res.StatusCode)
	}
	if res := post(t, c, u+"/fields", map[string]any{"name": "坏按钮", "type": "button", "options": []string{"点", "eval_js", ""}}); res.StatusCode != 400 {
		t.Fatalf("invalid button action accepted: %d", res.StatusCode)
	}

	ck := strconv.FormatInt(curF.ID, 10)
	pk := strconv.FormatInt(progF.ID, 10)
	ak := strconv.FormatInt(autoF.ID, 10)
	bk := strconv.FormatInt(btnF.ID, 10)
	lk := strconv.FormatInt(locF.ID, 10)

	// Valid record creation gets server-assigned sequential autonumber.
	var rec1, rec2 store.Record
	res1 := post(t, c, u+"/records", map[string]any{"cells": map[string]any{
		ck: 1234.5,
		pk: 75,
		lk: "北京市海淀区 | 39.98,116.31",
	}})
	if res1.StatusCode != 201 {
		raw, _ := io.ReadAll(res1.Body)
		t.Fatalf("add record 1: %d %s", res1.StatusCode, raw)
	}
	json.NewDecoder(res1.Body).Decode(&rec1)
	if string(rec1.Cells[ak]) != "1" {
		t.Fatalf("expected autonumber 1 on rec1, got %s", rec1.Cells[ak])
	}

	res2 := post(t, c, u+"/records", map[string]any{"cells": map[string]any{
		ck: 250.25,
		pk: 100,
		lk: "上海市浦东新区",
	}})
	if res2.StatusCode != 201 {
		t.Fatalf("add record 2: %d", res2.StatusCode)
	}
	json.NewDecoder(res2.Body).Decode(&rec2)
	if string(rec2.Cells[ak]) != "2" {
		t.Fatalf("expected autonumber 2 on rec2, got %s", rec2.Cells[ak])
	}

	// Out-of-range progress, manual autonumber write/clear, and button write must fail with 400.
	if res := post(t, c, u+"/records", map[string]any{"cells": map[string]any{pk: 120}}); res.StatusCode != 400 {
		t.Fatalf("progress > 100 accepted: %d", res.StatusCode)
	}
	if res := post(t, c, u+"/records", map[string]any{"cells": map[string]any{pk: -5}}); res.StatusCode != 400 {
		t.Fatalf("progress < 0 accepted: %d", res.StatusCode)
	}
	if res := post(t, c, u+"/records", map[string]any{"cells": map[string]any{ak: 99}}); res.StatusCode != 400 {
		t.Fatalf("manual autonumber create accepted: %d", res.StatusCode)
	}
	if res := send(t, c, "PATCH", u+"/records/"+strconv.FormatInt(rec1.ID, 10), map[string]any{"cells": map[string]any{ak: nil}}); res.StatusCode != 400 {
		t.Fatalf("manual autonumber null-clear accepted: %d", res.StatusCode)
	}
	if res := post(t, c, u+"/records", map[string]any{"cells": map[string]any{bk: "clicked"}}); res.StatusCode != 400 {
		t.Fatalf("manual button write accepted: %d", res.StatusCode)
	}

	// Server-side query filters & sorts on currency, progress, autonumber, location.
	qRes := post(t, c, u+"/query", map[string]any{
		"filters": map[string]any{
			"conj": "and",
			"rules": []map[string]any{
				{"f": curF.ID, "op": "gte", "v": 200},
				{"f": progF.ID, "op": "gte", "v": 50},
				{"f": autoF.ID, "op": "gte", "v": 1},
				{"f": locF.ID, "op": "contains", "v": "区"},
			},
		},
		"sorts": []map[string]any{
			{"f": curF.ID, "asc": true},
		},
	})
	if qRes.StatusCode != 200 {
		raw, _ := io.ReadAll(qRes.Body)
		t.Fatalf("query extended fields: %d %s", qRes.StatusCode, raw)
	}
	var qBody struct {
		Records []store.Record `json:"records"`
	}
	json.NewDecoder(qRes.Body).Decode(&qBody)
	if len(qBody.Records) != 2 || qBody.Records[0].ID != rec2.ID || qBody.Records[1].ID != rec1.ID {
		t.Fatalf("unexpected query result order: %+v", qBody.Records)
	}

	// Create hierarchy view with parentField + grid view with 3-level groups.
	hRes := post(t, c, u+"/views", map[string]any{
		"type":   "hierarchy",
		"name":   "任务层级",
		"config": map[string]any{"parentField": linkF.ID},
	})
	if hRes.StatusCode != 201 {
		raw, _ := io.ReadAll(hRes.Body)
		t.Fatalf("create hierarchy view: %d %s", hRes.StatusCode, raw)
	}
	var hv store.View
	json.NewDecoder(hRes.Body).Decode(&hv)
	if hv.Type != "hierarchy" {
		t.Fatalf("expected hierarchy view, got %+v", hv)
	}

	gRes := post(t, c, u+"/views", map[string]any{
		"type": "grid",
		"name": "三级分组",
		"config": map[string]any{
			"group":  curF.ID,
			"groups": []int64{curF.ID, progF.ID, locF.ID},
		},
	})
	if gRes.StatusCode != 201 {
		raw, _ := io.ReadAll(gRes.Body)
		t.Fatalf("create 3-level group view: %d %s", gRes.StatusCode, raw)
	}
	// >3 grouping levels rejected with 400.
	if badG := post(t, c, u+"/views", map[string]any{
		"type":   "grid",
		"name":   "四级分组",
		"config": map[string]any{"groups": []int64{curF.ID, progF.ID, autoF.ID, locF.ID}},
	}); badG.StatusCode != 400 {
		t.Fatalf(">3 grouping levels accepted: %d", badG.StatusCode)
	}
}
