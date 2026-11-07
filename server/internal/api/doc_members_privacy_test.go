package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

type membersPrivacyStore struct {
	store.Store
	extra store.User
	hook  func()
}

func (s *membersPrivacyStore) WorkspaceMembers(ctx context.Context, id int64) ([]store.User, error) {
	users, err := s.Store.WorkspaceMembers(ctx, id)
	if err == nil {
		users = append(users, s.extra)
	}
	if s.hook != nil {
		f := s.hook
		s.hook = nil
		f()
	}
	return users, err
}
func TestDocumentMemberDirectoryPrivacy(t *testing.T) {
	st := &membersPrivacyStore{Store: store.NewMemory()}
	ts, owner := newTestServer(t, st, nil)
	guest := newCommentClient()
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "privacy-owner@example.test", "name": "Owner", "password": "password123"}).Body.Close()
	post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "privacy-guest@example.test", "name": "Guest", "password": "password123"}).Body.Close()
	hidden, _, err := st.CreateUser(context.Background(), "unrelated@example.test", "Unrelated", "hash")
	if err != nil {
		t.Fatal(err)
	}
	st.extra = hidden
	var d store.DocMeta
	res := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "doc"})
	json.NewDecoder(res.Body).Decode(&d)
	res.Body.Close()
	url := ts.URL + "/api/docs/" + strconv.FormatInt(d.ID, 10)
	read := func(c *http.Client) (int, []store.User) {
		res := cGet(t, c, url+"/members")
		defer res.Body.Close()
		var data struct {
			Members []store.User `json:"members"`
		}
		json.NewDecoder(res.Body).Decode(&data)
		return res.StatusCode, data.Members
	}
	has := func(users []store.User, id int64) bool {
		for _, u := range users {
			if u.ID == id {
				return true
			}
		}
		return false
	}
	for _, role := range []string{"view", "edit", "manage"} {
		res = send(t, owner, "PUT", url+"/shares", map[string]string{"email": "privacy-guest@example.test", "role": role})
		res.Body.Close()
		status, users := read(guest)
		if status != 200 || has(users, hidden.ID) || !has(users, d.CreatorID) {
			t.Fatalf("external %s: %d %+v", role, status, users)
		}
	}
	status, users := read(owner)
	if status != 200 || !has(users, hidden.ID) {
		t.Fatalf("workspace member lost directory: %d %+v", status, users)
	}
	st.hook = func() { _ = st.SetShare(context.Background(), d.ID, 2, "") }
	status, users = read(guest)
	if status == 200 || len(users) != 0 {
		t.Fatalf("revoked access leaked directory: %d %+v", status, users)
	}
}

func TestCreateOnlyInvitationDoesNotChangeExistingRole(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	guest := newCommentClient()
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "invite-owner@example.test", "name": "Owner", "password": "password123"}).Body.Close()
	post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "invite-guest@example.test", "name": "Guest", "password": "password123"}).Body.Close()
	var d store.DocMeta
	res := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "doc"})
	json.NewDecoder(res.Body).Decode(&d)
	res.Body.Close()
	url := ts.URL + "/api/docs/" + strconv.FormatInt(d.ID, 10) + "/shares"
	invite := func(email, role string) int {
		r := send(t, owner, "PUT", url, map[string]any{"email": email, "role": role, "createOnly": true})
		defer r.Body.Close()
		return r.StatusCode
	}
	if got := invite("invite-guest@example.test", "manage"); got != 200 {
		t.Fatalf("create %d", got)
	}
	if got := invite("invite-guest@example.test", "edit"); got != http.StatusConflict {
		t.Fatalf("overwrite %d", got)
	}
	if got := invite("invite-owner@example.test", "edit"); got != http.StatusConflict {
		t.Fatalf("owner %d", got)
	}
	shares, err := st.ListShares(context.Background(), d.ID)
	if err != nil || len(shares) != 1 || shares[0].Role != "manage" {
		t.Fatalf("shares %+v %v", shares, err)
	}
}
