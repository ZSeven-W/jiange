package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/slidessync"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type slidesWSMessage struct {
	Type          string                    `json:"type"`
	Seq           int64                     `json:"seq"`
	ActorID       int64                     `json:"actorId"`
	Collaborators []slidessync.Collaborator `json:"collaborators"`
}

func dialSlidesWS(t *testing.T, tsURL string, c *http.Client, deckID int64) *websocket.Conn {
	t.Helper()
	parsed, err := url.Parse(tsURL)
	if err != nil {
		t.Fatal(err)
	}
	var cookies []string
	for _, ck := range c.Jar.Cookies(parsed) {
		cookies = append(cookies, ck.Name+"="+ck.Value)
	}
	wsURL := "ws" + strings.TrimPrefix(tsURL, "http") + "/api/slides/" + strconv64(deckID) + "/ws"
	hdr := http.Header{}
	if len(cookies) > 0 {
		hdr.Set("Cookie", strings.Join(cookies, "; "))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		t.Fatalf("dial slides ws: %v", err)
	}
	return conn
}

func waitSlidesWSMsg(t *testing.T, conn *websocket.Conn, match func(slidesWSMessage) bool) slidesWSMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read slides ws: %v", err)
		}
		var msg slidesWSMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			t.Fatalf("unmarshal slides ws %s: %v", data, err)
		}
		if match(msg) {
			return msg
		}
	}
}

