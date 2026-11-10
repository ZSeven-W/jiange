package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

// 允许多选: person fields may hold a JSON array of member ids; flipping the
// flag converts stored cells (single → [n], [a, b…] → a) and drops defaults
// that no longer fit.

func TestPersonMultipleLifecycle(t *testing.T)       { checkPersonMultiple(t, store.NewMemory()) }
func TestPostgresPersonMultipleLifecycle(t *testing.T) { checkPersonMultiple(t, postgresBaseSecurityStore(t)) }

func checkPersonMultiple(t *testing.T, st store.Store) {
	t.Helper()
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "person-multi@example.test", "name": "P", "password": "password123"})
	uid := meID(t, c, ts.URL)
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)
	var multi, single, text store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "成员", "type": "person", "multiple": true, "defaultValue": []int64{uid}}).Body).Decode(&multi)
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "单选负责人", "type": "person"}).Body).Decode(&single)
	if !multi.Multiple || single.Multiple {
		t.Fatalf("multiple flags: multi=%v single=%v", multi.Multiple, single.Multiple)
	}
	mk, sk := strconv.FormatInt(multi.ID, 10), strconv.FormatInt(single.ID, 10)

	// The array default fills omitted cells of new records.
	var rec store.Record
	json.NewDecoder(post(t, c, u+"/records", nil).Body).Decode(&rec)
	if string(rec.Cells[mk]) != "["+strconv.FormatInt(uid, 10)+"]" {
		t.Fatalf("multi default not applied: %+v", rec.Cells)
	}

	// Array cells validate; scalar cells and non-positive ids do not.
	var two store.Record
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{mk: []int64{7, 9}}}).Body).Decode(&two)
	if string(two.Cells[mk]) != "[7,9]" {
		t.Fatalf("array cell not stored: %+v", two.Cells)
	}
	for _, bad := range []any{[]int64{0}, 7, "kay"} {
		if r := send(t, c, "POST", u+"/records", map[string]any{"cells": map[string]any{mk: bad}}); r.StatusCode != http.StatusBadRequest {
			t.Fatalf("multiple field accepted %#v: %d", bad, r.StatusCode)
		}
	}
	var one store.Record
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{sk: 7}}).Body).Decode(&one)
	if string(one.Cells[sk]) != "7" {
		t.Fatalf("scalar cell not stored: %+v", one.Cells)
	}
	if r := send(t, c, "POST", u+"/records", map[string]any{"cells": map[string]any{sk: []int64{7}}}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("single field accepted an array: %d", r.StatusCode)
	}

	// 允许多选 on a non-person type is rejected.
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "文本", "type": "text"}).Body).Decode(&text)
	if r := send(t, c, "PATCH", u+"/fields/"+strconv.FormatInt(text.ID, 10), map[string]any{"multiple": true}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("text field accepted multiple: %d", r.StatusCode)
	}

	// Flipping to single keeps the first member; the array default no longer
	// fits and is dropped.
	if r := send(t, c, "PATCH", u+"/fields/"+mk, map[string]any{"multiple": false}); r.StatusCode != http.StatusOK {
		t.Fatalf("flip to single: %d", r.StatusCode)
	}
	var base struct {
		Fields  []store.Field
		Records []store.Record
	}
	json.NewDecoder(cGet(t, c, u).Body).Decode(&base)
	for _, f := range base.Fields {
		if f.ID == multi.ID && (f.Multiple || f.DefaultValue != nil) {
			t.Fatalf("default not dropped on flip: %+v", f)
		}
	}
	cell := func(recs []store.Record, id int64) string {
		for _, r := range recs {
			if r.ID == id {
				return string(r.Cells[mk])
			}
		}
		return "<missing record>"
	}
	if got := cell(base.Records, two.ID); got != "7" {
		t.Fatalf("flip to single kept %s", got)
	}
	// Flipping back wraps scalars into arrays.
	if r := send(t, c, "PATCH", u+"/fields/"+mk, map[string]any{"multiple": true}); r.StatusCode != http.StatusOK {
		t.Fatalf("flip to multiple: %d", r.StatusCode)
	}
	var base2 struct{ Records []store.Record }
	json.NewDecoder(cGet(t, c, u).Body).Decode(&base2)
	if got := cell(base2.Records, two.ID); got != "[7]" {
		t.Fatalf("flip to multiple kept %s", got)
	}
}

