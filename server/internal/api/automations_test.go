package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestAutomations(t *testing.T) {
	st := store.NewMemory()
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "ao@x.com", "name": "Ao", "password": "password123"})
	gj0, _ := cookiejar.New(nil)
	guest := &http.Client{Jar: gj0}
	post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "bo@x.com", "name": "Bo", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)

	// Bo 可以编辑（收到通知）
	send(t, c, "PUT", ts.URL+"/api/docs/"+strconv.FormatInt(b.ID, 10)+"/shares", map[string]any{"email": "bo@x.com", "role": "edit"})

	var status store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "状态", "type": "text"}).Body).Decode(&status)
	sk := strconv.FormatInt(status.ID, 10)

	// record_matches 自动化：状态=完成 → 通知 Bo，消息带 {{状态}} 插值
	cfg := map[string]any{
		"rules":       []map[string]any{{"f": json.Number(sk), "op": "is", "v": "完成"}},
		"conj":        "and",
		"notifyUsers": []int64{2},
		"message":     "任务{{状态}}了，请查收",
	}
	var a store.Automation
	res := post(t, c, u+"/automations", map[string]any{"name": "完成通知", "triggerKind": "record_matches", "config": cfg})
	if res.StatusCode != 201 {
		t.Fatalf("create automation: %d", res.StatusCode)
	}
	json.NewDecoder(res.Body).Decode(&a)

	// 写入匹配记录 → Bo 收到通知（插值生效）
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{sk: "完成"}}).Body).Decode(&store.Record{})
	time.Sleep(20 * time.Millisecond) // 通知在请求内同步写入，这里防御性等待
	post(t, guest, ts.URL+"/api/auth/login", map[string]string{"email": "bo@x.com", "password": "password123"})
	var notif struct {
		Notifications []store.Notification
		Unread        int64
	}
	r := cGet(t, guest, ts.URL+"/api/notifications")
	json.NewDecoder(r.Body).Decode(&notif)
	if notif.Unread != 1 || len(notif.Notifications) != 1 || !strings.Contains(notif.Notifications[0].Preview, "任务完成了") {
		t.Fatalf("automation notification: %+v", notif)
	}

	// 不匹配的记录不触发
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{sk: "进行中"}}).Body).Decode(&store.Record{})
	r = cGet(t, guest, ts.URL+"/api/notifications")
	json.NewDecoder(r.Body).Decode(&notif)
	if notif.Unread != 1 {
		t.Fatalf("non-matching record should not notify: %+v", notif)
	}

	// CRUD 权限：guest(view? no edit ok) 可建；CRUD 完整流程
	res = send(t, c, "PATCH", u+"/automations/"+strconv.FormatInt(a.ID, 10), map[string]any{"enabled": false})
	if res.StatusCode != 200 {
		t.Fatalf("disable: %d", res.StatusCode)
	}
	if res := send(t, c, "DELETE", u+"/automations/"+strconv.FormatInt(a.ID, 10), nil); res.StatusCode != 204 {
		t.Fatalf("delete: %d", res.StatusCode)
	}
}

