package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type baseSecurityFixture struct {
	st              store.Store
	owner, guest    *http.Client
	url             string
	base            store.DocMeta
	status, secret  store.Field
	public, private store.Record
}

func newBaseSecurityFixture(t *testing.T) baseSecurityFixture {
	return newBaseSecurityFixtureWithStore(t, store.NewMemory())
}
func newBaseSecurityFixtureWithStore(t *testing.T, st store.Store) baseSecurityFixture {
	t.Helper()
	ts, owner := newTestServer(t, st, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "locked-owner@example.test", "name": "Owner", "password": "password123"})
	jar, _ := cookiejar.New(nil)
	guest := &http.Client{Jar: jar}
	post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "locked-guest@example.test", "name": "Guest", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)
	var status, secret store.Field
	json.NewDecoder(post(t, owner, u+"/fields", map[string]string{"name": "状态", "type": "text"}).Body).Decode(&status)
	json.NewDecoder(post(t, owner, u+"/fields", map[string]string{"name": "敏感", "type": "text"}).Body).Decode(&secret)
	statusID, secretID := strconv.FormatInt(status.ID, 10), strconv.FormatInt(secret.ID, 10)
	var public, private store.Record
	json.NewDecoder(post(t, owner, u+"/records", map[string]any{"cells": map[string]any{statusID: "公开", secretID: "HIDDEN_PUBLIC_VALUE"}}).Body).Decode(&public)
	json.NewDecoder(post(t, owner, u+"/records", map[string]any{"cells": map[string]any{statusID: "机密", secretID: "HIDDEN_PRIVATE_VALUE"}}).Body).Decode(&private)
	if r := send(t, owner, "PUT", ts.URL+"/api/docs/"+strconv.FormatInt(b.ID, 10)+"/shares", map[string]any{"email": "locked-guest@example.test", "role": "edit"}); r.StatusCode != http.StatusOK {
		t.Fatalf("share %d", r.StatusCode)
	}
	return baseSecurityFixture{st: st, owner: owner, guest: guest, url: u, base: b, status: status, secret: secret, public: public, private: private}
}
func setLockedFixture(t *testing.T, f baseSecurityFixture) {
	t.Helper()
	views, err := f.st.Views(context.Background(), f.base.ID)
	if err != nil || len(views) == 0 {
		t.Fatalf("views %v %v", views, err)
	}
	cfg := map[string]any{"locked": true, "filters": map[string]any{"conj": "and", "rules": []map[string]any{{"f": f.status.ID, "op": "is", "v": "公开"}}}, "hidden": []int64{f.secret.ID}}
	if r := send(t, f.owner, "PATCH", f.url+"/views/"+strconv.FormatInt(views[0].ID, 10), map[string]any{"config": cfg}); r.StatusCode != http.StatusOK {
		t.Fatalf("lock %d", r.StatusCode)
	}
}
func TestLockedViewCannotBeBypassedThroughQueryOrWrites(t *testing.T) {
	checkLockedViewCannotBeBypassed(t, newBaseSecurityFixture(t))
}
func checkLockedViewCannotBeBypassed(t *testing.T, f baseSecurityFixture) {
	setLockedFixture(t, f)
	var out struct {
		Records         []store.Record
		Fields          []store.Field
		Views           []store.View
		WriteRestricted bool
	}
	res := cGet(t, f.guest, f.url)
	if res.StatusCode != 200 {
		t.Fatalf("GET=%d", res.StatusCode)
	}
	json.NewDecoder(res.Body).Decode(&out)
	if len(out.Records) != 1 || out.Records[0].ID != f.public.ID || !out.WriteRestricted {
		t.Fatalf("records=%+v restricted=%v", out.Records, out.WriteRestricted)
	}
	if _, ok := out.Records[0].Cells[strconv.FormatInt(f.secret.ID, 10)]; ok {
		t.Fatal("hidden cell returned")
	}
	for _, field := range out.Fields {
		if field.ID == f.secret.ID {
			t.Fatal("hidden field listed")
		}
	}
	checks := []any{
		map[string]any{},
		map[string]any{"viewId": nil},
		map[string]any{"filters": map[string]any{"conj": "or", "rules": []map[string]any{{"f": f.status.ID, "op": "is", "v": "机密"}, {"f": f.status.ID, "op": "is", "v": "公开"}}}},
	}
	for _, body := range checks {
		r := post(t, f.guest, f.url+"/query", body)
		if r.StatusCode != 200 {
			t.Fatalf("query=%d", r.StatusCode)
		}
		var q struct{ Records []store.Record }
		json.NewDecoder(r.Body).Decode(&q)
		if len(q.Records) != 1 || q.Records[0].ID != f.public.ID {
			t.Fatalf("leaked rows: %+v", q.Records)
		}
		if _, ok := q.Records[0].Cells[strconv.FormatInt(f.secret.ID, 10)]; ok {
			t.Fatal("query leaked hidden cell")
		}
	}
	for _, body := range []any{
		map[string]any{"filters": map[string]any{"conj": "and", "rules": []map[string]any{{"f": f.secret.ID, "op": "is", "v": "HIDDEN_PUBLIC_VALUE"}}}},
		map[string]any{"sorts": []map[string]any{{"f": f.secret.ID, "asc": true}}},
	} {
		if r := post(t, f.guest, f.url+"/query", body); r.StatusCode != http.StatusBadRequest {
			t.Fatalf("hidden oracle=%d", r.StatusCode)
		}
	}
	for _, id := range []any{0, 987654321} {
		if r := post(t, f.guest, f.url+"/query", map[string]any{"viewId": id}); r.StatusCode != http.StatusNotFound {
			t.Fatalf("viewId=%v status=%d", id, r.StatusCode)
		}
	}
	// Picking an otherwise unlocked view cannot remove the mandatory policy.
	extra, err := f.st.AddView(context.Background(), store.View{BaseID: f.base.ID, Type: "grid", Name: "未锁定"})
	if err != nil {
		t.Fatal(err)
	}
	r := post(t, f.guest, f.url+"/query", map[string]any{"viewId": extra.ID})
	var extraQuery struct{ Records []store.Record }
	if err := json.NewDecoder(r.Body).Decode(&extraQuery); err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 || len(extraQuery.Records) != 1 || extraQuery.Records[0].ID != f.public.ID {
		t.Fatalf("unlocked view bypass: %d %+v", r.StatusCode, extraQuery.Records)
	}
	if r := post(t, f.guest, f.url+"/query", map[string]any{"unexpected": true}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown param=%d", r.StatusCode)
	}
	if r := send(t, f.guest, "PATCH", f.url+"/records/"+strconv.FormatInt(f.private.ID, 10), map[string]any{"cells": map[string]any{strconv.FormatInt(f.status.ID, 10): "公开"}}); r.StatusCode != http.StatusForbidden {
		t.Fatalf("hidden row write=%d", r.StatusCode)
	}
	if r := send(t, f.guest, "DELETE", f.url+"/records/"+strconv.FormatInt(f.private.ID, 10), nil); r.StatusCode != http.StatusForbidden {
		t.Fatalf("hidden row delete=%d", r.StatusCode)
	}
	views, _ := f.st.Views(context.Background(), f.base.ID)
	if r := send(t, f.guest, "PATCH", f.url+"/views/"+strconv.FormatInt(views[0].ID, 10), map[string]any{"config": map[string]any{}}); r.StatusCode != http.StatusForbidden {
		t.Fatalf("unlock=%d", r.StatusCode)
	}
	if r := send(t, f.guest, "DELETE", f.url+"/views/"+strconv.FormatInt(views[0].ID, 10), nil); r.StatusCode != http.StatusForbidden {
		t.Fatalf("delete lock=%d", r.StatusCode)
	}
	if r := post(t, f.guest, f.url+"/views", map[string]any{"name": "绕过", "type": "grid"}); r.StatusCode != http.StatusForbidden {
		t.Fatalf("new view bypass=%d", r.StatusCode)
	}
}

func TestInvalidLockedConfigurationFailsClosed(t *testing.T) {
	f := newBaseSecurityFixture(t)
	views, _ := f.st.Views(context.Background(), f.base.ID)
	views[0].Config = []byte(`{"locked":true,"filters":{"conj":"and","rules":[{"f":999999,"op":"is","v":"x"}]}}`)
	if _, err := f.st.UpdateView(context.Background(), views[0]); err != nil {
		t.Fatal(err)
	}
	for _, r := range []*http.Response{cGet(t, f.guest, f.url), post(t, f.guest, f.url+"/query", map[string]any{})} {
		if r.StatusCode == http.StatusOK {
			t.Fatal("invalid locked config returned unrestricted data")
		}
	}
}

func TestUnsupportedLockedFiltersCannotBeSaved(t *testing.T) {
	f := newBaseSecurityFixture(t)
	views, err := f.st.Views(context.Background(), f.base.ID)
	if err != nil || len(views) == 0 {
		t.Fatalf("views=%+v err=%v", views, err)
	}
	for _, typ := range []string{"multi_select", "created_by", "created_at", "modified_at", "formula", "link", "lookup"} {
		field, err := f.st.AddField(context.Background(), store.Field{BaseID: f.base.ID, Name: typ, Type: typ})
		if err != nil {
			t.Fatal(err)
		}
		op, value := "empty", any(nil)
		if typ == "multi_select" {
			op, value = "contains", `"`
		}
		cfg := map[string]any{"locked": true, "filters": map[string]any{"conj": "and", "rules": []map[string]any{{"f": field.ID, "op": op, "v": value}}}}
		res := send(t, f.owner, "PATCH", f.url+"/views/"+strconv.FormatInt(views[0].ID, 10), map[string]any{"config": cfg})
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("unsupported locked %s accepted: %d", typ, res.StatusCode)
		}
	}
}

