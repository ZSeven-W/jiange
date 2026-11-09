package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestSelectOptionRenameKeepsRecordValues(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "rename@example.test", "name": "R", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)
	var f store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "状态", "type": "select", "options": []string{"待办", "完成"}}).Body).Decode(&f)
	fk := strconv.FormatInt(f.ID, 10)
	var r1, r2 store.Record
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{fk: "待办"}}).Body).Decode(&r1)
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{fk: "完成"}}).Body).Decode(&r2)
	if r := send(t, c, "PATCH", u+"/fields/"+fk, map[string]any{"options": []string{"未开始", "完成"}, "optionRenames": map[string]string{"待办": "未开始"}}); r.StatusCode != http.StatusOK {
		t.Fatalf("rename %d", r.StatusCode)
	}
	var out struct{ Records []store.Record }
	json.NewDecoder(cGet(t, c, u).Body).Decode(&out)
	got := map[int64]string{}
	for _, rec := range out.Records {
		var v string
		json.Unmarshal(rec.Cells[fk], &v)
		got[rec.ID] = v
	}
	if got[r1.ID] != "未开始" || got[r2.ID] != "完成" {
		t.Fatalf("values after rename: %+v", got)
	}
}
