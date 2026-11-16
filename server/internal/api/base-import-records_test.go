package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestMemoryImportBaseRecords(t *testing.T) { checkImportBaseRecords(t, newBaseSecurityFixture(t)) }
func TestPostgresImportBaseRecords(t *testing.T) {
	checkImportBaseRecords(t, newBaseSecurityFixtureWithStore(t, postgresBaseSecurityStore(t)))
}

func TestAIImportPreviewRequiresAccountAndEditableBase(t *testing.T) {
	f := newBaseSecurityFixture(t)
	call := func(client *http.Client, account string) int {
		req, _ := http.NewRequest("POST", f.url+"/ai-import-preview", bytes.NewBufferString(`{"messages":[{"role":"user","content":"test"}]}`))
		req.Header.Set("Content-Type", "application/json")
		if account != "" {
			req.Header.Set("X-Jiange-User-Id", account)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		return res.StatusCode
	}
	if got := call(f.owner, ""); got != http.StatusUnauthorized {
		t.Fatalf("missing account: %d", got)
	}
	if got := call(f.owner, "999999"); got != http.StatusUnauthorized {
		t.Fatalf("wrong account: %d", got)
	}
	if got := call(f.owner, fmt.Sprint(f.base.CreatorID)); got != http.StatusPreconditionFailed {
		t.Fatalf("authorized without AI: %d", got)
	}
	setLockedFixture(t, f)
	root := f.url[:len(f.url)-len(fmt.Sprintf("/api/bases/%d", f.base.ID))]
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(cGet(t, f.guest, root+"/api/me").Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	// Locked views must not send their restricted schema to a model.
	if got := call(f.guest, fmt.Sprint(me.User.ID)); got != http.StatusForbidden {
		t.Fatalf("restricted account: %d", got)
	}
}

func checkImportBaseRecords(t *testing.T, f baseSecurityFixture) {
	t.Helper()
	field := importRecordField{ID: f.status.ID, Name: f.status.Name, Type: f.status.Type, Options: f.status.Options}
	key := strconv.FormatInt(field.ID, 10)
	write := func(client *http.Client, user string, fields []importRecordField, rows []map[string]any) int {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"fields": fields, "rows": rows})
		req, _ := http.NewRequest("POST", f.url+"/import-records", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if user != "" {
			req.Header.Set("X-Jiange-User-Id", user)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		return res.StatusCode
	}
	count := func() int {
		t.Helper()
		rows, err := f.st.Records(context.Background(), f.base.ID)
		if err != nil {
			t.Fatal(err)
		}
		return len(rows)
	}
	owner := fmt.Sprint(f.base.CreatorID)
	var defaultField store.Field
	response := post(t, f.owner, f.url+"/fields", map[string]any{"name": "默认状态", "type": "text", "defaultValue": "待处理"})
	if response.StatusCode != http.StatusCreated || json.NewDecoder(response.Body).Decode(&defaultField) != nil {
		t.Fatalf("create default field: %d", response.StatusCode)
	}
	initial := count()
	rows := []map[string]any{{key: "设计"}, {key: "评审"}}
	if got := write(f.owner, "", []importRecordField{field}, rows); got != http.StatusUnauthorized {
		t.Fatalf("missing account: %d", got)
	}
	if got := write(f.owner, "999999", []importRecordField{field}, rows); got != http.StatusUnauthorized {
		t.Fatalf("wrong account: %d", got)
	}
	if got := write(f.owner, owner, []importRecordField{field}, []map[string]any{{key: "valid"}, {key: 123}}); got != http.StatusConflict {
		t.Fatalf("bad cell: %d", got)
	}
	stale := field
	stale.Name = "stale"
	if got := write(f.owner, owner, []importRecordField{stale}, rows); got != http.StatusConflict {
		t.Fatalf("stale field: %d", got)
	}
	if count() != initial {
		t.Fatal("invalid batch wrote records")
	}
	if got := write(f.owner, owner, []importRecordField{field}, rows); got != http.StatusOK {
		t.Fatalf("valid batch: %d", got)
	}
	if count() != initial+2 {
		t.Fatal("valid batch did not create both records")
	}
	created, err := f.st.Records(context.Background(), f.base.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range created[len(created)-2:] {
		if string(row.Cells[strconv.FormatInt(defaultField.ID, 10)]) != `"待处理"` {
			t.Fatalf("default not applied: %+v", row.Cells)
		}
	}
	setLockedFixture(t, f)
	root := f.url[:len(f.url)-len(fmt.Sprintf("/api/bases/%d", f.base.ID))]
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(cGet(t, f.guest, root+"/api/me").Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	if got := write(f.guest, fmt.Sprint(me.User.ID), []importRecordField{field}, rows); got != http.StatusForbidden {
		t.Fatalf("restricted writer: %d", got)
	}
	if count() != initial+2 {
		t.Fatal("restricted write created records")
	}
}
