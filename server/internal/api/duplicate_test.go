package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestDuplicateDoc(t *testing.T) {
	st := store.NewMemory()
	s := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "dup@x.com", "name": "D", "password": "password123"})
	var d store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/docs", map[string]string{"title": "原始文档"}).Body).Decode(&d)
	seedDoc(t, s, d.ID, "模板正文内容")

	res := post(t, c, ts.URL+"/api/docs/"+strconv.FormatInt(d.ID, 10)+"/duplicate", nil)
	if res.StatusCode != 201 {
		t.Fatalf("duplicate: %d", res.StatusCode)
	}
	var copy store.DocMeta
	json.NewDecoder(res.Body).Decode(&copy)
	if copy.ID == d.ID || !strings.HasSuffix(copy.Title, "副本") {
		t.Fatalf("copy meta: %+v", copy)
	}

	// 副本内容 = 源快照（标题块 + 正文）
	cur, _, err := StateAtHead(context.Background(), st, copy.ID)
	if err != nil {
		t.Fatal(err)
	}
	text := viewText(cur.View())
	if !strings.Contains(text, "模板正文内容") {
		t.Fatalf("copy missing body: %q", text)
	}
}

func newSlogDiscard4() *slogLogger4 { return &slogLogger4{} }
func hour4() time.Duration          { return time.Hour }
func newTS4(t *testing.T, s *Server) *struct{} {
	return &struct{}{}
}
func newC4(t *testing.T, ts *struct{}) *httpClient4 { return nil }

type httpClient4 struct{}
type slogLogger4 struct{}
