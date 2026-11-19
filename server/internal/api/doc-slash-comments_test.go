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
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func runDocCrossCommentSuite(t *testing.T, st store.Store) {
	t.Helper()
	srv := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1,
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	newClient := func() *http.Client {
		j, _ := cookiejar.New(nil)
		return &http.Client{Jar: j}
	}
	cOwner := newClient()
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

	owner := register(cOwner, "cross-owner@test.dev", "Owner")
	viewer := register(cViewer, "cross-viewer@test.dev", "Viewer")

	doJSON := func(c *http.Client, method, path string, body any, extra map[string]string) (int, []byte) {
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
		for k, v := range extra {
			req.Header.Set(k, v)
		}
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		return res.StatusCode, raw
	}

	code, raw := doJSON(cOwner, http.MethodPost, "/api/docs", map[string]any{
		"title": "跨段落评论与内嵌资源验证文档",
	}, nil)
	if code != http.StatusCreated {
		t.Fatalf("create doc: status=%d body=%s", code, raw)
	}
	var doc store.DocMeta
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}

	// Share view permission with Viewer.
	if err := st.SetShare(context.Background(), doc.ID, viewer.ID, store.RoleView); err != nil {
		t.Fatalf("share viewer: %v", err)
	}

	// 1. Create a cross-paragraph comment anchor using `<endBlock>|<endChar>`.
	crossAnchor := map[string]any{
		"block":     "1:10",
		"startChar": "1:15",
		"endChar":   "1:12|1:42",
		"quote":     "第一段结尾\n第二段整段\n第三段开头",
		"body":      "跨三段文字请合并表述",
		"mentions":  []int64{viewer.ID},
	}
	code, raw = doJSON(cOwner, http.MethodPost, fmt.Sprintf("/api/docs/%d/comments", doc.ID), crossAnchor, nil)
	if code != http.StatusCreated {
		t.Fatalf("create cross-paragraph comment: status=%d body=%s", code, raw)
	}
	var rootComment store.Comment
	if err := json.Unmarshal(raw, &rootComment); err != nil {
		t.Fatal(err)
	}
	if rootComment.Block != "1:10" || rootComment.StartChar != "1:15" || rootComment.EndChar != "1:12|1:42" {
		t.Fatalf("unexpected persisted anchor: %+v", rootComment)
	}

	// 2. Viewer replies to the cross-paragraph thread while commentMinRole allows view.
	code, raw = doJSON(cViewer, http.MethodPost, fmt.Sprintf("/api/docs/%d/comments", doc.ID), map[string]any{
		"parentId": rootComment.ID,
		"body":     "收到，我来统一三段口径",
	}, nil)
	if code != http.StatusCreated {
		t.Fatalf("viewer reply: status=%d body=%s", code, raw)
	}

	// 3. List comments verifies both root cross-paragraph anchor and reply round-trip cleanly.
	code, raw = doJSON(cViewer, http.MethodGet, fmt.Sprintf("/api/docs/%d/comments", doc.ID), nil, nil)
	if code != http.StatusOK {
		t.Fatalf("list comments: status=%d body=%s", code, raw)
	}
	var listRes struct {
		Comments []store.Comment `json:"comments"`
	}
	if err := json.Unmarshal(raw, &listRes); err != nil {
		t.Fatal(err)
	}
	if len(listRes.Comments) != 2 {
		t.Fatalf("expected 2 comments, got %d", len(listRes.Comments))
	}

	// 4. Restrict commentMinRole to edit -> Viewer cannot create a new cross-paragraph comment.
	meta, err := st.GetDoc(context.Background(), owner.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	code, raw = doJSON(cOwner, http.MethodPatch, fmt.Sprintf("/api/docs/%d", doc.ID), map[string]any{
		"commentMinRole":              "edit",
		"expectedPermissionsRevision": meta.PermissionsRevision,
	}, map[string]string{"X-Jiange-User-Id": fmt.Sprintf("%d", owner.ID)})
	if code != http.StatusOK {
		t.Fatalf("patch policy: status=%d body=%s", code, raw)
	}
	code, _ = doJSON(cViewer, http.MethodPost, fmt.Sprintf("/api/docs/%d/comments", doc.ID), crossAnchor, nil)
	if code != http.StatusForbidden {
		t.Fatalf("expected 403 for viewer when commentMinRole=edit, got %d", code)
	}

	// 5. Owner resolves the cross-paragraph thread.
	resolved := true
	code, raw = doJSON(cOwner, http.MethodPatch, fmt.Sprintf("/api/docs/%d/account-comments/%d", doc.ID, rootComment.ID), map[string]any{
		"resolved": resolved,
	}, map[string]string{"X-Jiange-User-Id": fmt.Sprintf("%d", owner.ID)})
	if code != http.StatusOK {
		t.Fatalf("resolve cross-paragraph thread: status=%d body=%s", code, raw)
	}
	var patched store.Comment
	if err := json.Unmarshal(raw, &patched); err != nil {
		t.Fatal(err)
	}
	if !patched.Resolved || patched.EndChar != "1:12|1:42" {
		t.Fatalf("expected resolved cross-paragraph comment, got %+v", patched)
	}
}