func TestFormSubmitAutomationAndWebhook(t *testing.T) {
	var hookBody string
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		hookBody = string(b)
		w.WriteHeader(200)
	}))
	defer hook.Close()

	st := store.NewMemory()
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "fw@x.com", "name": "FW", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)
	var fb store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "反馈", "type": "text"}).Body).Decode(&fb)

	// form_submit 自动化 → 通用 webhook
	cfg := map[string]any{
		"notifyUsers": []int64{},
		"message":     "新反馈",
		"webhook":     map[string]any{"url": hook.URL, "kind": "generic", "message": "收到反馈：{{反馈}}"},
	}
	if res := post(t, c, u+"/automations", map[string]any{"name": "表单提醒", "triggerKind": "form_submit", "config": cfg}); res.StatusCode != 201 {
		t.Fatalf("create: %d", res.StatusCode)
	}

	// 匿名表单提交（触发 form_submit）——建一个只含「反馈」字段的表单视图
	var fv store.View
	json.NewDecoder(post(t, c, u+"/views", map[string]any{
		"type": "form", "name": "反馈表单",
		"config": map[string]any{"fields": []int64{fb.ID}},
	}).Body).Decode(&fv)
	token := publishTestForm(t, c, u, fv.ID)
	anon := &http.Client{} // 无 cookie = 未登录
	res := post(t, anon, ts.URL+"/api/forms/"+token,
		map[string]any{"cells": map[string]any{strconv.FormatInt(fb.ID, 10): "很好用"}})
	if res.StatusCode != 201 {
		t.Fatalf("form submit: %d", res.StatusCode)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && hookBody == "" {
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(hookBody, `"text":"收到反馈：很好用"`) {
		t.Fatalf("webhook payload: %s", hookBody)
	}
}

func TestScheduleAutomation(t *testing.T) {
	st := store.NewMemory()
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "sc@x.com", "name": "SC", "password": "password123"})
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "sc2@x.com", "name": "SC2", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)

	// 每小时汇总，通知 user 2
	cfg := map[string]any{
		"schedule":    map[string]string{"every": "1h"},
		"notifyUsers": []int64{2},
		"message":     "整点汇总",
	}
	if res := post(t, c, u+"/automations", map[string]any{"name": "整点汇总", "triggerKind": "schedule", "config": cfg}); res.StatusCode != 201 {
		t.Fatalf("create schedule automation: %d", res.StatusCode)
	}
	// 非法 every 被拒
	bad := post(t, c, u+"/automations", map[string]any{"name": "坏的", "triggerKind": "schedule", "config": map[string]any{"schedule": map[string]string{"every": "2m"}}})
	if bad.StatusCode != 400 {
		t.Fatalf("bad every accepted: %d", bad.StatusCode)
	}

	// 手动执行一次 sweep（正常由 main 的 goroutine 每分钟调）
	sweepSrv := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ctx := context.Background()
	sweepSrv.SweepSchedules(ctx)

	// user 2 收到通知
	j, _ := cookiejar.New(nil)
	guest := &http.Client{Jar: j}
	post(t, guest, ts.URL+"/api/auth/login", map[string]string{"email": "sc2@x.com", "password": "password123"})
	var notif struct {
		Unread        int64
		Notifications []store.Notification
	}
	r := cGet(t, guest, ts.URL+"/api/notifications")
	json.NewDecoder(r.Body).Decode(&notif)
	if notif.Unread != 1 || notif.Notifications[0].Preview != "整点汇总" {
		t.Fatalf("schedule notification: %+v", notif)
	}

	// 立刻再 sweep 不重复发（间隔未到）
	sweepSrv.SweepSchedules(ctx)
	r = cGet(t, guest, ts.URL+"/api/notifications")
	json.NewDecoder(r.Body).Decode(&notif)
	if notif.Unread != 1 {
		t.Fatalf("schedule refired within gap: %+v", notif)
	}
}

