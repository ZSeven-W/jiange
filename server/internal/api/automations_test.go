package api

import (
	"encoding/json"
	"io"
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
	anon := &http.Client{} // 无 cookie = 未登录
	res := post(t, anon, ts.URL+"/api/forms/"+strconv.FormatInt(b.ID, 10)+"/"+strconv.FormatInt(fv.ID, 10),
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
