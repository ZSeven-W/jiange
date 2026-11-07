package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type revokeDuringLinkProjection struct {
	store.Store
	mu     sync.Mutex
	target int64
	hook   func()
}

func (s *revokeDuringLinkProjection) VisibleRecordIDs(ctx context.Context, baseID int64, ids []int64, fields []store.Field, mandatory []btquery.Config) ([]int64, error) {
	s.mu.Lock()
	var hook func()
	if baseID == s.target {
		hook = s.hook
		s.hook = nil
	}
	s.mu.Unlock()
	if hook != nil {
		hook()
	}
	return s.Store.VisibleRecordIDs(ctx, baseID, ids, fields, mandatory)
}

func TestRecordWriteResponsesProjectLinkPermissions(t *testing.T) {
	f := newBaseChannelFixture(t)
	var target store.DocMeta
	if r := post(t, f.owner, f.ts.URL+"/api/bases", map[string]string{"title": "target"}); r.StatusCode != http.StatusCreated {
		t.Fatalf("target %d", r.StatusCode)
	} else {
		if err := json.NewDecoder(r.Body).Decode(&target); err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
	}
	targetRows, err := f.st.Records(context.Background(), target.ID)
	if err != nil || len(targetRows) == 0 {
		t.Fatalf("target rows=%v err=%v", targetRows, err)
	}
	fields, err := f.st.Fields(context.Background(), f.base.ID)
	if err != nil || len(fields) == 0 {
		t.Fatal(err)
	}
	var link, date store.Field
	if r := post(t, f.owner, f.path("/fields"), map[string]any{"name": "关联", "type": "link", "options": []string{strconv.FormatInt(target.ID, 10)}}); r.StatusCode != http.StatusCreated {
		t.Fatalf("link %d", r.StatusCode)
	} else {
		_ = json.NewDecoder(r.Body).Decode(&link)
		r.Body.Close()
	}
	if r := post(t, f.owner, f.path("/fields"), map[string]any{"name": "日期", "type": "date"}); r.StatusCode != http.StatusCreated {
		t.Fatalf("date %d", r.StatusCode)
	} else {
		_ = json.NewDecoder(r.Body).Decode(&date)
		r.Body.Close()
	}
	rows, err := f.st.Records(context.Background(), f.base.ID)
	if err != nil || len(rows) == 0 {
		t.Fatal(err)
	}
	rid, tid := rows[0].ID, targetRows[0].ID
	linkKey, dateKey, textKey := strconv.FormatInt(link.ID, 10), strconv.FormatInt(date.ID, 10), strconv.FormatInt(fields[0].ID, 10)
	path := f.path("/records/") + strconv.FormatInt(rid, 10)
	if r := send(t, f.owner, "PATCH", path, map[string]any{"cells": map[string]any{linkKey: []int64{tid}}}); r.StatusCode != http.StatusOK {
		t.Fatalf("link write %d", r.StatusCode)
	} else {
		r.Body.Close()
	}
	assertLink := func(r *http.Response, want string) {
		t.Helper()
		defer r.Body.Close()
		var rec store.Record
		if r.StatusCode != http.StatusOK {
			t.Fatalf("status=%d", r.StatusCode)
		}
		if err := json.NewDecoder(r.Body).Decode(&rec); err != nil {
			t.Fatal(err)
		}
		if got := string(rec.Cells[linkKey]); got != want {
			t.Fatalf("link response=%s want=%s", got, want)
		}
	}
	assertLink(send(t, f.guest, "PATCH", path, map[string]any{"cells": map[string]any{textKey: "updated"}}), "[]")
	assertLink(send(t, f.guest, "PATCH", path+"/compare-cells", map[string]any{"expected": map[string]any{dateKey: nil}, "cells": map[string]any{dateKey: "2026-11-07"}}), "[]")
	if err := f.st.SetShare(context.Background(), target.ID, 2, store.RoleView); err != nil {
		t.Fatal(err)
	}
	want := "[" + strconv.FormatInt(tid, 10) + "]"
	assertLink(send(t, f.guest, "PATCH", path, map[string]any{"cells": map[string]any{textKey: "permitted"}}), want)
	// The same linked row becomes inaccessible when the target's locked
	// predicate excludes it, even though the target Base is shared.
	views, err := f.st.Views(context.Background(), target.ID)
	if err != nil || len(views) == 0 {
		t.Fatal(err)
	}
	targetFields, err := f.st.Fields(context.Background(), target.ID)
	if err != nil || len(targetFields) == 0 {
		t.Fatal(err)
	}
	views[0].Config, _ = json.Marshal(map[string]any{"locked": true, "filters": map[string]any{"conj": "and", "rules": []map[string]any{{"f": targetFields[0].ID, "op": "is", "v": "visible-only"}}}})
	if _, err := f.st.UpdateView(context.Background(), views[0]); err != nil {
		t.Fatal(err)
	}
	assertLink(send(t, f.guest, "PATCH", path, map[string]any{"cells": map[string]any{textKey: "hidden-target"}}), "[]")
	views[0].Config = json.RawMessage(`{}`)
	if _, err := f.st.UpdateView(context.Background(), views[0]); err != nil {
		t.Fatal(err)
	}
	bulk := make([]store.Record, 10001)
	if err := f.st.AddRecordsBulk(context.Background(), target.ID, bulk); err != nil {
		t.Fatal(err)
	}
	late, err := f.st.AddRecord(context.Background(), store.Record{BaseID: target.ID})
	if err != nil {
		t.Fatal(err)
	}
	r := send(t, f.owner, "PATCH", path, map[string]any{"cells": map[string]any{linkKey: []int64{late.ID}}})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("late target write=%d", r.StatusCode)
	}
	r.Body.Close()
	assertLink(send(t, f.guest, "PATCH", path, map[string]any{"cells": map[string]any{textKey: "late-target"}}), "["+strconv.FormatInt(late.ID, 10)+"]")

	// A self-link can point to a different record, not just the response row.
	var self store.Field
	r = post(t, f.owner, f.path("/fields"), map[string]any{"name": "本表关联", "type": "link", "options": []string{strconv.FormatInt(f.base.ID, 10)}})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("self field=%d", r.StatusCode)
	}
	_ = json.NewDecoder(r.Body).Decode(&self)
	r.Body.Close()
	if len(rows) < 2 {
		t.Fatal("need second source record")
	}
	selfKey := strconv.FormatInt(self.ID, 10)
	selfID := rows[1].ID
	r = send(t, f.owner, "PATCH", path, map[string]any{"cells": map[string]any{selfKey: []int64{selfID}}})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("self link write=%d", r.StatusCode)
	}
	r.Body.Close()
	r = send(t, f.guest, "PATCH", path, map[string]any{"cells": map[string]any{textKey: "self-target"}})
	defer r.Body.Close()
	var selfResult store.Record
	if r.StatusCode != http.StatusOK {
		t.Fatalf("self result=%d", r.StatusCode)
	}
	if err := json.NewDecoder(r.Body).Decode(&selfResult); err != nil {
		t.Fatal(err)
	}
	if got := string(selfResult.Cells[selfKey]); got != "["+strconv.FormatInt(selfID, 10)+"]" {
		t.Fatalf("self link lost: %s", got)
	}
}