func TestAutomationCreateRecordAndTemplateInterpolation(t *testing.T) {
	st := store.NewMemory()
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "cr1@x.com", "name": "CR1", "password": "password123"})
	gj, _ := cookiejar.New(nil)
	bo := &http.Client{Jar: gj}
	post(t, bo, ts.URL+"/api/auth/register", map[string]string{"email": "cr2@x.com", "name": "CR2", "password": "password123"})

	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", map[string]string{"title": "项目追踪"}).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)
	send(t, c, "PUT", ts.URL+"/api/docs/"+strconv.FormatInt(b.ID, 10)+"/shares", map[string]any{"email": "cr2@x.com", "role": "edit"})

	var statusField, titleField store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "状态", "type": "text"}).Body).Decode(&statusField)
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "任务名", "type": "text"}).Body).Decode(&titleField)

	// 创建第二张数据表「归档表」
	var archiveTable store.BaseTable
	resTbl := post(t, c, u+"/tables", map[string]string{"name": "归档表"})
	if resTbl.StatusCode != 201 {
		t.Fatalf("create archive table: %d", resTbl.StatusCode)
	}
	json.NewDecoder(resTbl.Body).Decode(&archiveTable)
	var logField store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "归档内容", "type": "text", "tableId": archiveTable.ID}).Body).Decode(&logField)

	titleKey := strconv.FormatInt(titleField.ID, 10)
	statusKey := strconv.FormatInt(statusField.ID, 10)
	logKey := strconv.FormatInt(logField.ID, 10)

	cfg := map[string]any{
		"rules": []map[string]any{{"f": statusField.ID, "op": "is", "v": "完成"}},
		"conj":  "and",
		"actions": []map[string]any{
			{
				"id":      "a1",
				"type":    "create_record",
				"tableId": archiveTable.ID,
				"cells": map[string]any{
					logKey: "{{base.title}}|#{{record.id}}|{{field:" + titleKey + "}}",
				},
			},
			{
				"id":          "a2",
				"type":        "notify",
				"notifyUsers": []int64{2},
				"message":     "已归档：{{field:" + titleKey + "}}（{{base.title}}）",
			},
		},
	}
	res := post(t, c, u+"/automations", map[string]any{"name": "完成自动归档", "triggerKind": "record_matches", "config": cfg})
	if res.StatusCode != 201 {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("create automation: %d %s", res.StatusCode, string(body))
	}

	var created store.Record
	resRec := post(t, c, u+"/records", map[string]any{"cells": map[string]any{statusKey: "完成", titleKey: "发布 v2.0"}})
	if resRec.StatusCode != 201 {
		t.Fatalf("add record: %d", resRec.StatusCode)
	}
	json.NewDecoder(resRec.Body).Decode(&created)

	recs, err := st.Records(context.Background(), b.ID)
	if err != nil {
		t.Fatal(err)
	}
	wantLog := `"项目追踪|#` + strconv.FormatInt(created.ID, 10) + `|发布 v2.0"`
	foundArchive := false
	for _, r := range recs {
		if r.TableID == archiveTable.ID && string(r.Cells[logKey]) == wantLog {
			foundArchive = true
			break
		}
	}
	if !foundArchive {
		t.Fatalf("expected archived record with %s, got records: %+v", wantLog, recs)
	}

	post(t, bo, ts.URL+"/api/auth/login", map[string]string{"email": "cr2@x.com", "password": "password123"})
	var notif struct {
		Unread        int64
		Notifications []store.Notification
	}
	json.NewDecoder(cGet(t, bo, ts.URL+"/api/notifications").Body).Decode(&notif)
	if notif.Unread != 1 || !strings.Contains(notif.Notifications[0].Preview, "已归档：发布 v2.0（项目追踪）") {
		t.Fatalf("expected interpolated notify action, got: %+v", notif)
	}
}

func TestAutomationUpdateTriggerRecord(t *testing.T) {
	st := store.NewMemory()
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "up@x.com", "name": "UP", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)

	var statusF, noteF, doneF store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "状态", "type": "text"}).Body).Decode(&statusF)
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "备注", "type": "text"}).Body).Decode(&noteF)
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "已归档", "type": "checkbox"}).Body).Decode(&doneF)

	sk, nk, dk := strconv.FormatInt(statusF.ID, 10), strconv.FormatInt(noteF.ID, 10), strconv.FormatInt(doneF.ID, 10)
	cfg := map[string]any{
		"rules": []map[string]any{{"f": statusF.ID, "op": "is", "v": "待审核"}},
		"conj":  "and",
		"actions": []map[string]any{
			{
				"type":        "update_record",
				"targetScope": "trigger",
				"cells": map[string]any{
					sk: "审核中",
					nk: "自动受理 #{{record.id}}",
					dk: true,
				},
			},
		},
	}
	if res := post(t, c, u+"/automations", map[string]any{"name": "自动受理", "triggerKind": "record_matches", "config": cfg}); res.StatusCode != 201 {
		t.Fatalf("create automation: %d", res.StatusCode)
	}

	var rec store.Record
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{sk: "待审核"}}).Body).Decode(&rec)
	if string(rec.Cells[sk]) != `"审核中"` || string(rec.Cells[dk]) != "true" {
		t.Fatalf("expected trigger record updated, got cells: %+v", rec.Cells)
	}
	wantNote := `"自动受理 #` + strconv.FormatInt(rec.ID, 10) + `"`
	if string(rec.Cells[nk]) != wantNote {
		t.Fatalf("want note %s, got %s", wantNote, string(rec.Cells[nk]))
	}
}

