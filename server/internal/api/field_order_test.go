package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestFieldOrderHTTP(t *testing.T) {
	_, client, url, _ := newBaseForViews(t)
	var initial struct {
		Fields []store.Field `json:"fields"`
	}
	resp, err := client.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.NewDecoder(resp.Body).Decode(&initial); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if len(initial.Fields) < 1 {
		t.Fatalf("fields=%+v", initial.Fields)
	}
	var second store.Field
	resp = post(t, client, url+"/fields", map[string]any{"name": "第二列", "type": "text"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("add field: %d", resp.StatusCode)
	}
	if err = json.NewDecoder(resp.Body).Decode(&second); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	var third store.Field
	resp = post(t, client, url+"/fields", map[string]any{"name": "第三列", "type": "text"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("add third field: %d", resp.StatusCode)
	}
	if err = json.NewDecoder(resp.Body).Decode(&third); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	currentIDs := make([]int64, 0, len(initial.Fields)+1)
	for _, field := range initial.Fields {
		currentIDs = append(currentIDs, field.ID)
	}
	currentIDs = append(currentIDs, second.ID)
	currentIDs = append(currentIDs, third.ID)
	desired := append([]int64(nil), currentIDs[:len(initial.Fields)]...)
	desired = append(desired, third.ID, second.ID)
	if res := post(t, client, url+"/fields/reorder", map[string]any{"expectedFieldIds": currentIDs[:1], "desiredFieldIds": currentIDs[:1]}); res.StatusCode != http.StatusConflict {
		t.Fatalf("partial order: %d", res.StatusCode)
	}
	if res := post(t, client, url+"/fields/reorder", map[string]any{"expectedFieldIds": currentIDs, "desiredFieldIds": desired}); res.StatusCode != http.StatusNoContent {
		t.Fatalf("reorder: %d", res.StatusCode)
	}
	if res := post(t, client, url+"/fields/reorder", map[string]any{"expectedFieldIds": currentIDs, "desiredFieldIds": desired}); res.StatusCode != http.StatusConflict {
		t.Fatalf("stale order: %d", res.StatusCode)
	}
	var current struct {
		Fields []store.Field `json:"fields"`
	}
	resp, err = client.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.NewDecoder(resp.Body).Decode(&current); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if len(current.Fields) != len(desired) || current.Fields[0].ID != currentIDs[0] || current.Fields[len(initial.Fields)].ID != third.ID || current.Fields[len(initial.Fields)+1].ID != second.ID {
		t.Fatalf("fields=%+v", current.Fields)
	}
}

func TestFieldOrderRejectsRestrictedEditor(t *testing.T) {
	f := newBaseSecurityFixture(t)
	fields, err := f.st.Fields(t.Context(), f.base.ID)
	if err != nil || len(fields) == 0 {
		t.Fatalf("fields=%v err=%v", fields, err)
	}
	ids := make([]int64, len(fields))
	for i := range fields {
		ids[i] = fields[i].ID
	}
	setLockedFixture(t, f)
	res := post(t, f.guest, f.url+"/fields/reorder", map[string]any{"expectedFieldIds": ids, "desiredFieldIds": ids})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("restricted reorder: %d", res.StatusCode)
	}
}
