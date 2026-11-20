package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func runBaseScheduleUndoAPISuite(t *testing.T, st store.Store) {
	t.Helper()
	srv := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1,
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	doReq := func(method, path string, body any) (int, []byte) {
		t.Helper()
		var rd io.Reader
		if body != nil {
			b, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			rd = bytes.NewReader(b)
		}
		req, err := http.NewRequest(method, ts.URL+path, rd)
		if err != nil {
			t.Fatal(err)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, raw
	}

	email := fmt.Sprintf("sched-undo-%d@example.test", time.Now().UnixNano())
	if code, raw := doReq(http.MethodPost, "/api/auth/register", map[string]string{
		"email": email, "name": "Scheduler", "password": "password123",
	}); code != http.StatusCreated {
		t.Fatalf("register: %d %s", code, raw)
	}
	code, raw := doReq(http.MethodPost, "/api/bases", map[string]any{"title": "排期与结构撤销测试"})
	if code != http.StatusCreated {
		t.Fatalf("create base: %d %s", code, raw)
	}
	var base struct{ ID int64 `json:"id"` }
	_ = json.Unmarshal(raw, &base)
	bPath := fmt.Sprintf("/api/bases/%d", base.ID)

	// Add start & end date fields and a notes field.
	var startField, endField, noteField store.Field
	code, raw = doReq(http.MethodPost, bPath+"/fields", map[string]any{"name": "开始时间", "type": "date"})
	if code != http.StatusCreated {
		t.Fatalf("add start field: %d %s", code, raw)
	}
	_ = json.Unmarshal(raw, &startField)

	code, raw = doReq(http.MethodPost, bPath+"/fields", map[string]any{"name": "结束时间", "type": "date"})
	if code != http.StatusCreated {
		t.Fatalf("add end field: %d %s", code, raw)
	}
	_ = json.Unmarshal(raw, &endField)

	code, raw = doReq(http.MethodPost, bPath+"/fields", map[string]any{"name": "里程碑备注", "type": "text"})
	if code != http.StatusCreated {
		t.Fatalf("add note field: %d %s", code, raw)
	}
	_ = json.Unmarshal(raw, &noteField)

	// Add a record with hourly schedule timestamps and note text.
	sk, ek, nk := strconv.FormatInt(startField.ID, 10), strconv.FormatInt(endField.ID, 10), strconv.FormatInt(noteField.ID, 10)
	code, raw = doReq(http.MethodPost, bPath+"/records", map[string]any{
		"cells": map[string]any{
			sk: "2026-11-20 09:00",
			ek: "2026-11-20 10:30",
			nk: "需求评审会",
		},
	})
	if code != http.StatusCreated {
		t.Fatalf("add timed record: %d %s", code, raw)
	}
	var rec struct {
		ID    int64                      `json:"id"`
		Cells map[string]json.RawMessage `json:"cells"`
	}
	_ = json.Unmarshal(raw, &rec)

	// Reschedule via compare-cells to a new hourly slot.
	code, raw = doReq(http.MethodPatch, fmt.Sprintf("%s/records/%d/compare-cells", bPath, rec.ID), map[string]any{
		"expected": map[string]any{sk: "2026-11-20 09:00", ek: "2026-11-20 10:30"},
		"cells":    map[string]any{sk: "2026-11-20 13:30", ek: "2026-11-20 15:00"},
	})
	if code != http.StatusOK {
		t.Fatalf("compare hourly cells: %d %s", code, raw)
	}

	// Create Calendar view and persist both group (startField) & endField in view config.
	code, raw = doReq(http.MethodPost, bPath+"/views", map[string]any{
		"type": "calendar",
		"name": "小时排程日历",
		"config": map[string]any{
			"group":    startField.ID,
			"endField": endField.ID,
		},
	})
	if code != http.StatusCreated {
		t.Fatalf("add calendar view with endField: %d %s", code, raw)
	}
	// Reject invalid unknown endField.
	if code, _ := doReq(http.MethodPost, bPath+"/views", map[string]any{
		"type":   "gantt",
		"name":   "非法甘特",
		"config": map[string]any{"group": startField.ID, "endField": 999999},
	}); code != http.StatusBadRequest && code != http.StatusConflict {
		t.Fatalf("expected 400/409 for unknown endField, got %d", code)
	}

	// Delete noteField and restore it atomically via /fields/restore.
	if code, raw = doReq(http.MethodDelete, fmt.Sprintf("%s/fields/%d", bPath, noteField.ID), nil); code != http.StatusNoContent {
		t.Fatalf("delete field: %d %s", code, raw)
	}
	// Reject bad cell type on restore.
	if code, _ = doReq(http.MethodPost, bPath+"/fields/restore", map[string]any{
		"field": map[string]any{
			"tableId":  noteField.TableID,
			"name":     "里程碑备注",
			"type":     "number",
			"position": noteField.Position,
		},
		"cells": []map[string]any{{"recordId": rec.ID, "value": "not-a-number"}},
	}); code != http.StatusBadRequest {
		t.Fatalf("expected 400 on mismatched restored cell value, got %d", code)
	}
	// Valid atomic restore brings back schema + cell values!
	code, raw = doReq(http.MethodPost, bPath+"/fields/restore", map[string]any{
		"field": map[string]any{
			"tableId":  noteField.TableID,
			"name":     noteField.Name,
			"type":     noteField.Type,
			"position": noteField.Position,
		},
		"cells": []map[string]any{{"recordId": rec.ID, "value": "需求评审会"}},
	})
	if code != http.StatusCreated {
		t.Fatalf("restore field: %d %s", code, raw)
	}
	var restored struct {
		Field         store.Field `json:"field"`
		RestoredCells int         `json:"restoredCells"`
	}
	_ = json.Unmarshal(raw, &restored)
	if restored.Field.ID == 0 || restored.RestoredCells != 1 {
		t.Fatalf("unexpected restore response: %+v", restored)
	}
	// Verify snapshot contains the restored field AND restored cell text.
	code, raw = doReq(http.MethodGet, bPath, nil)
	if code != http.StatusOK {
		t.Fatalf("get base: %d %s", code, raw)
	}
	var snap struct {
		Records []struct {
			ID    int64                      `json:"id"`
			Cells map[string]json.RawMessage `json:"cells"`
		} `json:"records"`
	}
	_ = json.Unmarshal(raw, &snap)
	foundText := ""
	for _, r := range snap.Records {
		if r.ID == rec.ID {
			foundText = string(r.Cells[strconv.FormatInt(restored.Field.ID, 10)])
		}
	}
	if foundText != `"需求评审会"` {
		t.Fatalf("expected restored cell text \"需求评审会\", got %q", foundText)
	}
}

func TestMemoryBaseScheduleUndoAPI(t *testing.T) {
	runBaseScheduleUndoAPISuite(t, store.NewMemory())
}

func TestPostgresBaseScheduleUndoAPI(t *testing.T) {
	dsn := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	st, err := store.NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if _, err := migrate.Up(ctx, st.Pool); err != nil {
		t.Fatal(err)
	}
	runBaseScheduleUndoAPISuite(t, st)
}
