package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/sheetsync"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/coder/websocket"
)

func sheetReq(t *testing.T, client *http.Client, method, url, uid, version string, body any) *http.Response {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	req, err := http.NewRequest(method, url, &buf)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if uid != "" {
		req.Header.Set("X-Jiange-User-Id", uid)
	}
	if version != "" {
		req.Header.Set("X-Jiange-Sheet-Version", version)
	}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestSheetAPILifecycleAndSecurity(t *testing.T) {
	st := store.NewMemory()
	hub := &sheetsync.Hub{Store: st, PingInterval: 2 * time.Second, SweepInterval: 100 * time.Millisecond}
	srv := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 1, SheetHub: hub}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	jar1, _ := cookiejar.New(nil)
	jar2, _ := cookiejar.New(nil)
	c1 := &http.Client{Jar: jar1}
	c2 := &http.Client{Jar: jar2}

	res := post(t, c1, ts.URL+"/api/auth/register", map[string]string{"email": "sheet-owner@test.dev", "name": "Owner", "password": "password123"})
	res.Body.Close()
	res = post(t, c2, ts.URL+"/api/auth/register", map[string]string{"email": "sheet-guest@test.dev", "name": "Guest", "password": "password123"})
	res.Body.Close()

	ctx := context.Background()
	u1, err := st.UserByEmail(ctx, "sheet-owner@test.dev")
	if err != nil {
		t.Fatal(err)
	}
	u2, err := st.UserByEmail(ctx, "sheet-guest@test.dev")
	if err != nil {
		t.Fatal(err)
	}
	uid1, uid2 := strconv64(u1.ID), strconv64(u2.ID)

	res = post(t, c1, ts.URL+"/api/drive/nodes", map[string]any{"kind": "sheet", "title": "销售统计", "scope": "personal"})
	var entry store.DriveEntry
	if err = json.NewDecoder(res.Body).Decode(&entry); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusCreated || entry.Kind != "sheet" {
		t.Fatalf("create sheet node: status=%d entry=%+v", res.StatusCode, entry)
	}
	idStr := strconv64(entry.ID)

	// Protocol and account binding fences.
	if r := sheetReq(t, c1, http.MethodGet, ts.URL+"/api/sheets/"+idStr, "", "1", nil); r.StatusCode != http.StatusBadRequest {
		r.Body.Close()
		t.Fatalf("expected 400 missing X-Jiange-User-Id, got %d", r.StatusCode)
	} else {
		r.Body.Close()
	}
	if r := sheetReq(t, c1, http.MethodGet, ts.URL+"/api/sheets/"+idStr, uid1, "2", nil); r.StatusCode != http.StatusUpgradeRequired {
		r.Body.Close()
		t.Fatalf("expected 426 unsupported sheet version, got %d", r.StatusCode)
	} else {
		r.Body.Close()
	}
	if r := sheetReq(t, c1, http.MethodGet, ts.URL+"/api/sheets/"+idStr, uid2, "1", nil); r.StatusCode != http.StatusUnauthorized {
		r.Body.Close()
		t.Fatalf("expected 401 wrong X-Jiange-User-Id, got %d", r.StatusCode)
	} else {
		r.Body.Close()
	}

	// Read workbook.
	snapRes := sheetReq(t, c1, http.MethodGet, ts.URL+"/api/sheets/"+idStr, uid1, "1", nil)
	var snap store.SheetSnapshot
	if err = json.NewDecoder(snapRes.Body).Decode(&snap); err != nil {
		t.Fatal(err)
	}
	snapRes.Body.Close()
	if snapRes.StatusCode != http.StatusOK || len(snap.Sheets) != 1 {
		t.Fatalf("get sheet: status=%d snap=%+v", snapRes.StatusCode, snap)
	}

	// Invite u2 as editor and connect WS.
	if err = st.SetShare(ctx, entry.ID, u2.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	jarURL := strings.Replace(ts.URL, "http://", "ws://", 1) + "/api/sheets/" + idStr + "/ws"
	parsedTS, _ := url.Parse(ts.URL)
	wsHdr := http.Header{}
	for _, ck := range c2.Jar.Cookies(parsedTS) {
		wsHdr.Add("Cookie", ck.Name+"="+ck.Value)
	}
	wsConn, _, err := websocket.Dial(ctx, jarURL, &websocket.DialOptions{HTTPHeader: wsHdr})
	if err != nil {
		t.Fatal(err)
	}
	defer wsConn.CloseNow()

	// Write cells via REST -> notifies WS.
	ws1 := snap.Sheets[0]
	rawVal := "=10+20"
	cellRes := sheetReq(t, c1, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/cells", uid1, "1", store.SheetCellBatch{
		MutationID:  "11111111111111111111111111111111",
		WorksheetID: ws1.ID,
		Cells: []store.SheetCellWrite{
			{RowID: ws1.Rows[0].ID, ColumnID: ws1.Columns[0].ID, ExpectedRevision: 0, Raw: &rawVal},
		},
	})
	var batchOut store.SheetBatchResult
	if err = json.NewDecoder(cellRes.Body).Decode(&batchOut); err != nil {
		t.Fatal(err)
	}
	cellRes.Body.Close()
	if cellRes.StatusCode != http.StatusOK || batchOut.WorkbookRevision != 2 {
		t.Fatalf("write cells: status=%d out=%+v", cellRes.StatusCode, batchOut)
	}

	wsCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	gotRev := false
	for !gotRev {
		_, data, err := wsConn.Read(wsCtx)
		if err != nil {
			t.Fatalf("ws read: %v", err)
		}
		var frame struct {
			Type             string `json:"type"`
			WorkbookRevision int64  `json:"workbookRevision"`
		}
		if json.Unmarshal(data, &frame) == nil && frame.Type == "revision" && frame.WorkbookRevision == 2 {
			gotRev = true
		}
	}

	// Create Sheet2, rename workbook, duplicate, search, disallow anon share.
	cwsRes := sheetReq(t, c1, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/worksheets", uid1, "1", map[string]string{"title": "二季度汇总"})
	cwsRes.Body.Close()
	if cwsRes.StatusCode != http.StatusCreated {
		t.Fatalf("create worksheet: %d", cwsRes.StatusCode)
	}

	renRes := sheetReq(t, c1, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/account-title", uid1, "1", map[string]any{
		"title":         "年度销售统计",
		"expectedTitle": "销售统计",
		"expected":      entry.Revision,
	})
	renRes.Body.Close()
	if renRes.StatusCode != http.StatusOK {
		t.Fatalf("rename sheet title: %d", renRes.StatusCode)
	}

	// Anonymous link sharing is rejected on sheets; workspace_view link sharing succeeds.
	if r := sheetReq(t, c1, http.MethodPut, ts.URL+"/api/docs/"+idStr+"/link", "", "", map[string]string{"role": "anon"}); r.StatusCode != http.StatusBadRequest {
		r.Body.Close()
		t.Fatalf("expected 400 anon share on sheet, got %d", r.StatusCode)
	} else {
		r.Body.Close()
	}
	if r := sheetReq(t, c1, http.MethodPut, ts.URL+"/api/docs/"+idStr+"/link-guarded", uid1, "", map[string]any{"role": "anon", "expectedRevision": 0}); r.StatusCode != http.StatusBadRequest {
		r.Body.Close()
		t.Fatalf("expected 400 anon guarded share on sheet, got %d", r.StatusCode)
	} else {
		r.Body.Close()
	}
	if r := sheetReq(t, c1, http.MethodPut, ts.URL+"/api/docs/"+idStr+"/link-guarded", uid1, "", map[string]any{"role": store.LinkWorkspaceView, "expectedRevision": 0}); r.StatusCode != http.StatusOK {
		r.Body.Close()
		t.Fatalf("expected 200 workspace_view link on sheet, got %d", r.StatusCode)
	} else {
		r.Body.Close()
	}

	dupRes := sheetReq(t, c1, http.MethodPost, ts.URL+"/api/docs/"+idStr+"/account-duplicate", uid1, "", nil)
	var dupMeta store.DocMeta
	if err = json.NewDecoder(dupRes.Body).Decode(&dupMeta); err != nil {
		t.Fatal(err)
	}
	dupRes.Body.Close()
	if dupRes.StatusCode != http.StatusCreated || dupMeta.Kind != "sheet" || dupMeta.Title != "年度销售统计 副本" {
		t.Fatalf("duplicate sheet: status=%d meta=%+v", dupRes.StatusCode, dupMeta)
	}

	// u2 sees only the shared original sheet in search (never u1's unshared copy); u1 sees both.
	searchRes, err := c2.Get(ts.URL + "/api/search?q=" + strings.ReplaceAll("二季度汇总", " ", "+"))
	if err != nil {
		t.Fatal(err)
	}
	var searchBody struct {
		Docs []store.DocMeta `json:"docs"`
	}
	if err = json.NewDecoder(searchRes.Body).Decode(&searchBody); err != nil {
		t.Fatal(err)
	}
	searchRes.Body.Close()
	if len(searchBody.Docs) != 1 || searchBody.Docs[0].ID != entry.ID {
		t.Fatalf("expected only shared original sheet for u2 in search, got %+v", searchBody.Docs)
	}

	ownerSearch, err := c1.Get(ts.URL + "/api/search?q=" + strings.ReplaceAll("二季度汇总", " ", "+"))
	if err != nil {
		t.Fatal(err)
	}
	var ownerBody struct {
		Docs []store.DocMeta `json:"docs"`
	}
	if err = json.NewDecoder(ownerSearch.Body).Decode(&ownerBody); err != nil {
		t.Fatal(err)
	}
	ownerSearch.Body.Close()
	if len(ownerBody.Docs) != 2 {
		t.Fatalf("expected both original and copied sheets for u1 in search, got %+v", ownerBody.Docs)
	}

	// Spreadsheets accept the split copy/download/comment policy.
	current, err := st.GetDoc(ctx, u1.ID, entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	if r := sheetReq(t, c1, http.MethodPatch, ts.URL+"/api/docs/"+idStr, uid1, "", map[string]any{"commentMinRole": "edit", "expectedPermissionsRevision": current.PermissionsRevision}); r.StatusCode != http.StatusOK {
		r.Body.Close()
		t.Fatalf("sheet comment policy: expected 200, got %d", r.StatusCode)
	} else {
		r.Body.Close()
	}
	if r := sheetReq(t, c1, http.MethodPatch, ts.URL+"/api/docs/"+idStr, uid1, "", map[string]any{"downloadMinRole": "manage", "copyMinRole": "edit", "expectedPermissionsRevision": current.PermissionsRevision + 1}); r.StatusCode != http.StatusOK {
		r.Body.Close()
		t.Fatalf("sheet copy/download policy: expected 200, got %d", r.StatusCode)
	} else {
		r.Body.Close()
	}
	if updated, err := st.GetDoc(ctx, u2.ID, entry.ID); err != nil || updated.DownloadMinRole != store.RoleManage || updated.CopyMinRole != store.RoleEdit || updated.CommentMinRole != store.RoleEdit {
		t.Fatalf("sheet policy not stored: %+v err=%v", updated, err)
	}
	if r := sheetReq(t, c2, http.MethodPost, ts.URL+"/api/docs/"+idStr+"/account-duplicate", uid2, "", nil); r.StatusCode == http.StatusCreated {
		r.Body.Close()
		t.Fatal("download policy must block duplicating the sheet")
	} else {
		r.Body.Close()
	}
}