func runSlidesCollabPptxSuite(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	hub := &slidessync.Hub{
		PingInterval:  time.Second,
		SweepInterval: 50 * time.Millisecond,
	}
	srv := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1,
		SlidesHub:  hub,
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	newClient := func() *http.Client {
		j, _ := cookiejar.New(nil)
		return &http.Client{Jar: j}
	}
	cOwner := newClient()
	cEditor := newClient()
	cViewer := newClient()

	register := func(c *http.Client, email, name string) store.User {
		t.Helper()
		r := post(t, c, ts.URL+"/api/auth/register", map[string]string{
			"email": email, "name": name, "password": "password123",
		})
		defer r.Body.Close()
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("register %s: status=%d", email, r.StatusCode)
		}
		var out struct {
			User store.User `json:"user"`
		}
		if err := json.NewDecoder(r.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out.User
	}

	owner := register(cOwner, "slides-owner@test.dev", "Owner")
	editor := register(cEditor, "slides-editor@test.dev", "Editor")
	viewer := register(cViewer, "slides-viewer@test.dev", "Viewer")

	doJSON := func(c *http.Client, method, path string, body any, uid int64) (int, []byte) {
		t.Helper()
		var rdr io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rdr = bytesReader(b)
		}
		req, err := http.NewRequest(method, ts.URL+path, rdr)
		if err != nil {
			t.Fatal(err)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if uid > 0 {
			req.Header.Set("X-Jiange-User-Id", strconv64(uid))
		}
		req.Header.Set("X-Jiange-Slides-Version", "5")
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		return res.StatusCode, raw
	}

	// 1. Create slides deck and share with Editor & Viewer.
	code, raw := doJSON(cOwner, http.MethodPost, "/api/drive/nodes", map[string]any{
		"kind": "slides", "title": "协作演示文稿", "scope": "personal",
	}, owner.ID)
	if code != http.StatusCreated {
		t.Fatalf("create slides: status=%d body=%s", code, raw)
	}
	var deck store.DriveEntry
	if err := json.Unmarshal(raw, &deck); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, deck.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, deck.ID, viewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}

	deckPath := "/api/slides/" + strconv64(deck.ID)

	// 2. Connect Owner & Editor to Slides WebSocket and verify presence + active page cursor.
	wsOwner := dialSlidesWS(t, ts.URL, cOwner, deck.ID)
	defer wsOwner.CloseNow()
	wsEditor := dialSlidesWS(t, ts.URL, cEditor, deck.ID)
	defer wsEditor.CloseNow()

	waitSlidesWSMsg(t, wsOwner, func(m slidesWSMessage) bool {
		return m.Type == "presence" && len(m.Collaborators) == 2
	})
	waitSlidesWSMsg(t, wsEditor, func(m slidesWSMessage) bool {
		return m.Type == "presence" && len(m.Collaborators) == 2
	})

	// List initial slide and report Owner's cursor pageId.
	code, raw = doJSON(cOwner, http.MethodGet, deckPath+"/pages", nil, owner.ID)
	if code != http.StatusOK {
		t.Fatalf("list initial pages: status=%d body=%s", code, raw)
	}
	var initialList struct {
		Pages []store.SlidesPage `json:"pages"`
	}
	if err := json.Unmarshal(raw, &initialList); err != nil || len(initialList.Pages) != 1 {
		t.Fatalf("initial pages: err=%v pages=%+v", err, initialList.Pages)
	}
	firstPageID := initialList.Pages[0].ID
	if err := wsOwner.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"type":"cursor","pageId":%d}`, firstPageID))); err != nil {
		t.Fatal(err)
	}
	waitSlidesWSMsg(t, wsEditor, func(m slidesWSMessage) bool {
		if m.Type != "presence" {
			return false
		}
		for _, col := range m.Collaborators {
			if col.UserID == owner.ID && col.PageID == firstPageID {
				return true
			}
		}
		return false
	})

	// 3. Test import-pptx validation & permission fences.
	sampleShapes := json.RawMessage(`[{"id":"shp-1","kind":"star","x":62,"y":20,"width":18,"height":24,"rotation":15,"color":"#3370ff"},{"id":"txt-1","kind":"text","x":10,"y":60,"width":40,"height":18,"color":"#1f2329","text":"导入文本框","fontSize":24,"bold":true,"align":"center"}]`)
	importPages := []store.ImportedSlidePage{
		{
			Title:      "封面：年度规划",
			Body:       "核心目标与里程碑",
			Background: "#f5f7fb",
			Layout:     "title",
			Notes:      "开场备注",
			Hidden:     false,
			Shapes:     sampleShapes,
		},
		{
			Title:      "附录（已隐藏）",
			Body:       "备选数据明细",
			Background: "#1f2329",
			Layout:     "",
			Notes:      "仅内部参考",
			Hidden:     true,
			Shapes:     json.RawMessage(`[{"id":"rect-2","kind":"rounded-rectangle","x":15,"y":30,"width":25,"height":20,"color":"#00b42a"}]`),
		},
		{
			Title:      "总结",
			Body:       "感谢聆听",
			Background: "",
			Layout:     "blank-title",
			Notes:      "",
			Hidden:     false,
			Shapes:     json.RawMessage(`[]`),
		},
	}

	// Missing X-Jiange-User-Id -> 400
	code, _ = doJSON(cOwner, http.MethodPost, deckPath+"/import-pptx", map[string]any{"pages": importPages}, 0)
	if code != http.StatusBadRequest {
		t.Fatalf("import missing user header: expected 400, got %d", code)
	}
	// Viewer cannot import -> 403
	code, _ = doJSON(cViewer, http.MethodPost, deckPath+"/import-pptx", map[string]any{"pages": importPages}, viewer.ID)
	if code != http.StatusForbidden {
		t.Fatalf("viewer import: expected 403, got %d", code)
	}
	// Empty pages -> 400
	code, _ = doJSON(cOwner, http.MethodPost, deckPath+"/import-pptx", map[string]any{"pages": []any{}}, owner.ID)
	if code != http.StatusBadRequest {
		t.Fatalf("empty import: expected 400, got %d", code)
	}
	// Invalid shape -> 400
	code, _ = doJSON(cOwner, http.MethodPost, deckPath+"/import-pptx", map[string]any{
		"pages": []store.ImportedSlidePage{{Title: "坏图形", Shapes: json.RawMessage(`[{"id":"x","kind":"invalid","x":0,"y":0,"color":"#000000"}]`)}},
	}, owner.ID)
	if code != http.StatusBadRequest {
		t.Fatalf("invalid shapes import: expected 400, got %d", code)
	}

	// 4. Owner imports 3 pages atomically; Editor receives live revision event.
	code, raw = doJSON(cOwner, http.MethodPost, deckPath+"/import-pptx", map[string]any{"pages": importPages}, owner.ID)
	if code != http.StatusOK {
		t.Fatalf("owner import-pptx: status=%d body=%s", code, raw)
	}
	var imported struct {
		Pages []store.SlidesPage `json:"pages"`
	}
	if err := json.Unmarshal(raw, &imported); err != nil || len(imported.Pages) != 3 {
		t.Fatalf("imported response: err=%v len=%d body=%s", err, len(imported.Pages), raw)
	}
	if imported.Pages[0].Title != "封面：年度规划" || imported.Pages[0].Layout != "title" || imported.Pages[0].Notes != "开场备注" || !imported.Pages[1].Hidden || imported.Pages[2].Layout != "blank-title" {
		t.Fatalf("imported page fields mismatch: %+v", imported.Pages)
	}

	rev := waitSlidesWSMsg(t, wsEditor, func(m slidesWSMessage) bool {
		return m.Type == "revision" && m.ActorID == owner.ID
	})
	if rev.Seq < 1 {
		t.Fatalf("expected positive revision seq, got %+v", rev)
	}

	// Verify persisted via GET /pages
	code, raw = doJSON(cEditor, http.MethodGet, deckPath+"/pages", nil, editor.ID)
	if code != http.StatusOK {
		t.Fatalf("editor list after import: status=%d body=%s", code, raw)
	}
	var afterImport struct {
		Pages []store.SlidesPage `json:"pages"`
	}
	if err := json.Unmarshal(raw, &afterImport); err != nil || len(afterImport.Pages) != 3 {
		t.Fatalf("afterImport list: err=%v pages=%+v", err, afterImport.Pages)
	}
	midPage := afterImport.Pages[1]

	// 5. Editor deletes middle slide (index 1), Owner receives live revision, then Editor restores it at exact index 1!
	code, raw = doJSON(cEditor, http.MethodPost, fmt.Sprintf("%s/pages/%d/delete", deckPath, midPage.ID), map[string]any{
		"expectedRevision": midPage.Revision,
	}, editor.ID)
	if code != http.StatusOK {
		t.Fatalf("editor delete page: status=%d body=%s", code, raw)
	}
	waitSlidesWSMsg(t, wsOwner, func(m slidesWSMessage) bool {
		return m.Type == "revision" && m.ActorID == editor.ID
	})

	// Viewer cannot restore -> 403
	code, _ = doJSON(cViewer, http.MethodPost, deckPath+"/pages/restore", map[string]any{
		"page": store.ImportedSlidePage{
			Title: midPage.Title, Body: midPage.Body, Background: midPage.Background,
			Layout: midPage.Layout, Notes: midPage.Notes, Hidden: midPage.Hidden, Shapes: midPage.Shapes,
		},
		"targetIndex": 1,
	}, viewer.ID)
	if code != http.StatusForbidden {
		t.Fatalf("viewer restore: expected 403, got %d", code)
	}

	// Editor restores deleted slide at index 1
	code, raw = doJSON(cEditor, http.MethodPost, deckPath+"/pages/restore", map[string]any{
		"page": store.ImportedSlidePage{
			Title: midPage.Title, Body: midPage.Body, Background: midPage.Background,
			Layout: midPage.Layout, Notes: midPage.Notes, Hidden: midPage.Hidden, Shapes: midPage.Shapes,
		},
		"targetIndex": 1,
	}, editor.ID)
	if code != http.StatusCreated {
		t.Fatalf("editor restore page: status=%d body=%s", code, raw)
	}
	var restoredResp struct {
		Page  store.SlidesPage   `json:"page"`
		Pages []store.SlidesPage `json:"pages"`
	}
	if err := json.Unmarshal(raw, &restoredResp); err != nil {
		t.Fatal(err)
	}
	if len(restoredResp.Pages) != 3 || restoredResp.Pages[1].ID != restoredResp.Page.ID {
		t.Fatalf("restored page not at index 1: %+v", restoredResp)
	}
	if restoredResp.Pages[1].Title != "附录（已隐藏）" || !restoredResp.Pages[1].Hidden || restoredResp.Pages[1].Notes != "仅内部参考" || restoredResp.Pages[1].Background != "#1f2329" {
		t.Fatalf("restored page fields lost: %+v", restoredResp.Pages[1])
	}
	if restoredResp.Pages[0].Title != "封面：年度规划" || restoredResp.Pages[2].Title != "总结" {
		t.Fatalf("neighboring slide order broken: %+v", restoredResp.Pages)
	}
	waitSlidesWSMsg(t, wsOwner, func(m slidesWSMessage) bool {
		return m.Type == "revision" && m.ActorID == editor.ID
	})

	// 6. Revoke Editor's access -> Editor's WS closes with StatusPolicyViolation.
	if err := st.SetShare(ctx, deck.ID, editor.ID, ""); err != nil {
		t.Fatal(err)
	}
	rctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	for {
		_, _, err := wsEditor.Read(rctx)
		if err != nil {
			if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
				t.Fatalf("expected StatusPolicyViolation after share revoke, got err=%v status=%v", err, websocket.CloseStatus(err))
			}
			break
		}
	}
}

func TestSlidesCollabPptxMemory(t *testing.T) {
	runSlidesCollabPptxSuite(t, store.NewMemory())
}

func TestSlidesCollabPptxPostgres(t *testing.T) {
	dbURL := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("jiange_slides_cp_%d", time.Now().UnixNano())}.Sanitize()
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
		admin.Close()
	}()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.ConnConfig.RuntimeParams["application_name"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	runSlidesCollabPptxSuite(t, &store.Postgres{Pool: pool})
}
