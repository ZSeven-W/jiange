package api

import (
	"bytes"
	"context"
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
	"github.com/ZSeven-W/jiange/server/internal/slidessync"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newSlidesExtrasTestMux(srv *Server) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /api/slides/{id}/comments", srv.requireUser(http.HandlerFunc(srv.listSlidesComments)))
	mux.Handle("POST /api/slides/{id}/comments", httpx.Chain(srv.requireUser(http.HandlerFunc(srv.createSlidesComment)), httpx.RequireJSON))
	mux.Handle("PATCH /api/slides/{id}/comments/{cid}", httpx.Chain(srv.requireUser(http.HandlerFunc(srv.patchSlidesComment)), httpx.RequireJSON))
	mux.Handle("DELETE /api/slides/{id}/comments/{cid}", srv.requireUser(http.HandlerFunc(srv.deleteSlidesComment)))
	mux.Handle("GET /api/slides/{id}/versions", srv.requireUser(http.HandlerFunc(srv.listSlidesVersions)))
	mux.Handle("POST /api/slides/{id}/versions", httpx.Chain(srv.requireUser(http.HandlerFunc(srv.createSlidesVersion)), httpx.RequireJSON))
	mux.Handle("POST /api/slides/{id}/versions/{vid}/restore", httpx.Chain(srv.requireUser(http.HandlerFunc(srv.restoreSlidesVersion)), httpx.RequireJSON))
	mux.Handle("/", srv.Handler())
	return mux
}

