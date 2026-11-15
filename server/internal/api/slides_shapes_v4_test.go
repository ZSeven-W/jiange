package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"net/http"
	"testing"
)

func TestSlidesShapeV4FencesOldReadersAndWriters(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "shape4@example.test", "name": "owner", "password": "password123"}).Body.Close()
	var deck store.DriveEntry
	res := post(t, c, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "Deck", "scope": "personal"})
	if res.StatusCode != 201 {
		t.Fatal(res.StatusCode)
	}
	json.NewDecoder(res.Body).Decode(&deck)
	res.Body.Close()
	url := fmt.Sprintf("%s/api/slides/%d/pages", ts.URL, deck.ID)
	res, err := c.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Pages []store.SlidesPage `json:"pages"`
	}
	if err = json.NewDecoder(res.Body).Decode(&data); err != nil || len(data.Pages) != 1 {
		t.Fatalf("page: %+v %v", data, err)
	}
	res.Body.Close()
	page := data.Pages[0]
	account := fmt.Sprint(deck.CreatorID)
	call := func(method, path, version, body string) (int, map[string]any) {
		req, e := http.NewRequest(method, path, bytes.NewBufferString(body))
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Jiange-User-Id", account)
		if version != "" {
			req.Header.Set("X-Jiange-Slides-Version", version)
		}
		r, e := c.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer r.Body.Close()
		var result map[string]any
		json.NewDecoder(r.Body).Decode(&result)
		return r.StatusCode, result
	}
	path := fmt.Sprintf("%s/%d/content", url, page.ID)
	modern := `{"title":"Shape","body":"","background":"","layout":"","notes":"","shapes":[{"id":"s","kind":"star","x":10,"y":10,"color":"#3370ff"}],"expectedRevision":1}`
	if status, _ := call("PATCH", path, "3", modern); status != 426 {
		t.Fatalf("old insert %d", status)
	}
	if status, _ := call("PATCH", path, "4", modern); status != 200 {
		t.Fatalf("new insert %d", status)
	}
	if status, _ := call("GET", url, "3", ""); status != 426 {
		t.Fatalf("old read %d", status)
	}
	if status, payload := call("GET", url, "4", ""); status != 200 || payload["presentationProtocol"] != float64(4) {
		t.Fatalf("new read %d %+v", status, payload)
	}
	visibility := fmt.Sprintf("%s/%d/visibility", url, page.ID)
	if status, _ := call("PATCH", visibility, "4", `{"hidden":true,"expectedRevision":2}`); status != 200 {
		t.Fatalf("hide %d", status)
	}
	if status, payload := call("GET", url, "4", ""); status != 200 || payload["presentationProtocol"] != float64(4) {
		t.Fatalf("hidden v4 read %d %+v", status, payload)
	}
	overwrite := `{"title":"lost","body":"","background":"","layout":"","shapes":[],"expectedRevision":2}`
	if status, _ := call("PATCH", path, "3", overwrite); status != 426 {
		t.Fatalf("old overwrite %d", status)
	}
	if status, _ := call("PATCH", fmt.Sprintf("%s/api/slides/pages/%d", ts.URL, page.ID), "", `{"title":"lost","expectedRevision":2}`); status != 426 {
		t.Fatalf("legacy overwrite %d", status)
	}
	if status, payload := call("GET", url, "4", ""); status != 200 || len(payload["pages"].([]any)) != 1 {
		t.Fatalf("preserve %d %+v", status, payload)
	}
}
