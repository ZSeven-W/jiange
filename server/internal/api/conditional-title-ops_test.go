package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type conditionalTitleHook struct {
	store.Store
	before func()
}

func (s *conditionalTitleHook) CommitConditionalOps(ctx context.Context, g store.RestoreGuard, doc, epoch, head int64, req string, ops []store.RawOp) ([]int64, error) {
	return s.Store.(store.ConditionalOpsCommitter).CommitConditionalOps(ctx, g, doc, epoch, head, req, ops)
}
func (s *conditionalTitleHook) LookupConditionalOps(ctx context.Context, g store.RestoreGuard, doc, epoch, head int64, req string, ops []store.RawOp) ([]int64, error) {
	return s.Store.(store.ConditionalOpsCommitter).LookupConditionalOps(ctx, g, doc, epoch, head, req, ops)
}
func (s *conditionalTitleHook) CommitConditionalTitleOps(ctx context.Context, g store.RestoreGuard, doc, epoch, head int64, req string, ops []store.RawOp, old, title string) ([]int64, error) {
	if s.before != nil {
		callback := s.before
		s.before = nil
		callback()
	}
	return s.Store.(store.ConditionalTitleOpsCommitter).CommitConditionalTitleOps(ctx, g, doc, epoch, head, req, ops, old, title)
}

func checkConditionalTitleAPI(t *testing.T, base store.Store) {
	t.Helper()
	ctx := context.Background()
	st := &conditionalTitleHook{Store: base}
	ts, client := newTestServer(t, st, nil)
	resp := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "conditional-title-api@test.dev", "name": "Owner", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	resp = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "原标题"})
	var doc store.DocMeta
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	replica, err := base.AllocClient(ctx, me.User.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	url := fmt.Sprintf("%s/api/docs/%d/conditional-ops", ts.URL, doc.ID)
	sendBatch := func(epoch, head int64, request string, ops []collab.Op) (int, []int64) {
		t.Helper()
		batch, err := collab.EncodeOps(ops)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := json.Marshal(conditionalOpsInput{Epoch: epoch, Head: head, RequestID: request, Batch: batch})
		req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Jiange-User-Id", fmt.Sprint(me.User.ID))
		r, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		var result struct {
			Sequences []int64 `json:"sequences"`
		}
		_ = json.NewDecoder(r.Body).Decode(&result)
		return r.StatusCode, result.Sequences
	}
	epoch, head, err := base.HeadVersion(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	state, _, err := StateAtHead(ctx, base, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	title := collab.OpID{Client: 0, Clock: 1}
	body := collab.OpID{Client: 0, Clock: 2}
	titleOp := state.InsertText(uint64(replica), title, 0, "新")
	bodyOp := state.InsertText(uint64(replica), body, 0, "正文")
	ops := []collab.Op{titleOp, bodyOp}
	request := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	status, seqs := sendBatch(epoch, head, request, ops)
	if status != 200 || len(seqs) != 2 || seqs[0] != head+1 || seqs[1] != head+2 {
		t.Fatalf("commit %d %v", status, seqs)
	}
	after, afterHead, err := StateAtHead(ctx, base, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	meta, err := base.GetDocSystem(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if afterHead != head+2 || after.Text(title) != state.Text(title) || meta.Title != after.Text(title) || after.Text(body) != "正文" {
		t.Fatalf("atomic state title=%q metadata=%q body=%q", after.Text(title), meta.Title, after.Text(body))
	}
	if _, err = base.UpdateTitle(ctx, doc.ID, "后来改名"); err != nil {
		t.Fatal(err)
	}
	status, retry := sendBatch(epoch, head, request, ops)
	if status != 200 || !reflect.DeepEqual(retry, seqs) {
		t.Fatalf("retry %d %v", status, retry)
	}
	meta, _ = base.GetDocSystem(ctx, doc.ID)
	if meta.Title != "后来改名" {
		t.Fatalf("retry changed newer title: %q", meta.Title)
	}
	epoch, head, err = base.HeadVersion(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	state, _, err = StateAtHead(ctx, base, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	next := state.InsertText(uint64(replica), title, 0, "另")
	status, _ = sendBatch(epoch, head, "dddddddddddddddddddddddddddddddd", []collab.Op{next})
	if status != 409 {
		t.Fatalf("pre-existing directory divergence %d", status)
	}
	if _, err = base.UpdateTitle(ctx, doc.ID, after.Text(title)); err != nil {
		t.Fatal(err)
	}
	st.before = func() {
		if _, e := base.UpdateTitle(ctx, doc.ID, "并发改名"); e != nil {
			t.Error(e)
		}
	}
	status, _ = sendBatch(epoch, head, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", []collab.Op{next})
	if status != 409 {
		t.Fatalf("metadata race %d", status)
	}
	_, actualHead, _ := base.HeadVersion(ctx, doc.ID)
	meta, _ = base.GetDocSystem(ctx, doc.ID)
	after, _, _ = StateAtHead(ctx, base, doc.ID)
	if actualHead != head || meta.Title != "并发改名" || after.Text(title) == state.Text(title) {
		t.Fatalf("partial commit: head=%d title=%q directory=%q", actualHead, after.Text(title), meta.Title)
	}
	// Rejected text must not write either the log or directory metadata.
	if _, err = base.UpdateTitle(ctx, doc.ID, after.Text(title)); err != nil {
		t.Fatal(err)
	}
	unchangedTitle := after.Text(title)
	state, _, _ = StateAtHead(ctx, base, doc.ID)
	invalid := state.InsertText(uint64(replica), title, 0, strings.Repeat("超", 201))
	invalidBody := state.InsertText(uint64(replica), body, 0, "不应写入")
	status, _ = sendBatch(epoch, head, "cccccccccccccccccccccccccccccccc", []collab.Op{invalid, invalidBody})
	if status != 400 {
		t.Fatalf("long title %d", status)
	}
	_, actualHead, _ = base.HeadVersion(ctx, doc.ID)
	meta, _ = base.GetDocSystem(ctx, doc.ID)
	after, _, _ = StateAtHead(ctx, base, doc.ID)
	if actualHead != head || meta.Title != unchangedTitle || after.Text(body) != "正文" {
		t.Fatal("invalid title changed state")
	}
	state, _, _ = StateAtHead(ctx, base, doc.ID)
	late := state.InsertText(uint64(replica), title, 0, "续")
	st.before = func() {
		cookies := client.Jar.Cookies(mustParseURL(t, ts.URL))
		if len(cookies) == 0 {
			t.Error("missing session cookie")
			return
		}
		if e := base.DeleteSession(ctx, auth.HashToken(cookies[0].Value)); e != nil {
			t.Error(e)
		}
	}
	status, _ = sendBatch(epoch, head, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", []collab.Op{late})
	if status != http.StatusUnauthorized {
		t.Fatalf("revoked session %d", status)
	}
	_, actualHead, _ = base.HeadVersion(ctx, doc.ID)
	meta, _ = base.GetDocSystem(ctx, doc.ID)
	if actualHead != head || meta.Title != unchangedTitle {
		t.Fatal("revoked session changed state")
	}
}
func TestMemoryConditionalTitleAPI(t *testing.T) { checkConditionalTitleAPI(t, store.NewMemory()) }
func TestPostgresConditionalTitleAPI(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	pg, err := store.NewPostgres(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err = migrate.Up(context.Background(), pg.Pool); err != nil {
		t.Fatal(err)
	}
	checkConditionalTitleAPI(t, pg)
}
