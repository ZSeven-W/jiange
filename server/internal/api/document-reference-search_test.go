package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAccountDocumentSearchFiltersAccess(t *testing.T) {
	e := newCopyTestEnv(t)
	search := func(client *http.Client, uid, query string) (int, []byte) {
		t.Helper()
		req, _ := http.NewRequest("GET", e.server.URL+"/api/account-document-search?q="+url.QueryEscape(query), nil)
		if uid != "" {
			req.Header.Set("X-Jiange-User-Id", uid)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, b
	}
	guest := strconv.FormatInt(e.guestUser.ID, 10)
	owner := strconv.FormatInt(e.ownerUser.ID, 10)
	if code, _ := search(e.guest, "", "项目"); code != 400 {
		t.Fatalf("missing account: %d", code)
	}
	if code, _ := search(e.guest, owner, "项目"); code != 401 {
		t.Fatalf("wrong account: %d", code)
	}
	if code, body := search(e.guest, guest, "项目"); code != 200 || bytes.Contains(body, []byte("项目方案")) {
		t.Fatalf("private: %d %s", code, body)
	}
	e.share(t)
	if code, body := search(e.guest, guest, "项目"); code != 200 || !bytes.Contains(body, []byte("项目方案")) || bytes.Contains(body, []byte("creatorId")) {
		t.Fatalf("shared: %d %s", code, body)
	}
	if err := e.store.SetShare(context.Background(), e.source.ID, e.guestUser.ID, ""); err != nil {
		t.Fatal(err)
	}
	if code, body := search(e.guest, guest, "项目"); code != 200 || bytes.Contains(body, []byte("项目方案")) {
		t.Fatalf("revoked: %d %s", code, body)
	}
	if code, _ := search(e.guest, guest, ""); code != 400 {
		t.Fatalf("empty: %d", code)
	}
}

func TestAccountDocumentSearchReportsTruncatedResults(t *testing.T) {
	e := newCopyTestEnv(t)
	for i := 0; i < 33; i++ {
		title := fmt.Sprintf("同类文档 %d", i)
		if _, err := e.store.CreateDoc(context.Background(), e.ownerSpace.ID, e.ownerUser.ID, nil, title, syncsrv.InitialOps(title)); err != nil {
			t.Fatal(err)
		}
	}
	req, _ := http.NewRequest("GET", e.server.URL+"/api/account-document-search?q="+url.QueryEscape("同类文档"), nil)
	req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(e.ownerUser.ID, 10))
	res, err := e.owner.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var data struct {
		Docs []struct {
			ID int64 `json:"id"`
		} `json:"docs"`
		Truncated bool `json:"truncated"`
	}
	if err = json.NewDecoder(res.Body).Decode(&data); err != nil || res.StatusCode != 200 || len(data.Docs) != 30 || !data.Truncated {
		t.Fatalf("search: %d %+v %v", res.StatusCode, data, err)
	}
}

func TestPostgresAccountDocumentSearchAccess(t *testing.T) {
	connection := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if connection == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, connection)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := pgx.Identifier{fmt.Sprintf("reference_search_%d", time.Now().UnixNano())}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
	config, err := pgxpool.ParseConfig(connection)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	st := &store.Postgres{Pool: pool}
	server, owner := newTestServer(t, st, nil)
	jar, _ := cookiejar.New(nil)
	guest := &http.Client{Jar: jar}
	register := func(client *http.Client, email string) meResponse {
		t.Helper()
		res := post(t, client, server.URL+"/api/auth/register", map[string]string{"email": email, "name": "用户", "password": "password123"})
		defer res.Body.Close()
		var me meResponse
		if e := json.NewDecoder(res.Body).Decode(&me); e != nil || res.StatusCode != 201 {
			t.Fatalf("register: %d %v", res.StatusCode, e)
		}
		return me
	}
	ownerMe := register(owner, "reference-search-owner@test.dev")
	guestMe := register(guest, "reference-search-guest@test.dev")
	doc, err := st.CreateDoc(ctx, ownerMe.Workspaces[0].ID, ownerMe.User.ID, nil, "保密方案", syncsrv.InitialOps("保密方案"))
	if err != nil {
		t.Fatal(err)
	}
	search := func() []byte {
		t.Helper()
		req, _ := http.NewRequest("GET", server.URL+"/api/account-document-search?q="+url.QueryEscape("保密方案"), nil)
		req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(guestMe.User.ID, 10))
		res, e := guest.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		if res.StatusCode != 200 {
			t.Fatalf("search %d %s", res.StatusCode, body)
		}
		return body
	}
	if bytes.Contains(search(), []byte("保密方案")) {
		t.Fatal("private title leaked")
	}
	if err = st.SetShare(ctx, doc.ID, guestMe.User.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(search(), []byte("保密方案")) {
		t.Fatal("shared title missing")
	}
	if err = st.SetShare(ctx, doc.ID, guestMe.User.ID, ""); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(search(), []byte("保密方案")) {
		t.Fatal("revoked title leaked")
	}
}
