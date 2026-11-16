package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func checkConditionalColumnArchive(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	ts, client := newTestServer(t, st, nil)
	r := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "archive-conditional@test.dev", "name": "Tester", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("register %d", r.StatusCode)
	}
	if err := json.NewDecoder(r.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	r = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "分栏"})
	var doc store.DocMeta
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create doc %d", r.StatusCode)
	}
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	author, err := st.AllocClient(ctx, me.User.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	peerID, err := st.AllocClient(ctx, me.User.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	state, _, err := StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	group := state.CreateBlock(uint64(author), collab.Root, "X", "columns")
	left := state.CreateBlock(uint64(author), group.ID, "A", "paragraph")
	right := state.CreateBlock(uint64(author), group.ID, "B", "paragraph")
	outside := state.CreateBlock(uint64(author), collab.Root, "Y", "paragraph")
	text := state.InsertText(uint64(author), left.ID, 0, "原文")
	seed := []collab.Op{group, left, right, outside, text}
	appendRaw := func(ops ...collab.Op) {
		t.Helper()
		var raws []store.RawOp
		for _, op := range ops {
			raw, e := collab.EncodeOps([]collab.Op{op})
			if e != nil {
				t.Fatal(e)
			}
			raws = append(raws, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: raw})
		}
		if _, e := st.AppendOps(ctx, doc.ID, raws); e != nil {
			t.Fatal(e)
		}
	}
	appendRaw(seed...)
	epoch, head, err := st.HeadVersion(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	state, _, err = StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	peer, err := collab.DecodeState(state.EncodeState())
	if err != nil {
		t.Fatal(err)
	}
	late := peer.InsertText(uint64(peerID), left.ID, 2, "远端")
	id := collab.OpID{Client: uint64(author), Clock: state.Clock() + 1}
	archive := []collab.Op{
		{T: collab.TBlockCreate, ID: id, Parent: collab.Root, Pos: "U", Type: "jiange-column-archive-v1"},
		{T: collab.TBlockDelete, ID: collab.OpID{Client: id.Client, Clock: id.Clock + 1}, Block: id},
		{T: collab.TBlockMove, ID: collab.OpID{Client: id.Client, Clock: id.Clock + 2}, Block: left.ID, Parent: id, Pos: "U"},
	}
	do := func(key string, base int64, ops []collab.Op) int {
		t.Helper()
		batch, e := collab.EncodeOps(ops)
		if e != nil {
			t.Fatal(e)
		}
		body, _ := json.Marshal(conditionalOpsInput{epoch, base, key, batch})
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/docs/"+strconv.FormatInt(doc.ID, 10)+"/conditional-ops", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(me.User.ID, 10))
		response, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		return response.StatusCode
	}
	invalid := [][]collab.Op{
		archive[:1], archive[:2],
		{archive[0], archive[1], {T: collab.TBlockMove, ID: archive[2].ID, Block: outside.ID, Parent: id, Pos: "U"}},
		{{T: collab.TBlockCreate, ID: id, Parent: collab.Root, Pos: "U", Type: "paragraph"}, archive[1], archive[2]},
		{archive[0], archive[1], {T: collab.TBlockMove, ID: archive[2].ID, Block: left.ID, Parent: group.ID, Pos: "U"}},
	}
	for i, ops := range invalid {
		if code := do(fmt.Sprintf("%032x", i+1), head, ops); code != http.StatusBadRequest {
			t.Fatalf("invalid %d: %d", i, code)
		}
	}
	viewerServer, viewerClient := newTestServer(t, st, nil)
	viewerResponse := post(t, viewerClient, viewerServer.URL+"/api/auth/register", map[string]string{"email": "archive-viewer@test.dev", "name": "Viewer", "password": "password123"})
	var viewer struct {
		User store.User `json:"user"`
	}
	if viewerResponse.StatusCode != http.StatusCreated {
		t.Fatalf("viewer register %d", viewerResponse.StatusCode)
	}
	if err := json.NewDecoder(viewerResponse.Body).Decode(&viewer); err != nil {
		t.Fatal(err)
	}
	viewerResponse.Body.Close()
	if err := st.SetShare(ctx, doc.ID, viewer.User.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	batch, _ := collab.EncodeOps(archive)
	viewerBody, _ := json.Marshal(conditionalOpsInput{epoch, head, "dddddddddddddddddddddddddddddddd", batch})
	viewerRequest, _ := http.NewRequest(http.MethodPost, viewerServer.URL+"/api/docs/"+strconv.FormatInt(doc.ID, 10)+"/conditional-ops", bytes.NewReader(viewerBody))
	viewerRequest.Header.Set("Content-Type", "application/json")
	viewerRequest.Header.Set("X-Jiange-User-Id", strconv.FormatInt(viewer.User.ID, 10))
	viewerResult, err := viewerClient.Do(viewerRequest)
	if err != nil {
		t.Fatal(err)
	}
	viewerResult.Body.Close()
	if viewerResult.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer archive: %d", viewerResult.StatusCode)
	}
	key := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if racing, ok := st.(*racingConditionalStore); ok {
		racing.hook = func(context.Context) error { appendRaw(late); return nil }
		if code := do(key, head, archive); code != http.StatusConflict {
			t.Fatalf("concurrent archive: %d", code)
		}
		actual, finalHead, err := StateAtHead(ctx, st, doc.ID)
		if err != nil || finalHead != head+1 {
			t.Fatalf("racing head %d: %v", finalHead, err)
		}
		if value, _, visible := actual.VisibleBlockText(left.ID); !visible || value != "原文远端" {
			t.Fatalf("concurrent content: %q %v", value, visible)
		}
		return
	}
	if code := do(key, head, archive); code != http.StatusOK {
		t.Fatalf("archive %d", code)
	}
	if code := do(key, head, archive); code != http.StatusOK {
		t.Fatalf("idempotent archive %d", code)
	}
	if code := do("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", head, archive); code != http.StatusConflict {
		t.Fatalf("stale head %d", code)
	}
	appendRaw(late)
	if code := do(key, head, archive); code != http.StatusOK {
		t.Fatalf("idempotent retry after later edit: %d", code)
	}
	actual, finalHead, err := StateAtHead(ctx, st, doc.ID)
	if err != nil || finalHead != head+4 {
		t.Fatalf("head %d: %v", finalHead, err)
	}
	if _, _, visible := actual.VisibleBlockText(left.ID); visible {
		t.Fatal("archived column visible")
	}
	if actual.Text(left.ID) != "原文远端" {
		t.Fatalf("late edit lost: %q", actual.Text(left.ID))
	}
	if _, _, visible := actual.VisibleBlockText(right.ID); !visible {
		t.Fatal("sibling disappeared")
	}
}

func TestMemoryConditionalColumnArchive(t *testing.T) {
	checkConditionalColumnArchive(t, store.NewMemory())
}
func TestConditionalColumnArchiveRechecksHead(t *testing.T) {
	base := store.NewMemory()
	checkConditionalColumnArchive(t, &racingConditionalStore{Store: base, ConditionalOpsCommitter: base})
}
func TestPostgresConditionalColumnArchive(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	pg, err := store.NewPostgres(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err = migrate.Up(context.Background(), pg.Pool); err != nil {
		t.Fatal(err)
	}
	checkConditionalColumnArchive(t, pg)
}