func TestMultipleLockedViewsIntersect(t *testing.T) {
	f := newBaseSecurityFixture(t)
	setLockedFixture(t, f)
	// A second locked view must not widen the first one's row/column policy.
	second := btquery.Config{Locked: true, Filters: &btquery.Filters{Conj: "or", Rules: []btquery.Rule{
		{F: f.status.ID, Op: "is", V: "公开"}, {F: f.status.ID, Op: "is", V: "机密"},
	}}}
	raw, _ := json.Marshal(second)
	if _, err := f.st.AddView(context.Background(), store.View{BaseID: f.base.ID, Type: "gantt", Name: "第二权限", Config: raw}); err != nil {
		t.Fatal(err)
	}
	r := post(t, f.guest, f.url+"/query", map[string]any{})
	var got struct{ Records []store.Record }
	if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 || len(got.Records) != 1 || got.Records[0].ID != f.public.ID {
		t.Fatalf("multiple locked views widened access: %d %+v", r.StatusCode, got.Records)
	}
}

type changingBaseStore struct {
	store.Store
	onQuery func()
	once    atomic.Bool
}

func (s *changingBaseStore) QueryRecordsConstrained(ctx context.Context, id int64, fields []store.Field, mandatory []btquery.Config, cfg btquery.Config, limit int) ([]store.Record, error) {
	r, err := s.Store.QueryRecordsConstrained(ctx, id, fields, mandatory, cfg, limit)
	if s.onQuery != nil && s.once.CompareAndSwap(false, true) {
		s.onQuery()
	}
	return r, err
}
func TestBaseReadRechecksRoleAfterQuery(t *testing.T) {
	st := store.NewMemory()
	wrapped := &changingBaseStore{Store: st}
	ts, owner := newTestServer(t, wrapped, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "race-owner@example.test", "name": "Owner", "password": "password123"})
	jar, _ := cookiejar.New(nil)
	guest := &http.Client{Jar: jar}
	post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "race-guest@example.test", "name": "Guest", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/bases", nil).Body).Decode(&b)
	if err := st.SetShare(context.Background(), b.ID, 2, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	wrapped.onQuery = func() { _ = st.SetShare(context.Background(), b.ID, 2, "") }
	r := post(t, guest, ts.URL+"/api/bases/"+strconv.FormatInt(b.ID, 10)+"/query", map[string]any{})
	if r.StatusCode == http.StatusOK {
		t.Fatal("revoked read returned data")
	}
}

type failingConstrainedStore struct{ store.Store }

type failingSnapshotReader struct{ store.BaseSnapshotReader }

func (s failingSnapshotReader) QueryRecordsConstrained(context.Context, int64, []store.Field, []btquery.Config, btquery.Config, int) ([]store.Record, error) {
	return nil, errors.New("injected snapshot query error")
}

func (s failingConstrainedStore) WithBaseReadSnapshot(ctx context.Context, uid, id int64, fn func(store.BaseSnapshotReader) error) error {
	return s.Store.WithBaseReadSnapshot(ctx, uid, id, func(reader store.BaseSnapshotReader) error {
		return fn(failingSnapshotReader{reader})
	})
}

func (s failingConstrainedStore) QueryRecordsConstrained(context.Context, int64, []store.Field, []btquery.Config, btquery.Config, int) ([]store.Record, error) {
	return nil, errors.New("injected query error")
}
func TestLockedQueryErrorNeverReturnsAllRows(t *testing.T) {
	// Injecting a query failure must be an error response, never an unrestricted fallback.
	st := store.NewMemory()
	ts, c := newTestServer(t, failingConstrainedStore{st}, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "failed-query@example.test", "name": "Owner", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)
	if r := post(t, c, u+"/query", map[string]any{}); r.StatusCode == 200 {
		t.Fatal("query failure returned success")
	}
	if r := cGet(t, c, u); r.StatusCode == 200 {
		t.Fatal("GET failure returned success")
	}
}

