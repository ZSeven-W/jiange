package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestFieldDefaultValueFillsNewRecords(t *testing.T) {
	checkFieldDefault(t, store.NewMemory())
}

func TestPostgresFieldDefaultValue(t *testing.T) {
	checkFieldDefault(t, postgresBaseSecurityStore(t))
}

func checkFieldDefault(t *testing.T, st store.Store) {
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "default@example.test", "name": "D", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)
	var status, count store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "状态", "type": "select", "options": []string{"待办", "完成"}, "defaultValue": "待办"}).Body).Decode(&status)
	if string(status.DefaultValue) != `"待办"` {
		t.Fatalf("default not stored: %s", status.DefaultValue)
	}
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "数量", "type": "number"}).Body).Decode(&count)
	if r := send(t, c, "PATCH", u+"/fields/"+strconv.FormatInt(count.ID, 10), map[string]any{"defaultValue": 3}); r.StatusCode != http.StatusOK {
		t.Fatalf("patch default %d", r.StatusCode)
	}
	if r := send(t, c, "PATCH", u+"/fields/"+strconv.FormatInt(count.ID, 10), map[string]any{"defaultValue": "abc"}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("mismatched default accepted: %d", r.StatusCode)
	}
	sk, ck := strconv.FormatInt(status.ID, 10), strconv.FormatInt(count.ID, 10)
	var plain, explicit store.Record
	json.NewDecoder(post(t, c, u+"/records", nil).Body).Decode(&plain)
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{sk: "完成"}}).Body).Decode(&explicit)
	if string(plain.Cells[sk]) != `"待办"` || string(plain.Cells[ck]) != "3" {
		t.Fatalf("defaults not applied: %+v", plain.Cells)
	}
	if string(explicit.Cells[sk]) != `"完成"` || string(explicit.Cells[ck]) != "3" {
		t.Fatalf("explicit value overridden: %+v", explicit.Cells)
	}
	// clearing the default stops filling; reloading keeps it cleared
	if r := send(t, c, "PATCH", u+"/fields/"+sk, map[string]any{"defaultValue": nil}); r.StatusCode != http.StatusOK {
		t.Fatalf("clear %d", r.StatusCode)
	}
	var later store.Record
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{}}).Body).Decode(&later)
	if _, ok := later.Cells[sk]; ok {
		t.Fatalf("cleared default still applied: %+v", later.Cells)
	}
	var full struct{ Fields []store.Field }
	json.NewDecoder(cGet(t, c, u).Body).Decode(&full)
	for _, f := range full.Fields {
		if f.ID == count.ID && string(f.DefaultValue) != "3" {
			t.Fatalf("default not persisted: %+v", f)
		}
		if f.ID == status.ID && f.DefaultValue != nil {
			t.Fatalf("cleared default persisted: %+v", f)
		}
	}
}

func TestMultiSelectAndPersonDefaults(t *testing.T) { checkMultiPersonDefaults(t, store.NewMemory()) }

func TestPostgresMultiSelectAndPersonDefaults(t *testing.T) {
	checkMultiPersonDefaults(t, postgresBaseSecurityStore(t))
}

func checkMultiPersonDefaults(t *testing.T, st store.Store) {
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "multi-default@example.test", "name": "M", "password": "password123"})
	uid := meID(t, c, ts.URL)
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)
	var tags, owner store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "标签", "type": "multi_select", "options": []string{"前端", "后端", "设计"}, "defaultValue": []string{"前端", "设计"}}).Body).Decode(&tags)
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "负责人", "type": "person", "defaultValue": uid}).Body).Decode(&owner)
	if r := send(t, c, "PATCH", u+"/fields/"+strconv.FormatInt(tags.ID, 10), map[string]any{"defaultValue": []string{"不存在"}}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown option default accepted: %d", r.StatusCode)
	}
	var rec store.Record
	json.NewDecoder(post(t, c, u+"/records", nil).Body).Decode(&rec)
	if string(rec.Cells[strconv.FormatInt(tags.ID, 10)]) != `["前端","设计"]` || string(rec.Cells[strconv.FormatInt(owner.ID, 10)]) != strconv.FormatInt(uid, 10) {
		t.Fatalf("multi/person defaults not applied: %+v", rec.Cells)
	}
}
