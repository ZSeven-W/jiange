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
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/sheetsync"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func runSheetAdvancedSuite(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	hub := &sheetsync.Hub{Store: st, PingInterval: 2 * time.Second, SweepInterval: 100 * time.Millisecond}
	srv := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1,
		SheetHub:   hub,
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	newClient := func() *http.Client {
		jar, _ := cookiejar.New(nil)
		return &http.Client{Jar: jar}
	}
	cOwner := newClient()
	cEditor := newClient()
	cAllow := newClient()
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

	owner := register(cOwner, "sa-owner@test.dev", "Owner")
	editor := register(cEditor, "sa-editor@test.dev", "Editor")
	allowed := register(cAllow, "sa-allowed@test.dev", "Allowed")
	viewer := register(cViewer, "sa-viewer@test.dev", "Viewer")
	uidOwner := strconv64(owner.ID)
	uidEditor := strconv64(editor.ID)
	uidAllow := strconv64(allowed.ID)
	uidViewer := strconv64(viewer.ID)

	// Create a new spreadsheet
	res := post(t, cOwner, ts.URL+"/api/drive/nodes", map[string]any{
		"kind": "sheet", "title": "高级表格测试", "scope": "personal",
	})
	var entry store.DriveEntry
	if err := json.NewDecoder(res.Body).Decode(&entry); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create sheet: status=%d", res.StatusCode)
	}
	idStr := strconv64(entry.ID)

	// Share sheet: editor (edit), allowed (edit), viewer (view)
	if err := st.SetShare(ctx, entry.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, entry.ID, allowed.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, entry.ID, viewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}

	getSnap := func(c *http.Client, uid string) store.SheetSnapshot {
		t.Helper()
		r := sheetReq(t, c, http.MethodGet, ts.URL+"/api/sheets/"+idStr, uid, "1", nil)
		defer r.Body.Close()
		if r.StatusCode != http.StatusOK {
			t.Fatalf("get sheet: status=%d", r.StatusCode)
		}
		var snap store.SheetSnapshot
		if err := json.NewDecoder(r.Body).Decode(&snap); err != nil {
			t.Fatal(err)
		}
		return snap
	}

	snap := getSnap(cOwner, uidOwner)
	if len(snap.Sheets) != 1 {
		t.Fatalf("expected 1 worksheet, got %d", len(snap.Sheets))
	}
	ws := snap.Sheets[0]
	widStr := strconv64(ws.ID)

	mutSeq := 0
	nextMut := func() string {
		mutSeq++
		return fmt.Sprintf("%032x", mutSeq)
	}
	writeCell := func(c *http.Client, uid string, rowID, colID int64, raw string, expectedRev int64) (int, map[string]any) {
		t.Helper()
		r := sheetReq(t, c, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/cells", uid, "1", map[string]any{
			"mutationId":  nextMut(),
			"worksheetId": ws.ID,
			"cells": []map[string]any{
				{"rowId": rowID, "columnId": colID, "raw": raw, "expectedRevision": expectedRev},
			},
		})
		defer r.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(r.Body).Decode(&out)
		return r.StatusCode, out
	}

	// 1. Configure validations, conditional formats, and protected ranges.
	// First verify editor CANNOT set protectedRanges (403).
	r := sheetReq(t, cEditor, http.MethodPatch, ts.URL+"/api/sheets/"+idStr+"/worksheets/"+widStr, uidEditor, "1", map[string]any{
		"protectedRanges": []map[string]any{
			{"id": "p1", "top": 1, "left": 1, "bottom": 2, "right": 2, "description": "Forbidden"},
		},
	})
	r.Body.Close()
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("editor setting protectedRanges: expected 403, got %d", r.StatusCode)
	}

	// Owner sets validations + conditionalFormats + protectedRanges
	r = sheetReq(t, cOwner, http.MethodPatch, ts.URL+"/api/sheets/"+idStr+"/worksheets/"+widStr, uidOwner, "1", map[string]any{
		"validations": []map[string]any{
			{"id": "v-list", "top": 0, "left": 0, "bottom": 3, "right": 0, "type": "list", "options": []string{"进行中", "已完成", "已延期"}, "strict": true, "hint": "仅限状态枚举"},
			{"id": "v-num", "top": 0, "left": 1, "bottom": 3, "right": 1, "type": "number", "min": "0", "max": "100", "strict": true},
			{"id": "v-date", "top": 0, "left": 2, "bottom": 3, "right": 2, "type": "date", "min": "2026-01-01", "max": "2026-12-31", "strict": true},
			{"id": "v-warn", "top": 0, "left": 3, "bottom": 3, "right": 3, "type": "list", "options": []string{"高", "低"}, "strict": false},
		},
		"conditionalFormats": []map[string]any{
			{"id": "cf-1", "top": 0, "left": 1, "bottom": 4, "right": 1, "op": "gt", "value1": "80", "bg": "#dcfce7", "color": "#166534", "bold": true},
			{"id": "cf-2", "top": 0, "left": 0, "bottom": 4, "right": 0, "op": "eq", "value1": "已延期", "bg": "#fee2e2", "color": "#991b1b"},
		},
		"protectedRanges": []map[string]any{
			{"id": "pr-1", "top": 5, "left": 1, "bottom": 6, "right": 2, "description": "预算锁定区", "allowedUserIds": []int64{allowed.ID}},
		},
	})
	if r.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()
		t.Fatalf("owner patch rules: status=%d body=%s", r.StatusCode, string(body))
	}
	r.Body.Close()

	// Verify persisted via GET
	snap = getSnap(cOwner, uidOwner)
	ws = snap.Sheets[0]
	if len(ws.Validations) != 4 || len(ws.ConditionalFormats) != 2 || len(ws.ProtectedRanges) != 1 {
		t.Fatalf("unexpected persisted rule counts: v=%d cf=%d pr=%d", len(ws.Validations), len(ws.ConditionalFormats), len(ws.ProtectedRanges))
	}

	// 2. Test data validation enforcement on WriteSheetCells
	// Strict list: invalid rejected with 422 validation_failed
	code, body := writeCell(cOwner, uidOwner, ws.Rows[0].ID, ws.Columns[0].ID, "非法状态", 0)
	if code != http.StatusUnprocessableEntity || body["error"] != "validation_failed" {
		t.Fatalf("strict list invalid: expected 422 validation_failed, got %d %+v", code, body)
	}
	// Strict list: valid accepted
	code, _ = writeCell(cOwner, uidOwner, ws.Rows[0].ID, ws.Columns[0].ID, "进行中", 0)
	if code != http.StatusOK {
		t.Fatalf("strict list valid: expected 200, got %d", code)
	}
	// Strict list: formula allowed
	code, _ = writeCell(cOwner, uidOwner, ws.Rows[1].ID, ws.Columns[0].ID, "=A1", 0)
	if code != http.StatusOK {
		t.Fatalf("strict list formula: expected 200, got %d", code)
	}
	// Strict list: clearing cell to empty string allowed
	code, _ = writeCell(cOwner, uidOwner, ws.Rows[0].ID, ws.Columns[0].ID, "", 1)
	if code != http.StatusOK {
		t.Fatalf("strict list clear: expected 200, got %d", code)
	}
	// Strict number: out-of-range and non-numeric rejected with 422
	code, _ = writeCell(cOwner, uidOwner, ws.Rows[0].ID, ws.Columns[1].ID, "150", 0)
	if code != http.StatusUnprocessableEntity {
		t.Fatalf("strict number >max: expected 422, got %d", code)
	}
	code, _ = writeCell(cOwner, uidOwner, ws.Rows[0].ID, ws.Columns[1].ID, "notnum", 0)
	if code != http.StatusUnprocessableEntity {
		t.Fatalf("strict number non-num: expected 422, got %d", code)
	}
	code, _ = writeCell(cOwner, uidOwner, ws.Rows[0].ID, ws.Columns[1].ID, "88.5", 0)
	if code != http.StatusOK {
		t.Fatalf("strict number valid: expected 200, got %d", code)
	}
	// Strict date: out-of-range and malformed rejected with 422
	code, _ = writeCell(cOwner, uidOwner, ws.Rows[0].ID, ws.Columns[2].ID, "2025-12-31", 0)
	if code != http.StatusUnprocessableEntity {
		t.Fatalf("strict date <min: expected 422, got %d", code)
	}
	code, _ = writeCell(cOwner, uidOwner, ws.Rows[0].ID, ws.Columns[2].ID, "2026-06-15", 0)
	if code != http.StatusOK {
		t.Fatalf("strict date valid: expected 200, got %d", code)
	}
	// Non-strict validation allows arbitrary values
	code, _ = writeCell(cOwner, uidOwner, ws.Rows[0].ID, ws.Columns[3].ID, "自定义值", 0)
	if code != http.StatusOK {
		t.Fatalf("non-strict list: expected 200, got %d", code)
	}

	// 3. Test protected range enforcement (rows 5..6, cols 1..2)
	// Regular editor blocked from writing inside protected range (403)
	code, _ = writeCell(cEditor, uidEditor, ws.Rows[5].ID, ws.Columns[1].ID, "999", 0)
	if code != http.StatusForbidden {
		t.Fatalf("editor write protected cell: expected 403, got %d", code)
	}
	// Regular editor allowed to write outside protected range (row 5, col 0)
	code, _ = writeCell(cEditor, uidEditor, ws.Rows[5].ID, ws.Columns[0].ID, "外围可写", 0)
	if code != http.StatusOK {
		t.Fatalf("editor write outside protected cell: expected 200, got %d", code)
	}
	// Regular editor blocked from deleting row 5 or col 1 intersecting protected range (403)
	r = sheetReq(t, cEditor, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/worksheets/"+widStr+"/axes", uidEditor, "1", map[string]any{
		"op": "delete_row", "index": 5, "count": 1,
	})
	r.Body.Close()
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("editor delete protected row: expected 403, got %d", r.StatusCode)
	}
	r = sheetReq(t, cEditor, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/worksheets/"+widStr+"/axes", uidEditor, "1", map[string]any{
		"op": "delete_col", "index": 2, "count": 1,
	})
	r.Body.Close()
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("editor delete protected col: expected 403, got %d", r.StatusCode)
	}
	// Allowlisted editor CAN write inside protected range
	code, _ = writeCell(cAllow, uidAllow, ws.Rows[5].ID, ws.Columns[1].ID, "允许编辑", 0)
	if code != http.StatusOK {
		t.Fatalf("allowlisted editor write protected cell: expected 200, got %d", code)
	}
	// Owner (manager) CAN write inside protected range
	code, _ = writeCell(cOwner, uidOwner, ws.Rows[6].ID, ws.Columns[2].ID, "管理员可写", 0)
	if code != http.StatusOK {
		t.Fatalf("manager write protected cell: expected 200, got %d", code)
	}

	// 4. Test cell-anchored comments & axis mutations
	anchorRowID := ws.Rows[2].ID
	anchorColID := ws.Columns[1].ID
	// Viewer creates comment (default commentMinRole is "view")
	r = sheetReq(t, cViewer, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/comments", uidViewer, "1", map[string]any{
		"worksheetId": ws.ID, "rowId": anchorRowID, "columnId": anchorColID, "body": "请核对 B3 预算数值",
	})
	var createdComment struct {
		Comment store.SheetComment `json:"comment"`
	}
	if err := json.NewDecoder(r.Body).Decode(&createdComment); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != http.StatusCreated || createdComment.Comment.Body != "请核对 B3 预算数值" || createdComment.Comment.AuthorName != "Viewer" {
		t.Fatalf("viewer create comment: status=%d cm=%+v", r.StatusCode, createdComment.Comment)
	}
	cidStr := strconv64(createdComment.Comment.ID)

	// Non-author editor cannot edit comment body (403)
	r = sheetReq(t, cEditor, http.MethodPatch, ts.URL+"/api/sheets/"+idStr+"/comments/"+cidStr, uidEditor, "1", map[string]any{
		"body": "篡改内容",
	})
	r.Body.Close()
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("non-author edit comment: expected 403, got %d", r.StatusCode)
	}
	// Author edits comment body (200)
	r = sheetReq(t, cViewer, http.MethodPatch, ts.URL+"/api/sheets/"+idStr+"/comments/"+cidStr, uidViewer, "1", map[string]any{
		"body": "请再次核对 B3 预算数值",
	})
	var editedComment struct {
		Comment store.SheetComment `json:"comment"`
	}
	_ = json.NewDecoder(r.Body).Decode(&editedComment)
	r.Body.Close()
	if r.StatusCode != http.StatusOK || editedComment.Comment.Body != "请再次核对 B3 预算数值" {
		t.Fatalf("author edit comment: status=%d cm=%+v", r.StatusCode, editedComment.Comment)
	}
	// Editor resolves comment (200)
	r = sheetReq(t, cEditor, http.MethodPatch, ts.URL+"/api/sheets/"+idStr+"/comments/"+cidStr, uidEditor, "1", map[string]any{
		"resolved": true,
	})
	var resolvedComment struct {
		Comment store.SheetComment `json:"comment"`
	}
	_ = json.NewDecoder(r.Body).Decode(&resolvedComment)
	r.Body.Close()
	if r.StatusCode != http.StatusOK || !resolvedComment.Comment.Resolved || resolvedComment.Comment.ResolvedBy == nil || *resolvedComment.Comment.ResolvedBy != editor.ID {
		t.Fatalf("editor resolve comment: status=%d cm=%+v", r.StatusCode, resolvedComment.Comment)
	}

	// Insert 1 row at index 0 -> shifts validations/condFormats/protectedRanges down by 1,
	// and comment remains anchored to the durable anchorRowID (which is now at pos 3).
	r = sheetReq(t, cOwner, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/worksheets/"+widStr+"/axes", uidOwner, "1", map[string]any{
		"op": "insert_row", "index": 0, "count": 1,
	})
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("insert_row at 0: status=%d", r.StatusCode)
	}
	snapAfterInsert := getSnap(cOwner, uidOwner)
	wsAfterInsert := snapAfterInsert.Sheets[0]
	if wsAfterInsert.Validations[0].Top != 1 || wsAfterInsert.ConditionalFormats[0].Top != 1 || wsAfterInsert.ProtectedRanges[0].Top != 6 {
		t.Fatalf("rules did not shift after insert_row: v=%+v cf=%+v pr=%+v",
			wsAfterInsert.Validations[0], wsAfterInsert.ConditionalFormats[0], wsAfterInsert.ProtectedRanges[0])
	}
	if wsAfterInsert.Rows[3].ID != anchorRowID {
		t.Fatalf("expected anchorRowID %d at pos 3, got %d", anchorRowID, wsAfterInsert.Rows[3].ID)
	}

	// Verify comment still listed with durable rowId
	r = sheetReq(t, cOwner, http.MethodGet, ts.URL+"/api/sheets/"+idStr+"/comments?worksheetId="+widStr, uidOwner, "1", nil)
	var listRes struct {
		Comments []store.SheetComment `json:"comments"`
	}
	_ = json.NewDecoder(r.Body).Decode(&listRes)
	r.Body.Close()
	if r.StatusCode != http.StatusOK || len(listRes.Comments) != 1 || listRes.Comments[0].RowID != anchorRowID {
		t.Fatalf("comments after insert_row: status=%d list=%+v", r.StatusCode, listRes.Comments)
	}

	// Non-author non-manager editor cannot delete viewer's comment (403)
	r = sheetReq(t, cEditor, http.MethodDelete, ts.URL+"/api/sheets/"+idStr+"/comments/"+cidStr, uidEditor, "1", nil)
	r.Body.Close()
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("editor delete viewer comment: expected 403, got %d", r.StatusCode)
	}

	// Delete the anchored row (pos 3) -> comment cascades and disappears!
	r = sheetReq(t, cOwner, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/worksheets/"+widStr+"/axes", uidOwner, "1", map[string]any{
		"op": "delete_row", "index": 3, "count": 1,
	})
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("delete anchored row: status=%d", r.StatusCode)
	}
	r = sheetReq(t, cOwner, http.MethodGet, ts.URL+"/api/sheets/"+idStr+"/comments?worksheetId="+widStr, uidOwner, "1", nil)
	listRes.Comments = nil
	_ = json.NewDecoder(r.Body).Decode(&listRes)
	r.Body.Close()
	if r.StatusCode != http.StatusOK || len(listRes.Comments) != 0 {
		t.Fatalf("expected 0 comments after deleting anchor row, got %+v", listRes.Comments)
	}

	// 5. Verify commentMinRole="edit" blocks viewer comment creation (403) while editor succeeds (201)
	meta, err := st.GetDoc(ctx, owner.ID, entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	r = sheetReq(t, cOwner, http.MethodPatch, ts.URL+"/api/docs/"+idStr, uidOwner, "", map[string]any{
		"commentMinRole": "edit", "expectedPermissionsRevision": meta.PermissionsRevision,
	})
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("set commentMinRole=edit: status=%d", r.StatusCode)
	}
	snapNow := getSnap(cOwner, uidOwner)
	wsNow := snapNow.Sheets[0]
	r = sheetReq(t, cViewer, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/comments", uidViewer, "1", map[string]any{
		"worksheetId": wsNow.ID, "rowId": wsNow.Rows[0].ID, "columnId": wsNow.Columns[0].ID, "body": "viewer blocked",
	})
	r.Body.Close()
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer comment when commentMinRole=edit: expected 403, got %d", r.StatusCode)
	}
	r = sheetReq(t, cEditor, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/comments", uidEditor, "1", map[string]any{
		"worksheetId": wsNow.ID, "rowId": wsNow.Rows[0].ID, "columnId": wsNow.Columns[0].ID, "body": "editor allowed",
	})
	var edCm struct {
		Comment store.SheetComment `json:"comment"`
	}
	_ = json.NewDecoder(r.Body).Decode(&edCm)
	r.Body.Close()
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("editor comment when commentMinRole=edit: expected 201, got %d", r.StatusCode)
	}
	// Owner (manager) can delete editor's comment (204)
	r = sheetReq(t, cOwner, http.MethodDelete, ts.URL+"/api/sheets/"+idStr+"/comments/"+strconv64(edCm.Comment.ID), uidOwner, "1", nil)
	r.Body.Close()
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("owner delete editor comment: expected 204, got %d", r.StatusCode)
	}

	// 6. Verify CopySheetWorkbook duplicates validations, conditionalFormats, and protectedRanges
	r = sheetReq(t, cOwner, http.MethodPost, ts.URL+"/api/docs/"+idStr+"/account-duplicate", uidOwner, "", nil)
	var dupMeta store.DocMeta
	if err := json.NewDecoder(r.Body).Decode(&dupMeta); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("duplicate sheet: status=%d", r.StatusCode)
	}
	r = sheetReq(t, cOwner, http.MethodGet, ts.URL+"/api/sheets/"+strconv64(dupMeta.ID), uidOwner, "1", nil)
	var dupSnap store.SheetSnapshot
	if err := json.NewDecoder(r.Body).Decode(&dupSnap); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != http.StatusOK || len(dupSnap.Sheets) != 1 {
		t.Fatalf("get dup sheet: status=%d", r.StatusCode)
	}
	dupWS := dupSnap.Sheets[0]
	if len(dupWS.Validations) != len(wsNow.Validations) || len(dupWS.ConditionalFormats) != len(wsNow.ConditionalFormats) || len(dupWS.ProtectedRanges) != len(wsNow.ProtectedRanges) {
		t.Fatalf("duplicated sheet lost rules: orig=(%d,%d,%d) dup=(%d,%d,%d)",
			len(wsNow.Validations), len(wsNow.ConditionalFormats), len(wsNow.ProtectedRanges),
			len(dupWS.Validations), len(dupWS.ConditionalFormats), len(dupWS.ProtectedRanges))
	}
}

func TestSheetAdvancedMemory(t *testing.T) {
	runSheetAdvancedSuite(t, store.NewMemory())
}

func TestSheetAdvancedPostgres(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("jiange_sheet_adv_%d", time.Now().UnixNano())}.Sanitize()
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
	runSheetAdvancedSuite(t, &store.Postgres{Pool: pool})
}
