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

func newBaseForViews(t *testing.T) (*httptest.Server, *http.Client, string, string) {
	t.Helper()
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "v@x.com", "name": "V", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)

	// 状态 select + 估时 number, a few rows
	var st, num store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "状态", "type": "select", "options": []string{"待办", "完成"}}).Body).Decode(&st)
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "估时", "type": "number"}).Body).Decode(&num)
	sk, nk := strconv.FormatInt(st.ID, 10), strconv.FormatInt(num.ID, 10)
	post(t, c, u+"/records", map[string]any{"cells": map[string]any{sk: "待办", nk: 5}})
	post(t, c, u+"/records", map[string]any{"cells": map[string]any{sk: "完成", nk: 1}})
	post(t, c, u+"/records", map[string]any{"cells": map[string]any{nk: 9}})
	return ts, c, u, sk
}

func TestViewsCRUDAndQuery(t *testing.T) {
	_, c, u, sk := newBaseForViews(t)

	// default view ships with the base
	var full struct {
		Views []store.View
	}
	r, _ := c.Get(u)
	json.NewDecoder(r.Body).Decode(&full)
	if len(full.Views) != 1 || full.Views[0].Type != "grid" {
		t.Fatalf("default view: %+v", full.Views)
	}
	fid := full.Views[0].ID

	// 保存：filter 状态=待办, no sorts yet
	cfg := map[string]any{"filters": map[string]any{"conj": "and", "rules": []map[string]any{{"f": json.Number(sk), "op": "is", "v": "待办"}}}}
	res := send(t, c, "PATCH", u+"/views/"+strconv.FormatInt(fid, 10), map[string]any{"config": cfg})
	if res.StatusCode != 200 {
		t.Fatalf("save view: %d", res.StatusCode)
	}

	// server-side query with the same filters returns only matching rows, injection-safe
	q := map[string]any{"filters": cfg["filters"], "sorts": []map[string]any{{"f": json.Number(sk), "asc": true}}}
	res = post(t, c, u+"/query", q)
	var out struct{ Records []store.Record }
	json.NewDecoder(res.Body).Decode(&out)
	if res.StatusCode != 200 || len(out.Records) != 1 || out.Records[0].Cells[sk] == nil {
		t.Fatalf("query: %d %+v", res.StatusCode, out.Records)
	}

	// hostile values stay bind parameters; unknown fields/ops are rejected
	hostile := map[string]any{"filters": map[string]any{"conj": "and", "rules": []map[string]any{{"f": json.Number(sk), "op": "contains", "v": "' OR '1'='1"}}}}
	if res := post(t, c, u+"/query", hostile); res.StatusCode != 200 {
		t.Fatalf("hostile value should still bind: %d", res.StatusCode)
	}
	bad := map[string]any{"filters": map[string]any{"conj": "and", "rules": []map[string]any{{"f": json.Number("999"), "op": "is", "v": "x"}}}}
	if res := post(t, c, u+"/query", bad); res.StatusCode != 400 {
		t.Fatalf("unknown field must 400: %d", res.StatusCode)
	}
	badOp := map[string]any{"filters": map[string]any{"conj": "and", "rules": []map[string]any{{"f": json.Number(sk), "op": "; DROP TABLE base_records", "v": "x"}}}}
	if res := post(t, c, u+"/query", badOp); res.StatusCode != 400 {
		t.Fatalf("hostile op must 400: %d", res.StatusCode)
	}

	// create a kanban view, rename it, then delete it
	var v store.View
	json.NewDecoder(post(t, c, u+"/views", map[string]any{"type": "kanban", "name": "按状态", "config": map[string]any{"group": json.Number(sk)}}).Body).Decode(&v)
	if v.Type != "kanban" || v.ID == 0 {
		t.Fatalf("kanban view: %+v", v)
	}
	if res := send(t, c, "PATCH", u+"/views/"+strconv.FormatInt(v.ID, 10), map[string]string{"name": "状态看板"}); res.StatusCode != 200 {
		t.Fatalf("rename view: %d", res.StatusCode)
	}
	if res := send(t, c, "DELETE", u+"/views/"+strconv.FormatInt(v.ID, 10), nil); res.StatusCode != 204 {
		t.Fatalf("delete view: %d", res.StatusCode)
	}
	r, _ = c.Get(u)
	full.Views = nil
	json.NewDecoder(r.Body).Decode(&full)
	if len(full.Views) != 1 {
		t.Fatalf("views after delete: %+v", full.Views)
	}
}

// TestQueryPerfSmoke keeps the server-side path honest on the memory store:
// 10k rows filter+sort well under 200ms.
func TestQueryPerfSmoke(t *testing.T) {
	st := store.NewMemory()
	s := &Server{Store: st, Log: slogDiscard(), SessionTTL: time.Hour, Iterations: 1000}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	j, _ := cookiejar.New(nil)
	c := &http.Client{Jar: j}
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "p@x.com", "name": "P", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)
	var num store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "v", "type": "number"}).Body).Decode(&num)
	nk := strconv.FormatInt(num.ID, 10)
	for i := 0; i < 10000; i += 500 {
		batch := make([]struct{}, 0)
		_ = batch
		for j := 0; j < 500; j++ {
			post(t, c, u+"/records", map[string]any{"cells": map[string]any{nk: float64(i + j)}})
		}
	}
	start := time.Now()
	res := post(t, c, u+"/query", map[string]any{
		"filters": map[string]any{"conj": "and", "rules": []map[string]any{{"f": json.Number(nk), "op": "gte", "v": 9000}}},
		"sorts":   []map[string]any{{"f": json.Number(nk), "asc": true}},
		"limit":   10001,
	})
	if res.StatusCode != 200 {
		t.Fatalf("query: %d", res.StatusCode)
	}
	var out struct{ Records []store.Record }
	json.NewDecoder(res.Body).Decode(&out)
	elapsed := time.Since(start)
	if len(out.Records) != 1000 {
		t.Fatalf("expected 1000 records, got %d", len(out.Records))
	}
	if elapsed > 200*time.Millisecond {
		t.Fatalf("10k-row query took %s (>200ms)", elapsed)
	}
	t.Logf("10k-row filter+sort took %s", elapsed)
}

func slogDiscard() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }
