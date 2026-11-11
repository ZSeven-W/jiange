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

func TestRecordCommentReactionsHTTP(t *testing.T) {
	mem := store.NewMemory()
	ts, owner := newTestServer(t, mem, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "react-owner@example.test", "name": "Owner", "password": "password123"})
	jar, _ := cookiejar.New(nil)
	viewer := &http.Client{Jar: jar}
	post(t, viewer, ts.URL+"/api/auth/register", map[string]string{"email": "react-viewer@example.test", "name": "Viewer", "password": "password123"})
	var base store.DocMeta
	json.NewDecoder(post(t, owner, ts.URL+"/api/bases", nil).Body).Decode(&base)
	u := ts.URL + "/api/bases/" + strconv.FormatInt(base.ID, 10)
	rows, err := mem.Records(context.Background(), base.ID)
	if err != nil || len(rows) == 0 {
		t.Fatalf("rows=%v err=%v", rows, err)
	}
	cpath := u + "/records/" + strconv.FormatInt(rows[0].ID, 10) + "/comments"
	var c store.Comment
	json.NewDecoder(post(t, owner, cpath, map[string]any{"body": "看一下"}).Body).Decode(&c)
	rpath := cpath + "/" + strconv.FormatInt(c.ID, 10) + "/reactions"
	if res := send(t, owner, "POST", rpath, map[string]any{"emoji": "👍", "on": true}); res.StatusCode != http.StatusNoContent {
		t.Fatalf("react status=%d", res.StatusCode)
	}
	// Idempotent add; free text is refused.
	send(t, owner, "POST", rpath, map[string]any{"emoji": "👍", "on": true})
	if res := send(t, owner, "POST", rpath, map[string]any{"emoji": "hello", "on": true}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("free text status=%d", res.StatusCode)
	}
	var list struct {
		Comments  []store.Comment                    `json:"comments"`
		Reactions map[string][]store.CommentReaction `json:"reactions"`
	}
	res := send(t, owner, "GET", cpath, nil)
	json.NewDecoder(res.Body).Decode(&list)
	got := list.Reactions[strconv.FormatInt(c.ID, 10)]
	if len(got) != 1 || got[0].Emoji != "👍" || len(got[0].UserIDs) != 1 {
		t.Fatalf("reactions=%+v", list.Reactions)
	}
	// A base viewer cannot comment on a base, so cannot react either.
	if err := mem.SetShare(context.Background(), base.ID, 2, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if res := send(t, viewer, "POST", rpath, map[string]any{"emoji": "🎉", "on": true}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer react status=%d", res.StatusCode)
	}
	// Removing works and leaves nothing behind.
	send(t, owner, "POST", rpath, map[string]any{"emoji": "👍", "on": false})
	res = send(t, owner, "GET", cpath, nil)
	list.Reactions = nil
	json.NewDecoder(res.Body).Decode(&list)
	if len(list.Reactions) != 0 {
		t.Fatalf("after removal=%+v", list.Reactions)
	}
	// A comment from another record cannot be reached through this record.
	var other store.Record
	json.NewDecoder(post(t, owner, u+"/records", map[string]any{"cells": map[string]any{}}).Body).Decode(&other)
	if other.ID == 0 {
		t.Fatal("second record not created")
	}
	wrong := u + "/records/" + strconv.FormatInt(other.ID, 10) + "/comments/" + strconv.FormatInt(c.ID, 10) + "/reactions"
	if res := send(t, owner, "POST", wrong, map[string]any{"emoji": "👍", "on": true}); res.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-record status=%d", res.StatusCode)
	}
}
