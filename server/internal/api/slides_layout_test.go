package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestSlidesLayoutProtocol(t *testing.T) {
	ts, client := newTestServer(t, store.NewMemory(), nil)
	post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "slide-layout-api@example.test", "name": "Owner", "password": "password123"}).Body.Close()
	var deck store.DriveEntry
	res := post(t, client, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "Deck", "scope": "personal"})
	if err := json.NewDecoder(res.Body).Decode(&deck); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	list := fmt.Sprintf("%s/api/slides/%d/pages", ts.URL, deck.ID)
	res, err := client.Get(list)
	if err != nil {
		t.Fatal(err)
	}
	var initial struct {
		Pages []store.SlidesPage `json:"pages"`
	}
	if err = json.NewDecoder(res.Body).Decode(&initial); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if len(initial.Pages) != 1 {
		t.Fatal("missing page")
	}
	page := initial.Pages[0]
	call := func(method, path, account, version, body string) (int, map[string]any) {
		req, e := http.NewRequest(method, path, bytes.NewBufferString(body))
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Content-Type", "application/json")
		if account != "" {
			req.Header.Set("X-Jiange-User-Id", account)
		}
		if version != "" {
			req.Header.Set("X-Jiange-Slides-Version", version)
		}
		response, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		var payload map[string]any
		if e = json.NewDecoder(response.Body).Decode(&payload); e != nil {
			t.Fatal(e)
		}
		return response.StatusCode, payload
	}
	account := fmt.Sprint(deck.CreatorID)
	path := fmt.Sprintf("%s/%d/content", list, page.ID)
	body := `{"title":"Title","body":"Keep body","background":"","layout":"title","notes":"note","shapes":[],"expectedRevision":1}`
	if status, _ := call("PATCH", path, "", "", body); status != 400 {
		t.Fatalf("missing account %d", status)
	}
	if status, _ := call("PATCH", path, "999", "", body); status != 401 {
		t.Fatalf("wrong account %d", status)
	}
	if status, _ := call("PATCH", path, account, "", `{"layout":"bad"}`); status != 400 {
		t.Fatalf("bad layout %d", status)
	}
	if status, payload := call("PATCH", path, account, "", body); status != 200 || payload["layout"] != "title" {
		t.Fatalf("v3 update %d %+v", status, payload)
	}
	if status, _ := call("GET", list, account, "2", ""); status != 426 {
		t.Fatalf("old read %d", status)
	}
	if status, _ := call("PATCH", fmt.Sprintf("%s/api/slides/pages/%d", ts.URL, page.ID), "", "", `{"title":"oops","expectedRevision":2}`); status != 426 {
		t.Fatalf("old write %d", status)
	}
	if status, payload := call("GET", list, account, "3", ""); status != 200 || payload["presentationProtocol"] != float64(3) {
		t.Fatalf("v3 read %d %+v", status, payload)
	}
}
