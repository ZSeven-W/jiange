package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestDocumentTitleModifierUsesAuthenticatedEditor(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	ownerRes := post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "metadata-owner@test.dev", "name": "Owner", "password": "password123"})
	if ownerRes.StatusCode != http.StatusCreated {
		t.Fatal(ownerRes.Status)
	}
	jar, _ := cookiejar.New(nil)
	editor := &http.Client{Jar: jar}
	editorRes := post(t, editor, ts.URL+"/api/auth/register", map[string]string{"email": "metadata-editor@test.dev", "name": "Editor", "password": "password123"})
	if editorRes.StatusCode != http.StatusCreated {
		t.Fatal(editorRes.Status)
	}
	var editorMe meResponse
	if err := json.NewDecoder(editorRes.Body).Decode(&editorMe); err != nil {
		t.Fatal(err)
	}
	var doc store.DocMeta
	created := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "Initial"})
	if created.StatusCode != http.StatusCreated {
		t.Fatal(created.Status)
	}
	if err := json.NewDecoder(created.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(context.Background(), doc.ID, editorMe.User.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	res := send(t, editor, http.MethodPatch, ts.URL+"/api/docs/"+strconv64(doc.ID), map[string]string{"title": "Editor title"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("patch: %s", res.Status)
	}
	var listing struct {
		Entries []store.DriveEntry `json:"entries"`
	}
	if err := json.NewDecoder(cGet(t, owner, ts.URL+"/api/drive/children").Body).Decode(&listing); err != nil {
		t.Fatal(err)
	}
	if len(listing.Entries) != 1 || listing.Entries[0].LastModifierName != "Editor" {
		t.Fatalf("modifier: %+v", listing.Entries)
	}
}