func TestBaseLinksRespectBothSourceAndTargetPermissions(t *testing.T) {
	checkBaseLinksRespectPermissions(t, newBaseSecurityFixture(t))
}
func checkBaseLinksRespectPermissions(t *testing.T, f baseSecurityFixture) {
	root := strings.TrimSuffix(f.url, "/api/bases/"+strconv.FormatInt(f.base.ID, 10))
	var target store.DocMeta
	json.NewDecoder(post(t, f.owner, root+"/api/bases", map[string]string{"title": "目标"}).Body).Decode(&target)
	tu := root + "/api/bases/" + strconv.FormatInt(target.ID, 10)
	var fullTarget struct {
		Fields []store.Field
		Views  []store.View
	}
	json.NewDecoder(cGet(t, f.owner, tu).Body).Decode(&fullTarget)
	titleID := fullTarget.Fields[0].ID
	var status, sensitive store.Field
	json.NewDecoder(post(t, f.owner, tu+"/fields", map[string]string{"name": "状态", "type": "text"}).Body).Decode(&status)
	json.NewDecoder(post(t, f.owner, tu+"/fields", map[string]string{"name": "密文", "type": "text"}).Body).Decode(&sensitive)
	var allowed, denied store.Record
	for _, row := range []struct {
		status, title, secret string
		out                   *store.Record
	}{
		{"公开", "可见项目", "TARGET_VISIBLE_SECRET", &allowed},
		{"机密", "隐藏项目", "TARGET_HIDDEN_SECRET", &denied},
	} {
		body := map[string]any{"cells": map[string]any{strconv.FormatInt(titleID, 10): row.title, strconv.FormatInt(status.ID, 10): row.status, strconv.FormatInt(sensitive.ID, 10): row.secret}}
		json.NewDecoder(post(t, f.owner, tu+"/records", body).Body).Decode(row.out)
	}
	var link, lookup store.Field
	json.NewDecoder(post(t, f.owner, f.url+"/fields", map[string]any{"name": "项目", "type": "link", "options": []string{strconv.FormatInt(target.ID, 10)}}).Body).Decode(&link)
	json.NewDecoder(post(t, f.owner, f.url+"/fields", map[string]any{"name": "查找密文", "type": "lookup", "options": []string{strconv.FormatInt(link.ID, 10), strconv.FormatInt(sensitive.ID, 10)}}).Body).Decode(&lookup)
	key := strconv.FormatInt(link.ID, 10)
	for _, row := range []store.Record{f.public, f.private} {
		r := send(t, f.owner, "PATCH", f.url+"/records/"+strconv.FormatInt(row.ID, 10), map[string]any{"cells": map[string]any{key: []int64{allowed.ID, denied.ID}}})
		if r.StatusCode != http.StatusOK {
			t.Fatalf("link write=%d", r.StatusCode)
		}
	}
	setLockedFixture(t, f)
	var noTarget struct {
		Fields     []store.Field
		Records    []store.Record
		Expansions map[string]json.RawMessage
		Members    []store.User
	}
	r := cGet(t, f.guest, f.url)
	if r.StatusCode != 200 {
		t.Fatalf("source GET %d", r.StatusCode)
	}
	if err := json.NewDecoder(r.Body).Decode(&noTarget); err != nil {
		t.Fatal(err)
	}
	if len(noTarget.Records) != 1 || noTarget.Records[0].ID != f.public.ID {
		t.Fatalf("source rows: %+v", noTarget.Records)
	}
	if got := string(noTarget.Records[0].Cells[key]); got != "[]" {
		t.Fatalf("unshared target IDs leaked: %s", got)
	}
	if len(noTarget.Members) != 0 {
		t.Fatalf("external guest got member directory: %+v", noTarget.Members)
	}
	for _, field := range noTarget.Fields {
		if (field.ID == link.ID || field.ID == lookup.ID) && len(field.Options) > 0 {
			t.Fatalf("unshared metadata leaked: %+v", field)
		}
	}
	if strings.Contains(string(noTarget.Expansions[key+":titles"]), "项目") {
		t.Fatalf("unshared target titles: %s", noTarget.Expansions[key+":titles"])
	}
	var query struct{ Records []store.Record }
	qr := post(t, f.guest, f.url+"/query", map[string]any{})
	json.NewDecoder(qr.Body).Decode(&query)
	if qr.StatusCode != 200 || len(query.Records) != 1 || string(query.Records[0].Cells[key]) != "[]" {
		t.Fatalf("query leaked links: %+v status=%d", query, qr.StatusCode)
	}
	// The caller must not infer a concealed link by filtering or sorting the
	// raw cached IDs before the authorized projection is applied.
	for _, body := range []any{
		map[string]any{"filters": map[string]any{"conj": "and", "rules": []map[string]any{{"f": link.ID, "op": "contains", "v": strconv.FormatInt(allowed.ID, 10)}}}},
		map[string]any{"sorts": []map[string]any{{"f": link.ID, "asc": true}}},
		map[string]any{"filters": map[string]any{"conj": "and", "rules": []map[string]any{{"f": lookup.ID, "op": "contains", "v": "SECRET"}}}},
	} {
		if res := post(t, f.guest, f.url+"/query", body); res.StatusCode != http.StatusBadRequest {
			t.Fatalf("association oracle status=%d", res.StatusCode)
		}
	}

	// Sharing the target is not enough to expose rows or columns filtered by
	// its own locked policy.
	guestID := int64(2)
	if err := f.st.SetShare(context.Background(), target.ID, guestID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	cfg := map[string]any{"locked": true, "filters": map[string]any{"conj": "and", "rules": []map[string]any{{"f": status.ID, "op": "is", "v": "公开"}}}, "hidden": []int64{sensitive.ID}}
	if r := send(t, f.owner, "PATCH", tu+"/views/"+strconv.FormatInt(fullTarget.Views[0].ID, 10), map[string]any{"config": cfg}); r.StatusCode != 200 {
		t.Fatalf("target lock=%d", r.StatusCode)
	}
	var permitted struct {
		Fields     []store.Field
		Records    []store.Record
		Expansions map[string]json.RawMessage
	}
	r = cGet(t, f.guest, f.url)
	if r.StatusCode != 200 {
		t.Fatalf("shared target GET %d", r.StatusCode)
	}
	json.NewDecoder(r.Body).Decode(&permitted)
	var ids []int64
	if err := json.Unmarshal(permitted.Records[0].Cells[key], &ids); err != nil || len(ids) != 1 || ids[0] != allowed.ID {
		t.Fatalf("permitted link IDs=%v err=%v", ids, err)
	}
	var titles map[string]string
	json.Unmarshal(permitted.Expansions[key+":titles"], &titles)
	if len(titles) != 1 || titles[strconv.FormatInt(allowed.ID, 10)] != "可见项目" {
		t.Fatalf("titles=%v", titles)
	}
	if raw := string(permitted.Expansions[strconv.FormatInt(lookup.ID, 10)]); strings.Contains(raw, "SECRET") {
		t.Fatalf("hidden lookup leaked: %s", raw)
	}
	for _, field := range permitted.Fields {
		if field.ID == lookup.ID && len(field.Options) > 0 {
			t.Fatalf("hidden lookup options leaked: %+v", field)
		}
	}
	var targetView struct{ Expansions map[string]json.RawMessage }
	r = cGet(t, f.guest, tu)
	json.NewDecoder(r.Body).Decode(&targetView)
	var reverse []baseReverse
	if err := json.Unmarshal(targetView.Expansions["reverse"], &reverse); err != nil {
		t.Fatal(err)
	}
	for _, entry := range reverse {
		for targetID, sources := range entry.From {
			if targetID != allowed.ID {
				t.Fatalf("reverse leaked hidden target %d", targetID)
			}
			for _, sourceID := range sources {
				if sourceID == f.private.ID {
					t.Fatalf("reverse leaked hidden source %d", sourceID)
				}
			}
		}
		if _, found := entry.Titles[f.private.ID]; found {
			t.Fatalf("reverse leaked hidden title: %+v", entry.Titles)
		}
	}
}

func TestLinkWriteCannotMutateUnsharedOrForeignTarget(t *testing.T) {
	f := newBaseSecurityFixture(t)
	ctx := context.Background()
	guest, err := f.st.UserByEmail(ctx, "locked-guest@example.test")
	if err != nil {
		t.Fatal(err)
	}
	// A source editor has no right to create a companion field in another
	// user's unshared target, even if they guess its numeric ID.
	otherBase, err := f.st.CreateInitializedBase(ctx, 1, 1, nil, "private target")
	if err != nil {
		t.Fatal(err)
	}
	before, err := f.st.Fields(ctx, otherBase.ID)
	if err != nil {
		t.Fatal(err)
	}
	res := post(t, f.guest, f.url+"/fields", map[string]any{"name": "forged", "type": "link", "options": []string{strconv.FormatInt(otherBase.ID, 10)}})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("unshared link field: %d", res.StatusCode)
	}
	after, err := f.st.Fields(ctx, otherBase.ID)
	if err != nil || len(after) != len(before) {
		t.Fatalf("unshared target changed: %+v %v", after, err)
	}
	// Simulate a historical field already targeting a now-revoked base.
	link, err := f.st.AddField(ctx, store.Field{BaseID: f.base.ID, Name: "old link", Type: "link", Options: []string{strconv.FormatInt(otherBase.ID, 10)}})
	if err != nil {
		t.Fatal(err)
	}
	rows, err := f.st.Records(ctx, otherBase.ID)
	if err != nil || len(rows) == 0 {
		t.Fatalf("target rows: %v %v", rows, err)
	}
	key := strconv.FormatInt(link.ID, 10)
	res = send(t, f.guest, "PATCH", f.url+"/records/"+strconv.FormatInt(f.public.ID, 10), map[string]any{"cells": map[string]any{key: []int64{rows[0].ID}}})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("unshared target write: %d", res.StatusCode)
	}
	source, err := f.st.Records(ctx, f.base.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range source {
		if record.ID == f.public.ID {
			if _, exists := record.Cells[key]; exists {
				t.Fatal("source modified before target denial")
			}
		}
	}
	if err := f.st.SetShare(ctx, otherBase.ID, guest.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	res = send(t, f.guest, "PATCH", f.url+"/records/"+strconv.FormatInt(f.public.ID, 10), map[string]any{"cells": map[string]any{key: []int64{987654321}}})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("foreign target record accepted: %d", res.StatusCode)
	}
}

