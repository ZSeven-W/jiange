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

func TestGuardedNamedVersionAPI(t *testing.T) {
	st := store.NewMemory()
	s := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts, client := newTestServer(t, st, nil)
	res := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "guard-version@test.dev", "name": "Tester", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(res.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "Version"})
	var doc store.DocMeta
	if err := json.NewDecoder(res.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	seedDoc(t, s, doc.ID, "first")
	epoch, head, err := st.HeadVersion(context.Background(), doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	do := func(userID int64, seq, generation int64, label string) int {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"label": label, "expectedSeq": seq, "historyEpoch": generation})
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/docs/"+strconv.FormatInt(doc.ID, 10)+"/named-version", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(userID, 10))
		r, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer r.Body.Close()
		return r.StatusCode
	}
	if status := do(me.User.ID+1, head, epoch, "first"); status != 401 {
		t.Fatalf("wrong account: %d", status)
	}
	materialized, materializedHead, err := StateAtHead(context.Background(), st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.SaveSnapshot(context.Background(), doc.ID, materializedHead, materialized.EncodeState()); err != nil {
		t.Fatal(err)
	}
	if status := do(me.User.ID, head, epoch, "first"); status != 201 {
		t.Fatalf("save: %d", status)
	}
	if status := do(me.User.ID, head, epoch, "first"); status != 201 {
		t.Fatalf("retry: %d", status)
	}
	if status := do(me.User.ID, head, epoch, "rename"); status != 409 {
		t.Fatalf("existing: %d", status)
	}
	seedDoc(t, s, doc.ID, "second")
	if status := do(me.User.ID, head, epoch, "first"); status != 409 {
		t.Fatalf("stale head: %d", status)
	}
	versions, err := st.Versions(context.Background(), doc.ID)
	if err != nil || len(versions) != 1 || versions[0].Label != "first" {
		t.Fatalf("versions: %+v %v", versions, err)
	}
	state, err := st.VersionState(context.Background(), doc.ID, head)
	if err != nil || len(state) == 0 {
		t.Fatalf("state: %v", err)
	}
}
