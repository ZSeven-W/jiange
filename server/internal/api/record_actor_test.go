package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

type actorHistory struct {
	Entries []struct {
		Op    string `json:"op"`
		Actor *struct {
			Kind string `json:"kind"`
			ID   int64  `json:"id"`
			Name string `json:"name"`
		} `json:"actor"`
	} `json:"entries"`
}

func TestRecordHistoryActor(t *testing.T) { checkRecordHistoryActor(t, newBaseSecurityFixture(t)) }

func TestPostgresRecordHistoryActor(t *testing.T) {
	checkRecordHistoryActor(t, newBaseSecurityFixtureWithStore(t, postgresBaseSecurityStore(t)))
}

func checkRecordHistoryActor(t *testing.T, f baseSecurityFixture) {
	statusID := strconv.FormatInt(f.status.ID, 10)
	rec := f.url + "/records/" + strconv.FormatInt(f.public.ID, 10)
	// the shared editor edits the owner's record
	if r := send(t, f.guest, "PATCH", rec, map[string]any{"cells": map[string]any{statusID: "公开-已改"}}); r.StatusCode != http.StatusOK {
		t.Fatalf("guest patch %d", r.StatusCode)
	}
	var h actorHistory
	json.NewDecoder(cGet(t, f.owner, rec+"/history").Body).Decode(&h)
	if len(h.Entries) != 2 {
		t.Fatalf("entries: %+v", h.Entries)
	}
	if a := h.Entries[0].Actor; h.Entries[0].Op != "update" || a == nil || a.Kind != "user" || a.Name != "Guest" {
		t.Fatalf("update actor should be Guest: %+v %+v", h.Entries[0], h.Entries[0].Actor)
	}
	if a := h.Entries[1].Actor; h.Entries[1].Op != "add" || a == nil || a.Name != "Owner" {
		t.Fatalf("create actor should be Owner: %+v", h.Entries[1])
	}

	// an anonymous public form submission is attributed to 表单提交 (kind form)
	var fv store.View
	json.NewDecoder(post(t, f.owner, f.url+"/views", map[string]any{"type": "form", "name": "收集", "config": map[string]any{"fields": []int64{f.status.ID}}}).Body).Decode(&fv)
	token := publishTestForm(t, f.owner, f.url, fv.ID)
	root := f.url[:strings.Index(f.url, "/api/")]
	res := post(t, &http.Client{}, root+"/api/forms/"+token, map[string]any{"cells": map[string]any{statusID: "表单来的"}})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("form submit %d", res.StatusCode)
	}
	var created store.Record
	var all struct{ Records []store.Record }
	json.NewDecoder(cGet(t, f.owner, f.url).Body).Decode(&all)
	for _, r := range all.Records {
		if string(r.Cells[statusID]) == `"表单来的"` {
			created = r
		}
	}
	if created.ID == 0 {
		t.Fatal("form record not found")
	}
	json.NewDecoder(cGet(t, f.owner, f.url+"/records/"+strconv.FormatInt(created.ID, 10)+"/history").Body).Decode(&h)
	if len(h.Entries) != 1 || h.Entries[0].Actor == nil || h.Entries[0].Actor.Kind != "form" {
		t.Fatalf("form entry actor: %+v", h.Entries)
	}
}
