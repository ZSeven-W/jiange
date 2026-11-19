package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

type mtTestClient struct {
	baseURL string
	client  *http.Client
	userID  int64
	wsID    int64
}

func newMTTestServer(t *testing.T) (*httptest.Server, *Server) {
	t.Helper()
	st := store.NewMemory()
	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts, s
}

func signupMT(t *testing.T, ts *httptest.Server, email, name string) *mtTestClient {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	c := &mtTestClient{baseURL: ts.URL, client: &http.Client{Jar: jar}}
	res := c.mustJSON(t, "POST", "/api/auth/register", map[string]any{
		"email":    email,
		"name":     name,
		"password": "password123",
	})
	c.userID = int64(res["user"].(map[string]any)["id"].(float64))
	me := c.mustJSON(t, "GET", "/api/me", nil)
	ws := me["workspaces"].([]any)[0].(map[string]any)
	c.wsID = int64(ws["id"].(float64))
	return c
}

func (c *mtTestClient) do(t *testing.T, method, path string, body any) *http.Response {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.baseURL+path, r)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func (c *mtTestClient) mustJSON(t *testing.T, method, path string, body any) map[string]any {
	t.Helper()
	resp := c.do(t, method, path, body)
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		t.Fatalf("%s %s status=%d body=%s", method, path, resp.StatusCode, string(raw))
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("%s %s decode: %v body=%s", method, path, err, string(raw))
	}
	return out
}