func TestRecordWriteResponseBeyondListLimitIsNotEmpty(t *testing.T) {
	f := newBaseChannelFixture(t)
	ctx := context.Background()
	fields, err := f.st.Fields(ctx, f.base.ID)
	if err != nil || len(fields) == 0 {
		t.Fatal(err)
	}
	textKey := strconv.FormatInt(fields[0].ID, 10)
	bulk := make([]store.Record, 10001)
	for i := range bulk {
		bulk[i] = store.Record{Cells: map[string]json.RawMessage{textKey: json.RawMessage(`"保留内容"`)}}
	}
	if err := f.st.AddRecordsBulk(ctx, f.base.ID, bulk); err != nil {
		t.Fatal(err)
	}
	rows, err := f.st.Records(ctx, f.base.ID)
	if err != nil || len(rows) <= 10000 {
		t.Fatalf("records=%d err=%v", len(rows), err)
	}
	rid := rows[len(rows)-1].ID
	var date store.Field
	r := post(t, f.owner, f.path("/fields"), map[string]any{"name": "日期", "type": "date"})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("field=%d", r.StatusCode)
	}
	_ = json.NewDecoder(r.Body).Decode(&date)
	r.Body.Close()
	key := strconv.FormatInt(date.ID, 10)
	r = send(t, f.guest, "PATCH", f.path("/records/")+strconv.FormatInt(rid, 10)+"/compare-cells", map[string]any{"expected": map[string]any{key: nil}, "cells": map[string]any{key: "2026-11-07"}})
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("status=%d", r.StatusCode)
	}
	var result store.Record
	if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.ID != rid || string(result.Cells[textKey]) != `"保留内容"` || string(result.Cells[key]) != `"2026-11-07"` {
		t.Fatalf("incomplete record response: %+v", result)
	}
}

