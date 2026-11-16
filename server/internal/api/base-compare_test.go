package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"sync"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

// Revocation can occur after the HTTP handler's initial access check. The
// transaction must still refuse the change rather than relying on that check.
type revokeBeforeCompareStore struct {
	store.Store
	mu     sync.Mutex
	before func()
}

func (s *revokeBeforeCompareStore) CompareDateCells(ctx context.Context, guard store.BaseWriteGuard, baseID, recordID int64, expected, cells map[string]json.RawMessage) (store.Record, bool, error) {
	s.mu.Lock()
	fn := s.before
	s.before = nil
	s.mu.Unlock()
	if fn != nil {
		fn()
	}
	return s.Store.CompareDateCells(ctx, guard, baseID, recordID, expected, cells)
}

func TestCompareDateCellsHTTP(t *testing.T) {
	underlying := store.NewMemory()
	wrapped := &revokeBeforeCompareStore{Store: underlying}
	ts, owner := newTestServer(t, wrapped, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "compare-owner@example.test", "name": "Owner", "password": "password123"})
	jar, _ := cookiejar.New(nil)
	guest := &http.Client{Jar: jar}
	post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "compare-guest@example.test", "name": "Guest", "password": "password123"})
	var base store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/bases", nil).Body).Decode(&base)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(base.ID, 10)
	var start, end store.Field
	json.NewDecoder(post(t, owner, u+"/fields", map[string]string{"name": "开始", "type": "date"}).Body).Decode(&start)
	json.NewDecoder(post(t, owner, u+"/fields", map[string]string{"name": "结束", "type": "date"}).Body).Decode(&end)
	rows, err := underlying.Records(context.Background(), base.ID)
	if err != nil || len(rows) == 0 {
		t.Fatalf("rows=%v err=%v", rows, err)
	}
	rid := rows[0].ID
	a, b := strconv.FormatInt(start.ID, 10), strconv.FormatInt(end.ID, 10)
	path := u + "/records/" + strconv.FormatInt(rid, 10) + "/compare-cells"
	initial := map[string]any{"expected": map[string]any{a: nil, b: nil}, "cells": map[string]any{a: "2026-11-07", b: "2026-11-08"}}
	res := send(t, owner, "PATCH", path, initial)
	var record store.Record
	if res.StatusCode != http.StatusOK {
		t.Fatalf("initial status=%d", res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(&record); err != nil || string(record.Cells[a]) != `"2026-11-07"` {
		t.Fatalf("record=%+v err=%v", record, err)
	}
	if res := send(t, owner, "PATCH", path, initial); res.StatusCode != http.StatusConflict {
		t.Fatalf("stale status=%d", res.StatusCode)
	}
	if res := send(t, owner, "PATCH", path, map[string]any{"expected": map[string]any{a: "2026-11-07"}, "cells": map[string]any{a: "2026-02-30"}}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid date status=%d", res.StatusCode)
	}

	if err := underlying.SetShare(context.Background(), base.ID, 2, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	wrapped.mu.Lock()
	wrapped.before = func() {
		if err := underlying.SetShare(context.Background(), base.ID, 2, ""); err != nil {
			t.Error(err)
		}
	}
	wrapped.mu.Unlock()
	res = send(t, guest, "PATCH", path, map[string]any{"expected": map[string]any{a: "2026-11-07"}, "cells": map[string]any{a: "2026-11-09"}})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("revocation status=%d", res.StatusCode)
	}
	rows, _ = underlying.Records(context.Background(), base.ID)
	if string(rows[0].Cells[a]) != `"2026-11-07"` {
		t.Fatalf("revocation changed cells: %v", rows[0].Cells)
	}
}