func TestAutomationFindRecordsAndBatchUpdate(t *testing.T) {
	st := store.NewMemory()
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "fn1@x.com", "name": "FN1", "password": "password123"})
	gj, _ := cookiejar.New(nil)
	bo := &http.Client{Jar: gj}
	post(t, bo, ts.URL+"/api/auth/register", map[string]string{"email": "fn2@x.com", "name": "FN2", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)
	send(t, c, "PUT", ts.URL+"/api/docs/"+strconv.FormatInt(b.ID, 10)+"/shares", map[string]any{"email": "fn2@x.com", "role": "edit"})

	var kindF, statusF, noteF, signalF store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "分类", "type": "text"}).Body).Decode(&kindF)
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "状态", "type": "text"}).Body).Decode(&statusF)
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "备注", "type": "text"}).Body).Decode(&noteF)
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "指令", "type": "text"}).Body).Decode(&signalF)

	kk, sk, nk, sigk := strconv.FormatInt(kindF.ID, 10), strconv.FormatInt(statusF.ID, 10), strconv.FormatInt(noteF.ID, 10), strconv.FormatInt(signalF.ID, 10)

	// 先写入 3 条待办 Bug 和 1 条待办需求
	for i := 0; i < 3; i++ {
		post(t, c, u+"/records", map[string]any{"cells": map[string]any{kk: "Bug", sk: "待办"}})
	}
	post(t, c, u+"/records", map[string]any{"cells": map[string]any{kk: "需求", sk: "待办"}})

	cfg := map[string]any{
		"rules": []map[string]any{{"f": signalF.ID, "op": "is", "v": "关闭Bug"}},
		"conj":  "and",
		"actions": []map[string]any{
			{
				"type":  "find_records",
				"conj":  "and",
				"limit": 20,
				"rules": []map[string]any{
					{"f": kindF.ID, "op": "is", "v": "Bug"},
					{"f": statusF.ID, "op": "is", "v": "待办"},
				},
			},
			{
				"type":        "update_record",
				"targetScope": "found",
				"cells": map[string]any{
					sk: "已关闭",
					nk: "批量关闭共{{found.count}}条",
				},
			},
			{
				"type":        "notify",
				"notifyUsers": []int64{2},
				"message":     "已批量处理 {{found.count}} 条 Bug",
			},
		},
	}
	if res := post(t, c, u+"/automations", map[string]any{"name": "批量关闭Bug", "triggerKind": "record_matches", "config": cfg}); res.StatusCode != 201 {
		t.Fatalf("create automation: %d", res.StatusCode)
	}

	// 写入触发指令记录
	post(t, c, u+"/records", map[string]any{"cells": map[string]any{sigk: "关闭Bug"}})

	recs, _ := st.Records(context.Background(), b.ID)
	closedBugs := 0
	openFeatures := 0
	for _, r := range recs {
		if string(r.Cells[kk]) == `"Bug"` && string(r.Cells[sk]) == `"已关闭"` && string(r.Cells[nk]) == `"批量关闭共3条"` {
			closedBugs++
		}
		if string(r.Cells[kk]) == `"需求"` && string(r.Cells[sk]) == `"待办"` {
			openFeatures++
		}
	}
	if closedBugs != 3 || openFeatures != 1 {
		t.Fatalf("expected 3 closed bugs and 1 open feature, got closed=%d openFeat=%d", closedBugs, openFeatures)
	}

	post(t, bo, ts.URL+"/api/auth/login", map[string]string{"email": "fn2@x.com", "password": "password123"})
	var notif struct {
		Unread        int64
		Notifications []store.Notification
	}
	json.NewDecoder(cGet(t, bo, ts.URL+"/api/notifications").Body).Decode(&notif)
	if notif.Unread != 1 || notif.Notifications[0].Preview != "已批量处理 3 条 Bug" {
		t.Fatalf("expected found.count notification, got %+v", notif)
	}
}

