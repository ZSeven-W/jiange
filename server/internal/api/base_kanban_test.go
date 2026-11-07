package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestKanbanMoveHTTP(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	if r := post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "kanban-owner@example.test", "name": "Owner", "password": "password123"}); r.StatusCode != http.StatusCreated {
		t.Fatalf("register: %d", r.StatusCode)
	}
	jar, _ := cookiejar.New(nil)
	guest := &http.Client{Jar: jar}
	if r := post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "kanban-guest@example.test", "name": "Guest", "password": "password123"}); r.StatusCode != http.StatusCreated {
		t.Fatalf("guest register: %d", r.StatusCode)
	}
	var base store.DocMeta
	if err := json.NewDecoder(post(t, owner, ts.URL+"/api/bases", nil).Body).Decode(&base); err != nil {
		t.Fatal(err)
	}
	url := ts.URL + "/api/bases/" + strconv.FormatInt(base.ID, 10)
	var field store.Field
	if err := json.NewDecoder(post(t, owner, url+"/fields", map[string]any{"name": "状态", "type": "select", "options": []string{"待办", "完成"}}).Body).Decode(&field); err != nil {
		t.Fatal(err)
	}
	rows, err := st.Records(context.Background(), base.ID)
	if err != nil || len(rows) < 2 {
		t.Fatalf("rows=%v err=%v", rows, err)
	}
	key := strconv.FormatInt(field.ID, 10)
	if rows[0], err = st.SetCells(context.Background(), base.ID, rows[0].ID, map[string]json.RawMessage{key: json.RawMessage(`"待办"`)}); err != nil {
		t.Fatal(err)
	}
	if rows[1], err = st.SetCells(context.Background(), base.ID, rows[1].ID, map[string]json.RawMessage{key: json.RawMessage(`"完成"`)}); err != nil {
		t.Fatal(err)
	}
	head, _ := st.BtHead(context.Background(), base.ID)
	path := url + "/records/" + strconv.FormatInt(rows[0].ID, 10) + "/kanban-move"
	body := map[string]any{"fieldId": field.ID, "expectedHead": head, "expectedGroup": "待办", "expectedPosition": rows[0].Position, "expectedOptions": []string{"待办", "完成"}, "targetGroup": "完成", "before": map[string]any{"id": rows[1].ID, "position": rows[1].Position}, "after": nil}
	if r := send(t, owner, "PATCH", path, body); r.StatusCode != http.StatusOK {
		t.Fatalf("move: %d", r.StatusCode)
	} else {
		var got store.Record
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil || string(got.Cells[key]) != `"完成"` || got.Position <= rows[1].Position {
			t.Fatalf("projected=%+v err=%v", got, err)
		}
	}
	if r := send(t, owner, "PATCH", path, body); r.StatusCode != http.StatusConflict {
		t.Fatalf("stale move: %d", r.StatusCode)
	}
	if err := st.SetShare(context.Background(), base.ID, 2, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if r := send(t, guest, "PATCH", path, body); r.StatusCode != http.StatusForbidden {
		t.Fatalf("reader move: %d", r.StatusCode)
	}
}
