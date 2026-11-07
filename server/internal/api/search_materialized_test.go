package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

func TestSearchMaterializedTextPermissionsAndPagination(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	owner, ws, _ := st.CreateUser(ctx, "search-owner@example.test", "owner", "")
	guest, _, _ := st.CreateUser(ctx, "search-guest@example.test", "guest", "")
	server := &Server{Store: st}
	create := func(parent *int64, title string) store.DocMeta {
		d, err := st.CreateDoc(ctx, ws.ID, owner.ID, parent, title, syncsrv.InitialOps(title))
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	root := create(nil, "private parent")
	child := create(&root.ID, "Shared child")
	if err := st.SetShare(ctx, child.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	state, _, err := StateAtHead(ctx, st, child.ID)
	if err != nil {
		t.Fatal(err)
	}
	paragraph := collab.OpID{Client: 0, Clock: 2}
	var raw []store.RawOp
	appendOp := func(op collab.Op) {
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		raw = append(raw, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
	}
	for i, ch := range []rune("ABC%_\\Straße") {
		appendOp(state.InsertText(9, paragraph, i, string(ch)))
	}
	for _, op := range state.DeleteText(9, paragraph, 0, 3) {
		appendOp(op)
	}
	if _, err := st.AppendOps(ctx, child.ID, raw); err != nil {
		t.Fatal(err)
	}
	search := func(uid int64, q string, want int) []store.DocMeta {
		t.Helper()
		docs, err := server.searchMaterialized(ctx, uid, q)
		if err != nil || len(docs) != want {
			t.Fatalf("search %q: got %v, err %v; want %d", q, docs, err, want)
		}
		return docs
	}
	search(guest.ID, "abc", 0)                // deleted text must not be found
	got := search(guest.ID, "%_\\STRASSE", 1) // literal wildcards and Unicode folding
	if got[0].ID != child.ID || got[0].ParentID != nil {
		t.Fatalf("shared child or parent leak: %+v", got)
	}
	search(guest.ID, "private parent", 0)
	if err := st.SetShare(ctx, child.ID, guest.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, root.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	search(guest.ID, "STRASSE", 1) // inherited grant
	if err := st.SetShare(ctx, root.ID, guest.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := st.SetLink(ctx, root.ID, store.Link{Role: store.RoleView, Token: "search-link"}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.JoinLink(ctx, "search-link", guest.ID); err != nil {
		t.Fatal(err)
	}
	search(guest.ID, "STRASSE", 1)
	if err := st.SetLink(ctx, root.ID, store.Link{Role: "none"}); err != nil {
		t.Fatal(err)
	}
	search(guest.ID, "STRASSE", 0)
	for i := 0; i < 510; i++ {
		create(nil, fmt.Sprintf("paging %d", i))
	}
	search(owner.ID, "paging", 510)
	if err := st.Trash(ctx, child.ID); err != nil {
		t.Fatal(err)
	}
	search(owner.ID, "STRASSE", 0)
}

func TestSearchSkipsHiddenSourceAndIncludesVisibleTableCells(t *testing.T) {
	view := collab.DocView{Blocks: []collab.BlockView{
		{Type: "math", Spans: []collab.Span{{Text: "secret formula"}}},
		{Type: "diagram", Spans: []collab.Span{{Text: "secret diagram"}}},
		{Type: "paragraph", Spans: []collab.Span{{Text: "before"}, {Text: "secret", Marks: map[string]string{"math": "x"}}, {Text: "after"}}},
		{Type: "table", Props: map[string]string{"tableData": `[["Visible cell"]]`}},
	}}
	for _, q := range []string{"secret", "beforeafter"} {
		if searchableDocument(view, q) {
			t.Fatalf("matched hidden source %q", q)
		}
	}
	for _, q := range []string{"before", "visible cell"} {
		if !searchableDocument(view, q) {
			t.Fatalf("missed %q", q)
		}
	}
}

type corruptSearchStore struct{ store.Store }

func (s corruptSearchStore) OpsAfter(context.Context, int64, int64, int) ([]store.SeqOp, error) {
	return nil, errors.New("corrupt history")
}

func TestSearchReturnsErrorForCorruptHistory(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	u, ws, _ := st.CreateUser(ctx, "broken@example.test", "broken", "")
	if _, err := st.CreateDoc(ctx, ws.ID, u.ID, nil, "broken", syncsrv.InitialOps("broken")); err != nil {
		t.Fatal(err)
	}
	s := &Server{Store: corruptSearchStore{st}}
	if _, err := s.searchMaterialized(ctx, u.ID, "broken"); err == nil {
		t.Fatal("corrupt state must fail rather than silently omit the document")
	}
	ctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := s.searchMaterialized(ctx, u.ID, "broken"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
}

type revokeSearchStore struct {
	store.Store
	doc, user int64
}

func (s revokeSearchStore) SearchCandidates(ctx context.Context, uid, after int64, limit int) ([]store.DocMeta, error) {
	page, err := s.Store.SearchCandidates(ctx, uid, after, limit)
	if err == nil && after == 0 {
		err = s.Store.SetShare(ctx, s.doc, s.user, "")
	}
	return page, err
}

func TestSearchRechecksRevokedAccess(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	owner, ws, _ := st.CreateUser(ctx, "revoke-owner@test", "owner", "")
	guest, _, _ := st.CreateUser(ctx, "revoke-guest@test", "guest", "")
	doc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "revoked", syncsrv.InitialOps("revoked"))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, doc.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	s := &Server{Store: revokeSearchStore{Store: st, doc: doc.ID, user: guest.ID}}
	got, err := s.searchMaterialized(ctx, guest.ID, "revoked")
	if err != nil || len(got) != 0 {
		t.Fatalf("revoked result leaked: %+v %v", got, err)
	}
}

func TestSearchHTTPReportsIncomplete(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, corruptSearchStore{st}, nil)
	resp := post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "search-http@test", "name": "Owner", "password": "password123"})
	resp.Body.Close()
	resp = post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "broken"})
	resp.Body.Close()
	resp, err := owner.Get(ts.URL + "/api/search?q=broken")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusServiceUnavailable || body["error"] != "search_incomplete" {
		t.Fatalf("expected 503, got %d: %v", resp.StatusCode, body)
	}
}

func TestSearchFindsRenamedMetadataThroughHTTP(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	resp := post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "rename-search@test", "name": "Owner", "password": "password123"})
	resp.Body.Close()
	resp = post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "旧标题遗留"})
	var doc store.DocMeta
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	resp = send(t, owner, http.MethodPatch, ts.URL+"/api/docs/"+strconv.FormatInt(doc.ID, 10), map[string]string{"title": "新的名称"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("rename: %d", resp.StatusCode)
	}
	for query, want := range map[string]int{"新的名称": 1, "旧标题遗留": 0} {
		resp, err := owner.Get(ts.URL + "/api/search?q=" + url.QueryEscape(query))
		if err != nil {
			t.Fatal(err)
		}
		var body struct {
			Docs []store.DocMeta `json:"docs"`
		}
		err = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if err != nil || resp.StatusCode != http.StatusOK || len(body.Docs) != want {
			t.Fatalf("search %q: %d %+v %v", query, resp.StatusCode, body.Docs, err)
		}
	}
}

