package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func checkTitleReconcile(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	ts, owner := newTestServer(t, st, nil)
	resp := post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "title-reconcile-owner@test.dev", "name": "Owner", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	resp = post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "文档标题"})
	var doc store.DocMeta
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	url := fmt.Sprintf("%s/api/docs/%d", ts.URL, doc.ID)
	resp = send(t, owner, http.MethodPatch, url, map[string]string{"title": "目录名称"})
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("rename %d", resp.StatusCode)
	}
	snapshot := func() titleReconcileInput {
		t.Helper()
		r, e := owner.Get(url + "/title-consistency")
		if e != nil {
			t.Fatal(e)
		}
		defer r.Body.Close()
		if r.StatusCode != 200 {
			t.Fatalf("snapshot %d", r.StatusCode)
		}
		var value titleReconcileInput
		if e = json.NewDecoder(r.Body).Decode(&value); e != nil {
			t.Fatal(e)
		}
		return value
	}
	submit := func(client *http.Client, account string, value titleReconcileInput) int {
		t.Helper()
		data, _ := json.Marshal(value)
		req, _ := http.NewRequest(http.MethodPost, url+"/title-consistency", bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		if account != "" {
			req.Header.Set("X-Jiange-User-Id", account)
		}
		r, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer r.Body.Close()
		return r.StatusCode
	}
	account := strconv.FormatInt(me.User.ID, 10)
	first := snapshot()
	if first.HistoryEpoch < 1 || first.DirectoryTitle != "目录名称" || first.DocumentTitle != "文档标题" {
		t.Fatalf("bad snapshot %+v", first)
	}
	fake := first
	fake.DocumentTitle = "伪造标题"
	if got := submit(owner, account, fake); got != 409 {
		t.Fatalf("fake title %d", got)
	}
	if got := submit(owner, "", first); got != 400 {
		t.Fatalf("missing account %d", got)
	}
	if got := submit(owner, "999999", first); got != 401 {
		t.Fatalf("wrong account %d", got)
	}
	if _, err := st.UpdateTitle(ctx, doc.ID, "其他人修改"); err != nil {
		t.Fatal(err)
	}
	if got := submit(owner, account, first); got != 409 {
		t.Fatalf("stale metadata %d", got)
	}
	current := snapshot()
	state, _, err := StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	op := state.InsertText(99, collab.OpID{Client: 0, Clock: 1}, 0, "新")
	encoded, err := collab.EncodeOps([]collab.Op{op})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.AppendOps(ctx, doc.ID, []store.RawOp{{ClientID: 99, Clock: int64(op.ID.Clock), Bytes: encoded}}); err != nil {
		t.Fatal(err)
	}
	if got := submit(owner, account, current); got != 409 {
		t.Fatalf("stale head %d", got)
	}
	current = snapshot()
	if err = st.BumpHistoryEpoch(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	if got := submit(owner, account, current); got != 409 {
		t.Fatalf("stale epoch %d", got)
	}
	jar, _ := cookiejar.New(nil)
	viewer := &http.Client{Jar: jar}
	r := post(t, viewer, ts.URL+"/api/auth/register", map[string]string{"email": "title-reconcile-viewer@test.dev", "name": "Viewer", "password": "password123"})
	var vm struct {
		User store.User `json:"user"`
	}
	if err = json.NewDecoder(r.Body).Decode(&vm); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if err = st.SetShare(ctx, doc.ID, vm.User.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	current = snapshot()
	if got := submit(viewer, strconv.FormatInt(vm.User.ID, 10), current); got != 403 && got != 404 {
		t.Fatalf("viewer write %d", got)
	}
	if got := submit(owner, account, current); got != 204 {
		t.Fatalf("reconcile %d", got)
	}
	meta, err := st.GetDocSystem(ctx, doc.ID)
	if err != nil || meta.Title != current.DocumentTitle {
		t.Fatalf("metadata %+v %v", meta, err)
	}
	if got := submit(owner, account, current); got != 409 {
		t.Fatalf("stale replay %d", got)
	}
}
func TestMemoryTitleReconcile(t *testing.T) { checkTitleReconcile(t, store.NewMemory()) }
func TestPostgresTitleReconcile(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("title_reconcile_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
		admin.Close()
	})
	pg := &store.Postgres{Pool: pool}
	if _, err = migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	checkTitleReconcile(t, pg)
}

type titleReconcileHook struct {
	store.Store
	before func()
}

func (s *titleReconcileHook) ReconcileDocumentTitle(ctx context.Context, guard store.RestoreGuard, doc, epoch, head int64, expected, title string) error {
	if s.before != nil {
		s.before()
	}
	return s.Store.(store.TitleReconciler).ReconcileDocumentTitle(ctx, guard, doc, epoch, head, expected, title)
}

func TestTitleReconcileRechecksAccessAtCommit(t *testing.T) {
	for _, event := range []string{"rename", "revoke", "logout", "epoch"} {
		t.Run(event, func(t *testing.T) {
			ctx := context.Background()
			base := store.NewMemory()
			wrapped := &titleReconcileHook{Store: base}
			ts, owner := newTestServer(t, wrapped, nil)
			ownerResp := post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "title-hook-owner@test.dev", "name": "Owner", "password": "password123"})
			ownerResp.Body.Close()
			jar, _ := cookiejar.New(nil)
			editor := &http.Client{Jar: jar}
			editorResp := post(t, editor, ts.URL+"/api/auth/register", map[string]string{"email": "title-hook-editor@test.dev", "name": "Editor", "password": "password123"})
			var me struct {
				User store.User `json:"user"`
			}
			if err := json.NewDecoder(editorResp.Body).Decode(&me); err != nil {
				t.Fatal(err)
			}
			editorResp.Body.Close()
			resp := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "文档"})
			var doc store.DocMeta
			if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if err := base.SetShare(ctx, doc.ID, me.User.ID, store.RoleEdit); err != nil {
				t.Fatal(err)
			}
			if _, err := base.UpdateTitle(ctx, doc.ID, "旧目录"); err != nil {
				t.Fatal(err)
			}
			url := fmt.Sprintf("%s/api/docs/%d/title-consistency", ts.URL, doc.ID)
			get, err := editor.Get(url)
			if err != nil {
				t.Fatal(err)
			}
			var snapshot titleReconcileInput
			if err = json.NewDecoder(get.Body).Decode(&snapshot); err != nil {
				t.Fatal(err)
			}
			get.Body.Close()
			wrapped.before = func() {
				var err error
				switch event {
				case "rename":
					_, err = base.UpdateTitle(ctx, doc.ID, "并发目录")
				case "revoke":
					err = base.SetShare(ctx, doc.ID, me.User.ID, store.RoleView)
				case "logout":
					err = base.DeleteSession(ctx, auth.HashToken(editor.Jar.Cookies(mustParseURL(t, ts.URL))[0].Value))
				case "epoch":
					err = base.BumpHistoryEpoch(ctx, doc.ID)
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			data, _ := json.Marshal(snapshot)
			req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(me.User.ID, 10))
			result, err := editor.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			result.Body.Close()
			want := http.StatusConflict
			if event == "revoke" {
				want = http.StatusForbidden
			}
			if event == "logout" {
				want = http.StatusUnauthorized
			}
			if result.StatusCode != want {
				t.Fatalf("status %d want %d", result.StatusCode, want)
			}
			current, err := base.GetDocSystem(ctx, doc.ID)
			if err != nil {
				t.Fatal(err)
			}
			expected := "旧目录"
			if event == "rename" {
				expected = "并发目录"
			}
			if current.Title != expected {
				t.Fatalf("overwrote title: %q", current.Title)
			}
		})
	}
}

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}