func TestDocCrossCommentMemory(t *testing.T) {
	runDocCrossCommentSuite(t, store.NewMemory())
}

func TestDocCrossCommentPostgres(t *testing.T) {
	dsn := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	schema := fmt.Sprintf("test_cross_comment_%d", time.Now().UnixNano())
	admin, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer admin.Close(ctx)
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	defer func() { _, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE") }()

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	runDocCrossCommentSuite(t, &store.Postgres{Pool: pool})
}

func TestPublicCommonBlockAndSearchEmbedReminderH7H9(t *testing.T) {
	view := collab.DocView{
		Blocks: []collab.BlockView{
			{ID: "1:1", Parent: "0:0", Type: "h7", Props: map[string]string{"align": "center"}, Spans: []collab.Span{{Text: "七级深度标题", Marks: map[string]string{}}}},
			{ID: "1:2", Parent: "0:0", Type: "h8", Props: map[string]string{}, Spans: []collab.Span{{Text: "八级小节", Marks: map[string]string{}}}},
			{ID: "1:3", Parent: "0:0", Type: "h9", Props: map[string]string{}, Spans: []collab.Span{{Text: "九级条款", Marks: map[string]string{}}}},
			{ID: "1:4", Parent: "0:0", Type: "embed", Props: map[string]string{"resourceKind": "sheet", "resourceId": "42", "title": "Q4财务预测表", "secret": "drop-me"}, Spans: []collab.Span{{Text: "stale-text", Marks: map[string]string{}}}},
			{ID: "1:5", Parent: "0:0", Type: "embed", Props: map[string]string{"resourceKind": "evil", "resourceId": "not-a-number", "title": "bad"}, Spans: []collab.Span{}},
			{ID: "1:6", Parent: "0:0", Type: "reminder", Props: map[string]string{"date": "2026-11-25", "time": "14:00", "label": "里程碑评审", "done": "true", "extra": "drop-me"}, Spans: []collab.Span{{Text: "stale", Marks: map[string]string{}}}},
		},
	}

	ro, err := syncReadOnlyView(view)
	if err != nil {
		t.Fatalf("syncReadOnlyView: %v", err)
	}
	embedBlock := ro.Blocks[3]
	if embedBlock.Props["resourceKind"] != "sheet" || embedBlock.Props["resourceId"] != "42" || embedBlock.Props["title"] != "Q4财务预测表" {
		t.Fatalf("unexpected embed props: %+v", embedBlock.Props)
	}
	if _, leaked := embedBlock.Props["secret"]; leaked {
		t.Fatalf("secret prop leaked in embed block")
	}
	if len(embedBlock.Spans) != 0 {
		t.Fatalf("expected stale embed spans stripped, got %+v", embedBlock.Spans)
	}

	badEmbed := ro.Blocks[4]
	if badEmbed.Props["resourceKind"] != "" || badEmbed.Props["resourceId"] != "" {
		t.Fatalf("invalid embed kind/id should be stripped, got %+v", badEmbed.Props)
	}

	remBlock := ro.Blocks[5]
	if remBlock.Props["date"] != "2026-11-25" || remBlock.Props["time"] != "14:00" || remBlock.Props["label"] != "里程碑评审" || remBlock.Props["done"] != "true" {
		t.Fatalf("unexpected reminder props: %+v", remBlock.Props)
	}
	if _, leaked := remBlock.Props["extra"]; leaked {
		t.Fatalf("extra prop leaked in reminder block")
	}
	if len(remBlock.Spans) != 0 {
		t.Fatalf("expected stale reminder spans stripped, got %+v", remBlock.Spans)
	}

	if !conditionalTextBlock("h7") || !conditionalTextBlock("h8") || !conditionalTextBlock("h9") {
		t.Fatalf("expected h7-h9 to be conditionalTextBlock")
	}
	if !referenceTextBlock("h7") || !referenceTextBlock("h8") || !referenceTextBlock("h9") {
		t.Fatalf("expected h7-h9 to be referenceTextBlock")
	}

	indexed := extractSearchableDocumentText(view)
	for _, want := range []string{"七级深度标题", "八级小节", "九级条款", "Q4财务预测表", "里程碑评审", "2026-11-25"} {
		if !strings.Contains(indexed, want) {
			t.Fatalf("expected indexed doc text to contain %q, got %q", want, indexed)
		}
	}
}
