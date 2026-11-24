package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func rbacRegisterClient(t *testing.T, tsURL, email, name string) (*http.Client, store.User) {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	cli := &http.Client{Jar: jar}
	res := post(t, cli, tsURL+"/api/auth/register", map[string]string{
		"email": email, "name": name, "password": "password123",
	})
	if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusOK {
		t.Fatalf("register %s status=%d", email, res.StatusCode)
	}
	var out struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatalf("decode register %s: %v", email, err)
	}
	res.Body.Close()
	if out.User.ID <= 0 {
		t.Fatalf("register %s returned invalid user id: %+v", email, out.User)
	}
	return cli, out.User
}

type rbacBaseSnapshot struct {
	Base                 store.DocMeta            `json:"base"`
	Fields               []store.Field            `json:"fields"`
	Records              []store.Record           `json:"records"`
	Views                []store.View             `json:"views"`
	Head                 int64                    `json:"head"`
	WriteRestricted      bool                     `json:"writeRestricted"`
	EffectivePermissions EffectiveBasePermissions `json:"effectivePermissions"`
}

func rbacGetSnapshot(t *testing.T, cli *http.Client, baseURL string) rbacBaseSnapshot {
	t.Helper()
	res := cGet(t, cli, baseURL)
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		t.Fatalf("GET %s status=%d body=%s", baseURL, res.StatusCode, string(body))
	}
	var snap rbacBaseSnapshot
	if err := json.NewDecoder(res.Body).Decode(&snap); err != nil {
		res.Body.Close()
		t.Fatalf("decode snapshot: %v", err)
	}
	res.Body.Close()
	return snap
}

func rbacGetAccountSnapshot(t *testing.T, cli *http.Client, baseURL string, uid int64) rbacBaseSnapshot {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, baseURL+"/account-snapshot", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(uid, 10))
	res, err := cli.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		t.Fatalf("GET account-snapshot status=%d body=%s", res.StatusCode, string(body))
	}
	var snap rbacBaseSnapshot
	if err := json.NewDecoder(res.Body).Decode(&snap); err != nil {
		res.Body.Close()
		t.Fatalf("decode account snapshot: %v", err)
	}
	res.Body.Close()
	return snap
}

