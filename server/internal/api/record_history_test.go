package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

type historyOut struct {
	Entries []struct {
		Op      string `json:"op"`
		By      *int64 `json:"by"`
		Changes []struct {
			F      int64           `json:"f"`
			Before json.RawMessage `json:"before"`
			After  json.RawMessage `json:"after"`
		} `json:"changes"`
	} `json:"entries"`
}

func readHistory(t *testing.T, c *http.Client, url string) (int, historyOut) {
	t.Helper()
	res := cGet(t, c, url)
	var out historyOut
	if res.StatusCode == http.StatusOK {
		json.NewDecoder(res.Body).Decode(&out)
	}
	return res.StatusCode, out
}

func TestRecordHistoryDiffsAndRespectsLockedView(t *testing.T) {
	checkRecordHistory(t, newBaseSecurityFixture(t))
}

func checkRecordHistory(t *testing.T, f baseSecurityFixture) {
	statusID, secretID := strconv.FormatInt(f.status.ID, 10), strconv.FormatInt(f.secret.ID, 10)
	rec := f.url + "/records/" + strconv.FormatInt(f.public.ID, 10)
	if r := send(t, f.owner, "PATCH", rec, map[string]any{"cells": map[string]any{secretID: "NEW_SECRET"}}); r.StatusCode != http.StatusOK {
		t.Fatalf("patch secret %d", r.StatusCode)
	}
	if r := send(t, f.owner, "PATCH", rec, map[string]any{"cells": map[string]any{statusID: "公开", secretID: "NEW_SECRET"}}); r.StatusCode != http.StatusOK {
		t.Fatalf("noop patch %d", r.StatusCode)
	}
	code, owner := readHistory(t, f.owner, rec+"/history")
	if code != http.StatusOK || len(owner.Entries) != 2 {
		t.Fatalf("owner history %d %+v", code, owner.Entries)
	}
	if owner.Entries[0].Op != "update" || len(owner.Entries[0].Changes) != 1 || owner.Entries[0].Changes[0].F != f.secret.ID || string(owner.Entries[0].Changes[0].After) != `"NEW_SECRET"` || string(owner.Entries[0].Changes[0].Before) != `"HIDDEN_PUBLIC_VALUE"` {
		t.Fatalf("newest entry should be the secret edit: %+v", owner.Entries[0])
	}
	if owner.Entries[1].Op != "add" || owner.Entries[1].By == nil || len(owner.Entries[1].Changes) != 2 {
		t.Fatalf("creation entry: %+v", owner.Entries[1])
	}

	setLockedFixture(t, f)
	code, guest := readHistory(t, f.guest, rec+"/history")
	if code != http.StatusOK {
		t.Fatalf("guest history %d", code)
	}
	for _, e := range guest.Entries {
		for _, c := range e.Changes {
			if c.F == f.secret.ID {
				t.Fatalf("hidden field leaked through history: %+v", e)
			}
		}
	}
	if len(guest.Entries) != 1 || guest.Entries[0].Op != "add" {
		t.Fatalf("guest should only see the creation of the visible field: %+v", guest.Entries)
	}
	if code, _ := readHistory(t, f.guest, f.url+"/records/"+strconv.FormatInt(f.private.ID, 10)+"/history"); code != http.StatusNotFound {
		t.Fatalf("record outside the locked filter must 404, got %d", code)
	}
	_ = store.RoleView
}

func TestPostgresRecordHistory(t *testing.T) {
	checkRecordHistory(t, newBaseSecurityFixtureWithStore(t, postgresBaseSecurityStore(t)))
}
