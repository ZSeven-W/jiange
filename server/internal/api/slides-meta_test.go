package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newSlidesMetaTestServer(t *testing.T, st store.Store) (*httptest.Server, *http.Client) {
	t.Helper()
	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
	}
	// Mount the two meta endpoints on top of s.Handler() so this test works both
	// before and after coordinator route registration in api.go.
	base := s.Handler()
	mux := http.NewServeMux()
	mux.Handle("PATCH /api/slides/{id}/pages/{pid}/meta", httpx.Chain(
		s.requireUser(http.HandlerFunc(s.patchSlidesPageMeta)),
		httpx.RequireJSON,
	))
	mux.Handle("POST /api/slides/{id}/pages-meta", httpx.Chain(
		s.requireUser(http.HandlerFunc(s.batchSlidesPagesMeta)),
		httpx.RequireJSON,
	))
	mux.Handle("/", base)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	return ts, &http.Client{Jar: jar}
}

func TestSlidesMetaAPI(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newSlidesMetaTestServer(t, st)

	// Register owner and create a slides deck with 2 pages.
	res := post(t, owner, ts.URL+"/api/auth/register", map[string]string{
		"email": "slides-meta-api@example.test", "name": "Owner", "password": "password123",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register owner: %d", res.StatusCode)
	}
	res.Body.Close()

	var deck store.DriveEntry
	res = post(t, owner, ts.URL+"/api/drive/nodes", map[string]any{
		"kind": "slides", "title": "云端持久化测试", "scope": "personal",
	})
	if res.StatusCode != http.StatusCreated || json.NewDecoder(res.Body).Decode(&deck) != nil {
		t.Fatalf("create deck: %d", res.StatusCode)
	}
	res.Body.Close()

	// Create a second page.
	res = post(t, owner, fmt.Sprintf("%s/api/slides/%d/pages", ts.URL, deck.ID), map[string]any{"title": "第二页"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create page 2: %d", res.StatusCode)
	}
	res.Body.Close()

	listPages := func(client *http.Client) ([]store.SlidesPage, []byte) {
		t.Helper()
		r, err := client.Get(fmt.Sprintf("%s/api/slides/%d/pages", ts.URL, deck.ID))
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if r.StatusCode != http.StatusOK {
			t.Fatalf("list pages: %d %s", r.StatusCode, raw)
		}
		var out struct {
			Pages []store.SlidesPage `json:"pages"`
		}
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return out.Pages, raw
	}

	pages, rawInitial := listPages(owner)
	if len(pages) != 2 {
		t.Fatalf("expected 2 pages, got %d", len(pages))
	}
	// Untouched pages must omit "meta" in JSON response.
	if strings.Contains(string(rawInitial), `"meta"`) {
		t.Fatalf("untouched pages should omit meta field: %s", rawInitial)
	}

	p1, p2 := pages[0], pages[1]
	ownerID := fmt.Sprint(deck.CreatorID)

	doReq := func(client *http.Client, method, path, account, body string) (*http.Response, []byte) {
		t.Helper()
		req, err := http.NewRequest(method, ts.URL+path, bytes.NewBufferString(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		if account != "" {
			req.Header.Set("X-Jiange-User-Id", account)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		return resp, data
	}

	p1Path := fmt.Sprintf("/api/slides/%d/pages/%d/meta", deck.ID, p1.ID)
	p2Path := fmt.Sprintf("/api/slides/%d/pages/%d/meta", deck.ID, p2.ID)
	batchPath := fmt.Sprintf("/api/slides/%d/pages-meta", deck.ID)

	// Missing / mismatched account checks.
	if r, _ := doReq(owner, "PATCH", p1Path, "", `{"meta":{"transition":"fade"}}`); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing account header: %d", r.StatusCode)
	}
	if r, _ := doReq(owner, "PATCH", p1Path, "99999", `{"meta":{"transition":"fade"}}`); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong account header: %d", r.StatusCode)
	}

	// Invalid payloads -> 400.
	for _, bad := range []struct {
		name, method, path, body string
	}{
		{"missing meta field", "PATCH", p1Path, `{}`},
		{"invalid color", "PATCH", p1Path, `{"meta":{"titleStyle":{"color":"blue"}}}`},
		{"invalid fontSize", "PATCH", p1Path, `{"meta":{"titleStyle":{"fontSize":999}}}`},
		{"invalid align", "PATCH", p1Path, `{"meta":{"bodyStyle":{"align":"justify"}}}`},
		{"invalid transition", "PATCH", p1Path, `{"meta":{"transition":"zoom"}}`},
		{"unknown meta key", "PATCH", p1Path, `{"meta":{"extra":true}}`},
		{"invalid batch transition", "POST", batchPath, `{"meta":{"transition":"flip"}}`},
		{"invalid batch color", "POST", batchPath, `{"meta":{"bodyStyle":{"color":"#123"}}}`},
		{"batch rejects shapeGroups", "POST", batchPath, `{"meta":{"shapeGroups":{"g1":["s1","s2"]}}}`},
	} {
		t.Run(bad.name, func(t *testing.T) {
			r, data := doReq(owner, bad.method, bad.path, ownerID, bad.body)
			if r.StatusCode != http.StatusBadRequest {
				t.Fatalf("%s: status=%d body=%s want 400", bad.name, r.StatusCode, data)
			}
		})
	}

	// Save full page 1 metadata (styles + transition + shapeGroups).
	r, data := doReq(owner, "PATCH", p1Path, ownerID, `{
		"meta": {
			"titleStyle": {"fontSize": 44, "bold": true, "color": "#112233", "align": "center"},
			"bodyStyle": {"fontSize": 20, "italic": true, "color": "#4e5969"},
			"transition": "fade",
			"shapeGroups": {"grp-1": ["s1", "s2"]}
		}
	}`)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("save p1 meta: %d %s", r.StatusCode, data)
	}
	var saved1 store.SlidesPage
	if err := json.Unmarshal(data, &saved1); err != nil {
		t.Fatal(err)
	}
	if saved1.Revision != p1.Revision {
		t.Fatalf("revision should stay %d, got %d", p1.Revision, saved1.Revision)
	}

	// Save page 2 shapeGroups so batch merge can prove preservation.
	r, data = doReq(owner, "PATCH", p2Path, ownerID, `{"meta":{"shapeGroups":{"grp-2":["x1","x2"]}}}`)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("save p2 meta: %d %s", r.StatusCode, data)
	}

	// Batch apply theme colors + wipe transition across all pages.
	r, data = doReq(owner, "POST", batchPath, ownerID, `{"meta":{"titleStyle":{"color":"#ffffff"},"bodyStyle":{"color":"#cbd5e1"},"transition":"wipe"}}`)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("batch meta: %d %s", r.StatusCode, data)
	}
	var batchResp struct {
		Pages []store.SlidesPage `json:"pages"`
	}
	if err := json.Unmarshal(data, &batchResp); err != nil || len(batchResp.Pages) != 2 {
		t.Fatalf("batch decode: err=%v body=%s", err, data)
	}
	var meta1, meta2 store.SlidePageMeta
	if err := json.Unmarshal(batchResp.Pages[0].Meta, &meta1); err != nil {
		t.Fatalf("p1 meta decode: %v", err)
	}
	if meta1.TitleStyle == nil || *meta1.TitleStyle.FontSize != 44 || !*meta1.TitleStyle.Bold || *meta1.TitleStyle.Color != "#ffffff" || *meta1.TitleStyle.Align != "center" {
		t.Fatalf("p1 titleStyle merge mismatch: %+v", meta1.TitleStyle)
	}
	if meta1.BodyStyle == nil || !*meta1.BodyStyle.Italic || *meta1.BodyStyle.Color != "#cbd5e1" {
		t.Fatalf("p1 bodyStyle merge mismatch: %+v", meta1.BodyStyle)
	}
	if meta1.Transition == nil || *meta1.Transition != "wipe" || !reflect.DeepEqual(meta1.ShapeGroups["grp-1"], []string{"s1", "s2"}) {
		t.Fatalf("p1 batch lost groups or transition: %+v", meta1)
	}
	if err := json.Unmarshal(batchResp.Pages[1].Meta, &meta2); err != nil {
		t.Fatalf("p2 meta decode: %v", err)
	}
	if meta2.Transition == nil || *meta2.Transition != "wipe" || !reflect.DeepEqual(meta2.ShapeGroups["grp-2"], []string{"x1", "x2"}) {
		t.Fatalf("p2 batch lost groups or transition: %+v", meta2)
	}

	// Duplicate page 1 via API and verify duplicated page preserves cloud meta!
	r, data = doReq(owner, "POST", fmt.Sprintf("/api/slides/%d/pages/%d/duplicate", deck.ID, p1.ID), ownerID, fmt.Sprintf(`{"expectedRevision":%d}`, p1.Revision))
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("duplicate page: %d %s", r.StatusCode, data)
	}
	var duplicated store.SlidesPage
	if err := json.Unmarshal(data, &duplicated); err != nil {
		t.Fatal(err)
	}
	var dupMeta store.SlidePageMeta
	if err := json.Unmarshal(duplicated.Meta, &dupMeta); err != nil {
		t.Fatalf("duplicated meta decode: %v (%s)", err, duplicated.Meta)
	}
	if dupMeta.TitleStyle == nil || *dupMeta.TitleStyle.FontSize != 44 || *dupMeta.TitleStyle.Color != "#ffffff" || dupMeta.Transition == nil || *dupMeta.Transition != "wipe" || !reflect.DeepEqual(dupMeta.ShapeGroups["grp-1"], []string{"s1", "s2"}) {
		t.Fatalf("duplicated page did not preserve meta: %+v", dupMeta)
	}

	// Register a viewer with view-only access and verify 403 on both meta endpoints!
	viewerJar, _ := cookiejar.New(nil)
	viewer := &http.Client{Jar: viewerJar}
	res = post(t, viewer, ts.URL+"/api/auth/register", map[string]string{
		"email": "slides-meta-viewer@example.test", "name": "Viewer", "password": "password123",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register viewer: %d", res.StatusCode)
	}
	var viewerMe meResponse
	if err := json.NewDecoder(res.Body).Decode(&viewerMe); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	res = send(t, owner, "PUT", fmt.Sprintf("%s/api/docs/%d/shares", ts.URL, deck.ID), map[string]any{
		"email": "slides-meta-viewer@example.test", "role": "view",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("share viewer: %d", res.StatusCode)
	}
	res.Body.Close()

	viewerID := fmt.Sprint(viewerMe.User.ID)
	if r, data := doReq(viewer, "PATCH", p1Path, viewerID, `{"meta":{"transition":"push"}}`); r.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer patch meta: %d %s want 403", r.StatusCode, data)
	}
	if r, data := doReq(viewer, "POST", batchPath, viewerID, `{"meta":{"transition":"push"}}`); r.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer batch meta: %d %s want 403", r.StatusCode, data)
	}

	// Viewer can still read the deck pages with persisted cloud meta.
	viewerPages, _ := listPages(viewer)
	if len(viewerPages) != 3 || len(viewerPages[0].Meta) == 0 {
		t.Fatalf("viewer should see cloud meta: %+v", viewerPages)
	}
}