func rbacReqWithUser(t *testing.T, cli *http.Client, method, url string, uid int64, body any) *http.Response {
	t.Helper()
	var r io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r = strings.NewReader(string(raw))
	}
	req, err := http.NewRequest(method, url, r)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if uid > 0 {
		req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(uid, 10))
	}
	res, err := cli.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestBaseRBACMultiRoleEnforcement(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{
		"email": "rbac-owner@example.test", "name": "Owner", "password": "password123",
	})
	salesCli, salesUser := rbacRegisterClient(t, ts.URL, "rbac-sales@example.test", "Sales")
	reviewerCli, reviewerUser := rbacRegisterClient(t, ts.URL, "rbac-reviewer@example.test", "Reviewer")
	dualCli, dualUser := rbacRegisterClient(t, ts.URL, "rbac-dual@example.test", "Dual")
	fallbackCli, _ := rbacRegisterClient(t, ts.URL, "rbac-fallback@example.test", "Fallback")

	var base store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/bases", map[string]string{"title": "多角色销售审批表"}).Body).Decode(&base)
	baseURL := ts.URL + "/api/bases/" + strconv.FormatInt(base.ID, 10)

	// Fetch default primary field.
	initialSnap := rbacGetSnapshot(t, owner, baseURL)
	primaryF := initialSnap.Fields[0]
	if !primaryF.IsPrimary {
		t.Fatalf("expected primary field first, got %+v", primaryF)
	}

	var statusF, amountF, noteF, secretF, dateF store.Field
	json.NewDecoder(post(t, owner, baseURL+"/fields", map[string]any{"name": "状态", "type": "select", "options": []string{"草稿", "待审", "通过"}}).Body).Decode(&statusF)
	json.NewDecoder(post(t, owner, baseURL+"/fields", map[string]any{"name": "金额", "type": "number"}).Body).Decode(&amountF)
	json.NewDecoder(post(t, owner, baseURL+"/fields", map[string]any{"name": "备注", "type": "text"}).Body).Decode(&noteF)
	json.NewDecoder(post(t, owner, baseURL+"/fields", map[string]any{"name": "内部成本", "type": "text"}).Body).Decode(&secretF)
	json.NewDecoder(post(t, owner, baseURL+"/fields", map[string]any{"name": "审批日期", "type": "date"}).Body).Decode(&dateF)

	primaryK := strconv.FormatInt(primaryF.ID, 10)
	statusK := strconv.FormatInt(statusF.ID, 10)
	amountK := strconv.FormatInt(amountF.ID, 10)
	noteK := strconv.FormatInt(noteF.ID, 10)
	secretK := strconv.FormatInt(secretF.ID, 10)
	dateK := strconv.FormatInt(dateF.ID, 10)

	// Share base with all four collaborators as edit.
	for _, email := range []string{
		"rbac-sales@example.test",
		"rbac-reviewer@example.test",
		"rbac-dual@example.test",
		"rbac-fallback@example.test",
	} {
		if res := send(t, owner, http.MethodPut, ts.URL+"/api/docs/"+strconv.FormatInt(base.ID, 10)+"/shares", map[string]any{
			"email": email, "role": "edit",
		}); res.StatusCode != http.StatusOK {
			t.Fatalf("share %s failed: %d", email, res.StatusCode)
		}
	}

	// Owner creates two seed records (one draft, one pending review).
	var ownerDraft, ownerPending store.Record
	json.NewDecoder(post(t, owner, baseURL+"/records", map[string]any{
		"cells": map[string]any{
			primaryK: "草稿单", statusK: "草稿", amountK: 100, noteK: "draft-note", secretK: "SECRET_DRAFT", dateK: "2026-11-10",
		},
	}).Body).Decode(&ownerDraft)
	json.NewDecoder(post(t, owner, baseURL+"/records", map[string]any{
		"cells": map[string]any{
			primaryK: "待审单", statusK: "待审", amountK: 200, noteK: "pending-note", secretK: "SECRET_PENDING", dateK: "2026-11-11",
		},
	}).Body).Decode(&ownerPending)

	// Create a second shared view that will be hidden from Reviewer.
	var view2 store.View
	json.NewDecoder(post(t, owner, baseURL+"/views", map[string]any{"name": "内部明细视图", "type": "grid"}).Body).Decode(&view2)

	views, err := st.Views(context.Background(), base.ID)
	if err != nil || len(views) < 2 {
		t.Fatalf("views=%+v err=%v", views, err)
	}
	view1ID := views[0].ID
	view1URL := baseURL + "/views/" + strconv.FormatInt(view1ID, 10)
	view2URL := baseURL + "/views/" + strconv.FormatInt(view2.ID, 10)

	// Primary field cannot be hidden in role fieldModes (400).
	if res := send(t, owner, http.MethodPatch, view1URL, map[string]any{
		"config": map[string]any{
			"permissions": map[string]any{
				"roles": []map[string]any{{
					"id": "bad", "name": "Bad", "userIds": []int64{salesUser.ID},
					"fieldModes": map[string]string{primaryK: "hidden"},
				}},
			},
		},
	}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("hiding primary field in role=%d, want 400", res.StatusCode)
	}

	// Configure View 1 with default rule + Role A ("销售") + Role B ("审核").
	view1Cfg := map[string]any{
		"permissions": map[string]any{
			"onlyOwnRecords": true,
			"fieldModes": map[string]string{
				secretK: "hidden",
			},
			"roles": []map[string]any{
				{
					"id":              "role-sales",
					"name":            "销售",
					"userIds":         []int64{salesUser.ID, dualUser.ID},
					"canAddRecord":    true,
					"canDeleteRecord": true,
					"rowScope":        "own",
					"fieldModes": map[string]string{
						amountK: "readonly",
						noteK:   "readonly",
						dateK:   "readonly",
						secretK: "hidden",
					},
				},
				{
					"id":              "role-reviewer",
					"name":            "审核",
					"userIds":         []int64{reviewerUser.ID, dualUser.ID},
					"canAddRecord":    false,
					"canDeleteRecord": false,
					"rowScope":        "filter",
					"rowFilters": map[string]any{
						"conj":  "and",
						"rules": []map[string]any{{"f": statusF.ID, "op": "is", "v": "待审"}},
					},
					"fieldModes": map[string]string{
						amountK: "readonly",
						noteK:   "edit",
						secretK: "hidden",
					},
				},
			},
		},
	}
	if res := send(t, owner, http.MethodPatch, view1URL, map[string]any{"config": view1Cfg}); res.StatusCode != http.StatusOK {
		t.Fatalf("owner save view1 RBAC=%d, want 200", res.StatusCode)
	}

	// Configure View 2 to be hidden for Reviewer only (unrestricted row/add/delete so it doesn't tighten View 1).
	view2Cfg := map[string]any{
		"permissions": map[string]any{
			"roles": []map[string]any{
				{
					"id":         "role-hide-v2",
					"name":       "隐藏明细",
					"userIds":    []int64{reviewerUser.ID},
					"rowScope":   "all",
					"viewHidden": true,
				},
			},
		},
	}
	if res := send(t, owner, http.MethodPatch, view2URL, map[string]any{"config": view2Cfg}); res.StatusCode != http.StatusOK {
		t.Fatalf("owner save view2 RBAC=%d, want 200", res.StatusCode)
	}

	// Non-manager cannot delete a view that has RBAC roles configured.
	if res := send(t, salesCli, http.MethodDelete, view1URL, nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("sales delete RBAC view=%d, want 403", res.StatusCode)
	}

	// --- 1. Sales (Role A only) ---
	salesSnap := rbacGetAccountSnapshot(t, salesCli, baseURL, salesUser.ID)
	if !salesSnap.EffectivePermissions.CanAddRecord || !salesSnap.EffectivePermissions.CanDeleteRecord || !salesSnap.EffectivePermissions.OnlyOwnRecords {
		t.Fatalf("sales effectivePermissions mismatch: %+v", salesSnap.EffectivePermissions)
	}
	if !slices.Equal(salesSnap.EffectivePermissions.MatchedRoles, []string{"销售"}) {
		t.Fatalf("sales matchedRoles=%v, want [销售]", salesSnap.EffectivePermissions.MatchedRoles)
	}
	if !slices.Contains(salesSnap.EffectivePermissions.ReadonlyFieldIDs, amountF.ID) ||
		!slices.Contains(salesSnap.EffectivePermissions.ReadonlyFieldIDs, noteF.ID) ||
		!slices.Contains(salesSnap.EffectivePermissions.HiddenFieldIDs, secretF.ID) {
		t.Fatalf("sales field perms mismatch: %+v", salesSnap.EffectivePermissions)
	}
	if len(salesSnap.Records) != 0 {
		t.Fatalf("sales should see 0 owner records, saw %d", len(salesSnap.Records))
	}
	for _, f := range salesSnap.Fields {
		if f.ID == secretF.ID {
			t.Fatal("sales GET leaked hidden field")
		}
	}
	if len(salesSnap.Views) != 2 {
		t.Fatalf("sales should see both views, got %d", len(salesSnap.Views))
	}

	// Sales cannot add with readonly amountF (403), can add with editable fields (201).
	if res := post(t, salesCli, baseURL+"/records", map[string]any{"cells": map[string]any{amountK: 999}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("sales add readonly field=%d, want 403", res.StatusCode)
	}
	var salesRec store.Record
	res := post(t, salesCli, baseURL+"/records", map[string]any{"cells": map[string]any{primaryK: "销售自建", statusK: "草稿"}})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("sales add own record=%d, want 201", res.StatusCode)
	}
	json.NewDecoder(res.Body).Decode(&salesRec)
	res.Body.Close()

	salesRecURL := baseURL + "/records/" + strconv.FormatInt(salesRec.ID, 10)
	ownerDraftURL := baseURL + "/records/" + strconv.FormatInt(ownerDraft.ID, 10)
	ownerPendingURL := baseURL + "/records/" + strconv.FormatInt(ownerPending.ID, 10)

	// Sales cannot edit owner's record, cannot edit readonly noteF/dateF, cannot kanban-move owner record.
	if res := send(t, salesCli, http.MethodPatch, ownerDraftURL, map[string]any{"cells": map[string]any{primaryK: "hack"}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("sales patch owner rec=%d, want 403", res.StatusCode)
	}
	if res := send(t, salesCli, http.MethodPatch, salesRecURL, map[string]any{"cells": map[string]any{noteK: "hack"}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("sales patch readonly note=%d, want 403", res.StatusCode)
	}
	if res := send(t, salesCli, http.MethodPatch, salesRecURL+"/compare-cells", map[string]any{
		"expected": map[string]any{dateK: nil}, "cells": map[string]any{dateK: "2026-11-20"},
	}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("sales compare-cells readonly date=%d, want 403", res.StatusCode)
	}
	// Kanban-move on out-of-scope record returns 403.
	if res := send(t, salesCli, http.MethodPatch, ownerPendingURL+"/kanban-move", map[string]any{
		"fieldId": statusF.ID, "expectedHead": 0, "expectedGroup": "待审", "expectedPosition": ownerPending.Position,
		"expectedOptions": []string{"草稿", "待审", "通过"}, "targetGroup": "通过",
	}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("sales kanban-move out-of-scope=%d, want 403", res.StatusCode)
	}
	// Kanban-move on own record with editable statusF succeeds (200).
	salesSnap = rbacGetSnapshot(t, salesCli, baseURL)
	if res := send(t, salesCli, http.MethodPatch, salesRecURL+"/kanban-move", map[string]any{
		"fieldId": statusF.ID, "expectedHead": salesSnap.Head, "expectedGroup": "草稿", "expectedPosition": salesRec.Position,
		"expectedOptions": []string{"草稿", "待审", "通过"}, "targetGroup": "待审",
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("sales kanban-move own editable=%d, want 200", res.StatusCode)
	}
	// Reset salesRec back to 草稿 so only ownerPending is 待审 for subsequent checks.
	if res := send(t, salesCli, http.MethodPatch, salesRecURL, map[string]any{"cells": map[string]any{statusK: "草稿"}}); res.StatusCode != http.StatusOK {
		t.Fatalf("sales reset status=%d, want 200", res.StatusCode)
	}

	// --- 2. Reviewer (Role B + View 2 hidden) ---
	revSnap := rbacGetSnapshot(t, reviewerCli, baseURL)
	if revSnap.EffectivePermissions.CanAddRecord || revSnap.EffectivePermissions.CanDeleteRecord || revSnap.EffectivePermissions.OnlyOwnRecords {
		t.Fatalf("reviewer effectivePermissions mismatch: %+v", revSnap.EffectivePermissions)
	}
	if len(revSnap.Views) != 1 || revSnap.Views[0].ID != view1ID {
		t.Fatalf("reviewer should only see view1 (view2 hidden), got %+v", revSnap.Views)
	}
	if len(revSnap.Records) != 1 || revSnap.Records[0].ID != ownerPending.ID {
		t.Fatalf("reviewer should see ONLY ownerPending, got %+v", revSnap.Records)
	}
	if _, leaked := revSnap.Records[0].Cells[secretK]; leaked {
		t.Fatal("reviewer record leaked hidden field")
	}

	// Reviewer querying hidden view2 returns 403; patching hidden view2 returns 403.
	if res := post(t, reviewerCli, baseURL+"/query", map[string]any{"viewId": view2.ID}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("reviewer query hidden view=%d, want 403", res.StatusCode)
	}
	if res := send(t, reviewerCli, http.MethodPatch, view2URL, map[string]any{"name": "rename-hidden"}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("reviewer patch hidden view=%d, want 403", res.StatusCode)
	}
	// Reviewer query without hidden view returns ONLY ownerPending.
	res = post(t, reviewerCli, baseURL+"/query", map[string]any{})
	var revQuery struct{ Records []store.Record }
	json.NewDecoder(res.Body).Decode(&revQuery)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || len(revQuery.Records) != 1 || revQuery.Records[0].ID != ownerPending.ID {
		t.Fatalf("reviewer query=%d recs=%+v", res.StatusCode, revQuery.Records)
	}

	// Reviewer cannot add records, import CSV, import-records, delete, or batch-delete (all 403).
	if res := post(t, reviewerCli, baseURL+"/records", map[string]any{"cells": map[string]any{primaryK: "blocked"}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("reviewer POST records=%d, want 403", res.StatusCode)
	}
	if res := post(t, reviewerCli, baseURL+"/import", map[string]any{"csv": "标题\n测试", "header": true}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("reviewer CSV import=%d, want 403", res.StatusCode)
	}
	if res := rbacReqWithUser(t, reviewerCli, http.MethodPost, baseURL+"/import-records", reviewerUser.ID, map[string]any{
		"fields": []map[string]any{{"id": primaryF.ID, "name": primaryF.Name, "type": primaryF.Type}},
		"rows":   []map[string]any{{primaryK: "blocked"}},
	}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("reviewer import-records=%d, want 403", res.StatusCode)
	}
	if res := send(t, reviewerCli, http.MethodDelete, ownerPendingURL, nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("reviewer DELETE record=%d, want 403", res.StatusCode)
	}
	if res := post(t, reviewerCli, baseURL+"/records/batch-delete", map[string]any{"ids": []int64{ownerPending.ID}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("reviewer batch-delete=%d, want 403", res.StatusCode)
	}

	// Reviewer can edit noteF on ownerPending (200), cannot edit amountF (403), cannot edit ownerDraft (403).
	if res := send(t, reviewerCli, http.MethodPatch, ownerPendingURL, map[string]any{"cells": map[string]any{noteK: "审核意见OK"}}); res.StatusCode != http.StatusOK {
		t.Fatalf("reviewer patch editable note=%d, want 200", res.StatusCode)
	}
	if res := send(t, reviewerCli, http.MethodPatch, ownerPendingURL, map[string]any{"cells": map[string]any{amountK: 999}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("reviewer patch readonly amount=%d, want 403", res.StatusCode)
	}
	if res := send(t, reviewerCli, http.MethodPatch, ownerDraftURL, map[string]any{"cells": map[string]any{noteK: "out-of-scope"}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("reviewer patch out-of-scope draft=%d, want 403", res.StatusCode)
	}
	if res := post(t, reviewerCli, baseURL+"/records/batch-update", map[string]any{
		"updates": []map[string]any{{"id": ownerPending.ID, "cells": map[string]any{noteK: "批量审核"}}},
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("reviewer batch-update editable=%d, want 200", res.StatusCode)
	}
	if res := post(t, reviewerCli, baseURL+"/records/batch-update", map[string]any{
		"updates": []map[string]any{{"id": ownerDraft.ID, "cells": map[string]any{noteK: "hack"}}},
	}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("reviewer batch-update out-of-scope=%d, want 403", res.StatusCode)
	}

	// --- 3. Dual (Matches BOTH Role A "销售" AND Role B "审核" -> Union on View 1) ---
	dualSnap := rbacGetSnapshot(t, dualCli, baseURL)
	if !dualSnap.EffectivePermissions.CanAddRecord || !dualSnap.EffectivePermissions.CanDeleteRecord || dualSnap.EffectivePermissions.OnlyOwnRecords {
		t.Fatalf("dual effectivePermissions mismatch: %+v", dualSnap.EffectivePermissions)
	}
	if !slices.Equal(dualSnap.EffectivePermissions.MatchedRoles, []string{"销售", "审核"}) {
		t.Fatalf("dual matchedRoles=%v, want [销售 审核]", dualSnap.EffectivePermissions.MatchedRoles)
	}
	// noteF is readonly in Role A and edit in Role B -> union = edit (not in readonlyFieldIds)!
	if slices.Contains(dualSnap.EffectivePermissions.ReadonlyFieldIDs, noteF.ID) {
		t.Fatalf("dual union should unlock noteF to edit, got readonly=%v", dualSnap.EffectivePermissions.ReadonlyFieldIDs)
	}
	// amountF is readonly in both -> remains readonly; secretF is hidden in both -> remains hidden.
	if !slices.Contains(dualSnap.EffectivePermissions.ReadonlyFieldIDs, amountF.ID) ||
		!slices.Contains(dualSnap.EffectivePermissions.HiddenFieldIDs, secretF.ID) {
		t.Fatalf("dual field perms mismatch: %+v", dualSnap.EffectivePermissions)
	}

	// Dual can add a draft record (Role A canAddRecord=true) and see BOTH own draft AND ownerPending!
	var dualDraft store.Record
	res = post(t, dualCli, baseURL+"/records", map[string]any{"cells": map[string]any{primaryK: "双角色草稿", statusK: "草稿"}})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("dual add record=%d, want 201", res.StatusCode)
	}
	json.NewDecoder(res.Body).Decode(&dualDraft)
	res.Body.Close()

	dualSnap = rbacGetSnapshot(t, dualCli, baseURL)
	seenDualDraft, seenOwnerPending, seenOwnerDraft := false, false, false
	for _, r := range dualSnap.Records {
		switch r.ID {
		case dualDraft.ID:
			seenDualDraft = true
		case ownerPending.ID:
			seenOwnerPending = true
		case ownerDraft.ID:
			seenOwnerDraft = true
		}
	}
	if !seenDualDraft || !seenOwnerPending || seenOwnerDraft {
		t.Fatalf("dual row scope union mismatch: dualDraft=%v ownerPending=%v ownerDraft=%v", seenDualDraft, seenOwnerPending, seenOwnerDraft)
	}
	// Dual can edit noteF on ownerPending (200), blocked on amountF (403), blocked on ownerDraft (403), and can delete own dualDraft (204).
	if res := send(t, dualCli, http.MethodPatch, ownerPendingURL, map[string]any{"cells": map[string]any{noteK: "双角色备注"}}); res.StatusCode != http.StatusOK {
		t.Fatalf("dual patch noteF on ownerPending=%d, want 200", res.StatusCode)
	}
	if res := send(t, dualCli, http.MethodPatch, ownerPendingURL, map[string]any{"cells": map[string]any{amountK: 888}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("dual patch readonly amountF=%d, want 403", res.StatusCode)
	}
	if res := send(t, dualCli, http.MethodPatch, ownerDraftURL, map[string]any{"cells": map[string]any{noteK: "nope"}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("dual patch out-of-scope ownerDraft=%d, want 403", res.StatusCode)
	}
	if res := send(t, dualCli, http.MethodDelete, baseURL+"/records/"+strconv.FormatInt(dualDraft.ID, 10), nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("dual delete own record=%d, want 204", res.StatusCode)
	}

	// --- 4. Fallback user (matches 0 custom roles -> Case B default rule compatibility) ---
	fbSnap := rbacGetSnapshot(t, fallbackCli, baseURL)
	if !fbSnap.EffectivePermissions.CanAddRecord || !fbSnap.EffectivePermissions.CanDeleteRecord || !fbSnap.EffectivePermissions.OnlyOwnRecords {
		t.Fatalf("fallback effectivePermissions mismatch: %+v", fbSnap.EffectivePermissions)
	}
	if len(fbSnap.EffectivePermissions.MatchedRoles) != 0 {
		t.Fatalf("fallback matchedRoles=%v, want empty", fbSnap.EffectivePermissions.MatchedRoles)
	}
	if len(fbSnap.Records) != 0 {
		t.Fatalf("fallback default onlyOwnRecords leaked rows: %d", len(fbSnap.Records))
	}
	if !slices.Contains(fbSnap.EffectivePermissions.HiddenFieldIDs, secretF.ID) {
		t.Fatalf("fallback should inherit default hidden secretF: %+v", fbSnap.EffectivePermissions)
	}

	// --- 5. Manager bypasses all restrictions ---
	ownerSnap := rbacGetSnapshot(t, owner, baseURL)
	if !ownerSnap.EffectivePermissions.CanAddRecord || !ownerSnap.EffectivePermissions.CanDeleteRecord ||
		ownerSnap.EffectivePermissions.OnlyOwnRecords || len(ownerSnap.EffectivePermissions.ReadonlyFieldIDs) != 0 ||
		len(ownerSnap.EffectivePermissions.HiddenFieldIDs) != 0 || len(ownerSnap.EffectivePermissions.MatchedRoles) != 0 {
		t.Fatalf("manager effectivePermissions should be unrestricted: %+v", ownerSnap.EffectivePermissions)
	}
	if len(ownerSnap.Views) != 2 {
		t.Fatalf("manager should see all views, got %d", len(ownerSnap.Views))
	}
	if res := send(t, owner, http.MethodPatch, salesRecURL, map[string]any{"cells": map[string]any{amountK: 500, secretK: "MGR"}}); res.StatusCode != http.StatusOK {
		t.Fatalf("manager edit all fields=%d, want 200", res.StatusCode)
	}
}

func TestBaseRBACDepartmentAndGroupMatching(t *testing.T) {
	st := store.NewMemory()
	ts, ownerCli := newTestServer(t, st, nil)
	res := post(t, ownerCli, ts.URL+"/api/auth/register", map[string]string{
		"email": "org-rbac-owner@example.test", "name": "OrgOwner", "password": "password123",
	})
	var ownerReg struct {
		User store.User `json:"user"`
	}
	json.NewDecoder(res.Body).Decode(&ownerReg)
	res.Body.Close()

	aliceCli, aliceUser := rbacRegisterClient(t, ts.URL, "org-rbac-alice@example.test", "Alice")
	bobCli, bobUser := rbacRegisterClient(t, ts.URL, "org-rbac-bob@example.test", "Bob")

	// Owner's personal workspace.
	wsList, err := st.Workspaces(context.Background(), ownerReg.User.ID)
	if err != nil || len(wsList) == 0 {
		t.Fatalf("workspaces=%v err=%v", wsList, err)
	}
	wsID := wsList[0].ID
	if err := st.AddWorkspaceMember(context.Background(), wsID, aliceUser.ID); err != nil {
		t.Fatal(err)
	}
	if err := st.AddWorkspaceMember(context.Background(), wsID, bobUser.ID); err != nil {
		t.Fatal(err)
	}

	// Create Parent Dept -> Child Dept (Alice is in Child Dept), and Group (Bob is in Group).
	wsURL := ts.URL + "/api/workspaces/" + strconv.FormatInt(wsID, 10)
	var parentDept, childDept store.OrgDepartment
	res = rbacReqWithUser(t, ownerCli, http.MethodPost, wsURL+"/departments", ownerReg.User.ID, map[string]any{"name": "销售中心"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create parentDept=%d", res.StatusCode)
	}
	json.NewDecoder(res.Body).Decode(&parentDept)
	res.Body.Close()

	res = rbacReqWithUser(t, ownerCli, http.MethodPost, wsURL+"/departments", ownerReg.User.ID, map[string]any{"name": "华东销售组", "parentId": parentDept.ID})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create childDept=%d", res.StatusCode)
	}
	json.NewDecoder(res.Body).Decode(&childDept)
	res.Body.Close()

	res = rbacReqWithUser(t, ownerCli, http.MethodPut, wsURL+"/departments/"+strconv.FormatInt(childDept.ID, 10)+"/members", ownerReg.User.ID, map[string]any{
		"userId": aliceUser.ID, "present": true,
	})
	if res.StatusCode != http.StatusNoContent && res.StatusCode != http.StatusOK {
		t.Fatalf("add alice to childDept=%d", res.StatusCode)
	}
	res.Body.Close()

	var finGroup store.OrgGroup
	res = rbacReqWithUser(t, ownerCli, http.MethodPost, wsURL+"/groups", ownerReg.User.ID, map[string]any{"name": "财务审核组"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create group=%d", res.StatusCode)
	}
	json.NewDecoder(res.Body).Decode(&finGroup)
	res.Body.Close()

	res = rbacReqWithUser(t, ownerCli, http.MethodPut, wsURL+"/groups/"+strconv.FormatInt(finGroup.ID, 10)+"/members", ownerReg.User.ID, map[string]any{
		"userId": bobUser.ID, "present": true,
	})
	if res.StatusCode != http.StatusNoContent && res.StatusCode != http.StatusOK {
		t.Fatalf("add bob to finGroup=%d", res.StatusCode)
	}
	res.Body.Close()

	// Create base in workspace wsID.
	var base store.DocMeta
	json.NewDecoder(post(t, ownerCli, ts.URL+"/api/bases", map[string]any{"title": "组织权限表", "workspaceId": wsID}).Body).Decode(&base)
	baseURL := ts.URL + "/api/bases/" + strconv.FormatInt(base.ID, 10)
	initSnap := rbacGetSnapshot(t, ownerCli, baseURL)
	primaryF := initSnap.Fields[0]

	var amountF, secretF store.Field
	json.NewDecoder(post(t, ownerCli, baseURL+"/fields", map[string]any{"name": "合同金额", "type": "number"}).Body).Decode(&amountF)
	json.NewDecoder(post(t, ownerCli, baseURL+"/fields", map[string]any{"name": "成本底价", "type": "number"}).Body).Decode(&secretF)

	primaryK := strconv.FormatInt(primaryF.ID, 10)
	amountK := strconv.FormatInt(amountF.ID, 10)
	secretK := strconv.FormatInt(secretF.ID, 10)

	// Seed records: low amount (100), high amount (800).
	var lowRec, highRec store.Record
	json.NewDecoder(post(t, ownerCli, baseURL+"/records", map[string]any{"cells": map[string]any{primaryK: "小单", amountK: 100, secretK: 50}}).Body).Decode(&lowRec)
	json.NewDecoder(post(t, ownerCli, baseURL+"/records", map[string]any{"cells": map[string]any{primaryK: "大单", amountK: 800, secretK: 400}}).Body).Decode(&highRec)

	// Configure department-based Role (parentDept -> matches Alice via childDept!) & group-based Role (finGroup -> matches Bob!).
	viewURL := baseURL + "/views/" + strconv.FormatInt(initSnap.Views[0].ID, 10)
	if res := send(t, ownerCli, http.MethodPatch, viewURL, map[string]any{
		"config": map[string]any{
			"permissions": map[string]any{
				"roles": []map[string]any{
					{
						"id":              "dept-sales",
						"name":            "销售部门",
						"deptIds":         []int64{parentDept.ID},
						"canAddRecord":    true,
						"canDeleteRecord": false,
						"rowScope":        "own",
						"fieldModes":      map[string]string{secretK: "hidden"},
					},
					{
						"id":              "group-fin",
						"name":            "财务组",
						"groupIds":        []int64{finGroup.ID},
						"canAddRecord":    false,
						"canDeleteRecord": false,
						"rowScope":        "filter",
						"rowFilters": map[string]any{
							"conj":  "and",
							"rules": []map[string]any{{"f": amountF.ID, "op": "gte", "v": 500}},
						},
						"fieldModes": map[string]string{primaryK: "readonly"},
					},
				},
			},
		},
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("save dept/group RBAC=%d, want 200", res.StatusCode)
	}

	// Alice matches via ancestor department (parentDept).
	aliceSnap := rbacGetSnapshot(t, aliceCli, baseURL)
	if !slices.Equal(aliceSnap.EffectivePermissions.MatchedRoles, []string{"销售部门"}) {
		t.Fatalf("alice matchedRoles=%v, want [销售部门]", aliceSnap.EffectivePermissions.MatchedRoles)
	}
	if !aliceSnap.EffectivePermissions.CanAddRecord || aliceSnap.EffectivePermissions.CanDeleteRecord || !aliceSnap.EffectivePermissions.OnlyOwnRecords {
		t.Fatalf("alice effectivePermissions=%+v", aliceSnap.EffectivePermissions)
	}
	if len(aliceSnap.Records) != 0 {
		t.Fatalf("alice should see 0 owner records, got %d", len(aliceSnap.Records))
	}
	// Alice creates her own record, cannot delete it (canDeleteRecord=false), and cannot CSV-import hidden secretF.
	var aliceRec store.Record
	res = post(t, aliceCli, baseURL+"/records", map[string]any{"cells": map[string]any{primaryK: "Alice单", amountK: 300}})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("alice add record=%d, want 201", res.StatusCode)
	}
	json.NewDecoder(res.Body).Decode(&aliceRec)
	res.Body.Close()
	if res := send(t, aliceCli, http.MethodDelete, baseURL+"/records/"+strconv.FormatInt(aliceRec.ID, 10), nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("alice delete own record when canDeleteRecord=false: %d, want 403", res.StatusCode)
	}
	if res := post(t, aliceCli, baseURL+"/import", map[string]any{"csv": "文本,成本底价\n导入,99", "header": true}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("alice CSV import hidden field=%d, want 403", res.StatusCode)
	}
	// Alice CSV export must strip hidden field and include only her own row.
	exportRes := cGet(t, aliceCli, baseURL+"/export")
	exportBody, _ := io.ReadAll(exportRes.Body)
	exportRes.Body.Close()
	if exportRes.StatusCode != http.StatusOK {
		t.Fatalf("alice CSV export=%d, want 200", exportRes.StatusCode)
	}
	csvText := string(exportBody)
	if strings.Contains(csvText, "成本底价") || strings.Contains(csvText, "大单") || !strings.Contains(csvText, "Alice单") {
		t.Fatalf("alice CSV export leaked restricted data: %q", csvText)
	}

	// Bob matches via group (finGroup).
	bobSnap := rbacGetSnapshot(t, bobCli, baseURL)
	if !slices.Equal(bobSnap.EffectivePermissions.MatchedRoles, []string{"财务组"}) {
		t.Fatalf("bob matchedRoles=%v, want [财务组]", bobSnap.EffectivePermissions.MatchedRoles)
	}
	if bobSnap.EffectivePermissions.CanAddRecord || bobSnap.EffectivePermissions.CanDeleteRecord {
		t.Fatalf("bob effectivePermissions=%+v", bobSnap.EffectivePermissions)
	}
	if len(bobSnap.Records) != 1 || bobSnap.Records[0].ID != highRec.ID {
		t.Fatalf("bob should see ONLY highRec (amount>=500), got %+v", bobSnap.Records)
	}
	// Bob cannot edit readonly primary field (403), CAN edit editable amount field on highRec (200), cannot edit lowRec (403).
	if res := send(t, bobCli, http.MethodPatch, baseURL+"/records/"+strconv.FormatInt(highRec.ID, 10), map[string]any{"cells": map[string]any{primaryK: "改名"}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("bob patch readonly primary=%d, want 403", res.StatusCode)
	}
	if res := send(t, bobCli, http.MethodPatch, baseURL+"/records/"+strconv.FormatInt(highRec.ID, 10), map[string]any{"cells": map[string]any{amountK: 900}}); res.StatusCode != http.StatusOK {
		t.Fatalf("bob patch editable amount on highRec=%d, want 200", res.StatusCode)
	}
	if res := send(t, bobCli, http.MethodPatch, baseURL+"/records/"+strconv.FormatInt(lowRec.ID, 10), map[string]any{"cells": map[string]any{amountK: 999}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("bob patch out-of-scope lowRec=%d, want 403", res.StatusCode)
	}
}