func TestRecordWriteResponseRechecksTargetAfterCommit(t *testing.T) {
	var wrapper *revokeDuringLinkProjection
	f := newBaseChannelFixture(t, func(st store.Store) store.Store { wrapper = &revokeDuringLinkProjection{Store: st}; return wrapper })
	var target store.DocMeta
	r := post(t, f.owner, f.ts.URL+"/api/bases", nil)
	if err := json.NewDecoder(r.Body).Decode(&target); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	targetRows, err := f.st.Records(context.Background(), target.ID)
	if err != nil || len(targetRows) == 0 {
		t.Fatal(err)
	}
	var link store.Field
	r = post(t, f.owner, f.path("/fields"), map[string]any{"name": "关联", "type": "link", "options": []string{strconv.FormatInt(target.ID, 10)}})
	if err := json.NewDecoder(r.Body).Decode(&link); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	fields, err := f.st.Fields(context.Background(), f.base.ID)
	if err != nil || len(fields) == 0 {
		t.Fatal(err)
	}
	rows, err := f.st.Records(context.Background(), f.base.ID)
	if err != nil || len(rows) == 0 {
		t.Fatal(err)
	}
	rid, tid := rows[0].ID, targetRows[0].ID
	linkKey := strconv.FormatInt(link.ID, 10)
	textKey := strconv.FormatInt(fields[0].ID, 10)
	path := f.path("/records/") + strconv.FormatInt(rid, 10)
	r = send(t, f.owner, "PATCH", path, map[string]any{"cells": map[string]any{linkKey: []int64{tid}}})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("link %d", r.StatusCode)
	}
	r.Body.Close()
	if err := f.st.SetShare(context.Background(), target.ID, f.viewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	wrapper.mu.Lock()
	wrapper.target = target.ID
	wrapper.hook = func() { _ = wrapper.Store.SetShare(context.Background(), target.ID, f.viewer.ID, "") }
	wrapper.mu.Unlock()
	r = send(t, f.guest, "PATCH", path, map[string]any{"cells": map[string]any{textKey: "已提交"}})
	body, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != http.StatusForbidden && r.StatusCode != http.StatusConflict {
		t.Fatalf("status=%d body=%s", r.StatusCode, body)
	}
	if strings.Contains(string(body), `"`+linkKey+`":[`+strconv.FormatInt(tid, 10)+`]`) {
		t.Fatalf("revoked ID leaked: %s", body)
	}
	rows, err = f.st.Records(context.Background(), f.base.ID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, row := range rows {
		if row.ID == rid {
			found = string(row.Cells[textKey]) == `"已提交"`
		}
	}
	if !found {
		t.Fatal("test did not verify that the write committed before projection rejection")
	}
}
