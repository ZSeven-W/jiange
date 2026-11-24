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

func TestSlidesMediaShapesAndImageCropValidationAndRoundTrip(t *testing.T) {
	validCases := []struct {
		name string
		raw  string
	}{
		{"video https", `[{"id":"v1","kind":"video","x":10,"y":10,"width":40,"height":30,"color":"#1f2329","mediaUrl":"https://cdn.example.com/demo.mp4","posterUrl":"https://cdn.example.com/poster.png","autoplay":true,"loop":true}]`},
		{"video placeholder empty url", `[{"id":"v2","kind":"video","x":10,"y":10,"width":40,"height":30,"color":"#1f2329","mediaUrl":""}]`},
		{"audio internal file", `[{"id":"a1","kind":"audio","x":15,"y":60,"width":50,"height":12,"color":"#3370ff","mediaUrl":"/api/files/123","autoplay":false,"loop":true}]`},
		{"image with valid crop", `[{"id":"img1","kind":"image","x":10,"y":10,"width":40,"height":40,"color":"#ffffff","fileId":9,"crop":{"x":0.1,"y":0.2,"w":0.6,"h":0.5}}]`},
		{"image with full frame crop", `[{"id":"img2","kind":"image","x":10,"y":10,"width":40,"height":40,"color":"#ffffff","fileId":9,"crop":{"x":0,"y":0,"w":1,"h":1}}]`},
	}
	for _, tc := range validCases {
		if !validSlideShapes(json.RawMessage(tc.raw)) {
			t.Fatalf("expected valid case %q to pass", tc.name)
		}
	}

	invalidCases := []struct {
		name string
		raw  string
	}{
		{"video javascript url", `[{"id":"v1","kind":"video","x":10,"y":10,"width":40,"height":30,"color":"#1f2329","mediaUrl":"javascript:alert(1)"}]`},
		{"video data html url", `[{"id":"v1","kind":"video","x":10,"y":10,"width":40,"height":30,"color":"#1f2329","mediaUrl":"data:text/html,<script>alert(1)</script>"}]`},
		{"audio javascript poster", `[{"id":"a1","kind":"audio","x":10,"y":10,"width":40,"height":12,"color":"#3370ff","mediaUrl":"https://cdn.example.com/a.mp3","posterUrl":"javascript:void(0)"}]`},
		{"media path traversal", `[{"id":"a2","kind":"audio","x":10,"y":10,"width":40,"height":12,"color":"#3370ff","mediaUrl":"/api/files/../secret"}]`},
		{"crop negative x", `[{"id":"i1","kind":"image","x":10,"y":10,"width":40,"height":40,"color":"#ffffff","fileId":9,"crop":{"x":-0.1,"y":0,"w":0.5,"h":0.5}}]`},
		{"crop zero width", `[{"id":"i2","kind":"image","x":10,"y":10,"width":40,"height":40,"color":"#ffffff","fileId":9,"crop":{"x":0.1,"y":0.1,"w":0,"h":0.5}}]`},
		{"crop overflow x+w", `[{"id":"i3","kind":"image","x":10,"y":10,"width":40,"height":40,"color":"#ffffff","fileId":9,"crop":{"x":0.6,"y":0.1,"w":0.5,"h":0.5}}]`},
		{"crop overflow y+h", `[{"id":"i4","kind":"image","x":10,"y":10,"width":40,"height":40,"color":"#ffffff","fileId":9,"crop":{"x":0.1,"y":0.7,"w":0.5,"h":0.4}}]`},
		{"crop on non-image", `[{"id":"r1","kind":"rectangle","x":10,"y":10,"width":40,"height":40,"color":"#3370ff","crop":{"x":0.1,"y":0.1,"w":0.5,"h":0.5}}]`},
	}
	for _, tc := range invalidCases {
		if validSlideShapes(json.RawMessage(tc.raw)) {
			t.Fatalf("expected invalid case %q to fail", tc.name)
		}
	}

	// Full HTTP round-trip persistence for video, audio, and cropped image!
	st := store.NewMemory()
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "media5@example.test", "name": "owner", "password": "password123"}).Body.Close()
	var deck store.DriveEntry
	r := post(t, c, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "Media Deck", "scope": "personal"})
	if r.StatusCode != 201 {
		t.Fatal(r.StatusCode)
	}
	json.NewDecoder(r.Body).Decode(&deck)
	r.Body.Close()

	// Seed an attached image file owned by the deck so the cropped image shape can reference it.
	imgFile, err := st.CreateFile(t.Context(), store.FileMeta{
		DocID:      deck.ID,
		UploaderID: deck.CreatorID,
		Name:       "photo.png",
		Mime:       "image/png",
		Size:       128,
		ObjectKey:  "test-photo-key",
	})
	if err != nil {
		t.Fatalf("seed image file: %v", err)
	}

	pagesURL := fmt.Sprintf("%s/api/slides/%d/pages", ts.URL, deck.ID)
	req, _ := http.NewRequest("GET", pagesURL, nil)
	req.Header.Set("X-Jiange-User-Id", fmt.Sprint(deck.CreatorID))
	req.Header.Set("X-Jiange-Slides-Version", "5")
	resp, err := c.Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("list pages: %v", err)
	}
	var payload struct {
		Pages []store.SlidesPage `json:"pages"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil || len(payload.Pages) != 1 {
		t.Fatalf("decode pages: %v", err)
	}
	resp.Body.Close()

	contentPath := fmt.Sprintf("%s/%d/content", pagesURL, payload.Pages[0].ID)
	body := fmt.Sprintf(`{
		"title": "媒体展示",
		"body": "",
		"background": "#ffffff",
		"layout": "",
		"expectedRevision": 1,
		"shapes": [
			{"id":"vid-1","kind":"video","x":5,"y":15,"width":45,"height":40,"color":"#1f2329","mediaUrl":"https://cdn.example.com/intro.mp4","posterUrl":"https://cdn.example.com/intro.jpg","autoplay":false,"loop":true},
			{"id":"aud-1","kind":"audio","x":5,"y":65,"width":45,"height":14,"color":"#3370ff","mediaUrl":"/api/files/%d","loop":true},
			{"id":"img-1","kind":"image","x":55,"y":15,"width":38,"height":50,"color":"#ffffff","fileId":%d,"crop":{"x":0.15,"y":0.1,"w":0.7,"h":0.8}}
		]
	}`, imgFile.ID, imgFile.ID)

	patchReq, _ := http.NewRequest("PATCH", contentPath, bytes.NewBufferString(body))
	patchReq.Header.Set("Content-Type", "application/json")
	patchReq.Header.Set("X-Jiange-User-Id", fmt.Sprint(deck.CreatorID))
	patchReq.Header.Set("X-Jiange-Slides-Version", "5")
	patchResp, err := c.Do(patchReq)
	if err != nil {
		t.Fatal(err)
	}
	defer patchResp.Body.Close()
	if patchResp.StatusCode != 200 {
		t.Fatalf("patch media shapes failed: %d", patchResp.StatusCode)
	}

	// Verify V4 reader is fenced with 426 because video/audio are V5 shapes.
	v4Req, _ := http.NewRequest("GET", pagesURL, nil)
	v4Req.Header.Set("X-Jiange-User-Id", fmt.Sprint(deck.CreatorID))
	v4Req.Header.Set("X-Jiange-Slides-Version", "4")
	v4Resp, err := c.Do(v4Req)
	if err != nil {
		t.Fatal(err)
	}
	v4Resp.Body.Close()
	if v4Resp.StatusCode != http.StatusUpgradeRequired {
		t.Fatalf("expected 426 for V4 reader with video/audio shapes, got %d", v4Resp.StatusCode)
	}

	// Read back on V5 and confirm exact fields round-tripped.
	v5Req, _ := http.NewRequest("GET", pagesURL, nil)
	v5Req.Header.Set("X-Jiange-User-Id", fmt.Sprint(deck.CreatorID))
	v5Req.Header.Set("X-Jiange-Slides-Version", "5")
	v5Resp, err := c.Do(v5Req)
	if err != nil {
		t.Fatal(err)
	}
	defer v5Resp.Body.Close()
	if v5Resp.StatusCode != 200 {
		t.Fatalf("v5 read: %d", v5Resp.StatusCode)
	}
	var loaded struct {
		Pages []store.SlidesPage `json:"pages"`
	}
	if err := json.NewDecoder(v5Resp.Body).Decode(&loaded); err != nil || len(loaded.Pages) != 1 {
		t.Fatalf("decode v5 read: %v", err)
	}
	var gotShapes []struct {
		ID        string          `json:"id"`
		Kind      string          `json:"kind"`
		MediaURL  string          `json:"mediaUrl"`
		PosterURL string          `json:"posterUrl"`
		Loop      bool            `json:"loop"`
		Crop      *slideShapeCrop `json:"crop"`
	}
	if err := json.Unmarshal(loaded.Pages[0].Shapes, &gotShapes); err != nil || len(gotShapes) != 3 {
		t.Fatalf("unmarshal shapes: %v (%s)", err, loaded.Pages[0].Shapes)
	}
	if gotShapes[0].Kind != "video" || gotShapes[0].MediaURL != "https://cdn.example.com/intro.mp4" || gotShapes[0].PosterURL != "https://cdn.example.com/intro.jpg" || !gotShapes[0].Loop {
		t.Fatalf("video shape mismatch: %+v", gotShapes[0])
	}
	if gotShapes[1].Kind != "audio" || gotShapes[1].MediaURL != fmt.Sprintf("/api/files/%d", imgFile.ID) || !gotShapes[1].Loop {
		t.Fatalf("audio shape mismatch: %+v", gotShapes[1])
	}
	if gotShapes[2].Kind != "image" || gotShapes[2].Crop == nil || gotShapes[2].Crop.X != 0.15 || gotShapes[2].Crop.Y != 0.1 || gotShapes[2].Crop.W != 0.7 || gotShapes[2].Crop.H != 0.8 {
		t.Fatalf("cropped image mismatch: %+v", gotShapes[2])
	}
}
