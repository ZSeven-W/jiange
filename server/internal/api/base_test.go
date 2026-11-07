package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ZSeven-W/jiange/server/internal/btsync"
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
	if len(full.Fields) != 2 || len(full.Records) != 6 {
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

func TestFieldEditAndConvert(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "kay@x.com", "name": "Kay", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)
	var text, num store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "备注", "type": "text"}).Body).Decode(&text)
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "数量", "type": "number"}).Body).Decode(&num)

	// rename + reorder survive a fresh GET; a bad type is rejected with 400
	if res := send(t, c, "PATCH", u+"/fields/"+strconv.FormatInt(text.ID, 10), map[string]any{"name": "说明", "position": 5}); res.StatusCode != 200 {
		t.Fatalf("patch field: %d", res.StatusCode)
	}
	if res := send(t, c, "PATCH", u+"/fields/"+strconv.FormatInt(text.ID, 10), map[string]any{"type": "richtext"}); res.StatusCode != 400 {
		t.Fatalf("bad type accepted: %d", res.StatusCode)
	}
	var full struct {
		Fields []store.Field
	}
	r, _ := c.Get(u)
	json.NewDecoder(r.Body).Decode(&full)
	if full.Fields[1].Name != "说明" || full.Fields[1].Position != 5 {
		t.Fatalf("rename/reorder not persisted: %+v", full.Fields)
	}

	// type change converts compatible values and clears the rest
	tk, nk := strconv.FormatInt(text.ID, 10), strconv.FormatInt(num.ID, 10)
	var r1, r2, r3 store.Record
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{tk: "3.5"}}).Body).Decode(&r1)
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{tk: "abc"}}).Body).Decode(&r2)
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{nk: 7}}).Body).Decode(&r3)
	if res := send(t, c, "PATCH", u+"/fields/"+tk, map[string]string{"type": "number"}); res.StatusCode != 200 {
		t.Fatalf("convert to number: %d", res.StatusCode)
	}
	if res := send(t, c, "PATCH", u+"/fields/"+nk, map[string]string{"type": "text"}); res.StatusCode != 200 {
		t.Fatalf("convert to text: %d", res.StatusCode)
	}
	records := map[int64]store.Record{}
	r, _ = c.Get(u)
	var after struct{ Records []store.Record }
	json.NewDecoder(r.Body).Decode(&after)
	for _, rec := range after.Records {
		records[rec.ID] = rec
	}
	if string(records[r1.ID].Cells[tk]) != "3.5" {
		t.Fatalf("text '3.5' should convert to 3.5, got %v", records[r1.ID].Cells[tk])
	}
	if _, ok := records[r2.ID].Cells[tk]; ok {
		t.Fatalf("text 'abc' should be cleared, got %v", records[r2.ID].Cells[tk])
	}
	if string(records[r3.ID].Cells[nk]) != `"7"` {
		t.Fatalf("number 7 should convert to '7', got %v", records[r3.ID].Cells[nk])
	}

	// shrinking select options clears removed choices
	var sel store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "状态", "type": "select", "options": []string{"待办", "完成"}}).Body).Decode(&sel)
	sk := strconv.FormatInt(sel.ID, 10)
	var r4 store.Record
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{sk: "待办"}}).Body).Decode(&r4)
	send(t, c, "PATCH", u+"/fields/"+sk, map[string]any{"options": []string{"完成"}})
	r, _ = c.Get(u)
	json.NewDecoder(r.Body).Decode(&after)
	for _, rec := range after.Records {
		if rec.ID == r4.ID {
			if _, ok := rec.Cells[sk]; ok {
				t.Fatalf("removed option should clear cell, got %v", rec.Cells[sk])
			}
		}
	}
}

