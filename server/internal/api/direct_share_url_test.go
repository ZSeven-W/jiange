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

func TestDirectDocumentURLRequiresExistingAccess(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	client := func() *http.Client { jar, _ := cookiejar.New(nil); return &http.Client{Jar: jar} }
	invited, outsider, member := client(), client(), client()
	for _, account := range []struct {
		client *http.Client
		email  string
	}{
		{owner, "direct-owner@example.test"},
		{invited, "direct-invited@example.test"},
		{outsider, "direct-outsider@example.test"},
		{member, "direct-member@example.test"},
	} {
		res := post(t, account.client, ts.URL+"/api/auth/register", map[string]string{"email": account.email, "name": "User", "password": "password123"})
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("register: %d", res.StatusCode)
		}
		res.Body.Close()
	}
	var doc store.DocMeta
	res := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "private document"})
	if err := json.NewDecoder(res.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	url := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10)
	memberUser, err := st.UserByEmail(context.Background(), "direct-member@example.test")
	if err != nil {
		t.Fatal(err)
	}
	st.AddMember(doc.WorkspaceID, memberUser.ID)
	res = send(t, owner, "PUT", url+"/shares", map[string]string{"email": "direct-invited@example.test", "role": "view"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("invite: %d", res.StatusCode)
	}
	res.Body.Close()
	for _, tc := range []struct {
		name   string
		client *http.Client
		want   int
	}{
		{"owner", owner, http.StatusOK},
		{"invited", invited, http.StatusOK},
		{"workspace member", member, http.StatusOK},
		{"outsider", outsider, http.StatusNotFound},
		{"anonymous", &http.Client{}, http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := cGet(t, tc.client, url)
			defer response.Body.Close()
			if response.StatusCode != tc.want {
				t.Fatalf("direct access: got %d, want %d", response.StatusCode, tc.want)
			}
		})
	}
	res = send(t, owner, "PUT", url+"/shares", map[string]string{"email": "direct-invited@example.test", "role": ""})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("remove invitation: %d", res.StatusCode)
	}
	res.Body.Close()
	res = cGet(t, invited, url)
	defer res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("revoked direct access: got %d", res.StatusCode)
	}
}
