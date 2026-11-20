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
	"sync/atomic"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type refIndexReplaySpy struct {
	store.Store
	store.SurveyStore
	idx   store.ReferenceIndexStore
	reads atomic.Int64
}

func (s *refIndexReplaySpy) ReadTitleSnapshot(ctx context.Context, doc int64) (store.TitleSnapshot, error) {
	s.reads.Add(1)
	return s.Store.ReadTitleSnapshot(ctx, doc)
}
func (s *refIndexReplaySpy) GetReferenceIndexStates(ctx context.Context, ids []int64) (map[int64]store.ReferenceIndexState, error) {
	return s.idx.GetReferenceIndexStates(ctx, ids)
}
func (s *refIndexReplaySpy) ReplaceReferenceEdges(ctx context.Context, state store.ReferenceIndexState, edges []store.ReferenceEdge) error {
	return s.idx.ReplaceReferenceEdges(ctx, state, edges)
}
func (s *refIndexReplaySpy) ListOutgoingReferenceEdges(ctx context.Context, ids []int64) ([]store.ReferenceEdge, error) {
	return s.idx.ListOutgoingReferenceEdges(ctx, ids)
}
func (s *refIndexReplaySpy) ListIncomingReferenceEdges(ctx context.Context, ids []int64, tokens []string) ([]store.ReferenceEdge, error) {
	return s.idx.ListIncomingReferenceEdges(ctx, ids, tokens)
}
func (s *refIndexReplaySpy) ListNodeLinkTokens(ctx context.Context, ids []int64) (map[int64]string, error) {
	return s.idx.ListNodeLinkTokens(ctx, ids)
}
func (s *refIndexReplaySpy) ListDocHeadVersions(ctx context.Context, ids []int64) (map[int64][2]int64, error) {
	return s.idx.ListDocHeadVersions(ctx, ids)
}
func (s *refIndexReplaySpy) ListSheetWorkbookRevisions(ctx context.Context, ids []int64) (map[int64]int64, error) {
	return s.idx.ListSheetWorkbookRevisions(ctx, ids)
}
func (s *refIndexReplaySpy) ResolvePasteShareTarget(ctx context.Context, guard store.RestoreGuard, token string) (store.PasteShareTarget, error) {
	return s.Store.(store.PasteShareTargetReader).ResolvePasteShareTarget(ctx, guard, token)
}

func appendEmbedBlock(t *testing.T, st store.Store, docID int64, resourceKind string, resourceID int64, title string) string {
	t.Helper()
	ctx := context.Background()
	d, _, err := StateAtHead(ctx, st, docID)
	if err != nil {
		t.Fatal(err)
	}
	block := d.CreateBlock(55, collab.Root, "z", "embed")
	makeProp := func(k, v string) collab.Op {
		val := v
		op := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 55, Clock: d.Clock() + 1}, Block: block.ID, Key: k, Value: &val}
		if !d.Apply(op) {
			t.Fatalf("apply prop %s failed", k)
		}
		return op
	}
	pKind := makeProp("resourceKind", resourceKind)
	pID := makeProp("resourceId", fmt.Sprintf("%d", resourceID))
	pTitle := makeProp("title", title)
	var rows []store.RawOp
	for _, op := range []collab.Op{block, pKind, pID, pTitle} {
		raw, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		rows = append(rows, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: raw})
	}
	if _, err := st.AppendOps(ctx, docID, rows); err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%d:%d", block.ID.Client, block.ID.Clock)
}

