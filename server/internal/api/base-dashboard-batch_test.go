package api

import (
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
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func runBaseDashboardBatchSuite(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	srv := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1,
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	newClient := func() *http.Client {
		j, _ := cookiejar.New(nil)
		return &http.Client{Jar: j}
	}
	cOwner := newClient()
	cEditor := newClient()
	cViewer := newClient()

	register := func(c *http.Client, email, name string) store.User {
		t.Helper()
		r := post(t, c, ts.URL+"/api/auth/register", map[string]string{
			"email": email, "name": name, "password": "password123",
		})
		defer r.Body.Close()
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("register %s: status=%d", email, r.StatusCode)
		}
		var out struct {
			User store.User `json:"user"`
		}
		if err := json.NewDecoder(r.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out.User
	}

	owner := register(cOwner, "bdb-owner@test.dev", "Owner")
	editor := register(cEditor, "bdb-editor@test.dev", "Editor")
	viewer := register(cViewer, "bdb-viewer@test.dev", "Viewer")

	doJSON := func(c *http.Client, method, path string, body any, extra map[string]string) (int, []byte) {
		t.Helper()
		var rdr io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rdr = bytesReader(b)
		}
		req, err := http.NewRequest(method, ts.URL+path, rdr)
		if err != nil {
			t.Fatal(err)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		for k, v := range extra {
			req.Header.Set(k, v)
		}
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		return res.StatusCode, raw
	}

	ownerHdr := map[string]string{"X-Jiange-User-Id": strconv.FormatInt(owner.ID, 10)}

	// Create Base node via drive/nodes
	code, raw := doJSON(cOwner, http.MethodPost, "/api/drive/nodes", map[string]any{
		"kind": "base", "title": "项目数据中台", "scope": "personal",
	}, ownerHdr)
	if code != http.StatusCreated {
		t.Fatalf("create base: %d %s", code, string(raw))
	}
	var entry store.DriveEntry
	_ = json.Unmarshal(raw, &entry)
	baseID := entry.ID
	bPath := fmt.Sprintf("/api/bases/%d", baseID)

	if err := st.SetShare(ctx, baseID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, baseID, viewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}

	// Inspect base fields & initial records
	getBase := func(c *http.Client) struct {
		Tables  []store.BaseTable `json:"tables"`
		Fields  []store.Field     `json:"fields"`
		Records []store.Record    `json:"records"`
		Views   []store.View      `json:"views"`
	} {
		t.Helper()
		stCode, body := doJSON(c, http.MethodGet, bPath, nil, nil)
		if stCode != http.StatusOK {
			t.Fatalf("get base: %d %s", stCode, string(body))
		}
		var out struct {
			Tables  []store.BaseTable `json:"tables"`
			Fields  []store.Field     `json:"fields"`
			Records []store.Record    `json:"records"`
			Views   []store.View      `json:"views"`
		}
		_ = json.Unmarshal(body, &out)
		return out
	}

	snap := getBase(cOwner)
	if len(snap.Fields) == 0 || len(snap.Records) < 3 {
		t.Fatalf("unexpected initial base snapshot: fields=%d records=%d", len(snap.Fields), len(snap.Records))
	}
	primaryFID := snap.Fields[0].ID
	primaryKey := strconv.FormatInt(primaryFID, 10)
	tableID := snap.Tables[0].ID

	// Add a number field and a select field
	code, raw = doJSON(cOwner, http.MethodPost, bPath+"/fields", map[string]any{
		"tableId": tableID, "name": "预算", "type": "number",
	}, nil)
	if code != http.StatusCreated {
		t.Fatalf("add number field: %d %s", code, string(raw))
	}
	var numField store.Field
	_ = json.Unmarshal(raw, &numField)

	code, raw = doJSON(cOwner, http.MethodPost, bPath+"/fields", map[string]any{
		"tableId": tableID, "name": "状态", "type": "select", "options": []string{"进行中", "已完成"},
	}, nil)
	if code != http.StatusCreated {
		t.Fatalf("add select field: %d %s", code, string(raw))
	}
	var selField store.Field
	_ = json.Unmarshal(raw, &selField)

	// 1. Atomic Batch Update (with expected precondition + all-or-nothing rollback)
	rec0, rec1 := snap.Records[0], snap.Records[1]
	code, raw = doJSON(cOwner, http.MethodPost, bPath+"/records/batch-update", map[string]any{
		"updates": []map[string]any{
			{"id": rec0.ID, "cells": map[string]any{primaryKey: "任务 A", strconv.FormatInt(numField.ID, 10): 120, strconv.FormatInt(selField.ID, 10): "进行中"}},
			{"id": rec1.ID, "cells": map[string]any{primaryKey: "任务 B", strconv.FormatInt(numField.ID, 10): 80, strconv.FormatInt(selField.ID, 10): "已完成"}},
		},
	}, nil)
	if code != http.StatusOK {
		t.Fatalf("batch-update initial: %d %s", code, string(raw))
	}

	// Failing conditional batch-update: rec0 matches expected, rec1 mismatches -> ZERO rows updated!
	code, raw = doJSON(cOwner, http.MethodPost, bPath+"/records/batch-update", map[string]any{
		"updates": []map[string]any{
			{"id": rec0.ID, "expected": map[string]any{primaryKey: "任务 A"}, "cells": map[string]any{primaryKey: "不应写入"}},
			{"id": rec1.ID, "expected": map[string]any{primaryKey: "错误旧值"}, "cells": map[string]any{primaryKey: "也不应写入"}},
		},
	}, nil)
	if code != http.StatusConflict {
		t.Fatalf("conditional batch-update mismatch: expected 409, got %d %s", code, string(raw))
	}
	snapCheck := getBase(cOwner)
	for _, r := range snapCheck.Records {
		if r.ID == rec0.ID && string(r.Cells[primaryKey]) != `"任务 A"` {
			t.Fatalf("batch-update was NOT atomic! rec0 mutated to %s", string(r.Cells[primaryKey]))
		}
	}

	// 2. Atomic Batch Delete (all-or-nothing on missing ID, then real delete + atomic restore!)
	initialCount := len(snapCheck.Records)
	code, raw = doJSON(cOwner, http.MethodPost, bPath+"/records/batch-delete", map[string]any{
		"ids": []int64{rec0.ID, 99999999},
	}, nil)
	if code != http.StatusNotFound {
		t.Fatalf("batch-delete with missing id: expected 404, got %d %s", code, string(raw))
	}
	if got := len(getBase(cOwner).Records); got != initialCount {
		t.Fatalf("batch-delete partial delete occurred: had %d now %d", initialCount, got)
	}

	// Valid atomic batch delete of rec0 & rec1
	code, raw = doJSON(cOwner, http.MethodPost, bPath+"/records/batch-delete", map[string]any{
		"ids": []int64{rec0.ID, rec1.ID},
	}, nil)
	if code != http.StatusOK {
		t.Fatalf("batch-delete valid: %d %s", code, string(raw))
	}
	var delOut struct {
		Deleted []store.Record `json:"deleted"`
	}
	_ = json.Unmarshal(raw, &delOut)
	if len(delOut.Deleted) != 2 {
		t.Fatalf("expected 2 deleted snapshots, got %d", len(delOut.Deleted))
	}
	if got := len(getBase(cOwner).Records); got != initialCount-2 {
		t.Fatalf("after batch-delete: expected %d records, got %d", initialCount-2, got)
	}

	// Atomic Batch Restore (Undo of batch delete!)
	restoreInputs := make([]map[string]any, 0, len(delOut.Deleted))
	for _, dr := range delOut.Deleted {
		restoreInputs = append(restoreInputs, map[string]any{
			"tableId":  dr.TableID,
			"position": dr.Position,
			"cells":    dr.Cells,
		})
	}
	code, raw = doJSON(cOwner, http.MethodPost, bPath+"/records/batch-restore", map[string]any{
		"records": restoreInputs,
	}, nil)
	if code != http.StatusCreated {
		t.Fatalf("batch-restore: %d %s", code, string(raw))
	}
	var restOut struct {
		Records []store.Record `json:"records"`
	}
	_ = json.Unmarshal(raw, &restOut)
	if len(restOut.Records) != 2 || string(restOut.Records[0].Cells[primaryKey]) != `"任务 A"` || string(restOut.Records[1].Cells[primaryKey]) != `"任务 B"` {
		t.Fatalf("restored records mismatch: %+v", restOut.Records)
	}
	if got := len(getBase(cOwner).Records); got != initialCount {
		t.Fatalf("after batch-restore: expected %d records, got %d", initialCount, got)
	}

	// 3. Dashboards CRUD & optimistic revision + permission enforcement
	// Viewer cannot create dashboard (403)
	code, _ = doJSON(cViewer, http.MethodPost, bPath+"/dashboards", map[string]any{"name": "非法仪表盘", "widgets": []any{}}, nil)
	if code != http.StatusForbidden {
		t.Fatalf("viewer create dashboard: expected 403, got %d", code)
	}

	// Owner creates dashboard with all 6 widget types
	widgets := []store.DashboardWidget{
		{ID: "w1", Type: "metric", Title: "总预算", TableID: tableID, Span: 1, Metric: "sum", ValueFieldID: numField.ID},
		{ID: "w2", Type: "bar", Title: "按状态柱状图", TableID: tableID, Span: 1, GroupFieldID: selField.ID, Metric: "sum", ValueFieldID: numField.ID},
		{ID: "w3", Type: "pie", Title: "状态占比", TableID: tableID, Span: 1, GroupFieldID: selField.ID, Metric: "count"},
		{ID: "w4", Type: "line", Title: "预算趋势", TableID: tableID, Span: 2, GroupFieldID: selField.ID, Metric: "avg", ValueFieldID: numField.ID},
		{ID: "w5", Type: "horizontal_bar", Title: "排行条形图", TableID: tableID, Span: 1, GroupFieldID: selField.ID, Metric: "count"},
		{ID: "w6", Type: "pivot", Title: "汇总明细表", TableID: tableID, Span: 2, GroupFieldID: selField.ID, Metric: "sum", ValueFieldID: numField.ID},
	}
	code, raw = doJSON(cOwner, http.MethodPost, bPath+"/dashboards", map[string]any{
		"name":    "项目经营总览",
		"widgets": widgets,
	}, nil)
	if code != http.StatusCreated {
		t.Fatalf("create dashboard: %d %s", code, string(raw))
	}
	var dbCreated struct {
		Dashboard store.BaseDashboard `json:"dashboard"`
	}
	_ = json.Unmarshal(raw, &dbCreated)
	if dbCreated.Dashboard.ID <= 0 || len(dbCreated.Dashboard.Widgets) != 6 || dbCreated.Dashboard.Revision != 1 {
		t.Fatalf("unexpected created dashboard: %+v", dbCreated.Dashboard)
	}
	didPath := fmt.Sprintf("%s/dashboards/%d", bPath, dbCreated.Dashboard.ID)

	// Viewer CAN list dashboards (200)
	code, raw = doJSON(cViewer, http.MethodGet, bPath+"/dashboards", nil, nil)
	if code != http.StatusOK {
		t.Fatalf("viewer list dashboards: %d %s", code, string(raw))
	}
	var dbList struct {
		Dashboards []store.BaseDashboard `json:"dashboards"`
	}
	_ = json.Unmarshal(raw, &dbList)
	if len(dbList.Dashboards) != 1 || len(dbList.Dashboards[0].Widgets) != 6 {
		t.Fatalf("unexpected listed dashboards: %+v", dbList.Dashboards)
	}

	// Optimistic lock: stale revision 99 -> 409; matching revision 1 -> 200 rev 2
	code, _ = doJSON(cEditor, http.MethodPatch, didPath, map[string]any{
		"name": "并发冲突名称", "expectedRevision": 99,
	}, nil)
	if code != http.StatusConflict {
		t.Fatalf("stale dashboard patch: expected 409, got %d", code)
	}
	code, raw = doJSON(cEditor, http.MethodPatch, didPath, map[string]any{
		"name": "Q4 项目经营总览", "expectedRevision": 1,
	}, nil)
	if code != http.StatusOK {
		t.Fatalf("valid dashboard patch: %d %s", code, string(raw))
	}
	var dbUpdated struct {
		Dashboard store.BaseDashboard `json:"dashboard"`
	}
	_ = json.Unmarshal(raw, &dbUpdated)
	if dbUpdated.Dashboard.Name != "Q4 项目经营总览" || dbUpdated.Dashboard.Revision != 2 {
		t.Fatalf("unexpected updated dashboard: %+v", dbUpdated.Dashboard)
	}

	// 4. Duplicate Base -> cloned dashboards have remapped tableId & fieldIds!
	code, raw = doJSON(cOwner, http.MethodPost, fmt.Sprintf("/api/docs/%d/account-duplicate", baseID), nil, ownerHdr)
	if code != http.StatusCreated {
		t.Fatalf("duplicate base: %d %s", code, string(raw))
	}
	var dupBase store.DocMeta
	_ = json.Unmarshal(raw, &dupBase)
	code, raw = doJSON(cOwner, http.MethodGet, fmt.Sprintf("/api/bases/%d/dashboards", dupBase.ID), nil, nil)
	if code != http.StatusOK {
		t.Fatalf("get dup base dashboards: %d %s", code, string(raw))
	}
	dbList.Dashboards = nil
	_ = json.Unmarshal(raw, &dbList)
	if len(dbList.Dashboards) != 1 || len(dbList.Dashboards[0].Widgets) != 6 {
		t.Fatalf("dup base lost dashboards: %+v", dbList.Dashboards)
	}
	if dbList.Dashboards[0].Widgets[0].ValueFieldID == numField.ID || dbList.Dashboards[0].Widgets[0].ValueFieldID == 0 {
		t.Fatalf("dup base dashboard valueFieldId was not remapped: orig=%d dup=%d", numField.ID, dbList.Dashboards[0].Widgets[0].ValueFieldID)
	}

	// 5. Locked view (permission view) blocks non-manager editor from batch-delete & dashboard edits (403)
	viewID := snap.Views[0].ID
	code, raw = doJSON(cOwner, http.MethodPatch, fmt.Sprintf("%s/views/%d", bPath, viewID), map[string]any{
		"config": map[string]any{"locked": true},
	}, nil)
	if code != http.StatusOK {
		t.Fatalf("lock view: %d %s", code, string(raw))
	}
	code, _ = doJSON(cEditor, http.MethodPost, bPath+"/records/batch-delete", map[string]any{
		"ids": []int64{restOut.Records[0].ID},
	}, nil)
	if code != http.StatusForbidden {
		t.Fatalf("editor batch-delete under locked view: expected 403, got %d", code)
	}
	code, _ = doJSON(cEditor, http.MethodPost, bPath+"/dashboards", map[string]any{
		"name": "被阻断仪表盘", "widgets": []any{},
	}, nil)
	if code != http.StatusForbidden {
		t.Fatalf("editor create dashboard under locked view: expected 403, got %d", code)
	}

	// Owner can still delete dashboard (204)
	code, _ = doJSON(cOwner, http.MethodDelete, didPath, nil, nil)
	if code != http.StatusNoContent {
		t.Fatalf("owner delete dashboard: expected 204, got %d", code)
	}
}

func TestBaseDashboardBatchMemory(t *testing.T) {
	runBaseDashboardBatchSuite(t, store.NewMemory())
}

func TestBaseDashboardBatchPostgres(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("jiange_base_db_%d", time.Now().UnixNano())}.Sanitize()
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
		admin.Close()
	}()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.ConnConfig.RuntimeParams["application_name"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	runBaseDashboardBatchSuite(t, &store.Postgres{Pool: pool})
}
