package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestCreateViewAccountBinding(t *testing.T) {
	ts, owner := newTestServer(t, store.NewMemory(), nil)
	other := newCommentClient()
	var ownerMe, otherMe meResponse
	r := post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "view-owner@example.test", "name": "Owner", "password": "password123"})
	if err := json.NewDecoder(r.Body).Decode(&ownerMe); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	r = post(t, other, ts.URL+"/api/auth/register", map[string]string{"email": "view-other@example.test", "name": "Other", "password": "password123"})
	if err := json.NewDecoder(r.Body).Decode(&otherMe); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	var base store.DocMeta
	r = post(t, owner, ts.URL+"/api/bases", map[string]string{"title": "项目"})
	if err := json.NewDecoder(r.Body).Decode(&base); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	baseURL := fmt.Sprintf("%s/api/bases/%d", ts.URL, base.ID)
	r = send(t, owner, "PUT", fmt.Sprintf("%s/api/docs/%d/shares", ts.URL, base.ID), map[string]string{"email": "view-other@example.test", "role": "edit"})
	if r.StatusCode != 200 {
		t.Fatalf("share: %d", r.StatusCode)
	}
	r.Body.Close()
	call := func(client *http.Client, account string) int {
		req, err := http.NewRequest("POST", baseURL+"/account-views", bytes.NewBufferString(`{"type":"kanban","name":"看板视图"}`))
		if err != nil {
			t.Fatal(err)
		}
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
	if got := call(owner, ""); got != 400 {
		t.Fatalf("missing account: %d", got)
	}
	if got := call(owner, fmt.Sprint(otherMe.User.ID)); got != 401 {
		t.Fatalf("wrong account: %d", got)
	}
	if got := call(other, fmt.Sprint(ownerMe.User.ID)); got != 401 {
		t.Fatalf("session switched: %d", got)
	}
	if got := call(other, fmt.Sprint(otherMe.User.ID)); got != 201 {
		t.Fatalf("authorized: %d", got)
	}
	read := func(client *http.Client, account string) int {
		req, err := http.NewRequest("GET", baseURL+"/account-snapshot", nil)
		if err != nil {
			t.Fatal(err)
		}
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
	if got := read(owner, ""); got != 400 {
		t.Fatalf("unbound snapshot: %d", got)
	}
	if got := read(other, fmt.Sprint(ownerMe.User.ID)); got != 401 {
		t.Fatalf("switched snapshot: %d", got)
	}
	if got := read(owner, fmt.Sprint(ownerMe.User.ID)); got != 200 {
		t.Fatalf("authorized snapshot: %d", got)
	}
	r = send(t, owner, "PUT", fmt.Sprintf("%s/api/docs/%d/shares", ts.URL, base.ID), map[string]string{"email": "view-other@example.test", "role": "view"})
	if r.StatusCode != 200 {
		t.Fatalf("downgrade: %d", r.StatusCode)
	}
	r.Body.Close()
	if got := call(other, fmt.Sprint(otherMe.User.ID)); got != 403 {
		t.Fatalf("viewer: %d", got)
	}
	r, err := owner.Get(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	var state struct {
		Views []store.View `json:"views"`
	}
	if err = json.NewDecoder(r.Body).Decode(&state); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if len(state.Views) != 2 {
		t.Fatalf("unexpected views after rejected requests: %+v", state.Views)
	}
}