func postgresBaseSecurityStore(t *testing.T) store.Store {
	t.Helper()
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_api_base_acl_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
		admin.Close()
	})
	return &store.Postgres{Pool: pool}
}
func TestPostgresBaseSecurity(t *testing.T) {
	t.Run("locked query and writes", func(t *testing.T) {
		checkLockedViewCannotBeBypassed(t, newBaseSecurityFixtureWithStore(t, postgresBaseSecurityStore(t)))
	})
	t.Run("cross-base links", func(t *testing.T) {
		checkBaseLinksRespectPermissions(t, newBaseSecurityFixtureWithStore(t, postgresBaseSecurityStore(t)))
	})
}

func TestLockedHiddenComputedMetadataIsNotReturned(t *testing.T) {
	f := newBaseSecurityFixture(t)
	var createdBy, createdAt, modifiedAt store.Field
	json.NewDecoder(post(t, f.owner, f.url+"/fields", map[string]string{"name": "创建人", "type": "created_by"}).Body).Decode(&createdBy)
	json.NewDecoder(post(t, f.owner, f.url+"/fields", map[string]string{"name": "创建时间", "type": "created_at"}).Body).Decode(&createdAt)
	json.NewDecoder(post(t, f.owner, f.url+"/fields", map[string]string{"name": "最后更新", "type": "modified_at"}).Body).Decode(&modifiedAt)
	views, err := f.st.Views(context.Background(), f.base.ID)
	if err != nil {
		t.Fatal(err)
	}
	cfg := map[string]any{"locked": true, "hidden": []int64{createdBy.ID, createdAt.ID, modifiedAt.ID}}
	if r := send(t, f.owner, "PATCH", f.url+"/views/"+strconv.FormatInt(views[0].ID, 10), map[string]any{"config": cfg}); r.StatusCode != 200 {
		t.Fatalf("lock %d", r.StatusCode)
	}
	for _, r := range []*http.Response{cGet(t, f.guest, f.url), post(t, f.guest, f.url+"/query", map[string]any{})} {
		var out struct{ Records []store.Record }
		if err := json.NewDecoder(r.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		if r.StatusCode != 200 || len(out.Records) == 0 {
			t.Fatalf("response %d %+v", r.StatusCode, out)
		}
		for _, record := range out.Records {
			if record.CreatorID != nil || record.CreatedAt != nil || record.UpdatedAt != nil {
				t.Fatalf("hidden metadata leaked: %+v", record)
			}
		}
	}
}
