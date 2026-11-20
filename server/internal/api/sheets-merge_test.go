package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestSheetConcurrentMergeAndRegionConflictAPI(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	bobClient := newCommentClient()

	register := func(client *http.Client, email, name string) (store.User, store.Workspace) {
		res := post(t, client, ts.URL+"/api/auth/register", map[string]string{
			"email": email, "name": name, "password": "password123",
		})
		defer res.Body.Close()
		var me struct {
			User       store.User        `json:"user"`
			Workspaces []store.Workspace `json:"workspaces"`
		}
		if err := json.NewDecoder(res.Body).Decode(&me); err != nil {
			t.Fatal(err)
		}
		return me.User, me.Workspaces[0]
	}

	ownerUser, ws := register(owner, "api-sheet-merge-owner@example.test", "Owner")
	bobUser, _ := register(bobClient, "api-sheet-merge-bob@example.test", "Bob")

	// Invite Bob and accept.
	inv := send(t, owner, http.MethodPost, fmt.Sprintf("%s/api/workspaces/%d/members", ts.URL, ws.ID), map[string]any{
		"email": bobUser.Email, "role": "member",
	})
	var change store.WorkspaceMemberChange
	json.NewDecoder(inv.Body).Decode(&change)
	inv.Body.Close()
	acc := send(t, bobClient, http.MethodPost, fmt.Sprintf("%s/api/invitations/%d/accept", ts.URL, change.Invitation.ID), nil)
	acc.Body.Close()

	// Create standalone sheet node.
	createRes := send(t, owner, http.MethodPost, ts.URL+"/api/drive/nodes", map[string]any{
		"kind": "sheet", "title": "并发测试表格", "scope": "shared",
	})
	var entry store.DriveEntry
	json.NewDecoder(createRes.Body).Decode(&entry)
	createRes.Body.Close()
	if createRes.StatusCode != http.StatusCreated && createRes.StatusCode != http.StatusOK {
		t.Fatalf("create sheet status=%d", createRes.StatusCode)
	}

	sheetSend := func(client *http.Client, uid int64, method, path string, body any) *http.Response {
		var rdr io.Reader
		if body != nil {
			raw, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			rdr = bytes.NewReader(raw)
		}
		req, err := http.NewRequest(method, ts.URL+path, rdr)
		if err != nil {
			t.Fatal(err)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("X-Jiange-User-Id", fmt.Sprintf("%d", uid))
		req.Header.Set("X-Jiange-Sheet-Version", "1")
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}

	snapRes := sheetSend(owner, ownerUser.ID, http.MethodGet, fmt.Sprintf("/api/sheets/%d", entry.ID), nil)
	var snap store.SheetSnapshot
	json.NewDecoder(snapRes.Body).Decode(&snap)
	snapRes.Body.Close()
	sheet := snap.Sheets[0]

	// Owner writes A1 raw; Bob writes A1 stylePatch.bold at stale expectedRevision=0 with mergeMode="auto".
	res1 := sheetSend(owner, ownerUser.ID, http.MethodPost, fmt.Sprintf("/api/sheets/%d/cells", entry.ID), map[string]any{
		"mutationId":  "00000000000000000000000000000001",
		"worksheetId": sheet.ID,
		"mergeMode":   "auto",
		"cells": []map[string]any{
			{"rowId": sheet.Rows[0].ID, "columnId": sheet.Columns[0].ID, "expectedRevision": 0, "raw": "12345"},
		},
	})
	res1.Body.Close()
	if res1.StatusCode != http.StatusOK {
		t.Fatalf("owner write status=%d", res1.StatusCode)
	}

	res2 := sheetSend(bobClient, bobUser.ID, http.MethodPost, fmt.Sprintf("/api/sheets/%d/cells", entry.ID), map[string]any{
		"mutationId":  "00000000000000000000000000000002",
		"worksheetId": sheet.ID,
		"mergeMode":   "auto",
		"cells": []map[string]any{
			{"rowId": sheet.Rows[0].ID, "columnId": sheet.Columns[0].ID, "expectedRevision": 0, "stylePatch": map[string]any{"bold": true, "bg": "#fff2cc"}},
		},
	})
	var batchOut store.SheetBatchResult
	json.NewDecoder(res2.Body).Decode(&batchOut)
	res2.Body.Close()
	if res2.StatusCode != http.StatusOK || batchOut.MergedCount != 1 || len(batchOut.Cells) != 1 || batchOut.Cells[0].Raw != "12345" || !batchOut.Cells[0].Style.Bold {
		t.Fatalf("auto-merge API failed: status=%d out=%+v", res2.StatusCode, batchOut)
	}

	// Owner merges A1:B2; Bob sends overlapping merge B2:C3 with stale expectedMerges=[] -> 409 structured JSON!
	m1 := sheetSend(owner, ownerUser.ID, http.MethodPatch, fmt.Sprintf("/api/sheets/%d/worksheets/%d", entry.ID, sheet.ID), map[string]any{
		"mergeOp": map[string]any{
			"op":   "merge",
			"rect": map[string]int{"top": 0, "left": 0, "bottom": 1, "right": 1},
		},
	})
	m1.Body.Close()
	if m1.StatusCode != http.StatusOK {
		t.Fatalf("owner merge status=%d", m1.StatusCode)
	}

	m2 := sheetSend(bobClient, bobUser.ID, http.MethodPatch, fmt.Sprintf("/api/sheets/%d/worksheets/%d", entry.ID, sheet.ID), map[string]any{
		"mergeOp": map[string]any{
			"op":             "merge",
			"rect":           map[string]int{"top": 1, "left": 1, "bottom": 2, "right": 2},
			"expectedMerges": []any{},
		},
	})
	var conflictBody struct {
		Error             string               `json:"error"`
		ConflictingMerges []store.SheetMerge   `json:"conflictingMerges"`
		Worksheet         store.SheetWorksheet `json:"worksheet"`
	}
	json.NewDecoder(m2.Body).Decode(&conflictBody)
	m2.Body.Close()
	if m2.StatusCode != http.StatusConflict || conflictBody.Error != "merge_overlap_conflict" || len(conflictBody.ConflictingMerges) != 1 || len(conflictBody.Worksheet.Merges) != 1 {
		t.Fatalf("overlapping merge API expected 409 merge_overlap_conflict, got status=%d body=%+v", m2.StatusCode, conflictBody)
	}
}