func TestAutomationIfConditionThenAndElse(t *testing.T) {
	st := store.NewMemory()
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "if@x.com", "name": "IF", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)

	var amountF, prioF, flagF store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "金额", "type": "number"}).Body).Decode(&amountF)
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "优先级", "type": "text"}).Body).Decode(&prioF)
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "评估", "type": "text"}).Body).Decode(&flagF)

	ak, pk, fk := strconv.FormatInt(amountF.ID, 10), strconv.FormatInt(prioF.ID, 10), strconv.FormatInt(flagF.ID, 10)
	cfg := map[string]any{
		"rules": []map[string]any{{"f": flagF.ID, "op": "is", "v": "go"}},
		"conj":  "and",
		"actions": []map[string]any{
			{
				"type":  "if_condition",
				"conj":  "and",
				"rules": []map[string]any{{"f": amountF.ID, "op": "gte", "v": 1000}},
				"thenActions": []map[string]any{
					{"type": "update_record", "cells": map[string]any{pk: "P0"}},
				},
				"elseActions": []map[string]any{
					{"type": "update_record", "cells": map[string]any{pk: "P2"}},
				},
			},
		},
	}
	if res := post(t, c, u+"/automations", map[string]any{"name": "金额分级", "triggerKind": "record_matches", "config": cfg}); res.StatusCode != 201 {
		t.Fatalf("create if_condition automation: %d", res.StatusCode)
	}

	var high, low store.Record
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{fk: "go", ak: 1500}}).Body).Decode(&high)
	json.NewDecoder(post(t, c, u+"/records", map[string]any{"cells": map[string]any{fk: "go", ak: 200}}).Body).Decode(&low)

	if string(high.Cells[pk]) != `"P0"` {
		t.Fatalf("expected then branch P0, got %s", string(high.Cells[pk]))
	}
	if string(low.Cells[pk]) != `"P2"` {
		t.Fatalf("expected else branch P2, got %s", string(low.Cells[pk]))
	}
}

func TestAutomationRecursionDepthGuard(t *testing.T) {
	st := store.NewMemory()
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "lp@x.com", "name": "LP", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)

	var tagF store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "标签", "type": "text"}).Body).Decode(&tagF)
	tk := strconv.FormatInt(tagF.ID, 10)

	// 自触发循环：每次写入标签=loop 都创建一条新的标签=loop 记录
	cfg := map[string]any{
		"rules": []map[string]any{{"f": tagF.ID, "op": "is", "v": "loop"}},
		"conj":  "and",
		"actions": []map[string]any{
			{"type": "create_record", "cells": map[string]any{tk: "loop"}},
		},
	}
	if res := post(t, c, u+"/automations", map[string]any{"name": "自循环测试", "triggerKind": "record_matches", "config": cfg}); res.StatusCode != 201 {
		t.Fatalf("create loop automation: %d", res.StatusCode)
	}

	if res := post(t, c, u+"/records", map[string]any{"cells": map[string]any{tk: "loop"}}); res.StatusCode != 201 {
		t.Fatalf("trigger record: %d", res.StatusCode)
	}

	recs, _ := st.Records(context.Background(), b.ID)
	loopCount := 0
	for _, r := range recs {
		if string(r.Cells[tk]) == `"loop"` {
			loopCount++
		}
	}
	// 初始 1 条 + 深度 0/1/2 各创建 1 条，深度 3 被拦截 → 共 4 条
	if loopCount != maxAutomationDepth+1 {
		t.Fatalf("expected %d loop records (bounded by depth %d), got %d", maxAutomationDepth+1, maxAutomationDepth, loopCount)
	}
}

