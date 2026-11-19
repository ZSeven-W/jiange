package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

type countingSearchStore struct {
	*store.Memory
	opsAfterCalls atomic.Int64
}

func (c *countingSearchStore) OpsAfter(ctx context.Context, docID, after int64, limit int) ([]store.SeqOp, error) {
	c.opsAfterCalls.Add(1)
	return c.Memory.OpsAfter(ctx, docID, after, limit)
}

func TestSearchIndexCachesAndIncrementallyRefreshesDoc(t *testing.T) {
	ctx := context.Background()
	mem := store.NewMemory()
	cs := &countingSearchStore{Memory: mem}
	owner, ws, err := mem.CreateUser(ctx, "idx-owner@example.test", "Owner", "")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := mem.CreateDoc(ctx, ws.ID, owner.ID, nil, "技术方案", syncsrv.InitialOps("技术方案"))
	if err != nil {
		t.Fatal(err)
	}
	state, _, err := StateAtHead(ctx, mem, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	para := collab.OpID{Client: 0, Clock: 2}
	var raw []store.RawOp
	for i, ch := range []rune("量子计算架构初稿") {
		op := state.InsertText(11, para, i, string(ch))
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		raw = append(raw, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
	}
	if _, err := mem.AppendOps(ctx, doc.ID, raw); err != nil {
		t.Fatal(err)
	}
	srv := &Server{Store: cs}

	// First search populates the persistent search index (replaying CRDT ops).
	got, err := srv.searchMaterialized(ctx, owner.ID, "量子计算")
	if err != nil || len(got) != 1 || got[0].ID != doc.ID {
		t.Fatalf("first search: got %+v err %v", got, err)
	}
	firstReplayCalls := cs.opsAfterCalls.Load()
	if firstReplayCalls == 0 {
		t.Fatal("expected initial search to replay CRDT ops")
	}
	entry, err := mem.GetSearchIndex(ctx, doc.ID)
	if err != nil || entry.SourceSeq == 0 || entry.BodyText == "" {
		t.Fatalf("expected persisted index entry, got %+v err %v", entry, err)
	}

	// Second search at the same head hits doc_search_index without replaying ops.
	got, err = srv.searchMaterialized(ctx, owner.ID, "架构初稿")
	if err != nil || len(got) != 1 || got[0].ID != doc.ID {
		t.Fatalf("second search: got %+v err %v", got, err)
	}
	if cs.opsAfterCalls.Load() != firstReplayCalls {
		t.Fatalf("expected cached search with zero extra OpsAfter calls, got %d vs %d", cs.opsAfterCalls.Load(), firstReplayCalls)
	}

	// Advancing head invalidates cache and refreshes incrementally.
	state, _, err = StateAtHead(ctx, mem, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	var more []store.RawOp
	for i, ch := range []rune("·终版验证") {
		op := state.InsertText(12, para, 8+i, string(ch))
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		more = append(more, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
	}
	if _, err := mem.AppendOps(ctx, doc.ID, more); err != nil {
		t.Fatal(err)
	}
	got, err = srv.searchMaterialized(ctx, owner.ID, "终版验证")
	if err != nil || len(got) != 1 || got[0].ID != doc.ID {
		t.Fatalf("refreshed search: got %+v err %v", got, err)
	}
	afterRefreshCalls := cs.opsAfterCalls.Load()
	if afterRefreshCalls <= firstReplayCalls {
		t.Fatalf("expected index refresh after head advance, calls=%d", afterRefreshCalls)
	}
	// Repeating search hits the refreshed cache again.
	got, err = srv.searchMaterialized(ctx, owner.ID, "终版验证")
	if err != nil || len(got) != 1 {
		t.Fatalf("post-refresh cached search: got %+v err %v", got, err)
	}
	if cs.opsAfterCalls.Load() != afterRefreshCalls {
		t.Fatalf("expected cache hit after refresh, calls=%d vs %d", cs.opsAfterCalls.Load(), afterRefreshCalls)
	}
}

func TestSearchDeepMultiResourceAndFiltersHTTP(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)

	// Register owner and a second user (guest).
	resp := post(t, owner, ts.URL+"/api/auth/register", map[string]string{
		"email": "multi-owner@test", "name": "Owner", "password": "password123",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register owner: %d", resp.StatusCode)
	}
	var ownerReg struct {
		User struct {
			ID int64 `json:"id"`
		} `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&ownerReg); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	guestJar, _ := cookiejar.New(nil)
	guest := &http.Client{Jar: guestJar}
	resp = post(t, guest, ts.URL+"/api/auth/register", map[string]string{
		"email": "multi-guest@test", "name": "Guest", "password": "password123",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register guest: %d", resp.StatusCode)
	}
	var guestReg struct {
		User struct {
			ID int64 `json:"id"`
		} `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&guestReg); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	wss, err := st.Workspaces(ctx, ownerReg.User.ID)
	if err != nil || len(wss) == 0 {
		t.Fatalf("owner workspaces: %v", err)
	}
	wsID := wss[0].ID

	// Create folder hierarchy: rootFolder -> subFolder via Drive API
	createDrive := func(path string, payload map[string]any) store.DocMeta {
		t.Helper()
		r := post(t, owner, ts.URL+path, payload)
		defer r.Body.Close()
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("POST %s %v: %d", path, payload, r.StatusCode)
		}
		var d store.DocMeta
		if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
			t.Fatal(err)
		}
		return d
	}
	rootFolder := createDrive("/api/drive/folders", map[string]any{"title": "研发目录"})
	subFolder := createDrive("/api/drive/folders", map[string]any{"title": "核心专项", "parentId": rootFolder.ID})

	// 1. Base inside subFolder with deep cell text + locked view security test.
	baseDoc, err := st.CreateInitializedBase(ctx, wsID, ownerReg.User.ID, &subFolder.ID, "供应商台账")
	if err != nil {
		t.Fatal(err)
	}
	fields, err := st.Fields(ctx, baseDoc.ID)
	if err != nil || len(fields) == 0 {
		t.Fatalf("base fields: %v %d", err, len(fields))
	}
	statusField, err := st.AddField(ctx, store.Field{
		BaseID: baseDoc.ID, TableID: fields[0].TableID, Name: "级别", Type: "select", Options: []string{"公开", "机密"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddRecord(ctx, store.Record{
		BaseID:  baseDoc.ID,
		TableID: fields[0].TableID,
		Cells: map[string]json.RawMessage{
			strconv.FormatInt(fields[0].ID, 10):   json.RawMessage(`"星辰光刻机公开件"`),
			strconv.FormatInt(statusField.ID, 10): json.RawMessage(`"公开"`),
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddRecord(ctx, store.Record{
		BaseID:  baseDoc.ID,
		TableID: fields[0].TableID,
		Cells: map[string]json.RawMessage{
			strconv.FormatInt(fields[0].ID, 10):   json.RawMessage(`"绝密预算单号998"`),
			strconv.FormatInt(statusField.ID, 10): json.RawMessage(`"机密"`),
		},
	}); err != nil {
		t.Fatal(err)
	}
	// Add a locked view restricting non-managers to 级别 == "公开"
	lockedCfg := json.RawMessage(`{"locked":true,"filters":{"conj":"and","rules":[{"f":` + strconv.FormatInt(statusField.ID, 10) + `,"op":"is","v":"公开"}]}}`)
	if _, err := st.AddView(ctx, store.View{
		BaseID: baseDoc.ID, TableID: fields[0].TableID, Type: "grid", Name: "公开视图", Config: lockedCfg,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, baseDoc.ID, guestReg.User.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}

	// 2. Slides inside rootFolder with notes + shape text.
	slidesDoc := createDrive("/api/drive/nodes", map[string]any{"kind": "slides", "title": "季度汇报", "parentId": rootFolder.ID})
	pages, err := st.ListSlidesPages(ctx, ownerReg.User.ID, slidesDoc.ID)
	if err != nil || len(pages) == 0 {
		t.Fatalf("slides pages: %v %d", err, len(pages))
	}
	// Update slide page via HTTP API
	putPage := send(t, owner, http.MethodPatch, ts.URL+"/api/slides/pages/"+strconv.FormatInt(pages[0].ID, 10), map[string]any{
		"title":            "第一页标题",
		"body":             "核心结论摘要",
		"notes":            "演讲者隐藏备注关键词",
		"shapes":           []map[string]any{{"id": "s1", "kind": "text", "x": 10, "y": 10, "width": 40, "height": 20, "color": "#1f2329", "text": "端云协同引擎架构"}},
		"expectedRevision": pages[0].Revision,
	})
	putPage.Body.Close()
	if putPage.StatusCode != http.StatusOK {
		t.Fatalf("update slide page: %d", putPage.StatusCode)
	}

	// 3. Survey outside rootFolder with deep question + option text.
	surveyDoc := createDrive("/api/drive/nodes", map[string]any{"kind": "survey", "title": "客户调研"})
	sv, err := st.GetSurvey(ctx, surveyDoc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.SaveSurvey(ctx, surveyDoc.ID, store.SurveyUpdate{
		Description: "用于收集企业级私有化部署反馈",
		Questions: []store.SurveyQuestion{
			{
				ID:         "q1",
				Type:       "matrix",
				Title:      "请评估各项服务满意度",
				MatrixRows: []string{"稳定性SLA指标"},
				MatrixCols: []string{"极度认可"},
			},
		},
		ExpectedRevision: sv.Revision,
	}); err != nil {
		t.Fatal(err)
	}

	searchIDs := func(c *http.Client, rawQuery string) []int64 {
		t.Helper()
		r, err := c.Get(ts.URL + "/api/search?" + rawQuery)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		if r.StatusCode != http.StatusOK {
			t.Fatalf("GET /api/search?%s: status %d", rawQuery, r.StatusCode)
		}
		var out struct {
			Docs []store.DocMeta `json:"docs"`
		}
		if err := json.NewDecoder(r.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		ids := make([]int64, len(out.Docs))
		for i, d := range out.Docs {
			ids[i] = d.ID
		}
		return ids
	}

	// Owner finds deep content across base, slides, and survey.
	if ids := searchIDs(owner, "q="+url.QueryEscape("绝密预算单号998")); len(ids) != 1 || ids[0] != baseDoc.ID {
		t.Fatalf("owner base cell search: got %v want [%d]", ids, baseDoc.ID)
	}
	if ids := searchIDs(owner, "q="+url.QueryEscape("演讲者隐藏备注")); len(ids) != 1 || ids[0] != slidesDoc.ID {
		t.Fatalf("owner slides notes search: got %v want [%d]", ids, slidesDoc.ID)
	}
	if ids := searchIDs(owner, "q="+url.QueryEscape("端云协同引擎")); len(ids) != 1 || ids[0] != slidesDoc.ID {
		t.Fatalf("owner slides shape search: got %v want [%d]", ids, slidesDoc.ID)
	}
	if ids := searchIDs(owner, "q="+url.QueryEscape("稳定性SLA指标")); len(ids) != 1 || ids[0] != surveyDoc.ID {
		t.Fatalf("owner survey deep search: got %v want [%d]", ids, surveyDoc.ID)
	}

	// Guest sees visible base row but NEVER sees locked-out secret row.
	if ids := searchIDs(guest, "q="+url.QueryEscape("星辰光刻机公开件")); len(ids) != 1 || ids[0] != baseDoc.ID {
		t.Fatalf("guest visible base row search: got %v want [%d]", ids, baseDoc.ID)
	}
	if ids := searchIDs(guest, "q="+url.QueryEscape("绝密预算单号998")); len(ids) != 0 {
		t.Fatalf("guest leaked restricted base row: got %v", ids)
	}

	// Folder filter: rootFolder includes nested baseDoc (depth 2), slidesDoc (depth 1), subFolder, excludes surveyDoc and rootFolder itself.
	folderIDs := searchIDs(owner, "folderId="+strconv.FormatInt(rootFolder.ID, 10))
	idSet := map[int64]bool{}
	for _, id := range folderIDs {
		idSet[id] = true
	}
	if !idSet[baseDoc.ID] || !idSet[slidesDoc.ID] || !idSet[subFolder.ID] || idSet[surveyDoc.ID] || idSet[rootFolder.ID] {
		t.Fatalf("folderId filter unexpected results: %v", folderIDs)
	}

	// Combined folder + kind filter.
	if ids := searchIDs(owner, "folderId="+strconv.FormatInt(rootFolder.ID, 10)+"&kind=base"); len(ids) != 1 || ids[0] != baseDoc.ID {
		t.Fatalf("folderId+kind=base: got %v want [%d]", ids, baseDoc.ID)
	}

	// Unauthorized guest filtering by owner's private rootFolder gets empty results without error.
	if ids := searchIDs(guest, "folderId="+strconv.FormatInt(rootFolder.ID, 10)); len(ids) != 0 {
		t.Fatalf("guest private folderId leaked: %v", ids)
	}

	// Owner filter: guest with owner=mine excludes baseDoc created by owner.
	if ids := searchIDs(guest, "q="+url.QueryEscape("星辰光刻机")+"&owner=mine"); len(ids) != 0 {
		t.Fatalf("guest owner=mine should exclude shared baseDoc, got %v", ids)
	}

	// Date range filters: today matches, tomorrow excludes all.
	today := time.Now().Format("2006-01-02")
	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	if ids := searchIDs(owner, "kind=survey&updatedFrom="+today+"&updatedTo="+today); len(ids) != 1 || ids[0] != surveyDoc.ID {
		t.Fatalf("today date range filter: got %v want [%d]", ids, surveyDoc.ID)
	}
	if ids := searchIDs(owner, "kind=survey&updatedFrom="+tomorrow); len(ids) != 0 {
		t.Fatalf("future updatedFrom filter should be empty: got %v", ids)
	}

	// Invalid filter returns 400.
	badRes, err := owner.Get(ts.URL + "/api/search?q=test&kind=invalid_kind")
	if err != nil {
		t.Fatal(err)
	}
	badRes.Body.Close()
	if badRes.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid kind expected 400, got %d", badRes.StatusCode)
	}
}