func TestBaseMultiTableCRUDAndCrossTableLink(t *testing.T) {
	ts, _ := newMTTestServer(t)
	alice := signupMT(t, ts, "alice-mt@test.io", "Alice")

	base := alice.mustJSON(t, "POST", "/api/bases", map[string]any{
		"workspaceId": alice.wsID,
		"title":       "项目管理系统",
	})
	baseID := int64(base["id"].(float64))

	snap1 := alice.mustJSON(t, "GET", fmt.Sprintf("/api/bases/%d", baseID), nil)
	tables := snap1["tables"].([]any)
	if len(tables) != 1 {
		t.Fatalf("expected 1 default table, got %d", len(tables))
	}
	defaultTableID := int64(tables[0].(map[string]any)["id"].(float64))
	if int64(snap1["activeTableId"].(float64)) != defaultTableID {
		t.Fatalf("activeTableId=%v want %d", snap1["activeTableId"], defaultTableID)
	}

	// Deleting the default table must be rejected with 409.
	if resp := alice.do(t, "DELETE", fmt.Sprintf("/api/bases/%d/tables/%d", baseID, defaultTableID), nil); resp.StatusCode != http.StatusConflict {
		t.Fatalf("delete default table status=%d want 409", resp.StatusCode)
	}

	// Rename default table to "项目列表".
	renamed := alice.mustJSON(t, "PATCH", fmt.Sprintf("/api/bases/%d/tables/%d", baseID, defaultTableID), map[string]any{"name": "项目列表"})
	if renamed["name"] != "项目列表" {
		t.Fatalf("renamed=%v", renamed["name"])
	}

	// Create a second table "任务清单".
	taskTbl := alice.mustJSON(t, "POST", fmt.Sprintf("/api/bases/%d/tables", baseID), map[string]any{"name": "任务清单"})
	taskTableID := int64(taskTbl["id"].(float64))
	if taskTableID == defaultTableID {
		t.Fatalf("expected distinct table id")
	}

	// Table 2 has its own independent primary field, view, and 5 empty rows.
	snap2 := alice.mustJSON(t, "GET", fmt.Sprintf("/api/bases/%d?tableId=%d", baseID, taskTableID), nil)
	if int64(snap2["activeTableId"].(float64)) != taskTableID {
		t.Fatalf("activeTableId=%v want %d", snap2["activeTableId"], taskTableID)
	}
	t2Fields := snap2["fields"].([]any)
	t2Records := snap2["records"].([]any)
	if len(t2Fields) != 1 || len(t2Records) != 5 {
		t.Fatalf("expected 1 field & 5 records on table 2, got %d & %d", len(t2Fields), len(t2Records))
	}
	t1Fields := snap1["fields"].([]any)
	t1PrimaryID := int64(t1Fields[0].(map[string]any)["id"].(float64))
	t2PrimaryID := int64(t2Fields[0].(map[string]any)["id"].(float64))
	if t1PrimaryID == t2PrimaryID {
		t.Fatalf("table 1 and table 2 should have separate primary fields")
	}

	// Populate a project record in Table 1.
	projRec := alice.mustJSON(t, "POST", fmt.Sprintf("/api/bases/%d/records", baseID), map[string]any{
		"tableId": defaultTableID,
		"cells":   map[string]any{fmt.Sprint(t1PrimaryID): "飞书对齐专项"},
	})
	projRecID := int64(projRec["id"].(float64))

	// Create a same-base cross-table link field in Table 2 pointing to Table 1.
	linkField := alice.mustJSON(t, "POST", fmt.Sprintf("/api/bases/%d/fields", baseID), map[string]any{
		"tableId":       taskTableID,
		"name":          "所属项目",
		"type":          "link",
		"options":       []string{fmt.Sprint(baseID)},
		"targetTableId": defaultTableID,
	})
	linkFieldID := int64(linkField["id"].(float64))

	// Table 1 should now have an auto-created reciprocal link field named "任务清单".
	snap1After := alice.mustJSON(t, "GET", fmt.Sprintf("/api/bases/%d?tableId=%d", baseID, defaultTableID), nil)
	foundReciprocal := false
	for _, raw := range snap1After["fields"].([]any) {
		f := raw.(map[string]any)
		if f["type"] == "link" && f["name"] == "任务清单" {
			foundReciprocal = true
		}
	}
	if !foundReciprocal {
		t.Fatalf("expected reciprocal link field '任务清单' on table 1, got %v", snap1After["fields"])
	}

	// Add a task record in Table 2 linked to the project record in Table 1.
	alice.mustJSON(t, "POST", fmt.Sprintf("/api/bases/%d/records", baseID), map[string]any{
		"tableId": taskTableID,
		"cells": map[string]any{
			fmt.Sprint(t2PrimaryID): "完成多数据表",
			fmt.Sprint(linkFieldID): []int64{projRecID},
		},
	})

	// Reading Table 2 must expand the linked record title from Table 1.
	snap2Linked := alice.mustJSON(t, "GET", fmt.Sprintf("/api/bases/%d?tableId=%d", baseID, taskTableID), nil)
	expansions := snap2Linked["expansions"].(map[string]any)
	titles, ok := expansions[fmt.Sprintf("%d:titles", linkFieldID)].(map[string]any)
	if !ok {
		t.Fatalf("missing link titles expansion for field %d: %v", linkFieldID, expansions)
	}
	if titles[fmt.Sprint(projRecID)] != "飞书对齐专项" {
		t.Fatalf("expected linked project title '飞书对齐专项', got %v", titles)
	}

	// Export CSV for Table 2 only includes Table 2's rows and columns.
	resp := alice.do(t, "GET", fmt.Sprintf("/api/bases/%d/export?tableId=%d", baseID, taskTableID), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("export table 2 status=%d", resp.StatusCode)
	}
	var csvBuf bytes.Buffer
	_, _ = csvBuf.ReadFrom(resp.Body)
	resp.Body.Close()
	if !strings.Contains(csvBuf.String(), "完成多数据表") || strings.Contains(csvBuf.String(), "飞书对齐专项") {
		t.Fatalf("unexpected table 2 csv export: %s", csvBuf.String())
	}

	// Reorder tables: put Table 2 first.
	reordered := alice.mustJSON(t, "POST", fmt.Sprintf("/api/bases/%d/tables/reorder", baseID), map[string]any{
		"ids": []int64{taskTableID, defaultTableID},
	})
	reorderedTables := reordered["tables"].([]any)
	if int64(reorderedTables[0].(map[string]any)["id"].(float64)) != taskTableID {
		t.Fatalf("reorder did not persist: %v", reorderedTables)
	}

	// Delete non-default table 2 succeeds with 204.
	if resp := alice.do(t, "DELETE", fmt.Sprintf("/api/bases/%d/tables/%d", baseID, taskTableID), nil); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete table 2 status=%d want 204", resp.StatusCode)
	}
}

