package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestRestoreVersionBoundAccount(t *testing.T) {
	st := store.NewMemory()
	s := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts, client := newTestServer(t, st, nil)
	res := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "restore-bound@test.dev", "name": "Tester", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(res.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "版本"})
	var meta store.DocMeta
	if err := json.NewDecoder(res.Body).Decode(&meta); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	seedDoc(t, s, meta.ID, "旧内容")
	before, head, err := StateAtHead(context.Background(), st, meta.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.SaveSnapshot(context.Background(), meta.ID, head, before.EncodeState()); err != nil {
		t.Fatal(err)
	}
	if err = st.SaveVersion(context.Background(), meta.ID, head, "初稿", me.User.ID); err != nil {
		t.Fatal(err)
	}
	seedDoc(t, s, meta.ID, "新内容")
	url := ts.URL + "/api/docs/" + strconv.FormatInt(meta.ID, 10) + "/versions/" + strconv.FormatInt(head, 10) + "/restore-guarded"
	send := func(header string) int {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPost, url, nil)
		if header != "" {
			req.Header.Set("X-Jiange-User-Id", header)
		}
		response, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		return response.StatusCode
	}
	if status := send(""); status != http.StatusBadRequest {
		t.Fatalf("missing account: %d", status)
	}
	if status := send(strconv.FormatInt(me.User.ID+1, 10)); status != http.StatusUnauthorized {
		t.Fatalf("wrong account: %d", status)
	}
	current, _, err := StateAtHead(context.Background(), st, meta.ID)
	if err != nil || !strings.Contains(viewText(current.View()), "新内容") {
		t.Fatalf("denied restore changed state: %v", err)
	}
	if status := send(strconv.FormatInt(me.User.ID, 10)); status != http.StatusOK {
		t.Fatalf("authorized restore: %d", status)
	}
	current, _, err = StateAtHead(context.Background(), st, meta.ID)
	if err != nil || !strings.Contains(viewText(current.View()), "旧内容") || strings.Contains(viewText(current.View()), "新内容") {
		t.Fatalf("restored state: %q %v", viewText(current.View()), err)
	}
}
