package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"net/http"
	"testing"
)

func TestSlidesShapeV5FencesOldReadersAndWriters(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "shape5@example.test", "name": "owner", "password": "password123"}).Body.Close()
	var deck store.DriveEntry
	r := post(t, c, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "Deck", "scope": "personal"})
	if r.StatusCode != 201 {
		t.Fatal(r.StatusCode)
	}
	json.NewDecoder(r.Body).Decode(&deck)
	r.Body.Close()
	url := fmt.Sprintf("%s/api/slides/%d/pages", ts.URL, deck.ID)
	r, err := c.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Pages []store.SlidesPage `json:"pages"`
	}
	if err = json.NewDecoder(r.Body).Decode(&payload); err != nil || len(payload.Pages) != 1 {
		t.Fatal(err)
	}
	r.Body.Close()
	call := func(method, path, version, body string) (int, map[string]any) {
		req, e := http.NewRequest(method, path, bytes.NewBufferString(body))
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Jiange-User-Id", fmt.Sprint(deck.CreatorID))
		req.Header.Set("X-Jiange-Slides-Version", version)
		out, e := c.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer out.Body.Close()
		var result map[string]any
		json.NewDecoder(out.Body).Decode(&result)
		return out.StatusCode, result
	}
	path := fmt.Sprintf("%s/%d/content", url, payload.Pages[0].ID)
	line := `{"title":"","body":"","background":"","layout":"","shapes":[{"id":"l","kind":"line-arrow","x":10,"y":10,"color":"#1f2329"}],"expectedRevision":1}`
	if status, _ := call("PATCH", path, "4", line); status != 426 {
		t.Fatalf("v4 insert %d", status)
	}
	if status, _ := call("PATCH", path, "5", line); status != 200 {
		t.Fatalf("v5 insert %d", status)
	}
	if status, _ := call("GET", url, "4", ""); status != 426 {
		t.Fatalf("v4 read %d", status)
	}
	if status, result := call("GET", url, "5", ""); status != 200 || result["presentationProtocol"] != float64(5) {
		t.Fatalf("v5 read %d %v", status, result)
	}
	overwrite := `{"title":"","body":"","background":"","layout":"","shapes":[],"expectedRevision":2}`
	if status, _ := call("PATCH", path, "4", overwrite); status != 426 {
		t.Fatalf("v4 overwrite %d", status)
	}
}

func TestSlidesLineShapesValidate(t *testing.T) {
	for _, kind := range []string{"line", "line-arrow", "line-arrow-filled", "line-dot", "line-double-arrow"} {
		raw := fmt.Sprintf(`[{"id":"l","kind":%q,"x":10,"y":10,"width":30,"height":5,"color":"#1f2329"}]`, kind)
		if !validSlideShapes(json.RawMessage(raw)) {
			t.Fatalf("invalid line type %s", kind)
		}
	}
}
