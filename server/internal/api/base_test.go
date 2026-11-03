package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestBaseCRUD(t *testing.T) {
	st := store.NewMemory()
	s := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 1000}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	j, _ := cookiejar.New(nil)
	c := &http.Client{Jar: j}
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "kay@x.com", "name": "Kay", "password": "password123"})
	var b store.DocMeta
	cr := post(t, c, ts.URL+"/api/bases", map[string]string{"title": "需求池"})
	raw, _ := io.ReadAll(cr.Body)
	json.Unmarshal(raw, &b)
	if b.Kind != "base" || b.Title != "需求池" {
		t.Fatalf("create: %+v", b)
	}
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)
	var f store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "状态", "type": "select", "options": []string{"待办", "进行中", "完成"}}).Body).Decode(&f)
	if f.ID == 0 || f.Type != "select" {
		t.Fatalf("field: %+v", f)
	}
	fk := strconv.FormatInt(f.ID, 10)
	if res := post(t, c, u+"/records", map[string]any{"cells": map[string]any{fk: "不存在"}}); res.StatusCode != 400 {
		t.Fatalf("bad select accepted: %d", res.StatusCode)
	}
	var rec store.Record
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{fk: "进行中"}}).Body).Decode(&rec)
	res := send(t, c, "PATCH", u+"/records/"+strconv.FormatInt(rec.ID, 10), map[string]any{"cells": map[string]any{fk: nil}})
	rec = store.Record{}
	json.NewDecoder(res.Body).Decode(&rec)
	if res.StatusCode != 200 || len(rec.Cells) != 0 {
		t.Fatalf("clear: %d %+v", res.StatusCode, rec)
	}
	var full struct {
		Fields  []store.Field
		Records []store.Record
	}
	r2, _ := c.Get(u)
	json.NewDecoder(r2.Body).Decode(&full)
	if len(full.Fields) != 2 || len(full.Records) != 4 {
		t.Fatalf("get: %d fields %d records", len(full.Fields), len(full.Records))
	}
	if res := send(t, c, "DELETE", u+"/fields/"+fk, nil); res.StatusCode != 204 {
		t.Fatalf("delete field: %d", res.StatusCode)
	}
	// docs endpoints don't open bases over sync, and bases list in the tree
	r3, _ := c.Get(ts.URL + "/api/docs")
	var list struct{ Docs []store.DocMeta }
	json.NewDecoder(r3.Body).Decode(&list)
	if len(list.Docs) != 1 || list.Docs[0].Kind != "base" {
		t.Fatalf("tree: %+v", list.Docs)
	}
}