func TestSlidesExtrasCommentsAndVersionsAPI(t *testing.T) {
	st := store.NewMemory()
	hub := &slidessync.Hub{
		PingInterval:  2 * time.Second,
		SweepInterval: 100 * time.Millisecond,
	}
	srv := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1,
		SlidesHub:  hub,
	}
	ts := httptest.NewServer(newSlidesExtrasTestMux(srv))
	defer ts.Close()

	newClient := func() *http.Client {
		jar, _ := cookiejar.New(nil)
		return &http.Client{Jar: jar}
	}
	cOwner := newClient()
	cEditor := newClient()
	cViewer := newClient()
	cViewer2 := newClient()
	cOutsider := newClient()

	register := func(c *http.Client, email, name string) store.User {
		t.Helper()
		res := post(t, c, ts.URL+"/api/auth/register", map[string]string{
			"email": email, "name": name, "password": "password123",
		})
		defer res.Body.Close()
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("register %s: %d", email, res.StatusCode)
		}
		var out struct {
			User store.User `json:"user"`
		}
		if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out.User
	}

	uOwner := register(cOwner, "se-api-owner@test.dev", "Owner")
	uEditor := register(cEditor, "se-api-editor@test.dev", "Editor")
	uViewer := register(cViewer, "se-api-viewer@test.dev", "Viewer")
	uViewer2 := register(cViewer2, "se-api-viewer2@test.dev", "Viewer2")
	uOutsider := register(cOutsider, "se-api-outsider@test.dev", "Outsider")

	uidOwner := strconv64(uOwner.ID)
	uidEditor := strconv64(uEditor.ID)
	uidViewer := strconv64(uViewer.ID)
	uidViewer2 := strconv64(uViewer2.ID)
	uidOutsider := strconv64(uOutsider.ID)

	res := post(t, cOwner, ts.URL+"/api/drive/nodes", map[string]any{
		"kind": "slides", "title": "季度评审", "scope": "personal",
	})
	var deck store.DriveEntry
	if err := json.NewDecoder(res.Body).Decode(&deck); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	ctx := context.Background()
	if err := st.SetShare(ctx, deck.ID, uEditor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, deck.ID, uViewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, deck.ID, uViewer2.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}

	// Add second page.
	res = post(t, cOwner, fmt.Sprintf("%s/api/slides/%d/pages", ts.URL, deck.ID), map[string]any{"title": "第二页"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create page 2: %d", res.StatusCode)
	}
	res.Body.Close()

	pages, err := st.ListSlidesPages(ctx, uOwner.ID, deck.ID)
	if err != nil || len(pages) != 2 {
		t.Fatalf("list pages: %+v err=%v", pages, err)
	}
	p1, p2 := pages[0], pages[1]

	doReq := func(c *http.Client, method, path, uid string, body any) (*http.Response, []byte) {
		t.Helper()
		var reader io.Reader
		if body != nil {
			b, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			reader = bytes.NewReader(b)
		}
		req, err := http.NewRequest(method, ts.URL+path, reader)
		if err != nil {
			t.Fatal(err)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if uid != "" {
			req.Header.Set("X-Jiange-User-Id", uid)
		}
		resp, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		return resp, raw
	}

	commentsPath := fmt.Sprintf("/api/slides/%d/comments", deck.ID)
	versionsPath := fmt.Sprintf("/api/slides/%d/versions", deck.ID)

	// Account header checks.
	if r, _ := doReq(cOwner, http.MethodGet, commentsPath, "", nil); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing account header expected 400, got %d", r.StatusCode)
	}
	if r, _ := doReq(cOwner, http.MethodGet, commentsPath, "99999", nil); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong account header expected 401, got %d", r.StatusCode)
	}

	// Outsider receives 404.
	if r, _ := doReq(cOutsider, http.MethodGet, commentsPath, uidOutsider, nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("outsider list comments expected 404, got %d", r.StatusCode)
	}
	if r, _ := doReq(cOutsider, http.MethodGet, versionsPath, uidOutsider, nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("outsider list versions expected 404, got %d", r.StatusCode)
	}

	// Input validation (400).
	if r, _ := doReq(cViewer, http.MethodPost, commentsPath, uidViewer, map[string]any{"pageId": 0, "body": "hi"}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid pageId expected 400, got %d", r.StatusCode)
	}
	if r, _ := doReq(cViewer, http.MethodPost, commentsPath, uidViewer, map[string]any{"pageId": p1.ID, "body": "   "}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty body expected 400, got %d", r.StatusCode)
	}
	if r, _ := doReq(cViewer, http.MethodPost, commentsPath, uidViewer, map[string]any{"pageId": p1.ID, "body": strings.Repeat("a", 2001)}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("oversized body expected 400, got %d", r.StatusCode)
	}
	if r, _ := doReq(cViewer, http.MethodPost, commentsPath, uidViewer, map[string]any{"pageId": p1.ID, "shapeId": strings.Repeat("x", 65), "body": "ok"}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("oversized shapeId expected 400, got %d", r.StatusCode)
	}
	if r, _ := doReq(cViewer, http.MethodPost, commentsPath, uidViewer, map[string]any{"pageId": 999999, "body": "missing page"}); r.StatusCode != http.StatusNotFound {
		t.Fatalf("missing page expected 404, got %d", r.StatusCode)
	}

	// Viewer creates a shape-anchored comment -> 201.
	r, raw := doReq(cViewer, http.MethodPost, commentsPath, uidViewer, map[string]any{
		"pageId":  p1.ID,
		"shapeId": "shape-title",
		"body":    "标题字号建议再大一点",
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create comment: %d %s", r.StatusCode, raw)
	}
	var createdComment struct {
		Comment store.SlidesComment `json:"comment"`
	}
	if err := json.Unmarshal(raw, &createdComment); err != nil {
		t.Fatal(err)
	}
	cm1 := createdComment.Comment
	if cm1.ID <= 0 || cm1.PageID != p1.ID || cm1.ShapeID != "shape-title" || cm1.AuthorID != uViewer.ID || cm1.AuthorName != "Viewer" || cm1.Resolved {
		t.Fatalf("unexpected cm1: %+v", cm1)
	}

	// List comments returns cm1.
	r, raw = doReq(cEditor, http.MethodGet, commentsPath, uidEditor, nil)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("list comments: %d %s", r.StatusCode, raw)
	}
	var commentList struct {
		Comments []store.SlidesComment `json:"comments"`
	}
	if err := json.Unmarshal(raw, &commentList); err != nil || len(commentList.Comments) != 1 || commentList.Comments[0].ID != cm1.ID {
		t.Fatalf("list comments unexpected: err=%v body=%s", err, raw)
	}

	// Patch comment permissions & validation.
	cm1Path := fmt.Sprintf("%s/%d", commentsPath, cm1.ID)
	if r, _ := doReq(cViewer, http.MethodPatch, cm1Path, uidViewer, map[string]any{}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty patch expected 400, got %d", r.StatusCode)
	}
	if r, _ := doReq(cViewer2, http.MethodPatch, cm1Path, uidViewer2, map[string]any{"resolved": true}); r.StatusCode != http.StatusForbidden {
		t.Fatalf("other viewer resolve expected 403, got %d", r.StatusCode)
	}
	if r, _ := doReq(cEditor, http.MethodPatch, cm1Path, uidEditor, map[string]any{"body": "editor edit"}); r.StatusCode != http.StatusForbidden {
		t.Fatalf("editor edit body expected 403, got %d", r.StatusCode)
	}
	// Editor CAN resolve viewer's comment.
	r, raw = doReq(cEditor, http.MethodPatch, cm1Path, uidEditor, map[string]any{"resolved": true})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("editor resolve: %d %s", r.StatusCode, raw)
	}
	if err := json.Unmarshal(raw, &createdComment); err != nil || !createdComment.Comment.Resolved {
		t.Fatalf("expected resolved=true: %s", raw)
	}
	// Manager CAN edit body and reopen.
	r, raw = doReq(cOwner, http.MethodPatch, cm1Path, uidOwner, map[string]any{"body": "已统一调整字号", "resolved": false})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("owner edit: %d %s", r.StatusCode, raw)
	}
	if err := json.Unmarshal(raw, &createdComment); err != nil || createdComment.Comment.Body != "已统一调整字号" || createdComment.Comment.Resolved {
		t.Fatalf("owner edit response mismatch: %s", raw)
	}

	// Delete permissions: editor cannot delete viewer's comment, manager can.
	if r, _ := doReq(cEditor, http.MethodDelete, cm1Path, uidEditor, nil); r.StatusCode != http.StatusForbidden {
		t.Fatalf("editor delete expected 403, got %d", r.StatusCode)
	}
	if r, _ := doReq(cOwner, http.MethodDelete, cm1Path, uidOwner, nil); r.StatusCode != http.StatusNoContent {
		t.Fatalf("owner delete expected 204, got %d", r.StatusCode)
	}

	// --- Versions & Restore + SlidesHub Broadcast ---

	// Enrich p1 content + meta before snapshotting.
	r, raw = doReq(cOwner, http.MethodPatch, fmt.Sprintf("/api/slides/%d/pages/%d/content", deck.ID, p1.ID), uidOwner, map[string]any{
		"title":            "核心路线图",
		"body":             "里程碑一\n里程碑二",
		"background":       "#0f1f3d",
		"notes":            "重点强调时间节点",
		"layout":           "title",
		"shapes":           []any{map[string]any{"id": "s1", "kind": "rectangle", "x": 10, "y": 10, "width": 25, "height": 20, "color": "#3370ff"}},
		"expectedRevision": p1.Revision,
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("patch p1 content: %d %s", r.StatusCode, raw)
	}
	r, raw = doReq(cOwner, http.MethodPatch, fmt.Sprintf("/api/slides/%d/pages/%d/meta", deck.ID, p1.ID), uidOwner, map[string]any{
		"meta": map[string]any{
			"titleStyle":  map[string]any{"fontSize": 46, "bold": true, "color": "#ffffff"},
			"transition":  "wipe",
			"shapeGroups": map[string]any{"g1": []string{"s1", "s2"}},
		},
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("patch p1 meta: %d %s", r.StatusCode, raw)
	}

	// Viewer cannot create version; oversized label returns 400.
	if r, _ := doReq(cViewer, http.MethodPost, versionsPath, uidViewer, map[string]any{"label": "denied"}); r.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer create version expected 403, got %d", r.StatusCode)
	}
	if r, _ := doReq(cEditor, http.MethodPost, versionsPath, uidEditor, map[string]any{"label": strings.Repeat("x", 121)}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("long label expected 400, got %d", r.StatusCode)
	}

	// Editor creates named version v1 -> 201.
	r, raw = doReq(cEditor, http.MethodPost, versionsPath, uidEditor, map[string]any{"label": "定稿 v1"})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create version: %d %s", r.StatusCode, raw)
	}
	var createdVer struct {
		Version store.SlidesVersionMeta `json:"version"`
	}
	if err := json.Unmarshal(raw, &createdVer); err != nil {
		t.Fatal(err)
	}
	v1 := createdVer.Version
	if v1.ID <= 0 || v1.Label != "定稿 v1" || v1.AutoSaved || v1.PageCount != 2 || v1.ActorName != "Editor" {
		t.Fatalf("unexpected v1: %+v", v1)
	}

	// Empty body creates default-labeled version.
	r, raw = doReq(cOwner, http.MethodPost, versionsPath, uidOwner, nil)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create empty-body version: %d %s", r.StatusCode, raw)
	}

	// Mutate live deck: delete p2.
	if r, raw := doReq(cOwner, http.MethodDelete, fmt.Sprintf("/api/slides/pages/%d", p2.ID), uidOwner, nil); r.StatusCode != http.StatusNoContent {
		t.Fatalf("delete p2: %d %s", r.StatusCode, raw)
	}

	// Connect viewer WebSocket to verify restore broadcasts SlidesHub revision signal.
	wsConn := dialSlidesWS(t, ts.URL, cViewer, deck.ID)
	defer wsConn.CloseNow()
	_ = waitSlidesWSMsg(t, wsConn, func(m slidesWSMessage) bool { return m.Type == "presence" })

	restorePath := fmt.Sprintf("%s/%d/restore", versionsPath, v1.ID)
	// Viewer cannot restore.
	if r, _ := doReq(cViewer, http.MethodPost, restorePath, uidViewer, nil); r.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer restore expected 403, got %d", r.StatusCode)
	}
	// Invalid version id -> 400.
	if r, _ := doReq(cOwner, http.MethodPost, versionsPath+"/0/restore", uidOwner, nil); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid vid expected 400, got %d", r.StatusCode)
	}

	// Owner restores v1 -> returns {"pages": [...]} with preserved meta, and triggers WS revision broadcast.
	r, raw = doReq(cOwner, http.MethodPost, restorePath, uidOwner, nil)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("restore v1: %d %s", r.StatusCode, raw)
	}
	var restoreResp struct {
		Pages []store.SlidesPage `json:"pages"`
	}
	if err := json.Unmarshal(raw, &restoreResp); err != nil {
		t.Fatal(err)
	}
	if len(restoreResp.Pages) != 2 || restoreResp.Pages[0].Title != "核心路线图" || restoreResp.Pages[0].Notes != "重点强调时间节点" || restoreResp.Pages[1].Title != "第二页" {
		t.Fatalf("restored pages mismatch: %+v", restoreResp.Pages)
	}
	var restoredMeta store.SlidePageMeta
	if err := json.Unmarshal(restoreResp.Pages[0].Meta, &restoredMeta); err != nil {
		t.Fatalf("restored meta decode: %v (%s)", err, restoreResp.Pages[0].Meta)
	}
	if restoredMeta.TitleStyle == nil || *restoredMeta.TitleStyle.FontSize != 46 || restoredMeta.Transition == nil || *restoredMeta.Transition != "wipe" || !reflect.DeepEqual(restoredMeta.ShapeGroups["g1"], []string{"s1", "s2"}) {
		t.Fatalf("restored meta mismatch: %+v", restoredMeta)
	}

	revMsg := waitSlidesWSMsg(t, wsConn, func(m slidesWSMessage) bool { return m.Type == "revision" })
	if revMsg.ActorID != uOwner.ID || revMsg.Seq < 1 {
		t.Fatalf("unexpected ws revision message after restore: %+v", revMsg)
	}

	// Viewer lists versions -> sees pre-restore backup first (1 page), then default version, then v1.
	r, raw = doReq(cViewer, http.MethodGet, versionsPath, uidViewer, nil)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("list versions: %d %s", r.StatusCode, raw)
	}
	var listVers struct {
		Versions []store.SlidesVersionMeta `json:"versions"`
	}
	if err := json.Unmarshal(raw, &listVers); err != nil {
		t.Fatal(err)
	}
	if len(listVers.Versions) != 3 || !listVers.Versions[0].AutoSaved || listVers.Versions[0].Label != "恢复前自动备份" || listVers.Versions[0].PageCount != 1 {
		t.Fatalf("versions after restore unexpected: %+v", listVers.Versions)
	}
}
