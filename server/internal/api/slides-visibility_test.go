package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestSlideVisibilityProtocolAndAccount(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "visibility-api@example.test", "name": "Owner", "password": "password123"}).Body.Close()
	var deck store.DriveEntry
	r := post(t, c, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "Deck", "scope": "personal"})
	if r.StatusCode != 201 {
		t.Fatalf("deck: %d", r.StatusCode)
	}
	if err := json.NewDecoder(r.Body).Decode(&deck); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	url := fmt.Sprintf("%s/api/slides/%d/pages", ts.URL, deck.ID)
	r, err := c.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	var initial struct {
		Pages []store.SlidesPage `json:"pages"`
	}
	if err = json.NewDecoder(r.Body).Decode(&initial); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if len(initial.Pages) != 1 {
		t.Fatalf("initial: %+v", initial.Pages)
	}
	page := initial.Pages[0]
	call := func(method, path, version, account, body string) (*http.Response, []byte) {
		req, e := http.NewRequest(method, path, bytes.NewBufferString(body))
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Content-Type", "application/json")
		if version != "" {
			req.Header.Set("X-Jiange-Slides-Version", version)
		}
		if account != "" {
			req.Header.Set("X-Jiange-User-Id", account)
		}
		res, e := c.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		var payload json.RawMessage
		if e = json.NewDecoder(res.Body).Decode(&payload); e != nil {
			t.Fatal(e)
		}
		return res, payload
	}
	path := fmt.Sprintf("%s/%d/visibility", url, page.ID)
	body := `{"hidden":true,"expectedRevision":1}`
	account := fmt.Sprint(deck.CreatorID)
	if res, _ := call("PATCH", path, "", "", body); res.StatusCode != 400 {
		t.Fatalf("missing account: %d", res.StatusCode)
	}
	if res, _ := call("PATCH", path, "", "999", body); res.StatusCode != 401 {
		t.Fatalf("wrong account: %d", res.StatusCode)
	}
	if res, _ := call("PATCH", path, "", account, `{}`); res.StatusCode != 400 {
		t.Fatalf("missing state: %d", res.StatusCode)
	}
	if res, _ := call("PATCH", path, "", account, `{"hidden":true,"expectedRevision":99}`); res.StatusCode != 409 {
		t.Fatalf("stale: %d", res.StatusCode)
	}
	if res, _ := call("PATCH", path, "", account, body); res.StatusCode != 200 {
		t.Fatalf("hide: %d", res.StatusCode)
	}
	if res, _ := call("GET", url, "", "", ""); res.StatusCode != 426 {
		t.Fatalf("old client accepted hidden page: %d", res.StatusCode)
	}
	if res, _ := call("GET", url, "2", "", ""); res.StatusCode != 400 {
		t.Fatalf("unbound v2: %d", res.StatusCode)
	}
	if res, _ := call("GET", url, "2", "999", ""); res.StatusCode != 401 {
		t.Fatalf("switched v2: %d", res.StatusCode)
	}
	res, payload := call("GET", url, "2", account, "")
	var visible struct {
		Pages    []store.SlidesPage `json:"pages"`
		Protocol int                `json:"presentationProtocol"`
	}
	if res.StatusCode != 200 || json.Unmarshal(payload, &visible) != nil || visible.Protocol != 2 || len(visible.Pages) != 1 || !visible.Pages[0].Hidden {
		t.Fatalf("v2: %d %s", res.StatusCode, payload)
	}
	if res, _ := call("PATCH", path, "", account, `{"hidden":false,"expectedRevision":2}`); res.StatusCode != 200 {
		t.Fatalf("unhide: %d", res.StatusCode)
	}
	if res, _ := call("GET", url, "", "", ""); res.StatusCode != 200 {
		t.Fatalf("old client after unhide: %d", res.StatusCode)
	}
}
