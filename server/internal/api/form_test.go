package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestPublicForm(t *testing.T) {
	st := store.NewMemory()
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "form@x.com", "name": "F", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)

	// fields: 姓名(text) + 反馈(text) — form exposes only 反馈
	var name, fb store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "姓名", "type": "text"}).Body).Decode(&name)
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "反馈", "type": "text"}).Body).Decode(&fb)
	var v store.View
	json.NewDecoder(post(t, c, u+"/views", map[string]any{
		"type": "form", "name": "反馈收集",
		"config": map[string]any{"title": "产品反馈", "desc": "欢迎留言", "fields": []int64{fb.ID}},
	}).Body).Decode(&v)

	// public GET (no cookie)
	anon := &http.Client{}
	r, err := anon.Get(ts.URL + "/api/forms/" + strconv.FormatInt(b.ID, 10) + "/" + strconv.FormatInt(v.ID, 10))
	if err != nil || r.StatusCode != 200 {
		t.Fatalf("form get: %v %v", err, r)
	}
	var def struct {
		Title  string
		Fields []formField
	}
	json.NewDecoder(r.Body).Decode(&def)
	if def.Title != "产品反馈" || len(def.Fields) != 1 || def.Fields[0].Name != "反馈" {
		t.Fatalf("form def: %+v", def)
	}

	// anonymous submit fills the allowed field
	res := post(t, anon, ts.URL+"/api/forms/"+strconv.FormatInt(b.ID, 10)+"/"+strconv.FormatInt(v.ID, 10),
		map[string]any{"cells": map[string]any{strconv.FormatInt(fb.ID, 10): "很好用"}})
	if res.StatusCode != 201 {
		t.Fatalf("submit: %d", res.StatusCode)
	}
	// submitting a field that is not in the form is rejected
	res = post(t, anon, ts.URL+"/api/forms/"+strconv.FormatInt(b.ID, 10)+"/"+strconv.FormatInt(v.ID, 10),
		map[string]any{"cells": map[string]any{strconv.FormatInt(name.ID, 10): "x"}})
	if res.StatusCode != 400 {
		t.Fatalf("hidden field accepted: %d", res.StatusCode)
	}
	// invalid value for the exposed field type is rejected
	var bad store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "评分", "type": "number"}).Body).Decode(&bad)
	// add it to the form then submit a wrong-typed value
	send(t, c, "PATCH", u+"/views/"+strconv.FormatInt(v.ID, 10), map[string]any{
		"config": map[string]any{"title": "产品反馈", "fields": []int64{fb.ID, bad.ID}},
	})
	res = post(t, anon, ts.URL+"/api/forms/"+strconv.FormatInt(b.ID, 10)+"/"+strconv.FormatInt(v.ID, 10),
		map[string]any{"cells": map[string]any{strconv.FormatInt(bad.ID, 10): "abc"}})
	if res.StatusCode != 400 {
		t.Fatalf("bad number accepted: %d", res.StatusCode)
	}

	// the record landed
	var full struct {
		Records []store.Record
	}
	r2, _ := c.Get(u)
	json.NewDecoder(r2.Body).Decode(&full)
	found := false
	for _, rec := range full.Records {
		if string(rec.Cells[strconv.FormatInt(fb.ID, 10)]) == `"很好用"` {
			found = true
		}
	}
	if !found {
		t.Fatalf("submitted record missing: %+v", full.Records)
	}
}
