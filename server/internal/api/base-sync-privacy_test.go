package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/coder/websocket"
)

// A reader of a source Base may not have access to its linked target. Event
// bodies must not reveal IDs or values that the authorized GET has removed.
func TestBaseSocketSendsOnlyInvalidationsForUnsharedTarget(t *testing.T) {
	f := newBaseChannelFixture(t)
	if err := f.st.SetShare(context.Background(), f.base.ID, f.viewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	var target store.DocMeta
	response := post(t, f.owner, f.ts.URL+"/api/bases", map[string]string{"title": "private target"})
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("create target: %d", response.StatusCode)
	}
	if err := json.NewDecoder(response.Body).Decode(&target); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	targetPath := f.ts.URL + "/api/bases/" + strconv.FormatInt(target.ID, 10)
	response, err := f.guest.Get(targetPath)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden && response.StatusCode != http.StatusNotFound {
		t.Fatalf("target unexpectedly readable: %d", response.StatusCode)
	}
	rows, err := f.st.Records(context.Background(), target.ID)
	if err != nil || len(rows) == 0 {
		t.Fatalf("target records: %v %v", rows, err)
	}
	var link store.Field
	response = post(t, f.owner, f.path("/fields"), map[string]any{"name": "private link", "type": "link", "options": []string{strconv.FormatInt(target.ID, 10)}})
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("create link: %d", response.StatusCode)
	}
	if err := json.NewDecoder(response.Body).Decode(&link); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	source, err := f.st.Records(context.Background(), f.base.ID)
	if err != nil || len(source) == 0 {
		t.Fatalf("source records: %v %v", source, err)
	}
	path := f.path("/records/" + strconv.FormatInt(source[0].ID, 10))
	write := func(ids []int64) {
		t.Helper()
		res := send(t, f.owner, "PATCH", path, map[string]any{"cells": map[string]any{strconv.FormatInt(link.ID, 10): ids}})
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("write links: %d", res.StatusCode)
		}
	}
	write([]int64{rows[0].ID})
	ws, _, err := f.dial(t, f.guest)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, _, err := ws.Read(ctx); err != nil {
		t.Fatal(err)
	} // hello
	if err := ws.Write(ctx, websocket.MessageText, []byte(`{"t":"hello","lastSeq":0}`)); err != nil {
		t.Fatal(err)
	}
	assertHints := func() {
		t.Helper()
		_, data, err := ws.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var frame struct {
			T      string `json:"t"`
			Events []struct {
				Seq  int64          `json:"seq"`
				Body map[string]any `json:"body"`
			} `json:"events"`
		}
		if err := json.Unmarshal(data, &frame); err != nil {
			t.Fatal(err)
		}
		if frame.T != "events" || len(frame.Events) == 0 {
			t.Fatalf("invalid event frame: %s", data)
		}
		for _, event := range frame.Events {
			if event.Seq <= 0 || len(event.Body) != 1 || event.Body["kind"] != "reload" {
				t.Fatalf("event leaked payload: %s", data)
			}
		}
	}
	assertHints() // historical replay
	write([]int64{})
	assertHints() // live fanout
}
