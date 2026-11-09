package api

import (
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestPersonDefaultAcceptsSharedCollaborators(t *testing.T) {
	checkPersonDefaultCollaborators(t, newBaseSecurityFixture(t))
}

func TestPostgresPersonDefaultAcceptsSharedCollaborators(t *testing.T) {
	checkPersonDefaultCollaborators(t, newBaseSecurityFixtureWithStore(t, postgresBaseSecurityStore(t)))
}

func checkPersonDefaultCollaborators(t *testing.T, f baseSecurityFixture) {
	root := f.url[:strings.Index(f.url, "/api/")]
	guestID := meID(t, f.guest, root) // shared with the base, not a workspace member
	jar, _ := cookiejar.New(nil)
	stranger := &http.Client{Jar: jar}
	post(t, stranger, root+"/api/auth/register", map[string]string{"email": "stranger@example.test", "name": "Stranger", "password": "password123"})
	strangerID := meID(t, stranger, root)

	// the owner's base snapshot lists the shared guest as a member, without email
	var snap struct{ Members []store.User }
	json.NewDecoder(cGet(t, f.owner, f.url).Body).Decode(&snap)
	found := false
	for _, m := range snap.Members {
		if m.ID == guestID {
			found = true
			if m.Name != "Guest" || m.Email != "" {
				t.Fatalf("shared member exposed wrongly: %+v", m)
			}
		}
		if m.ID == strangerID {
			t.Fatalf("stranger listed: %+v", m)
		}
	}
	if !found {
		t.Fatalf("shared guest missing from members: %+v", snap.Members)
	}

	var person store.Field
	res := post(t, f.owner, f.url+"/fields", map[string]any{"name": "负责人", "type": "person", "defaultValue": guestID})
	json.NewDecoder(res.Body).Decode(&person)
	if res.StatusCode != http.StatusCreated || string(person.DefaultValue) != strconv.FormatInt(guestID, 10) {
		t.Fatalf("shared collaborator default rejected: %d %+v", res.StatusCode, person)
	}
	if r := send(t, f.owner, "PATCH", f.url+"/fields/"+strconv.FormatInt(person.ID, 10), map[string]any{"defaultValue": strangerID}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("non-collaborator default accepted: %d", r.StatusCode)
	}
	var rec store.Record
	json.NewDecoder(post(t, f.owner, f.url+"/records", nil).Body).Decode(&rec)
	if string(rec.Cells[strconv.FormatInt(person.ID, 10)]) != strconv.FormatInt(guestID, 10) {
		t.Fatalf("default person not applied: %+v", rec.Cells)
	}
}
