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

func checkConditionalColumnGroup(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	ts, client := newTestServer(t, st, nil)
	r := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "archive-group@test.dev", "name": "Tester", "password": "password123"})
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
	r = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "整组分栏"})
	var doc store.DocMeta
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create %d", r.StatusCode)
	}
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	writer, err := st.AllocClient(ctx, me.User.ID, doc.ID)
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
	group := state.CreateBlock(uint64(writer), collab.Root, "X", "columns")
	left := state.CreateBlock(uint64(writer), group.ID, "A", "paragraph")
	right := state.CreateBlock(uint64(writer), group.ID, "B", "paragraph")
	outside := state.CreateBlock(uint64(writer), collab.Root, "Y", "paragraph")
	text := state.InsertText(uint64(writer), left.ID, 0, "原文")
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
	appendRaw(group, left, right, outside, text)
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
	id := collab.OpID{Client: uint64(writer), Clock: state.Clock() + 1}
	metadata := fmt.Sprintf("v1|0:0|X|%s", id.Key())
	archive := []collab.Op{
		{T: collab.TBlockCreate, ID: id, Parent: collab.Root, Pos: "U", Type: "jiange-column-archive-v1"},
		{T: collab.TBlockDelete, ID: collab.OpID{Client: id.Client, Clock: id.Clock + 1}, Block: id},
		{T: collab.TBlockSet, ID: collab.OpID{Client: id.Client, Clock: id.Clock + 2}, Block: group.ID, Key: "_column_archive_v1", Value: &metadata},
		{T: collab.TBlockMove, ID: collab.OpID{Client: id.Client, Clock: id.Clock + 3}, Block: group.ID, Parent: id, Pos: "U"},
	}
	do := func(key string, base int64, ops []collab.Op) int {
		t.Helper()
		encoded, e := collab.EncodeOps(ops)
		if e != nil {
			t.Fatal(e)
		}
		body, _ := json.Marshal(conditionalOpsInput{epoch, base, key, encoded})
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
	bad := append([]collab.Op(nil), archive...)
	wrong := fmt.Sprintf("v1|0:0|Y|%s", id.Key())
	bad[2].Block = outside.ID
	bad[2].Value = &wrong
	bad[3].Block = outside.ID
	if code := do("11111111111111111111111111111111", head, bad); code != http.StatusBadRequest {
		t.Fatalf("root paragraph: %d", code)
	}
	badTitle := append([]collab.Op(nil), archive...)
	title := collab.OpID{Client: 0, Clock: 1}
	titleMeta := fmt.Sprintf("v1|0:0|U|%s", id.Key())
	badTitle[2].Block = title
	badTitle[2].Value = &titleMeta
	badTitle[3].Block = title
	if code := do("66666666666666666666666666666666", head, badTitle); code != http.StatusBadRequest {
		t.Fatalf("title archive: %d", code)
	}
	viewerServer, viewerClient := newTestServer(t, st, nil)
	viewerResponse := post(t, viewerClient, viewerServer.URL+"/api/auth/register", map[string]string{"email": "archive-group-viewer@test.dev", "name": "Viewer", "password": "password123"})
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
	encoded, _ := collab.EncodeOps(archive)
	viewerBody, _ := json.Marshal(conditionalOpsInput{epoch, head, "77777777777777777777777777777777", encoded})
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
	if code := do("22222222222222222222222222222222", head, archive); code != http.StatusOK {
		t.Fatalf("archive: %d", code)
	}
	appendRaw(late)
	state, head, err = StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, visible := state.VisibleBlockText(group.ID); visible {
		t.Fatal("group visible")
	}
	if _, _, visible := state.VisibleBlockText(left.ID); visible {
		t.Fatal("child visible")
	}
	if state.Text(left.ID) != "原文远端" {
		t.Fatalf("late edit: %q", state.Text(left.ID))
	}
	view, err := state.ReadOnlyProjectionView()
	if err != nil {
		t.Fatal(err)
	}
	projection, err := state.ReadOnlyProjection(view)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(projection.EncodeState(), []byte("原文")) || bytes.Contains(projection.EncodeState(), []byte("远端")) {
		t.Fatal("read-only projection exposed hidden group content")
	}
	restore := collab.Op{T: collab.TBlockMove, ID: collab.OpID{Client: uint64(writer), Clock: state.Clock() + 1}, Block: group.ID, Parent: collab.Root, Pos: "X"}
	wrongMove := restore
	wrongMove.Pos = "Z"
	if code := do("33333333333333333333333333333333", head, []collab.Op{wrongMove}); code != http.StatusBadRequest {
		t.Fatalf("wrong origin: %d", code)
	}
	if code := do("44444444444444444444444444444444", head, []collab.Op{restore}); code != http.StatusOK {
		t.Fatalf("restore: %d", code)
	}
	state, head, err = StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if value, _, visible := state.VisibleBlockText(left.ID); !visible || value != "原文远端" {
		t.Fatalf("restored content %q %v", value, visible)
	}
	if _, _, visible := state.VisibleBlockText(right.ID); !visible {
		t.Fatal("sibling not restored")
	}
	redo := collab.Op{T: collab.TBlockMove, ID: collab.OpID{Client: uint64(writer), Clock: state.Clock() + 1}, Block: group.ID, Parent: id, Pos: "U"}
	if code := do("55555555555555555555555555555555", head, []collab.Op{redo}); code != http.StatusOK {
		t.Fatalf("redo: %d", code)
	}
}

func TestMemoryConditionalColumnGroup(t *testing.T) {
	checkConditionalColumnGroup(t, store.NewMemory())
}
func TestPostgresConditionalColumnGroup(t *testing.T) {
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
	checkConditionalColumnGroup(t, pg)
}
