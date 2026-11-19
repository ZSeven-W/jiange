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
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func runWhiteboardCommentsSuite(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
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

	owner := register(cOwner, "wb-owner@test.dev", "Owner")
	viewer := register(cViewer, "wb-viewer@test.dev", "Viewer")

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

	// Create a board document (kind="doc", docType="board") and share view access to Viewer.
	code, raw := doJSON(cOwner, http.MethodPost, "/api/drive/nodes", map[string]any{
		"kind": "doc", "docType": "board", "title": "系统架构画板", "scope": "personal",
	}, map[string]string{"X-Jiange-User-Id": strconv64(owner.ID)})
	if code != http.StatusCreated {
		t.Fatalf("create board: status=%d body=%s", code, raw)
	}
	var board store.DriveEntry
	if err := json.Unmarshal(raw, &board); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, board.ID, viewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}

	// 1. Viewer with default commentMinRole=view can post object-anchored & coordinate-anchored canvas comments.
	cPath := "/api/docs/" + strconv64(board.ID) + "/comments"
	code, raw = doJSON(cViewer, http.MethodPost, cPath, map[string]any{
		"block":     "1:2",
		"startChar": "fc:n:n_api_gw",
		"endChar":   "320,140",
		"quote":     "[画板] API 网关",
		"body":      "这里建议增加限流降级策略",
	}, nil)
	if code != http.StatusCreated {
		t.Fatalf("viewer create node-anchored comment: status=%d body=%s", code, raw)
	}
	var nodeComment store.Comment
	if err := json.Unmarshal(raw, &nodeComment); err != nil {
		t.Fatal(err)
	}
	if nodeComment.StartChar != "fc:n:n_api_gw" || nodeComment.EndChar != "320,140" {
		t.Fatalf("anchor mismatch: %+v", nodeComment)
	}

	code, raw = doJSON(cOwner, http.MethodPost, cPath, map[string]any{
		"block":     "1:2",
		"startChar": "fc:p:512,-88",
		"endChar":   "512,-88",
		"quote":     "[画板] 画布位置 (512, -88)",
		"body":      "补充缓存集群部署图",
	}, nil)
	if code != http.StatusCreated {
		t.Fatalf("owner create point-anchored comment: status=%d body=%s", code, raw)
	}
	var pointComment store.Comment
	if err := json.Unmarshal(raw, &pointComment); err != nil {
		t.Fatal(err)
	}

	// 2. Owner replies to Viewer's node comment and resolves point comment via account-bound PATCH.
	code, raw = doJSON(cOwner, http.MethodPost, cPath, map[string]any{
		"parentId": nodeComment.ID,
		"body":     "收到，已纳入 Q4 方案",
	}, nil)
	if code != http.StatusCreated {
		t.Fatalf("owner reply: status=%d body=%s", code, raw)
	}

	code, raw = doJSON(cOwner, http.MethodPatch, fmt.Sprintf("/api/docs/%d/account-comments/%d", board.ID, pointComment.ID), map[string]any{
		"resolved": true,
	}, map[string]string{"X-Jiange-User-Id": strconv64(owner.ID)})
	if code != http.StatusOK {
		t.Fatalf("resolve canvas comment: status=%d body=%s", code, raw)
	}

	// 3. Verify GET /comments returns exact anchors, reply, and resolved flag.
	code, raw = doJSON(cOwner, http.MethodGet, cPath, nil, nil)
	if code != http.StatusOK {
		t.Fatalf("list comments: status=%d body=%s", code, raw)
	}
	var listResp struct {
		Comments []store.Comment `json:"comments"`
	}
	if err := json.Unmarshal(raw, &listResp); err != nil || len(listResp.Comments) != 3 {
		t.Fatalf("expected 3 comments, got err=%v len=%d body=%s", err, len(listResp.Comments), raw)
	}
	var sawNode, sawPointResolved, sawReply bool
	for _, c := range listResp.Comments {
		if c.ID == nodeComment.ID && c.StartChar == "fc:n:n_api_gw" && c.EndChar == "320,140" && !c.Resolved {
			sawNode = true
		}
		if c.ID == pointComment.ID && c.StartChar == "fc:p:512,-88" && c.Resolved {
			sawPointResolved = true
		}
		if c.ParentID != nil && *c.ParentID == nodeComment.ID && c.Body == "收到，已纳入 Q4 方案" {
			sawReply = true
		}
	}
	if !sawNode || !sawPointResolved || !sawReply {
		t.Fatalf("missing expected canvas comments: node=%v pointResolved=%v reply=%v all=%+v", sawNode, sawPointResolved, sawReply, listResp.Comments)
	}

	// 4. Tightening commentMinRole to "edit" blocks Viewer from adding new canvas pins (403).
	meta, err := st.GetDoc(ctx, owner.ID, board.ID)
	if err != nil {
		t.Fatal(err)
	}
	code, raw = doJSON(cOwner, http.MethodPatch, "/api/docs/"+strconv64(board.ID), map[string]any{
		"commentMinRole":              "edit",
		"expectedPermissionsRevision": meta.PermissionsRevision,
	}, map[string]string{"X-Jiange-User-Id": strconv64(owner.ID)})
	if code != http.StatusOK {
		t.Fatalf("restrict commentMinRole: status=%d body=%s", code, raw)
	}
	code, _ = doJSON(cViewer, http.MethodPost, cPath, map[string]any{
		"block":     "1:2",
		"startChar": "fc:m:m_root",
		"endChar":   "200,200",
		"quote":     "[思维导图] 中心主题",
		"body":      "应被拦截",
	}, nil)
	if code != http.StatusForbidden {
		t.Fatalf("viewer canvas comment under commentMinRole=edit: expected 403, got %d", code)
	}
}

func TestWhiteboardCommentsMemory(t *testing.T) {
	runWhiteboardCommentsSuite(t, store.NewMemory())
}

func TestWhiteboardCommentsPostgres(t *testing.T) {
	dbURL := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("jiange_wb_cm_%d", time.Now().UnixNano())}.Sanitize()
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
	runWhiteboardCommentsSuite(t, &store.Postgres{Pool: pool})
}