type renameSearchStore struct {
	store.Store
	doc   int64
	title string
}

func (s renameSearchStore) SearchCandidates(ctx context.Context, uid, after int64, limit int) ([]store.DocMeta, error) {
	page, err := s.Store.SearchCandidates(ctx, uid, after, limit)
	if err == nil && after == 0 {
		_, err = s.Store.UpdateTitle(ctx, s.doc, s.title)
	}
	return page, err
}

func TestSearchRechecksTitleAfterEnumeration(t *testing.T) {
	for _, tc := range []struct {
		before, after, query string
		want                 int
	}{
		{"old", "new", "old", 0}, {"old", "new", "new", 1},
	} {
		t.Run(tc.query, func(t *testing.T) {
			ctx := context.Background()
			st := store.NewMemory()
			owner, ws, _ := st.CreateUser(ctx, "rename-race@test", "owner", "")
			doc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, tc.before, syncsrv.InitialOps(tc.before))
			if err != nil {
				t.Fatal(err)
			}
			s := &Server{Store: renameSearchStore{Store: st, doc: doc.ID, title: tc.after}}
			got, err := s.searchMaterialized(ctx, owner.ID, tc.query)
			if err != nil || len(got) != tc.want {
				t.Fatalf("got %+v %v", got, err)
			}
		})
	}
}
