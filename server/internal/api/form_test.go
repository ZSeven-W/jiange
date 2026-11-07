package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func publicationTestBody(t *testing.T, owner *http.Client, baseURL string, viewID, revision int64) map[string]any {
	t.Helper()
	resp, err := owner.Get(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var data struct {
		Fields []store.Field `json:"fields"`
		Views  []store.View  `json:"views"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&data) != nil {
		t.Fatalf("base snapshot: %d", resp.StatusCode)
	}
	if data.Fields == nil {
		data.Fields = []store.Field{}
	}
	for _, view := range data.Views {
		if view.ID == viewID {
			return map[string]any{"expectedRevision": revision, "expectedConfig": view.Config, "expectedFields": data.Fields}
		}
	}
	t.Fatal("form view missing")
	return nil
}

func publishTestForm(t *testing.T, owner *http.Client, baseURL string, viewID int64) string {
	t.Helper()
	url := baseURL + "/views/" + strconv.FormatInt(viewID, 10) + "/public-form"
	status, err := owner.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	var current struct {
		Revision int64 `json:"revision"`
	}
	if status.StatusCode != http.StatusOK || json.NewDecoder(status.Body).Decode(&current) != nil {
		t.Fatalf("status form: %d", status.StatusCode)
	}
	status.Body.Close()
	res := post(t, owner, url, publicationTestBody(t, owner, baseURL, viewID, current.Revision))
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("publish form: %d", res.StatusCode)
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil || len(body.Token) != 43 {
		t.Fatalf("published token invalid: %v", err)
	}
	return body.Token
}

func TestPublicFormPublicationRotationAndRateLimit(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "form-token@example.test", "name": "F", "password": "password123"})
	var base store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/bases", nil).Body).Decode(&base)
	fields, err := st.Fields(context.Background(), base.ID)
	if err != nil || len(fields) == 0 {
		t.Fatalf("fields=%v err=%v", fields, err)
	}
	config, _ := json.Marshal(map[string]any{"title": "Private form", "fields": []int64{fields[0].ID}})
	view, err := st.AddView(context.Background(), store.View{BaseID: base.ID, Type: "form", Name: "F", Config: config})
	if err != nil {
		t.Fatal(err)
	}
	baseURL := ts.URL + "/api/bases/" + strconv.FormatInt(base.ID, 10)
	adminURL := baseURL + "/views/" + strconv.FormatInt(view.ID, 10) + "/public-form"
	legacyURL := ts.URL + "/api/forms/" + strconv.FormatInt(base.ID, 10) + "/" + strconv.FormatInt(view.ID, 10)
	anon := &http.Client{}
	resp, err := anon.Get(legacyURL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unpublished numeric form accessible: %d", resp.StatusCode)
	}
	resp = post(t, anon, legacyURL, map[string]any{"cells": map[string]any{strconv.FormatInt(fields[0].ID, 10): "guess"}})
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("numeric submit accessible: %d", resp.StatusCode)
	}
	resp = post(t, anon, adminURL, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous publication: %d", resp.StatusCode)
	}
	jar, _ := cookiejar.New(nil)
	editor := &http.Client{Jar: jar}
	resp = post(t, editor, ts.URL+"/api/auth/register", map[string]string{"email": "form-editor@example.test", "name": "Editor", "password": "password123"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("editor registration=%d", resp.StatusCode)
	}
	resp = send(t, owner, http.MethodPut, ts.URL+"/api/docs/"+strconv.FormatInt(base.ID, 10)+"/shares", map[string]string{"email": "form-editor@example.test", "role": "edit"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("editor share=%d", resp.StatusCode)
	}
	resp = post(t, editor, adminURL, map[string]any{"expectedRevision": 0})
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("editor publication=%d", resp.StatusCode)
	}
	resp, err = owner.Get(adminURL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), `"published":false`) {
		t.Fatalf("initial status=%d body=%s", resp.StatusCode, body)
	}
	first := publishTestForm(t, owner, baseURL, view.ID)
	second := publishTestForm(t, owner, baseURL, view.ID)
	if first == second {
		t.Fatal("rotation reused token")
	}
	// A collaborator with edit access may not silently expand or revoke a
	// manager-published anonymous form through generic view endpoints.
	viewURL := baseURL + "/views/" + strconv.FormatInt(view.ID, 10)
	resp = send(t, editor, http.MethodPatch, viewURL, map[string]any{"config": map[string]any{"fields": []int64{}}})
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("editor changed published form=%d", resp.StatusCode)
	}
	resp = send(t, editor, http.MethodDelete, viewURL, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("editor deleted published form=%d", resp.StatusCode)
	}
	for _, url := range []string{ts.URL + "/api/forms/" + first, ts.URL + "/api/forms/" + strings.Repeat("a", 43)} {
		resp, err = anon.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("invalid/revoked token accepted: %d", resp.StatusCode)
		}
	}
	url := ts.URL + "/api/forms/" + second
	resp, err = anon.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Cache-Control") != "private, no-store" {
		t.Fatalf("published form=%d cache=%q", resp.StatusCode, resp.Header.Get("Cache-Control"))
	}
	for i := 0; i < publicFormTestLimit(); i++ {
		resp = post(t, anon, url, map[string]any{"cells": map[string]any{"999999": "invalid"}})
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("invalid attempt %d: %d", i, resp.StatusCode)
		}
	}
	resp = post(t, anon, url, map[string]any{"cells": map[string]any{strconv.FormatInt(fields[0].ID, 10): "limited"}})
	resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("rate limit=%d", resp.StatusCode)
	}
	resp = send(t, owner, "DELETE", adminURL, map[string]any{"expectedRevision": 2})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("close=%d", resp.StatusCode)
	}
	resp, err = anon.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("closed token read=%d", resp.StatusCode)
	}
}

func publicFormTestLimit() int { return 20 }

func TestPublicFormJSONRejectsPostgresInvalidStrings(t *testing.T) {
	for _, raw := range []string{`"\u0000"`, `"\ud800"`, `"\udc00"`, `"\ud800x"`, `{"\u0000":1}`} {
		if validPublicFormJSON(json.RawMessage(raw)) {
			t.Fatalf("accepted invalid string %s", raw)
		}
	}
	for _, raw := range []string{`"\ud83d\ude00"`, `"\\ud800"`, `"😀"`, `"\ufffd"`, `["text","值"]`} {
		if !validPublicFormJSON(json.RawMessage(raw)) {
			t.Fatalf("rejected valid string %s", raw)
		}
	}
}

func TestPublicFormDefaultsSchemaCASAndRequired(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "form-default@example.test", "name": "F", "password": "password123"})
	var base store.DocMeta
	resp := post(t, owner, ts.URL+"/api/bases", nil)
	if err := json.NewDecoder(resp.Body).Decode(&base); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	baseURL := ts.URL + "/api/bases/" + strconv.FormatInt(base.ID, 10)
	ctx := context.Background()
	initial, err := st.Fields(ctx, base.ID)
	if err != nil || len(initial) != 1 {
		t.Fatalf("initial=%v err=%v", initial, err)
	}
	view, err := st.AddView(ctx, store.View{BaseID: base.ID, Type: "form", Name: "F", Config: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatal(err)
	}
	adminURL := baseURL + "/views/" + strconv.FormatInt(view.ID, 10) + "/public-form"
	stale := publicationTestBody(t, owner, baseURL, view.ID, 0)
	check, err := st.AddField(ctx, store.Field{BaseID: base.ID, Name: "确认", Type: "checkbox"})
	if err != nil {
		t.Fatal(err)
	}
	number, err := st.AddField(ctx, store.Field{BaseID: base.ID, Name: "数量", Type: "number"})
	if err != nil {
		t.Fatal(err)
	}
	resp = post(t, owner, adminURL, stale)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("stale schema published=%d", resp.StatusCode)
	}
	token := publishTestForm(t, owner, baseURL, view.ID)
	url := ts.URL + "/api/forms/" + token
	var def struct {
		Fields []formField `json:"fields"`
	}
	resp, err = http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&def) != nil {
		t.Fatalf("form get=%d", resp.StatusCode)
	}
	resp.Body.Close()
	if len(def.Fields) != 3 || def.Fields[0].ID != initial[0].ID || def.Fields[1].ID != check.ID || def.Fields[2].ID != number.ID {
		t.Fatalf("defaults=%+v", def.Fields)
	}
	// Later fields must not become public: publication freezes the preview.
	if _, err := st.AddField(ctx, store.Field{BaseID: base.ID, Name: "后续私密字段", Type: "text"}); err != nil {
		t.Fatal(err)
	}
	resp, err = http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	def.Fields = nil
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&def) != nil {
		t.Fatalf("form after add=%d", resp.StatusCode)
	}
	resp.Body.Close()
	if len(def.Fields) != 3 {
		t.Fatalf("new field became public: %+v", def.Fields)
	}
	// A manager may explicitly select required fields; false and zero are values.
	snapshot := publicationTestBody(t, owner, baseURL, view.ID, 1)
	config := map[string]any{"title": "反馈", "fields": []int64{initial[0].ID, check.ID, number.ID}, "required": []int64{initial[0].ID, check.ID, number.ID}}
	configURL := baseURL + "/views/" + strconv.FormatInt(view.ID, 10) + "/form-config"
	resp = post(t, owner, configURL, map[string]any{"expectedConfig": snapshot["expectedConfig"], "expectedFields": snapshot["expectedFields"], "config": config})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("save config=%d", resp.StatusCode)
	}
	resp = post(t, owner, configURL, map[string]any{"expectedConfig": snapshot["expectedConfig"], "expectedFields": snapshot["expectedFields"], "config": config})
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("stale config accepted=%d", resp.StatusCode)
	}
	fresh := publicationTestBody(t, owner, baseURL, view.ID, 1)
	changedExtras := map[string]any{"title": "反馈", "fields": []int64{initial[0].ID}, "locked": true}
	resp = post(t, owner, configURL, map[string]any{"expectedConfig": fresh["expectedConfig"], "expectedFields": fresh["expectedFields"], "config": changedExtras})
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unrelated settings changed via form config=%d", resp.StatusCode)
	}
	resp, err = http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	def.Fields = nil
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&def) != nil {
		t.Fatalf("required get=%d", resp.StatusCode)
	}
	resp.Body.Close()
	for _, field := range def.Fields {
		if !field.Required {
			t.Fatalf("missing required flag: %+v", field)
		}
	}
	resp = post(t, &http.Client{}, url, map[string]any{"cells": map[string]any{strconv.FormatInt(initial[0].ID, 10): "  ", strconv.FormatInt(check.ID, 10): false, strconv.FormatInt(number.ID, 10): 0}})
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty required=%d", resp.StatusCode)
	}
	resp = post(t, &http.Client{}, url, map[string]any{"cells": map[string]any{strconv.FormatInt(initial[0].ID, 10): "ok", strconv.FormatInt(check.ID, 10): false, strconv.FormatInt(number.ID, 10): 0}})
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("false/zero required=%d", resp.StatusCode)
	}
	// Explicit empty fields are not interpreted as an unconfigured default.
	empty, err := st.AddView(ctx, store.View{BaseID: base.ID, Type: "form", Name: "Empty", Config: json.RawMessage(`{"fields":[]}`)})
	if err != nil {
		t.Fatal(err)
	}
	emptyURL := baseURL + "/views/" + strconv.FormatInt(empty.ID, 10) + "/public-form"
	resp = post(t, owner, emptyURL, publicationTestBody(t, owner, baseURL, empty.ID, 0))
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("explicit empty published=%d", resp.StatusCode)
	}
	views, err := st.Views(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range views {
		if v.ID == empty.ID && !strings.Contains(string(v.Config), `"fields":[]`) {
			t.Fatalf("explicit empty mutated: %s", v.Config)
		}
	}
}

func TestPublicFormPublicationRequiresSameOriginJSON(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "form-csrf@example.test", "name": "F", "password": "password123"})
	var base store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/bases", nil).Body).Decode(&base)
	view, err := st.AddView(context.Background(), store.View{BaseID: base.ID, Type: "form", Name: "F"})
	if err != nil {
		t.Fatal(err)
	}
	url := ts.URL + "/api/bases/" + strconv.FormatInt(base.ID, 10) + "/views/" + strconv.FormatInt(view.ID, 10) + "/public-form"
	validBody, _ := json.Marshal(publicationTestBody(t, owner, ts.URL+"/api/bases/"+strconv.FormatInt(base.ID, 10), view.ID, 0))
	for _, test := range []struct {
		contentType, origin, site string
		body                      []byte
		status                    int
	}{
		{"", "", "", nil, http.StatusUnsupportedMediaType},
		{"text/plain", "", "", []byte(`{"expectedRevision":0}`), http.StatusUnsupportedMediaType},
		{"application/json", "https://sibling.example.test", "same-site", []byte(`{"expectedRevision":0}`), http.StatusForbidden},
		{"application/json", "https://evil.example.test", "cross-site", []byte(`{"expectedRevision":0}`), http.StatusForbidden},
		{"application/json", ts.URL, "same-origin", validBody, http.StatusOK},
	} {
		req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(test.body))
		if err != nil {
			t.Fatal(err)
		}
		if test.contentType != "" {
			req.Header.Set("Content-Type", test.contentType)
		}
		if test.origin != "" {
			req.Header.Set("Origin", test.origin)
		}
		if test.site != "" {
			req.Header.Set("Sec-Fetch-Site", test.site)
		}
		resp, err := owner.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != test.status {
			t.Fatalf("origin=%q site=%q type=%q: got %d want %d", test.origin, test.site, test.contentType, resp.StatusCode, test.status)
		}
	}
}

func TestPublicForm(t *testing.T) {
	st := store.NewMemory()
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "form@x.com", "name": "F", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)

	// fields: 姓名(text) + 反馈(text) — form exposes only 反馈
	var name, fb store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "姓名", "type": "text"}).Body).Decode(&name)
	json.NewDecoder(post(t, c, u+"/fields", map[string]string{"name": "反馈", "type": "text"}).Body).Decode(&fb)
	var v store.View
	json.NewDecoder(post(t, c, u+"/views", map[string]any{
		"type": "form", "name": "反馈收集",
		"config": map[string]any{"title": "产品反馈", "desc": "欢迎留言", "fields": []int64{fb.ID}},
	}).Body).Decode(&v)
	token := publishTestForm(t, c, u, v.ID)
	formURL := ts.URL + "/api/forms/" + token

	// public GET (no cookie)
	anon := &http.Client{}
	r, err := anon.Get(formURL)
	if err != nil || r.StatusCode != 200 {
		t.Fatalf("form get: %v %v", err, r)
	}
	var def struct {
		Title  string
		Fields []formField
	}
	json.NewDecoder(r.Body).Decode(&def)
	if def.Title != "产品反馈" || len(def.Fields) != 1 || def.Fields[0].Name != "反馈" {
		t.Fatalf("form def: %+v", def)
	}

	// anonymous submit fills the allowed field
	res := post(t, anon, formURL,
		map[string]any{"cells": map[string]any{strconv.FormatInt(fb.ID, 10): "很好用"}})
	if res.StatusCode != 201 {
		t.Fatalf("submit: %d", res.StatusCode)
	}
	// submitting a field that is not in the form is rejected
	res = post(t, anon, formURL,
		map[string]any{"cells": map[string]any{strconv.FormatInt(name.ID, 10): "x"}})
	if res.StatusCode != 400 {
		t.Fatalf("hidden field accepted: %d", res.StatusCode)
	}
	// invalid value for the exposed field type is rejected
	var bad store.Field
	json.NewDecoder(post(t, c, u+"/fields", map[string]any{"name": "评分", "type": "number"}).Body).Decode(&bad)
	// add it to the form then submit a wrong-typed value
	send(t, c, "PATCH", u+"/views/"+strconv.FormatInt(v.ID, 10), map[string]any{
		"config": map[string]any{"title": "产品反馈", "fields": []int64{fb.ID, bad.ID}},
	})
	res = post(t, anon, formURL,
		map[string]any{"cells": map[string]any{strconv.FormatInt(bad.ID, 10): "abc"}})
	if res.StatusCode != 400 {
		t.Fatalf("bad number accepted: %d", res.StatusCode)
	}

	// the record landed
	var full struct {
		Records []store.Record
	}
	r2, _ := c.Get(u)
	json.NewDecoder(r2.Body).Decode(&full)
	found := false
	for _, rec := range full.Records {
		if string(rec.Cells[strconv.FormatInt(fb.ID, 10)]) == `"很好用"` {
			found = true
		}
	}
	if !found {
		t.Fatalf("submitted record missing: %+v", full.Records)
	}
}

func TestPublicFormRejectsForgedLinkedDataAndTrashedBase(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "form-security@example.test", "name": "F", "password": "password123"})
	var base store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/bases", nil).Body).Decode(&base)
	ctx := context.Background()
	link, err := st.AddField(ctx, store.Field{BaseID: base.ID, Name: "关联", Type: "link", Options: []string{"999"}})
	if err != nil {
		t.Fatal(err)
	}
	file, err := st.AddField(ctx, store.Field{BaseID: base.ID, Name: "附件", Type: "attachment"})
	if err != nil {
		t.Fatal(err)
	}
	person, err := st.AddField(ctx, store.Field{BaseID: base.ID, Name: "人员", Type: "person"})
	if err != nil {
		t.Fatal(err)
	}
	initialFields, err := st.Fields(ctx, base.ID)
	if err != nil || len(initialFields) == 0 {
		t.Fatalf("fields=%v err=%v", initialFields, err)
	}
	config, _ := json.Marshal(map[string]any{"fields": []int64{initialFields[0].ID}})
	view, err := st.AddView(ctx, store.View{BaseID: base.ID, Type: "form", Name: "F", Config: config})
	if err != nil {
		t.Fatal(err)
	}
	token := publishTestForm(t, owner, ts.URL+"/api/bases/"+strconv.FormatInt(base.ID, 10), view.ID)
	// Simulate a legacy/malformed configuration introduced after publication.
	// It must not permit forged associated IDs to be submitted.
	view.Config, _ = json.Marshal(map[string]any{"fields": []int64{link.ID, file.ID, person.ID}})
	if _, err := st.UpdateView(ctx, view); err != nil {
		t.Fatal(err)
	}
	url := ts.URL + "/api/forms/" + token
	anon := &http.Client{}
	beforeRows, _ := st.Records(ctx, base.ID)
	beforeHead, _ := st.BtHead(ctx, base.ID)
	for _, cells := range []map[string]any{
		{strconv.FormatInt(link.ID, 10): []int64{123}},
		{strconv.FormatInt(file.ID, 10): []map[string]any{{"id": 123, "name": "secret", "mime": "text/plain", "size": 1}}},
		{strconv.FormatInt(person.ID, 10): 123},
	} {
		res := post(t, anon, url, map[string]any{"cells": cells})
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("forged field accepted: %d", res.StatusCode)
		}
		res.Body.Close()
	}
	afterRows, _ := st.Records(ctx, base.ID)
	afterHead, _ := st.BtHead(ctx, base.ID)
	if len(afterRows) != len(beforeRows) || beforeHead != afterHead {
		t.Fatalf("rejected form changed records/events: %d/%d -> %d/%d", len(beforeRows), beforeHead, len(afterRows), afterHead)
	}
	if err := st.Trash(ctx, base.ID); err != nil {
		t.Fatal(err)
	}
	resp, err := anon.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound || resp.Header.Get("Cache-Control") != "private, no-store" {
		t.Fatalf("trashed form read=%d cache=%q", resp.StatusCode, resp.Header.Get("Cache-Control"))
	}
	resp = post(t, anon, url, map[string]any{"cells": map[string]any{strconv.FormatInt(link.ID, 10): []int64{123}}})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("trashed form submit=%d", resp.StatusCode)
	}
}