func TestBaseViewConfigLockAndPersonalViews(t *testing.T) {
	ts, _ := newMTTestServer(t)
	alice := signupMT(t, ts, "alice-vl@test.io", "Alice")
	bob := signupMT(t, ts, "bob-vl@test.io", "Bob")

	base := alice.mustJSON(t, "POST", "/api/bases", map[string]any{
		"workspaceId": alice.wsID,
		"title":       "视图锁与个人视图测试",
	})
	baseID := int64(base["id"].(float64))

	// Share base to Bob with edit role.
	alice.mustJSON(t, "PUT", fmt.Sprintf("/api/docs/%d/shares", baseID), map[string]any{
		"email": "bob-vl@test.io",
		"role":  "edit",
	})

	snap := alice.mustJSON(t, "GET", fmt.Sprintf("/api/bases/%d", baseID), nil)
	defaultViewID := int64(snap["views"].([]any)[0].(map[string]any)["id"].(float64))
	primaryFieldID := int64(snap["fields"].([]any)[0].(map[string]any)["id"].(float64))

	// Alice (manage) enables View Config Lock (configLocked: true), NOT data-access locked.
	lockedView := alice.mustJSON(t, "PATCH", fmt.Sprintf("/api/bases/%d/views/%d", baseID, defaultViewID), map[string]any{
		"config": map[string]any{"configLocked": true},
	})
	var cfg map[string]any
	cfgBytes, _ := json.Marshal(lockedView["config"])
	_ = json.Unmarshal(cfgBytes, &cfg)
	if cfg["configLocked"] != true {
		t.Fatalf("expected configLocked=true, got %v", lockedView["config"])
	}

	// Bob (edit) sees writeRestricted == false and CAN still add records!
	bobSnap := bob.mustJSON(t, "GET", fmt.Sprintf("/api/bases/%d", baseID), nil)
	if bobSnap["writeRestricted"] != false {
		t.Fatalf("configLocked must NOT set writeRestricted=true; got %v", bobSnap["writeRestricted"])
	}
	rec := bob.mustJSON(t, "POST", fmt.Sprintf("/api/bases/%d/records", baseID), map[string]any{
		"cells": map[string]any{fmt.Sprint(primaryFieldID): "编辑者正常写入"},
	})
	if rec["id"] == nil {
		t.Fatalf("editor should be able to write records under configLocked view")
	}

	// Bob (edit) CANNOT patch or rename the configLocked shared view (403).
	if resp := bob.do(t, "PATCH", fmt.Sprintf("/api/bases/%d/views/%d", baseID, defaultViewID), map[string]any{
		"config": map[string]any{"configLocked": false},
	}); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("editor patch configLocked view status=%d want 403", resp.StatusCode)
	}
	if resp := bob.do(t, "POST", fmt.Sprintf("/api/bases/%d/views/%d/rename", baseID, defaultViewID), map[string]any{
		"expectedName": "表格",
		"name":         "被篡改",
	}); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("editor rename configLocked view status=%d want 403", resp.StatusCode)
	}

	// Bob (edit) CAN duplicate a configLocked view, and the copy has configLocked cleared.
	dup := bob.mustJSON(t, "POST", fmt.Sprintf("/api/bases/%d/views/%d/duplicate", baseID, defaultViewID), map[string]any{
		"name": "Bob 复制视图",
	})
	dupID := int64(dup["id"].(float64))
	if dupCfg, ok := dup["config"].(map[string]any); ok && dupCfg["configLocked"] == true {
		t.Fatalf("duplicated view by editor should clear configLocked: %v", dupCfg)
	}
	if resp := bob.do(t, "DELETE", fmt.Sprintf("/api/bases/%d/views/%d", baseID, dupID), nil); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete duplicated view status=%d want 204", resp.StatusCode)
	}

	// Bob creates a Personal View (isPersonal: true).
	personal := bob.mustJSON(t, "POST", fmt.Sprintf("/api/bases/%d/views", baseID), map[string]any{
		"type":       "grid",
		"name":       "Bob 的个人视图",
		"isPersonal": true,
	})
	personalID := int64(personal["id"].(float64))
	if int64(personal["ownerId"].(float64)) != bob.userID {
		t.Fatalf("expected personal view ownerId=%d, got %v", bob.userID, personal["ownerId"])
	}

	// Bob sees 2 views (shared + his personal view), while Alice (manage) sees only 1 (shared).
	bobSnap2 := bob.mustJSON(t, "GET", fmt.Sprintf("/api/bases/%d", baseID), nil)
	if len(bobSnap2["views"].([]any)) != 2 {
		t.Fatalf("Bob should see 2 views, got %d", len(bobSnap2["views"].([]any)))
	}
	aliceSnap := alice.mustJSON(t, "GET", fmt.Sprintf("/api/bases/%d", baseID), nil)
	if len(aliceSnap["views"].([]any)) != 1 {
		t.Fatalf("Alice must NOT see Bob's personal view, got %d views", len(aliceSnap["views"].([]any)))
	}

	// Alice cannot patch or delete Bob's personal view (404).
	if resp := alice.do(t, "PATCH", fmt.Sprintf("/api/bases/%d/views/%d", baseID, personalID), map[string]any{
		"name": "篡改个人视图",
	}); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("Alice patch Bob's personal view status=%d want 404", resp.StatusCode)
	}
	if resp := alice.do(t, "DELETE", fmt.Sprintf("/api/bases/%d/views/%d", baseID, personalID), nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("Alice delete Bob's personal view status=%d want 404", resp.StatusCode)
	}

	// Personal view cannot be form.
	if resp := bob.do(t, "POST", fmt.Sprintf("/api/bases/%d/views", baseID), map[string]any{
		"type":       "form",
		"name":       "个人表单",
		"isPersonal": true,
	}); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("personal form view status=%d want 400", resp.StatusCode)
	}

	// Bob can delete his personal view even though only 1 shared view remains.
	if resp := bob.do(t, "DELETE", fmt.Sprintf("/api/bases/%d/views/%d", baseID, personalID), nil); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("Bob delete personal view status=%d want 204", resp.StatusCode)
	}
}
