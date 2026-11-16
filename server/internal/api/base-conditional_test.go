package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

// Undo/redo writes are conditional: they apply only while the cells still hold
// the values the client last wrote, so a collaborator's newer edit is never
// silently overwritten.
func TestConditionalRecordWritesHTTP(t *testing.T) {
	mem := store.NewMemory()
	ts, owner := newTestServer(t, mem, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "undo-owner@example.test", "name": "Owner", "password": "password123"})
	var base store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/bases", nil).Body).Decode(&base)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(base.ID, 10)
	var num store.Field
	json.NewDecoder(post(t, owner, u+"/fields", map[string]string{"name": "数量", "type": "number"}).Body).Decode(&num)
	rows, err := mem.Records(context.Background(), base.ID)
	if err != nil || len(rows) == 0 {
		t.Fatalf("rows=%v err=%v", rows, err)
	}
	title := ""
	for _, f := range mustFields(t, mem, base.ID) {
		if f.Type == "text" {
			title = strconv.FormatInt(f.ID, 10)
			break
		}
	}
	n := strconv.FormatInt(num.ID, 10)
	path := u + "/records/" + strconv.FormatInt(rows[0].ID, 10)
	if res := send(t, owner, "PATCH", path, map[string]any{"cells": map[string]any{n: 5}}); res.StatusCode != http.StatusOK {
		t.Fatalf("plain write status=%d", res.StatusCode)
	}
	// Undo 5 -> empty succeeds while the cell is still 5 (5.0 compares equal).
	if res := send(t, owner, "PATCH", path, map[string]any{"expected": map[string]any{n: 5.0}, "cells": map[string]any{n: nil}}); res.StatusCode != http.StatusOK {
		t.Fatalf("undo status=%d", res.StatusCode)
	}
	// A collaborator writes 7; redo expecting empty must be refused untouched.
	send(t, owner, "PATCH", path, map[string]any{"cells": map[string]any{n: 7}})
	res := send(t, owner, "PATCH", path, map[string]any{"expected": map[string]any{n: nil}, "cells": map[string]any{n: 5}})
	var body struct {
		Code string `json:"error"`
	}
	json.NewDecoder(res.Body).Decode(&body)
	if res.StatusCode != http.StatusConflict || body.Code != "cells_changed" {
		t.Fatalf("stale redo status=%d code=%q", res.StatusCode, body.Code)
	}
	if got := mustRecord(t, mem, base.ID, rows[0].ID).Cells[n]; string(got) != "7" {
		t.Fatalf("cell after refused redo=%s", got)
	}
	// Expected keys must be among the written cells (no probing other cells).
	if title != "" {
		if res := send(t, owner, "PATCH", path, map[string]any{"expected": map[string]any{title: "x"}, "cells": map[string]any{n: 1}}); res.StatusCode != http.StatusBadRequest {
			t.Fatalf("probe status=%d", res.StatusCode)
		}
	}
	// Undoing a created record deletes it only while it holds exactly our cells.
	var created store.Record
	json.NewDecoder(post(t, owner, u+"/records", map[string]any{"cells": map[string]any{n: 3}}).Body).Decode(&created)
	cpath := u + "/records/" + strconv.FormatInt(created.ID, 10)
	send(t, owner, "PATCH", cpath, map[string]any{"cells": map[string]any{title: "别人填写"}})
	if res := send(t, owner, "DELETE", cpath, map[string]any{"expected": map[string]any{n: 3}, "exact": true}); res.StatusCode != http.StatusConflict {
		t.Fatalf("exact delete with foreign content status=%d", res.StatusCode)
	}
	send(t, owner, "PATCH", cpath, map[string]any{"cells": map[string]any{title: nil}})
	if res := send(t, owner, "DELETE", cpath, map[string]any{"expected": map[string]any{n: 3}, "exact": true}); res.StatusCode != http.StatusNoContent {
		t.Fatalf("exact delete status=%d", res.StatusCode)
	}
	if res := send(t, owner, "POST", u+"/records", map[string]any{"cells": map[string]any{}, "expected": map[string]any{n: 1}}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected on add status=%d", res.StatusCode)
	}
}

func mustFields(t *testing.T, s store.Store, baseID int64) []store.Field {
	t.Helper()
	fields, err := s.Fields(context.Background(), baseID)
	if err != nil {
		t.Fatal(err)
	}
	return fields
}

func mustRecord(t *testing.T, s store.Store, baseID, rid int64) store.Record {
	t.Helper()
	rows, err := s.Records(context.Background(), baseID)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		if r.ID == rid {
			return r
		}
	}
	t.Fatalf("record %d missing", rid)
	return store.Record{}
}
