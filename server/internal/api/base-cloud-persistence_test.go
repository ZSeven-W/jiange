package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestBaseCloudPermissionsServerEnforced(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{
		"email": "perm-owner@example.test", "name": "Owner", "password": "password123",
	})
	jar, _ := cookiejar.New(nil)
	editor := &http.Client{Jar: jar}
	post(t, editor, ts.URL+"/api/auth/register", map[string]string{
		"email": "perm-editor@example.test", "name": "Editor", "password": "password123",
	})

	var base store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/bases", map[string]string{"title": "权限表"}).Body).Decode(&base)
	baseURL := ts.URL + "/api/bases/" + strconv.FormatInt(base.ID, 10)

	var editF, roF, hidF, roDateF, editDateF store.Field
	json.NewDecoder(post(t, owner, baseURL+"/fields", map[string]string{"name": "可编辑列", "type": "text"}).Body).Decode(&editF)
	json.NewDecoder(post(t, owner, baseURL+"/fields", map[string]string{"name": "只读列", "type": "text"}).Body).Decode(&roF)
	json.NewDecoder(post(t, owner, baseURL+"/fields", map[string]string{"name": "隐藏列", "type": "text"}).Body).Decode(&hidF)
	json.NewDecoder(post(t, owner, baseURL+"/fields", map[string]string{"name": "只读日期", "type": "date"}).Body).Decode(&roDateF)
	json.NewDecoder(post(t, owner, baseURL+"/fields", map[string]string{"name": "可编辑日期", "type": "date"}).Body).Decode(&editDateF)

	editK := strconv.FormatInt(editF.ID, 10)
	roK := strconv.FormatInt(roF.ID, 10)
	hidK := strconv.FormatInt(hidF.ID, 10)
	roDateK := strconv.FormatInt(roDateF.ID, 10)
	editDateK := strconv.FormatInt(editDateF.ID, 10)

	var ownerRec store.Record
	json.NewDecoder(post(t, owner, baseURL+"/records", map[string]any{
		"cells": map[string]any{
			editK:     "owner-val",
			roK:       "owner-ro",
			hidK:      "TOP_SECRET",
			roDateK:   "2026-11-10",
			editDateK: "2026-11-12",
		},
	}).Body).Decode(&ownerRec)

	if res := send(t, owner, http.MethodPut, ts.URL+"/api/docs/"+strconv.FormatInt(base.ID, 10)+"/shares", map[string]any{
		"email": "perm-editor@example.test", "role": "edit",
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("share failed: %d", res.StatusCode)
	}

	views, err := st.Views(context.Background(), base.ID)
	if err != nil || len(views) == 0 {
		t.Fatalf("views=%v err=%v", views, err)
	}
	viewID := views[0].ID
	viewURL := baseURL + "/views/" + strconv.FormatInt(viewID, 10)

	permsCfg := map[string]any{
		"permissions": map[string]any{
			"onlyOwnRecords": true,
			"fieldModes": map[string]string{
				editK:   "edit",
				roK:     "readonly",
				hidK:    "hidden",
				roDateK: "readonly",
			},
		},
	}

	// Non-manager cannot configure view permissions on PATCH or POST.
	if res := send(t, editor, http.MethodPatch, viewURL, map[string]any{"config": permsCfg}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("editor patch permissions=%d, want 403", res.StatusCode)
	}
	if res := post(t, editor, baseURL+"/views", map[string]any{"name": "bad", "type": "grid", "config": permsCfg}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("editor add permissions view=%d, want 403", res.StatusCode)
	}

	// Personal view cannot carry permissions even for manager.
	if res := post(t, owner, baseURL+"/views", map[string]any{"name": "个人", "type": "grid", "isPersonal": true, "config": permsCfg}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("personal permissions view=%d, want 400", res.StatusCode)
	}

	// Invalid field ID or invalid mode rejected with 400.
	if res := send(t, owner, http.MethodPatch, viewURL, map[string]any{
		"config": map[string]any{"permissions": map[string]any{"fieldModes": map[string]string{"999999": "readonly"}}},
	}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown field mode=%d, want 400", res.StatusCode)
	}
	if res := send(t, owner, http.MethodPatch, viewURL, map[string]any{
		"config": map[string]any{"permissions": map[string]any{"fieldModes": map[string]string{roK: "admin"}}},
	}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid mode=%d, want 400", res.StatusCode)
	}

	// Manager saves fine-grained permissions (without locked=true).
	if res := send(t, owner, http.MethodPatch, viewURL, map[string]any{"config": permsCfg}); res.StatusCode != http.StatusOK {
		t.Fatalf("owner save permissions=%d, want 200", res.StatusCode)
	}

	// Editor GET: writeRestricted=false, ownerRec hidden by onlyOwnRecords, hidF stripped from fields and views.
	var editorSnap struct {
		Fields          []store.Field  `json:"fields"`
		Records         []store.Record `json:"records"`
		Views           []store.View   `json:"views"`
		WriteRestricted bool           `json:"writeRestricted"`
	}
	if res := cGet(t, editor, baseURL); res.StatusCode != http.StatusOK {
		t.Fatalf("editor GET=%d", res.StatusCode)
	} else {
		json.NewDecoder(res.Body).Decode(&editorSnap)
	}
	if editorSnap.WriteRestricted {
		t.Fatal("permissions-only view must not mark writeRestricted=true")
	}
	if len(editorSnap.Records) != 0 {
		t.Fatalf("onlyOwnRecords leaked owner rows: %+v", editorSnap.Records)
	}
	for _, f := range editorSnap.Fields {
		if f.ID == hidF.ID {
			t.Fatal("hidden field leaked in GET fields")
		}
	}
	var viewCfgObj struct {
		Permissions struct {
			OnlyOwnRecords bool              `json:"onlyOwnRecords"`
			FieldModes     map[string]string `json:"fieldModes"`
		} `json:"permissions"`
	}
	if err := json.Unmarshal(editorSnap.Views[0].Config, &viewCfgObj); err != nil {
		t.Fatalf("unmarshal view config: %v", err)
	}
	if !viewCfgObj.Permissions.OnlyOwnRecords || viewCfgObj.Permissions.FieldModes[roK] != "readonly" {
		t.Fatalf("editor view permissions missing readonly/onlyOwnRecords: %+v", viewCfgObj.Permissions)
	}
	if _, leaked := viewCfgObj.Permissions.FieldModes[hidK]; leaked {
		t.Fatal("hidden field id leaked in view permissions metadata")
	}

	// Editor addRecord: writing readonly or hidden field returns 403; writing editable fields succeeds.
	if res := post(t, editor, baseURL+"/records", map[string]any{"cells": map[string]any{roK: "forged"}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("addRecord readonly=%d, want 403", res.StatusCode)
	}
	if res := post(t, editor, baseURL+"/records", map[string]any{"cells": map[string]any{hidK: "forged"}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("addRecord hidden=%d, want 403", res.StatusCode)
	}
	var editorRec store.Record
	res := post(t, editor, baseURL+"/records", map[string]any{"cells": map[string]any{editK: "mine", editDateK: "2026-11-15"}})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("editor addRecord editable=%d, want 201", res.StatusCode)
	}
	json.NewDecoder(res.Body).Decode(&editorRec)

	// Editor query returns ONLY editorRec and rejects hidden field filter.
	res = post(t, editor, baseURL+"/query", map[string]any{})
	var qOut struct{ Records []store.Record }
	json.NewDecoder(res.Body).Decode(&qOut)
	if res.StatusCode != http.StatusOK || len(qOut.Records) != 1 || qOut.Records[0].ID != editorRec.ID {
		t.Fatalf("editor query=%d recs=%+v", res.StatusCode, qOut.Records)
	}
	if res := post(t, editor, baseURL+"/query", map[string]any{
		"filters": map[string]any{"conj": "and", "rules": []map[string]any{{"f": hidF.ID, "op": "is", "v": "TOP_SECRET"}}},
	}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("hidden filter oracle=%d, want 400", res.StatusCode)
	}

	editorRecURL := baseURL + "/records/" + strconv.FormatInt(editorRec.ID, 10)
	ownerRecURL := baseURL + "/records/" + strconv.FormatInt(ownerRec.ID, 10)

	// PATCH cells: own record editable=200, own record readonly/hidden=403, other user's record=403.
	if res := send(t, editor, http.MethodPatch, editorRecURL, map[string]any{"cells": map[string]any{editK: "mine-updated"}}); res.StatusCode != http.StatusOK {
		t.Fatalf("editor patch own editable=%d, want 200", res.StatusCode)
	}
	if res := send(t, editor, http.MethodPatch, editorRecURL, map[string]any{"cells": map[string]any{roK: "hack"}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("editor patch own readonly=%d, want 403", res.StatusCode)
	}
	if res := send(t, editor, http.MethodPatch, editorRecURL, map[string]any{"cells": map[string]any{hidK: "hack"}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("editor patch own hidden=%d, want 403", res.StatusCode)
	}
	if res := send(t, editor, http.MethodPatch, ownerRecURL, map[string]any{"cells": map[string]any{editK: "hack-owner"}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("editor patch owner record=%d, want 403", res.StatusCode)
	}
	if res := send(t, editor, http.MethodDelete, ownerRecURL, nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("editor delete owner record=%d, want 403", res.StatusCode)
	}

	// compare-cells: readonly date=403, owner record=403, own editable date=200.
	if res := send(t, editor, http.MethodPatch, editorRecURL+"/compare-cells", map[string]any{
		"expected": map[string]any{roDateK: nil}, "cells": map[string]any{roDateK: "2026-11-20"},
	}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("editor compare readonly date=%d, want 403", res.StatusCode)
	}
	if res := send(t, editor, http.MethodPatch, ownerRecURL+"/compare-cells", map[string]any{
		"expected": map[string]any{editDateK: "2026-11-12"}, "cells": map[string]any{editDateK: "2026-11-20"},
	}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("editor compare owner record=%d, want 403", res.StatusCode)
	}
	if res := send(t, editor, http.MethodPatch, editorRecURL+"/compare-cells", map[string]any{
		"expected": map[string]any{editDateK: "2026-11-15"}, "cells": map[string]any{editDateK: "2026-11-18"},
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("editor compare own editable date=%d, want 200", res.StatusCode)
	}

	// batch-update and batch-delete: readonly=403, owner record=403, own editable=200.
	if res := post(t, editor, baseURL+"/records/batch-update", map[string]any{
		"updates": []map[string]any{{"id": editorRec.ID, "cells": map[string]any{roK: "hack"}}},
	}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("editor batch-update readonly=%d, want 403", res.StatusCode)
	}
	if res := post(t, editor, baseURL+"/records/batch-update", map[string]any{
		"updates": []map[string]any{{"id": ownerRec.ID, "cells": map[string]any{editK: "hack"}}},
	}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("editor batch-update owner record=%d, want 403", res.StatusCode)
	}
	if res := post(t, editor, baseURL+"/records/batch-delete", map[string]any{
		"ids": []int64{ownerRec.ID},
	}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("editor batch-delete owner record=%d, want 403", res.StatusCode)
	}
	if res := post(t, editor, baseURL+"/records/batch-update", map[string]any{
		"updates": []map[string]any{{"id": editorRec.ID, "cells": map[string]any{editK: "batch-ok"}}},
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("editor batch-update own editable=%d, want 200", res.StatusCode)
	}

	// Editor cannot clear permissions or delete the permission view or restricted fields.
	if res := send(t, editor, http.MethodPatch, viewURL, map[string]any{"config": map[string]any{}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("editor clear permissions=%d, want 403", res.StatusCode)
	}
	if res := send(t, editor, http.MethodDelete, viewURL, nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("editor delete permission view=%d, want 403", res.StatusCode)
	}
	if res := send(t, editor, http.MethodDelete, baseURL+"/fields/"+roK, nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("editor delete readonly field=%d, want 403", res.StatusCode)
	}

	// Manager bypasses all restrictions: sees both ownerRec and editorRec, hidden field, and can edit readonly/hidden on editorRec.
	var ownerSnap struct {
		Fields  []store.Field  `json:"fields"`
		Records []store.Record `json:"records"`
	}
	json.NewDecoder(cGet(t, owner, baseURL).Body).Decode(&ownerSnap)
	sawOwnerRec, sawEditorRec := false, false
	for _, r := range ownerSnap.Records {
		if r.ID == ownerRec.ID {
			sawOwnerRec = true
		}
		if r.ID == editorRec.ID {
			sawEditorRec = true
		}
	}
	if !sawOwnerRec || !sawEditorRec {
		t.Fatalf("manager should see both ownerRec and editorRec (owner=%v editor=%v, total=%d)", sawOwnerRec, sawEditorRec, len(ownerSnap.Records))
	}
	hasHidden := false
	for _, f := range ownerSnap.Fields {
		if f.ID == hidF.ID {
			hasHidden = true
		}
	}
	if !hasHidden {
		t.Fatal("manager missing hidden field")
	}
	if res := send(t, owner, http.MethodPatch, editorRecURL, map[string]any{
		"cells": map[string]any{roK: "mgr-ro", hidK: "mgr-hid"},
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("manager edit readonly/hidden on editor record=%d, want 200", res.StatusCode)
	}

	// Editor can still delete their own record.
	if res := send(t, editor, http.MethodDelete, editorRecURL, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("editor delete own record=%d, want 204", res.StatusCode)
	}
}

func TestBaseCloudFormBranchingPersistenceAndSubmit(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{
		"email": "branch-owner@example.test", "name": "Owner", "password": "password123",
	})
	var base store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/bases", map[string]string{"title": "收集表"}).Body).Decode(&base)
	baseURL := ts.URL + "/api/bases/" + strconv.FormatInt(base.ID, 10)

	var custType, compName, taxID, needInv, invTitle store.Field
	json.NewDecoder(post(t, owner, baseURL+"/fields", map[string]any{"name": "客户类型", "type": "select", "options": []string{"个人", "企业"}}).Body).Decode(&custType)
	json.NewDecoder(post(t, owner, baseURL+"/fields", map[string]any{"name": "企业名称", "type": "text"}).Body).Decode(&compName)
	json.NewDecoder(post(t, owner, baseURL+"/fields", map[string]any{"name": "税号", "type": "text"}).Body).Decode(&taxID)
	json.NewDecoder(post(t, owner, baseURL+"/fields", map[string]any{"name": "需要发票", "type": "checkbox"}).Body).Decode(&needInv)
	json.NewDecoder(post(t, owner, baseURL+"/fields", map[string]any{"name": "发票抬头", "type": "text"}).Body).Decode(&invTitle)

	var formView store.View
	json.NewDecoder(post(t, owner, baseURL+"/views", map[string]any{"name": "问卷", "type": "form"}).Body).Decode(&formView)
	formConfigURL := baseURL + "/views/" + strconv.FormatInt(formView.ID, 10) + "/form-config"

	getSnapshot := func() (json.RawMessage, []store.Field) {
		var snap struct {
			Fields []store.Field `json:"fields"`
			Views  []store.View  `json:"views"`
		}
		json.NewDecoder(cGet(t, owner, baseURL).Body).Decode(&snap)
		for _, v := range snap.Views {
			if v.ID == formView.ID {
				cfg := v.Config
				if len(cfg) == 0 {
					cfg = json.RawMessage(`{}`)
				}
				return cfg, snap.Fields
			}
		}
		t.Fatal("form view not found")
		return nil, nil
	}

	selectedIDs := []int64{custType.ID, compName.ID, taxID.ID, needInv.ID, invTitle.ID}
	requiredIDs := []int64{custType.ID, compName.ID, taxID.ID}

	// Reject circular branching rules with 400.
	expCfg, expFields := getSnapshot()
	cyclicBody := map[string]any{
		"expectedConfig": expCfg,
		"expectedFields": expFields,
		"config": map[string]any{
			"title":    "客户登记",
			"fields":   selectedIDs,
			"required": requiredIDs,
			"branchRules": []map[string]any{
				{"id": "c1", "sourceFieldId": custType.ID, "targetFieldId": compName.ID, "operator": "eq", "value": "企业"},
				{"id": "c2", "sourceFieldId": compName.ID, "targetFieldId": custType.ID, "operator": "not_empty"},
			},
		},
	}
	if res := post(t, owner, formConfigURL, cyclicBody); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("cyclic branchRules=%d, want 400", res.StatusCode)
	}

	// Reject unknown operator with 400.
	invalidOpBody := map[string]any{
		"expectedConfig": expCfg,
		"expectedFields": expFields,
		"config": map[string]any{
			"title":  "客户登记",
			"fields": selectedIDs,
			"branchRules": []map[string]any{
				{"id": "bad1", "sourceFieldId": custType.ID, "targetFieldId": compName.ID, "operator": "regex", "value": ".*"},
			},
		},
	}
	if res := post(t, owner, formConfigURL, invalidOpBody); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid operator=%d, want 400", res.StatusCode)
	}

	// Save valid chained branching rules via form-config.
	validRules := []map[string]any{
		{"id": "r1", "sourceFieldId": custType.ID, "targetFieldId": compName.ID, "operator": "eq", "value": "企业"},
		{"id": "r2", "sourceFieldId": compName.ID, "targetFieldId": taxID.ID, "operator": "not_empty"},
		{"id": "r3", "sourceFieldId": needInv.ID, "targetFieldId": invTitle.ID, "operator": "checked"},
	}
	saveBody := map[string]any{
		"expectedConfig": expCfg,
		"expectedFields": expFields,
		"config": map[string]any{
			"title":       "客户登记",
			"desc":        "请选择客户类型",
			"fields":      selectedIDs,
			"required":    requiredIDs,
			"branchRules": validRules,
		},
	}
	if res := post(t, owner, formConfigURL, saveBody); res.StatusCode != http.StatusOK {
		t.Fatalf("save branchRules=%d, want 200", res.StatusCode)
	}

	// Publish public form and fetch anonymously.
	token := publishTestForm(t, owner, baseURL, formView.ID)
	anon := &http.Client{}
	publicURL := ts.URL + "/api/forms/" + token

	getResp, err := anon.Get(publicURL)
	if err != nil || getResp.StatusCode != http.StatusOK {
		t.Fatalf("GET public form=%v err=%v", getResp, err)
	}
	var pubForm struct {
		Title       string           `json:"title"`
		Fields      []formField      `json:"fields"`
		BranchRules []formBranchRule `json:"branchRules"`
	}
	json.NewDecoder(getResp.Body).Decode(&pubForm)
	getResp.Body.Close()
	if len(pubForm.BranchRules) != 3 || pubForm.BranchRules[0].ID != "r1" || pubForm.BranchRules[1].Operator != "not_empty" {
		t.Fatalf("GET public form missing branchRules: %+v", pubForm.BranchRules)
	}

	ctK := strconv.FormatInt(custType.ID, 10)
	cnK := strconv.FormatInt(compName.ID, 10)
	txK := strconv.FormatInt(taxID.ID, 10)

	beforeRecs, err := st.Records(context.Background(), base.ID)
	if err != nil {
		t.Fatal(err)
	}
	beforeCount := len(beforeRecs)

	// 1. Personal customer: companyName & taxID are hidden, so omitting them succeeds (201) AND forged hidden values are stripped!
	res := post(t, anon, publicURL, map[string]any{
		"cells": map[string]any{ctK: "个人", cnK: "SHOULD_BE_STRIPPED", txK: "STRIP_ME"},
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("hidden required bypass failed: %d", res.StatusCode)
	}
	res.Body.Close()

	// 2. Enterprise customer without companyName (now visible & required): must fail 400!
	res = post(t, anon, publicURL, map[string]any{"cells": map[string]any{ctK: "企业"}})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("visible required companyName missing=%d, want 400", res.StatusCode)
	}
	res.Body.Close()

	// 3. Enterprise customer with companyName but missing chained required taxID: must fail 400!
	res = post(t, anon, publicURL, map[string]any{"cells": map[string]any{ctK: "企业", cnK: "简格科技"}})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("chained visible required taxID missing=%d, want 400", res.StatusCode)
	}
	res.Body.Close()

	// 4. Enterprise customer with all visible required fields filled: succeeds (201)!
	res = post(t, anon, publicURL, map[string]any{
		"cells": map[string]any{ctK: "企业", cnK: "简格科技", txK: "91310000"},
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("full enterprise submit=%d, want 201", res.StatusCode)
	}
	res.Body.Close()

	// Verify stored records: first submitted record had hidden fields stripped; second kept all 3.
	recs, err := st.Records(context.Background(), base.ID)
	if err != nil || len(recs) != beforeCount+2 {
		t.Fatalf("stored records=%d (before=%d) err=%v", len(recs), beforeCount, err)
	}
	personalSub := recs[beforeCount]
	enterpriseSub := recs[beforeCount+1]
	if _, leaked := personalSub.Cells[cnK]; leaked {
		t.Fatalf("hidden cell companyName was not stripped on submit: %+v", personalSub.Cells)
	}
	if _, leaked := personalSub.Cells[txK]; leaked {
		t.Fatalf("hidden cell taxID was not stripped on submit: %+v", personalSub.Cells)
	}
	if string(enterpriseSub.Cells[cnK]) != `"简格科技"` || string(enterpriseSub.Cells[txK]) != `"91310000"` {
		t.Fatalf("enterprise cells missing: %+v", enterpriseSub.Cells)
	}
}

func TestBaseCloudGanttDependenciesPersistenceAndValidation(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{
		"email": "gantt-owner@example.test", "name": "Owner", "password": "password123",
	})
	var base store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/bases", map[string]string{"title": "甘特表"}).Body).Decode(&base)
	baseURL := ts.URL + "/api/bases/" + strconv.FormatInt(base.ID, 10)

	var ganttView store.View
	json.NewDecoder(post(t, owner, baseURL+"/views", map[string]any{"name": "甘特", "type": "gantt"}).Body).Decode(&ganttView)
	viewURL := baseURL + "/views/" + strconv.FormatInt(ganttView.ID, 10)

	// Reject cycle (1->2->3->1) with 400.
	if res := send(t, owner, http.MethodPatch, viewURL, map[string]any{
		"config": map[string]any{
			"ganttDeps": []map[string]any{
				{"id": "d1", "fromId": 1, "toId": 2},
				{"id": "d2", "fromId": 2, "toId": 3},
				{"id": "d3", "fromId": 3, "toId": 1},
			},
		},
	}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("cyclic ganttDeps=%d, want 400", res.StatusCode)
	}

	// Reject self-loop with 400.
	if res := send(t, owner, http.MethodPatch, viewURL, map[string]any{
		"config": map[string]any{"ganttDeps": []map[string]any{{"id": "s", "fromId": 5, "toId": 5}}},
	}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("self-loop ganttDeps=%d, want 400", res.StatusCode)
	}

	// Save valid diamond DAG and verify reload from GET /api/bases/{id}.
	validDeps := []map[string]any{
		{"id": "d1", "fromId": 10, "toId": 20},
		{"id": "d2", "fromId": 10, "toId": 30},
		{"id": "d3", "fromId": 20, "toId": 40},
		{"id": "d4", "fromId": 30, "toId": 40},
	}
	if res := send(t, owner, http.MethodPatch, viewURL, map[string]any{
		"config": map[string]any{"ganttDeps": validDeps},
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("save valid ganttDeps=%d, want 200", res.StatusCode)
	}

	var snap struct {
		Views []store.View `json:"views"`
	}
	json.NewDecoder(cGet(t, owner, baseURL).Body).Decode(&snap)
	found := false
	for _, v := range snap.Views {
		if v.ID == ganttView.ID {
			var cfg struct {
				GanttDeps []struct {
					ID     string `json:"id"`
					FromID int64  `json:"fromId"`
					ToID   int64  `json:"toId"`
				} `json:"ganttDeps"`
			}
			if err := json.Unmarshal(v.Config, &cfg); err != nil {
				t.Fatalf("unmarshal gantt config: %v", err)
			}
			if len(cfg.GanttDeps) != 4 || cfg.GanttDeps[0].FromID != 10 || cfg.GanttDeps[3].ToID != 40 {
				t.Fatalf("reloaded ganttDeps mismatch: %+v", cfg.GanttDeps)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("gantt view missing after reload")
	}
}

func TestBaseCloudLookupRollupOptionPersistenceAndValidation(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{
		"email": "rollup-owner@example.test", "name": "Owner", "password": "password123",
	})
	var tasks, projects store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/bases", map[string]string{"title": "任务表"}).Body).Decode(&tasks)
	json.NewDecoder(post(t, owner, ts.URL+"/api/bases", map[string]string{"title": "项目表"}).Body).Decode(&projects)
	tu := ts.URL + "/api/bases/" + strconv.FormatInt(tasks.ID, 10)
	pu := ts.URL + "/api/bases/" + strconv.FormatInt(projects.ID, 10)

	var budget store.Field
	json.NewDecoder(post(t, owner, pu+"/fields", map[string]any{"name": "预算", "type": "number"}).Body).Decode(&budget)
	var p1, p2 store.Record
	json.NewDecoder(post(t, owner, pu+"/records", map[string]any{"cells": map[string]any{strconv.FormatInt(budget.ID, 10): 100}}).Body).Decode(&p1)
	json.NewDecoder(post(t, owner, pu+"/records", map[string]any{"cells": map[string]any{strconv.FormatInt(budget.ID, 10): 250}}).Body).Decode(&p2)

	var link store.Field
	json.NewDecoder(post(t, owner, tu+"/fields", map[string]any{
		"name": "关联项目", "type": "link", "options": []string{strconv.FormatInt(projects.ID, 10)},
	}).Body).Decode(&link)

	linkStr := strconv.FormatInt(link.ID, 10)
	budgetStr := strconv.FormatInt(budget.ID, 10)

	// Invalid 3rd option rejected with 400.
	if res := post(t, owner, tu+"/fields", map[string]any{
		"name": "错误汇总", "type": "lookup", "options": []string{linkStr, budgetStr, "median"},
	}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid lookup rollup agg=%d, want 400", res.StatusCode)
	}
	if res := post(t, owner, tu+"/fields", map[string]any{
		"name": "多余选项", "type": "lookup", "options": []string{linkStr, budgetStr, "sum", "extra"},
	}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("4 lookup options=%d, want 400", res.StatusCode)
	}

	// Valid 3rd option "sum" accepted and persisted.
	var lookup store.Field
	res := post(t, owner, tu+"/fields", map[string]any{
		"name": "总预算", "type": "lookup", "options": []string{linkStr, budgetStr, "sum"},
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create lookup with sum=%d, want 201", res.StatusCode)
	}
	json.NewDecoder(res.Body).Decode(&lookup)
	if len(lookup.Options) != 3 || lookup.Options[2] != "sum" {
		t.Fatalf("created lookup options=%v", lookup.Options)
	}

	// Patch lookup 3rd option to "avg", reject invalid patch.
	if res := send(t, owner, http.MethodPatch, tu+"/fields/"+strconv.FormatInt(lookup.ID, 10), map[string]any{
		"options": []string{linkStr, budgetStr, "invalid"},
	}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("patch invalid rollup=%d, want 400", res.StatusCode)
	}
	if res := send(t, owner, http.MethodPatch, tu+"/fields/"+strconv.FormatInt(lookup.ID, 10), map[string]any{
		"options": []string{linkStr, budgetStr, "avg"},
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("patch valid rollup=%d, want 200", res.StatusCode)
	}

	// Link task to both projects and verify GET returns persisted options[2]="avg" AND expansions values.
	var task store.Record
	json.NewDecoder(post(t, owner, tu+"/records", map[string]any{"cells": map[string]any{}}).Body).Decode(&task)
	if res := send(t, owner, http.MethodPatch, tu+"/records/"+strconv.FormatInt(task.ID, 10), map[string]any{
		"cells": map[string]any{linkStr: []int64{p1.ID, p2.ID}},
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("link task=%d", res.StatusCode)
	}

	var snap struct {
		Fields     []store.Field  `json:"fields"`
		Expansions map[string]any `json:"expansions"`
	}
	json.NewDecoder(cGet(t, owner, tu).Body).Decode(&snap)
	var reloaded *store.Field
	for i := range snap.Fields {
		if snap.Fields[i].ID == lookup.ID {
			reloaded = &snap.Fields[i]
			break
		}
	}
	if reloaded == nil || len(reloaded.Options) != 3 || reloaded.Options[2] != "avg" {
		t.Fatalf("reloaded lookup field options=%+v", reloaded)
	}
	expRaw, _ := json.Marshal(snap.Expansions[strconv.FormatInt(lookup.ID, 10)])
	var expMap map[string][]float64
	_ = json.Unmarshal(expRaw, &expMap)
	vals := expMap[strconv.FormatInt(task.ID, 10)]
	if len(vals) != 2 || vals[0] != 100 || vals[1] != 250 {
		t.Fatalf("lookup expansion with 3rd option mismatch: %v", vals)
	}
}