func TestPersonMultipleQuery(t *testing.T)        { checkPersonMultipleQuery(t, store.NewMemory()) }
func TestPostgresPersonMultipleQuery(t *testing.T) { checkPersonMultipleQuery(t, postgresBaseSecurityStore(t)) }

func checkPersonMultipleQuery(t *testing.T, st store.Store) {
	t.Helper()
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "person-query@example.test", "name": "Q", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)
	var multi, single store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "成员", "type": "person", "multiple": true}).Body).Decode(&multi)
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "负责人", "type": "person"}).Body).Decode(&single)
	mk, sk := strconv.FormatInt(multi.ID, 10), strconv.FormatInt(single.ID, 10)
	var a, bb, empty store.Record
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{mk: []int64{11, 2}, sk: 7}}).Body).Decode(&a)
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{mk: []int64{2}, sk: 9}}).Body).Decode(&bb)
	json.NewDecoder(post(t, c, u+"/records", nil).Body).Decode(&empty)

	query := func(rules []map[string]any, sorts []map[string]any) []store.Record {
		body := map[string]any{}
		if rules != nil {
			body["filters"] = map[string]any{"conj": "and", "rules": rules}
		}
		if sorts != nil {
			body["sorts"] = sorts
		}
		var out struct{ Records []store.Record }
		json.NewDecoder(post(t, c, u+"/query", body).Body).Decode(&out)
		return out.Records
	}
	ids := func(recs []store.Record) map[int64]bool {
		out := map[int64]bool{}
		for _, r := range recs {
			out[r.ID] = true
		}
		return out
	}
	// contains must not substring-match ids inside the JSON text.
	if got := ids(query([]map[string]any{{"f": multi.ID, "op": "contains", "v": []int64{2}}}, nil)); !got[a.ID] || !got[bb.ID] {
		t.Fatalf("contains 2: %v", got)
	}
	if got := ids(query([]map[string]any{{"f": multi.ID, "op": "contains", "v": []int64{1}}}, nil)); len(got) != 0 {
		t.Fatalf("contains 1 matched substring: %v", got)
	}
	if got := ids(query([]map[string]any{{"f": multi.ID, "op": "not_contains", "v": []int64{2}}}, nil)); got[a.ID] || got[bb.ID] || !got[empty.ID] {
		t.Fatalf("not_contains 2: %v", got)
	}
	if got := ids(query([]map[string]any{{"f": single.ID, "op": "is", "v": 7}}, nil)); len(got) != 1 || !got[a.ID] {
		t.Fatalf("is 7: %v", got)
	}
	if got := ids(query([]map[string]any{{"f": single.ID, "op": "is_not", "v": 7}}, nil)); got[a.ID] {
		t.Fatalf("is_not 7 kept the record holding 7: %v", got)
	}
	if r := send(t, c, "POST", u+"/query", map[string]any{"filters": map[string]any{"conj": "and", "rules": []map[string]any{{"f": multi.ID, "op": "contains", "v": "abc"}}}}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("contains with text accepted: %d", r.StatusCode)
	}
	// Sorting orders by the first member; empty cells (the seeded rows and the
	// empty record) come last.
	recs := query(nil, []map[string]any{{"f": single.ID, "asc": true}})
	if len(recs) < 3 || recs[0].ID != a.ID || recs[1].ID != bb.ID {
		t.Fatalf("sort by person: %+v", recs)
	}
	for _, r := range recs[2:] {
		if v := r.Cells[sk]; len(v) > 0 && string(v) != "null" {
			t.Fatalf("non-empty cell sorted last: %+v", r.Cells[sk])
		}
	}
}

func TestPersonArrayTitleJoinsNames(t *testing.T) {
	row := store.Record{Cells: map[string]json.RawMessage{"5": json.RawMessage(`[7,9]`)}}
	person := store.Field{ID: 5, Type: "person", IsPrimary: true}
	if got := visibleRecordTitle(row, &person, map[int64]string{7: "张三", 9: "李四"}); got != "张三、李四" {
		t.Fatalf("array title=%q", got)
	}
	// Unknown members are omitted instead of leaking raw ids.
	if got := visibleRecordTitle(row, &person, map[int64]string{7: "张三"}); got != "张三" {
		t.Fatalf("partial title=%q", got)
	}
}
