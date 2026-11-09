package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestPinsMemory(t *testing.T) { checkPins(t, store.NewMemory()) }

func TestPostgresPins(t *testing.T) { checkPins(t, postgresBaseSecurityStore(t)) }

func checkPins(t *testing.T, st store.Store) {
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "pin@example.test", "name": "P", "password": "password123"})
	var a, b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/docs", map[string]string{"title": "甲"}).Body).Decode(&a)
	json.NewDecoder(post(t, c, ts.URL+"/api/docs", map[string]string{"title": "乙"}).Body).Decode(&b)
	pin := func(method string, id int64) {
		t.Helper()
		if r := send(t, c, method, ts.URL+"/api/docs/"+strconv.FormatInt(id, 10)+"/pin", nil); r.StatusCode != http.StatusNoContent {
			t.Fatalf("%s pin %d: %d", method, id, r.StatusCode)
		}
	}
	list := func() []int64 {
		t.Helper()
		r, _ := c.Get(ts.URL + "/api/pins")
		var res struct{ Docs []store.DocMeta }
		json.NewDecoder(r.Body).Decode(&res)
		ids := []int64{}
		for _, d := range res.Docs {
			ids = append(ids, d.ID)
		}
		return ids
	}
	pin("PUT", a.ID)
	pin("PUT", b.ID)
	pin("PUT", a.ID) // idempotent
	if got := list(); len(got) != 2 || got[0] != b.ID || got[1] != a.ID {
		t.Fatalf("pins newest first: %v", got)
	}
	// pins are independent of favorites
	r, _ := c.Get(ts.URL + "/api/favorites")
	var fav struct{ Docs []store.DocMeta }
	json.NewDecoder(r.Body).Decode(&fav)
	if len(fav.Docs) != 0 {
		t.Fatalf("pin leaked into favorites: %+v", fav.Docs)
	}
	pin("DELETE", b.ID)
	if got := list(); len(got) != 1 || got[0] != a.ID {
		t.Fatalf("after unpin: %v", got)
	}
}