func TestAutomationActionsValidation(t *testing.T) {
	st := store.NewMemory()
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "va@x.com", "name": "VA", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)

	var textF, formulaF store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "名称", "type": "text"}).Body).Decode(&textF)
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "公式列", "type": "formula", "formula": "1+1"}).Body).Decode(&formulaF)
	tk := strconv.FormatInt(textF.ID, 10)
	fk := strconv.FormatInt(formulaF.ID, 10)

	// 1. 超过 10 个动作被拒绝
	eleven := make([]map[string]any, 11)
	for i := range eleven {
		eleven[i] = map[string]any{"type": "notify", "notifyUsers": []int64{1}, "message": "hi"}
	}
	if res := post(t, c, u+"/automations", map[string]any{"name": "too-many", "triggerKind": "record_matches", "config": map[string]any{"actions": eleven}}); res.StatusCode != 400 {
		t.Fatalf("expected 400 for 11 actions, got %d", res.StatusCode)
	}

	// 2. 2 层嵌套 if_condition 允许，3 层拒绝
	depth2 := []map[string]any{{
		"type": "if_condition",
		"thenActions": []map[string]any{{
			"type": "if_condition",
			"thenActions": []map[string]any{
				{"type": "update_record", "cells": map[string]any{tk: "ok"}},
			},
		}},
	}}
	if res := post(t, c, u+"/automations", map[string]any{"name": "depth-2", "triggerKind": "record_matches", "config": map[string]any{"actions": depth2}}); res.StatusCode != 201 {
		t.Fatalf("expected 201 for depth-2 if_condition, got %d", res.StatusCode)
	}
	depth3 := []map[string]any{{
		"type": "if_condition",
		"thenActions": []map[string]any{{
			"type": "if_condition",
			"thenActions": []map[string]any{{
				"type": "if_condition",
			}},
		}},
	}}
	if res := post(t, c, u+"/automations", map[string]any{"name": "depth-3", "triggerKind": "record_matches", "config": map[string]any{"actions": depth3}}); res.StatusCode != 400 {
		t.Fatalf("expected 400 for depth-3 if_condition, got %d", res.StatusCode)
	}

	// 3. 未知动作类型 / 未知字段 / 不可写公式字段 / 未知数据表 / 超限 limit / 非法 targetScope
	badCases := []struct {
		name    string
		actions []map[string]any
	}{
		{"bad-type", []map[string]any{{"type": "drop_table"}}},
		{"bad-field", []map[string]any{{"type": "create_record", "cells": map[string]any{"999999": "x"}}}},
		{"readonly-formula", []map[string]any{{"type": "update_record", "cells": map[string]any{fk: "123"}}}},
		{"bad-table", []map[string]any{{"type": "create_record", "tableId": 999999, "cells": map[string]any{tk: "x"}}}},
		{"bad-limit", []map[string]any{{"type": "find_records", "limit": 51}}},
		{"bad-scope", []map[string]any{{"type": "update_record", "targetScope": "all", "cells": map[string]any{tk: "x"}}}},
		{"bad-webhook", []map[string]any{{"type": "webhook", "webhook": map[string]any{"url": "ftp://evil"}}}},
	}
	for _, tc := range badCases {
		res := post(t, c, u+"/automations", map[string]any{"name": tc.name, "triggerKind": "record_matches", "config": map[string]any{"actions": tc.actions}})
		if res.StatusCode != 400 {
			t.Fatalf("case %s: expected 400, got %d", tc.name, res.StatusCode)
		}
	}
}