func TestFieldTypesRegistry(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "ft@x.com", "name": "FT", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)

	// members ship with the base payload (person fields render names)
	var full struct {
		Members []store.User
	}
	r, _ := c.Get(u)
	json.NewDecoder(r.Body).Decode(&full)
	if len(full.Members) != 1 || full.Members[0].Name != "FT" {
		t.Fatalf("members: %+v", full.Members)
	}

	mk := func(name, typ string, opts []string) store.Field {
		var f store.Field
		json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": name, "type": typ, "options": opts}).Body).Decode(&f)
		return f
	}
	multi := mk("标签", "multi_select", []string{"红", "绿"})
	person := mk("负责", "person", nil)
	ro := mk("创建时间", "created_at", nil)
	if multi.Type != "multi_select" || person.Type != "person" || ro.Type != "created_at" {
		t.Fatalf("create typed fields: %+v %+v %+v", multi, person, ro)
	}

	// multi_select: valid arrays pass, unknown options are rejected
	mk2 := strconv.FormatInt(multi.ID, 10)
	if res := post(t, c, u+"/records", map[string]any{"cells": map[string]any{mk2: []string{"红", "绿"}}}); res.StatusCode != 201 {
		t.Fatalf("multi_select valid: %d", res.StatusCode)
	}
	if res := post(t, c, u+"/records", map[string]any{"cells": map[string]any{mk2: []string{"蓝"}}}); res.StatusCode != 400 {
		t.Fatalf("multi_select unknown option: %d", res.StatusCode)
	}
	if res := post(t, c, u+"/records", map[string]any{"cells": map[string]any{mk2: "红"}}); res.StatusCode != 400 {
		t.Fatalf("multi_select non-array: %d", res.StatusCode)
	}

	// person: a member id passes, garbage is rejected
	pk := strconv.FormatInt(person.ID, 10)
	if res := post(t, c, u+"/records", map[string]any{"cells": map[string]any{pk: full.Members[0].ID}}); res.StatusCode != 201 {
		t.Fatalf("person member: %d", res.StatusCode)
	}
	if res := post(t, c, u+"/records", map[string]any{"cells": map[string]any{pk: "kay"}}); res.StatusCode != 400 {
		t.Fatalf("person string: %d", res.StatusCode)
	}

	// computed columns reject writes but appear in fields
	if res := post(t, c, u+"/records", map[string]any{"cells": map[string]any{strconv.FormatInt(ro.ID, 10): "2024-01-01"}}); res.StatusCode != 400 {
		t.Fatalf("created_at should be read-only: %d", res.StatusCode)
	}

	// records carry creator/timestamps for the computed columns
	var got struct {
		Records []store.Record
	}
	r2, _ := c.Get(u)
	json.NewDecoder(r2.Body).Decode(&got)
	found := false
	for _, rec := range got.Records {
		if rec.CreatorID != nil && *rec.CreatorID == full.Members[0].ID && rec.CreatedAt != nil && rec.UpdatedAt != nil {
			found = true
		}
	}
	if !found {
		t.Fatalf("record metadata missing: %+v", got.Records)
	}

	// type conversion: multi_select → text joins with commas
	if res := send(t, c, "PATCH", u+"/fields/"+mk2, map[string]string{"type": "text"}); res.StatusCode != 200 {
		t.Fatalf("multi→text: %d", res.StatusCode)
	}
	r3, _ := c.Get(u)
	got.Records = nil
	json.NewDecoder(r3.Body).Decode(&got)
	for _, rec := range got.Records {
		if v, ok := rec.Cells[mk2]; ok && string(v) != `"红,绿"` {
			t.Fatalf("multi→text conversion: %v", string(v))
		}
	}
}

func TestLightFieldTypes(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "lf@x.com", "name": "LF", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)

	mk := func(name, typ string) store.Field {
		var f store.Field
		json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": name, "type": typ, "description": "帮助说明"}).Body).Decode(&f)
		return f
	}
	urlF, phoneF, emailF, ratingF := mk("链接", "url"), mk("电话", "phone"), mk("邮箱", "email"), mk("评分", "rating")
	if urlF.Description != "帮助说明" {
		t.Fatalf("description: %+v", urlF)
	}
	cells := map[string]any{
		strconv.FormatInt(urlF.ID, 10):    "https://jiange.dev",
		strconv.FormatInt(phoneF.ID, 10):  "+86 138 0000 0000",
		strconv.FormatInt(emailF.ID, 10):  "a@b.co",
		strconv.FormatInt(ratingF.ID, 10): 4,
	}
	if res := post(t, c, u+"/records", map[string]any{"cells": cells}); res.StatusCode != 201 {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("valid light cells: %d %s", res.StatusCode, body)
	}
	bad := map[string]any{
		strconv.FormatInt(urlF.ID, 10):    "ftp://x",
		strconv.FormatInt(phoneF.ID, 10):  "电话",
		strconv.FormatInt(emailF.ID, 10):  "not-an-email",
		strconv.FormatInt(ratingF.ID, 10): 6,
	}
	for k, v := range bad {
		one := map[string]any{k: v}
		if res := post(t, c, u+"/records", map[string]any{"cells": one}); res.StatusCode != 400 {
			t.Fatalf("bad %v accepted: %d", v, res.StatusCode)
		}
	}
}