func runReferenceIndexAndMultiHopSuite(t *testing.T, baseStore store.Store) {
	t.Helper()
	ctx := context.Background()
	spy := &refIndexReplaySpy{
		Store:       baseStore,
		SurveyStore: baseStore.(store.SurveyStore),
		idx:         baseStore.(store.ReferenceIndexStore),
	}
	srv := &Server{
		Store:      spy,
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
	cOwner, cBob := newClient(), newClient()

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
			req.Header.Set("X-Jiange-User-Id", fmt.Sprintf("%d", uid))
		}
		req.Header.Set("X-Jiange-Sheet-Version", sheetProtocolVersion)
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		return res.StatusCode, raw
	}

	register := func(c *http.Client, email, name string) (store.User, store.Workspace) {
		code, raw := doJSON(c, http.MethodPost, "/api/auth/register", map[string]string{
			"email": email, "name": name, "password": "password123",
		}, 0)
		if code != http.StatusCreated {
			t.Fatalf("register %s: %d %s", email, code, raw)
		}
		var out struct {
			User       store.User        `json:"user"`
			Workspaces []store.Workspace `json:"workspaces"`
		}
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return out.User, out.Workspaces[0]
	}

	suffix := time.Now().UnixNano()
	owner, ws := register(cOwner, fmt.Sprintf("refidx-owner-%d@test.dev", suffix), "Owner")
	bob, _ := register(cBob, fmt.Sprintf("refidx-bob-%d@test.dev", suffix), "Bob")

	// Create 4 Docs (A -> B -> C -> D) where C is NOT shared with Bob, plus multi-resource nodes.
	docA, err := baseStore.CreateDoc(ctx, ws.ID, owner.ID, nil, "文档A：总纲", syncsrv.InitialOps("文档A：总纲"))
	if err != nil {
		t.Fatal(err)
	}
	docB, err := baseStore.CreateDoc(ctx, ws.ID, owner.ID, nil, "文档B：架构", syncsrv.InitialOps("文档B：架构"))
	if err != nil {
		t.Fatal(err)
	}
	docC, err := baseStore.CreateDoc(ctx, ws.ID, owner.ID, nil, "文档C：机密中间件", syncsrv.InitialOps("文档C：机密中间件"))
	if err != nil {
		t.Fatal(err)
	}
	docD, err := baseStore.CreateDoc(ctx, ws.ID, owner.ID, nil, "文档D：下游服务", syncsrv.InitialOps("文档D：下游服务"))
	if err != nil {
		t.Fatal(err)
	}

	// Create Sheet, Base, Slides, Survey via HTTP APIs (exact production paths).
	createNode := func(kind, title string) store.DocMeta {
		code, raw := doJSON(cOwner, http.MethodPost, "/api/drive/nodes", map[string]any{
			"kind": kind, "title": title, "scope": "shared",
		}, owner.ID)
		if code != http.StatusCreated {
			t.Fatalf("create %s: %d %s", kind, code, raw)
		}
		var d store.DocMeta
		if err := json.Unmarshal(raw, &d); err != nil {
			t.Fatal(err)
		}
		return d
	}
	sheet := createNode("sheet", "预算排期表")
	base := createNode("base", "需求多维表")
	slides := createNode("slides", "季度评审幻灯片")
	survey := createNode("survey", "用户满意度问卷")

	// Wire references:
	// - DocA links to DocB, links to Base, embeds Sheet, links to Survey
	// - DocB links to DocC
	// - DocC links to DocD
	// - Slides mentions DocA in notes
	// - Sheet cell references DocA
	// - Survey description references DocA
	// - Base record references DocB
	appendReference(t, baseStore, docA.ID, fmt.Sprintf("#/doc/%d", docB.ID), "参见架构文档B", "reference")
	appendReference(t, baseStore, docA.ID, fmt.Sprintf("#/base/%d", base.ID), "关联需求多维表", "reference")
	appendReference(t, baseStore, docA.ID, fmt.Sprintf("#/survey/%d", survey.ID), "填写用户问卷", "reference")
	appendEmbedBlock(t, baseStore, docA.ID, "sheet", sheet.ID, "预算排期表")
	appendReference(t, baseStore, docB.ID, fmt.Sprintf("#/doc/%d", docC.ID), "机密设计文档C", "reference")
	appendReference(t, baseStore, docC.ID, fmt.Sprintf("#/doc/%d", docD.ID), "下游服务文档D", "reference")

	// Add slide note referencing DocA.
	pages, err := baseStore.ListSlidesPages(ctx, owner.ID, slides.ID)
	if err != nil || len(pages) == 0 {
		t.Fatalf("slides pages: %v %d", err, len(pages))
	}
	code, raw := doJSON(cOwner, http.MethodPatch, fmt.Sprintf("/api/slides/pages/%d", pages[0].ID), map[string]any{
		"title":            pages[0].Title,
		"body":             pages[0].Body,
		"background":       pages[0].Background,
		"notes":            fmt.Sprintf("参考总纲 #/doc/%d 详情", docA.ID),
		"expectedRevision": pages[0].Revision,
	}, owner.ID)
	if code != http.StatusOK {
		t.Fatalf("patch slide note: %d %s", code, raw)
	}

	// Add sheet cell referencing DocA.
	code, raw = doJSON(cOwner, http.MethodGet, fmt.Sprintf("/api/sheets/%d", sheet.ID), nil, owner.ID)
	if code != http.StatusOK {
		t.Fatalf("get sheet: %d %s", code, raw)
	}
	var snap store.SheetSnapshot
	_ = json.Unmarshal(raw, &snap)
	cellVal := fmt.Sprintf("源自总纲 #/doc/%d", docA.ID)
	code, raw = doJSON(cOwner, http.MethodPost, fmt.Sprintf("/api/sheets/%d/cells", sheet.ID), map[string]any{
		"mutationId":  "11111111111111111111111111111111",
		"worksheetId": snap.Sheets[0].ID,
		"cells": []map[string]any{
			{"rowId": snap.Sheets[0].Rows[0].ID, "columnId": snap.Sheets[0].Columns[0].ID, "expectedRevision": 0, "raw": cellVal},
		},
	}, owner.ID)
	if code != http.StatusOK {
		t.Fatalf("write sheet cell: %d %s", code, raw)
	}

	// Add survey description referencing DocA.
	code, raw = doJSON(cOwner, http.MethodGet, fmt.Sprintf("/api/surveys/%d", survey.ID), nil, owner.ID)
	if code != http.StatusOK {
		t.Fatalf("get survey: %d %s", code, raw)
	}
	var svResp struct {
		Survey store.Survey `json:"survey"`
	}
	_ = json.Unmarshal(raw, &svResp)
	code, raw = doJSON(cOwner, http.MethodPut, fmt.Sprintf("/api/surveys/%d", survey.ID), map[string]any{
		"description":      fmt.Sprintf("配合总纲 #/doc/%d 收集反馈", docA.ID),
		"questions":        svResp.Survey.Questions,
		"expectedRevision": svResp.Survey.Revision,
	}, owner.ID)
	if code != http.StatusOK {
		t.Fatalf("save survey: %d %s", code, raw)
	}

	// Add base record referencing DocB.
	fields, err := baseStore.Fields(ctx, base.ID)
	if err != nil || len(fields) == 0 {
		t.Fatalf("base fields: %v %d", err, len(fields))
	}
	if _, err := baseStore.AddRecord(ctx, store.Record{
		BaseID:  base.ID,
		TableID: fields[0].TableID,
		Cells: map[string]json.RawMessage{
			fmt.Sprintf("%d", fields[0].ID): json.RawMessage(fmt.Sprintf(`"需求对齐 #/doc/%d"`, docB.ID)),
		},
	}); err != nil {
		t.Fatal(err)
	}

	// 1. First query on DocA populates the persistent index.
	spy.reads.Store(0)
	code, raw = doJSON(cOwner, http.MethodGet, fmt.Sprintf("/api/docs/%d/references", docA.ID), nil, owner.ID)
	if code != http.StatusOK {
		t.Fatalf("refs docA: %d %s", code, raw)
	}
	var refsA referenceResult
	if err := json.Unmarshal(raw, &refsA); err != nil {
		t.Fatal(err)
	}
	if !refsA.Indexed {
		t.Fatalf("expected Indexed=true, got %+v", refsA)
	}
	if firstReads := spy.reads.Load(); firstReads == 0 {
		t.Fatalf("expected cold query to replay docs once, got 0")
	}

	// Verify DocA outgoing includes DocB, Base, Sheet (relationKind=embed), Survey.
	outByID := map[int64]referenceItem{}
	for _, it := range refsA.Outgoing {
		outByID[it.ID] = it
	}
	if outByID[docB.ID].Kind != "doc" || outByID[base.ID].Kind != "base" || outByID[survey.ID].Kind != "survey" {
		t.Fatalf("missing multi-resource outgoing from DocA: %+v", refsA.Outgoing)
	}
	if outByID[sheet.ID].Kind != "sheet" || outByID[sheet.ID].RelationKind != "embed" {
		t.Fatalf("expected embedded sheet in DocA outgoing, got %+v", outByID[sheet.ID])
	}

	// Verify DocA incoming includes Slides, Sheet, Survey!
	inByID := map[int64]referenceItem{}
	for _, it := range refsA.Incoming {
		inByID[it.ID] = it
	}
	if inByID[slides.ID].Kind != "slides" || inByID[sheet.ID].Kind != "sheet" || inByID[survey.ID].Kind != "survey" {
		t.Fatalf("expected slides/sheet/survey in DocA incoming, got %+v", refsA.Incoming)
	}

	// 2. Second query on Sheet (warm cache!) MUST perform ZERO CRDT replays!
	spy.reads.Store(0)
	code, raw = doJSON(cOwner, http.MethodGet, fmt.Sprintf("/api/docs/%d/references", sheet.ID), nil, owner.ID)
	if code != http.StatusOK {
		t.Fatalf("refs sheet: %d %s", code, raw)
	}
	if warmReads := spy.reads.Load(); warmReads != 0 {
		t.Fatalf("expected 0 CRDT replays on warm index hit, got %d", warmReads)
	}
	var refsSheet referenceResult
	_ = json.Unmarshal(raw, &refsSheet)
	if len(refsSheet.Incoming) != 1 || refsSheet.Incoming[0].ID != docA.ID || refsSheet.Incoming[0].RelationKind != "embed" {
		t.Fatalf("expected DocA embed in Sheet incoming, got %+v", refsSheet.Incoming)
	}
	if len(refsSheet.Outgoing) != 1 || refsSheet.Outgoing[0].ID != docA.ID {
		t.Fatalf("expected DocA in Sheet outgoing, got %+v", refsSheet.Outgoing)
	}

	// 3. Edit ONLY DocD -> incremental refresh replays ONLY 1 doc!
	appendReference(t, baseStore, docD.ID, fmt.Sprintf("#/slides/%d", slides.ID), "关联幻灯片", "reference")
	spy.reads.Store(0)
	code, raw = doJSON(cOwner, http.MethodGet, fmt.Sprintf("/api/docs/%d/references", slides.ID), nil, owner.ID)
	if code != http.StatusOK {
		t.Fatalf("refs slides: %d %s", code, raw)
	}
	if incReads := spy.reads.Load(); incReads != 1 {
		t.Fatalf("expected exactly 1 incremental CRDT replay after editing docD, got %d", incReads)
	}
	var refsSlides referenceResult
	_ = json.Unmarshal(raw, &refsSlides)
	if len(refsSlides.Incoming) != 1 || refsSlides.Incoming[0].ID != docD.ID {
		t.Fatalf("expected docD in slides incoming, got %+v", refsSlides.Incoming)
	}

	// 4. Multi-hop Reference Graph for Owner at DocA (depth 1, 2, 3).
	getGraph := func(c *http.Client, uid, nodeID int64, depth int) referenceGraphResult {
		t.Helper()
		code, raw := doJSON(c, http.MethodGet, fmt.Sprintf("/api/docs/%d/reference-graph?depth=%d", nodeID, depth), nil, uid)
		if code != http.StatusOK {
			t.Fatalf("graph node=%d depth=%d: %d %s", nodeID, depth, code, raw)
		}
		var g referenceGraphResult
		if err := json.Unmarshal(raw, &g); err != nil {
			t.Fatal(err)
		}
		return g
	}
	nodeDepths := func(g referenceGraphResult) map[int64]int {
		m := map[int64]int{}
		for _, n := range g.Nodes {
			m[n.ID] = n.Depth
		}
		return m
	}

	g1 := getGraph(cOwner, owner.ID, docA.ID, 1)
	d1 := nodeDepths(g1)
	if d1[docA.ID] != 0 || d1[docB.ID] != 1 || d1[sheet.ID] != 1 || d1[base.ID] != 1 || d1[slides.ID] != 1 || d1[survey.ID] != 1 {
		t.Fatalf("depth 1 unexpected nodes: %+v", d1)
	}
	if _, hasC := d1[docC.ID]; hasC {
		t.Fatalf("docC should not appear at depth 1: %+v", d1)
	}

	g2 := getGraph(cOwner, owner.ID, docA.ID, 2)
	d2 := nodeDepths(g2)
	if d2[docC.ID] != 2 || d2[docD.ID] != 2 { // docD links to slides (hop 1 -> hop 2!)
		t.Fatalf("depth 2 expected docC & docD at depth 2: %+v", d2)
	}

	// Invalid depth returns 400.
	if badCode, _ := doJSON(cOwner, http.MethodGet, fmt.Sprintf("/api/docs/%d/reference-graph?depth=4", docA.ID), nil, owner.ID); badCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for depth=4, got %d", badCode)
	}

	// 5. Permission fencing across multi-hop graph!
	// Share DocA, DocB, and DocD with Bob — do NOT share DocC or Slides!
	// Chain A -> B -> C (private) -> D (shared). Because C is private, Bob MUST NOT see C
	// and MUST NOT traverse through C to reach D!
	for _, id := range []int64{docA.ID, docB.ID, docD.ID} {
		if err := baseStore.SetShare(ctx, id, bob.ID, store.RoleView); err != nil {
			t.Fatal(err)
		}
	}
	gBob := getGraph(cBob, bob.ID, docA.ID, 3)
	dBob := nodeDepths(gBob)
	if dBob[docA.ID] != 0 || dBob[docB.ID] != 1 {
		t.Fatalf("bob should see docA (0) and docB (1): %+v", dBob)
	}
	if _, hasC := dBob[docC.ID]; hasC {
		t.Fatalf("private docC leaked to bob: %+v", dBob)
	}
	if _, hasD := dBob[docD.ID]; hasD {
		t.Fatalf("docD leaked transitively through private docC to bob: %+v", dBob)
	}

	// 6. Account-document-search returns multi-resource items with kind, and paste-target validates ?kind=.
	code, raw = doJSON(cOwner, http.MethodGet, "/api/account-document-search?q="+url.QueryEscape("排期"), nil, owner.ID)
	if code != http.StatusOK {
		t.Fatalf("search sheet: %d %s", code, raw)
	}
	var sr struct {
		Docs []struct {
			ID   int64  `json:"id"`
			Kind string `json:"kind"`
		} `json:"docs"`
	}
	_ = json.Unmarshal(raw, &sr)
	foundSheet := false
	for _, it := range sr.Docs {
		if it.ID == sheet.ID && it.Kind == "sheet" {
			foundSheet = true
			break
		}
	}
	if !foundSheet {
		t.Fatalf("expected sheet in account search, got %+v", sr)
	}

	if code, _ = doJSON(cOwner, http.MethodGet, fmt.Sprintf("/api/docs/%d/paste-target?kind=sheet", sheet.ID), nil, owner.ID); code != http.StatusOK {
		t.Fatalf("paste-target matching kind failed: %d", code)
	}
	if code, _ = doJSON(cOwner, http.MethodGet, fmt.Sprintf("/api/docs/%d/paste-target?kind=base", sheet.ID), nil, owner.ID); code != http.StatusNotFound {
		t.Fatalf("paste-target mismatched kind should be 404, got %d", code)
	}
}

func TestReferenceIndexAndMultiHopMemory(t *testing.T) {
	runReferenceIndexAndMultiHopSuite(t, store.NewMemory())
}

func TestReferenceIndexAndMultiHopPostgres(t *testing.T) {
	connStr := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if connStr == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, connStr)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := pgx.Identifier{fmt.Sprintf("ref_index_test_%d", time.Now().UnixNano())}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")

	cfg, err := pgxpool.ParseConfig(connStr)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	pg := &store.Postgres{Pool: pool}
	runReferenceIndexAndMultiHopSuite(t, pg)
}
