package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestVersionEntriesAPI(t *testing.T) {
	st := store.NewMemory()
	s := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts, client := newTestServer(t, st, nil)
	res := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "versions-multiple@test.dev", "name": "Tester", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(res.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "版本"})
	var doc store.DocMeta
	if err := json.NewDecoder(res.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	seedDoc(t, s, doc.ID, "内容")
	epoch, head, err := st.HeadVersion(context.Background(), doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	do := func(method string, userID int64, body any) (int, []byte) {
		t.Helper()
		var data io.Reader
		if body != nil {
			raw, _ := json.Marshal(body)
			data = bytes.NewReader(raw)
		}
		req, _ := http.NewRequest(method, ts.URL+"/api/docs/"+strconv.FormatInt(doc.ID, 10)+"/version-entries", data)
		req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(userID, 10))
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		r, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer r.Body.Close()
		v, _ := io.ReadAll(r.Body)
		return r.StatusCode, v
	}
	request := func(label, id string) map[string]any {
		return map[string]any{"label": label, "historyEpoch": epoch, "expectedSeq": head, "requestId": id}
	}
	a := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	b := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if status, _ := do("GET", me.User.ID+1, nil); status != 401 {
		t.Fatalf("wrong account: %d", status)
	}
	status, data := do("POST", me.User.ID, request("初稿", a))
	if status != 201 {
		t.Fatalf("create: %d %s", status, data)
	}
	var first store.VersionEntry
	if err = json.Unmarshal(data, &first); err != nil {
		t.Fatal(err)
	}
	status, data = do("POST", me.User.ID, request("初稿", a))
	var retry store.VersionEntry
	if status != 201 || json.Unmarshal(data, &retry) != nil || retry.ID != first.ID {
		t.Fatalf("retry: %d %s", status, data)
	}
	if status, _ = do("POST", me.User.ID, request("改名", a)); status != 409 {
		t.Fatalf("changed request: %d", status)
	}
	status, data = do("POST", me.User.ID, request("审阅版", b))
	var second store.VersionEntry
	if status != 201 || json.Unmarshal(data, &second) != nil || second.ID == first.ID || second.Seq != first.Seq {
		t.Fatalf("second: %d %s", status, data)
	}
	status, data = do("GET", me.User.ID, nil)
	var list struct {
		Versions []store.VersionEntry `json:"versions"`
	}
	if status != 200 || json.Unmarshal(data, &list) != nil || len(list.Versions) != 2 {
		t.Fatalf("list: %d %s", status, data)
	}
	res, err = client.Get(ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10) + "/versions/" + strconv.FormatInt(head, 10))
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("legacy preview: %d", res.StatusCode)
	}
	res.Body.Close()
	seedDoc(t, s, doc.ID, "更新")
	if status, _ = do("POST", me.User.ID, request("stale", "cccccccccccccccccccccccccccccccc")); status != 409 {
		t.Fatalf("stale head: %d", status)
	}
}