func TestMoveRecord(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "mv@x.com", "name": "MV", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)
	var initial struct{ Records []store.Record }
	json.NewDecoder(cGet(t, c, u).Body).Decode(&initial)
	var ids []int64
	for range 4 {
		var rec store.Record
		json.NewDecoder(post(t, c, u+"/records", nil).Body).Decode(&rec)
		ids = append(ids, rec.ID)
	}
	// move record 4 between 1 and 2
	res := send(t, c, "PATCH", u+"/records/"+strconv.FormatInt(ids[3], 10), map[string]any{"move": true, "position": 1.5})
	var moved store.Record
	json.NewDecoder(res.Body).Decode(&moved)
	if res.StatusCode != 200 || moved.Position != 1.5 {
		t.Fatalf("move: %d %+v", res.StatusCode, moved)
	}
	var full struct{ Records []store.Record }
	r, _ := c.Get(u)
	json.NewDecoder(r.Body).Decode(&full)
	got := []int64{}
	for _, rec := range full.Records {
		got = append(got, rec.ID)
	}
	want := []int64{ids[3]}
	for _, r := range initial.Records {
		want = append(want, r.ID)
	}
	want = append(want, ids[:3]...)
	if len(got) != len(want) {
		t.Fatalf("order after move: %v (want %v)", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order after move: %v (want %v)", got, want)
		}
	}
}

func TestBaseRealtimeEvents(t *testing.T) {
	st := store.NewMemory()
	hub := &btsync.Hub{Store: st, PingInterval: time.Hour}
	s := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 1000, BtHub: hub}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	j, _ := cookiejar.New(nil)
	c := &http.Client{Jar: j}
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "rt@x.com", "name": "RT", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)

	// connect before mutating (the dial must carry the session cookie)
	syncURL, _ := url.Parse(u + "/sync")
	var cookies []string
	for _, ck := range j.Cookies(syncURL) {
		cookies = append(cookies, ck.Name+"="+ck.Value)
	}
	ws, _, err := websocket.Dial(context.Background(), strings.Replace(u, "http://", "ws://", 1)+"/sync", &websocket.DialOptions{
		HTTPHeader: http.Header{"Cookie": cookies},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")
	readUntil := func(want string) map[string]any {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		for {
			_, data, err := ws.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var m map[string]any
			if json.Unmarshal(data, &m) == nil && m["t"] == want {
				return m
			}
		}
	}
	readUntil("hello")

	// a field add and a cell write both stream to the socket
	var f store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "说明", "type": "text"}).Body).Decode(&f)
	var rec store.Record
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]string{strconv.FormatInt(f.ID, 10): "hi"}}).Body).Decode(&rec)

	// Events may arrive in several frames. They are reload hints rather than
	// raw cell payloads, which can reveal links to inaccessible targets.
	var seqs []float64
	for len(seqs) < 2 {
		m := readUntil("events")
		for _, e := range m["events"].([]any) {
			event := e.(map[string]any)
			body := event["body"].(map[string]any)
			if body["kind"] != "reload" || len(body) != 1 {
				t.Fatalf("unexpected event payload: %v", body)
			}
			seqs = append(seqs, event["seq"].(float64))
		}
	}
	if seqs[0] >= seqs[1] {
		t.Fatalf("event order: %v", seqs)
	}

	// GET reports the event head so a fresh client knows where to resume
	var full struct{ Head int64 }
	r, _ := c.Get(u)
	json.NewDecoder(r.Body).Decode(&full)
	if full.Head == 0 {
		t.Fatalf("head should be positive, got %d", full.Head)
	}
}
