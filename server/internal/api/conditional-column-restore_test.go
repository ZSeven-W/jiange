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

func checkConditionalColumnRestore(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	ts, client := newTestServer(t, st, nil)
	r := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "archive-restore@test.dev", "name": "Tester", "password": "password123"})
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
	otherGroup := state.CreateBlock(uint64(writer), collab.Root, "Y", "columns")
	otherColumn := state.CreateBlock(uint64(writer), otherGroup.ID, "A", "paragraph")
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
	appendRaw(group, left, right, otherGroup, otherColumn, text)
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
	meta := fmt.Sprintf("v1|%s|A|%s", group.ID.Key(), id.Key())
	archive := []collab.Op{
		{T: collab.TBlockCreate, ID: id, Parent: collab.Root, Pos: "U", Type: "jiange-column-archive-v1"},
		{T: collab.TBlockDelete, ID: collab.OpID{Client: id.Client, Clock: id.Clock + 1}, Block: id},
		{T: collab.TBlockSet, ID: collab.OpID{Client: id.Client, Clock: id.Clock + 2}, Block: left.ID, Key: "_column_archive_v1", Value: &meta},
		{T: collab.TBlockMove, ID: collab.OpID{Client: id.Client, Clock: id.Clock + 3}, Block: left.ID, Parent: id, Pos: "U"},
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
	wrong := fmt.Sprintf("v1|%s|B|%s", group.ID.Key(), id.Key())
	bad := append([]collab.Op(nil), archive...)
	bad[2].Value = &wrong
	if code := do("11111111111111111111111111111111", head, bad); code != http.StatusBadRequest {
		t.Fatalf("invalid origin: %d", code)
	}
	if code := do("22222222222222222222222222222222", head, archive); code != http.StatusOK {
		t.Fatalf("archive: %d", code)
	}
	appendRaw(late)
	state, head, err = StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, visible := state.VisibleBlockText(left.ID); visible {
		t.Fatal("archive visible")
	}
	collision := collab.Op{T: collab.TBlockMove, ID: collab.OpID{Client: uint64(peerID), Clock: state.Clock() + 1}, Block: right.ID, Parent: group.ID, Pos: "A"}
	appendRaw(collision)
	state, head, err = StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	blocked := collab.Op{T: collab.TBlockMove, ID: collab.OpID{Client: uint64(writer), Clock: state.Clock() + 1}, Block: left.ID, Parent: group.ID, Pos: "A"}
	if code := do("77777777777777777777777777777777", head, []collab.Op{blocked}); code != http.StatusBadRequest {
		t.Fatalf("occupied origin: %d", code)
	}
	reset := collab.Op{T: collab.TBlockMove, ID: collab.OpID{Client: uint64(peerID), Clock: state.Clock() + 1}, Block: right.ID, Parent: group.ID, Pos: "B"}
	appendRaw(reset)
	state, head, err = StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	restore := collab.Op{T: collab.TBlockMove, ID: collab.OpID{Client: uint64(writer), Clock: state.Clock() + 1}, Block: left.ID, Parent: group.ID, Pos: "A"}
	for i, invalid := range []collab.Op{
		{T: collab.TBlockMove, ID: restore.ID, Block: left.ID, Parent: otherGroup.ID, Pos: "A"},
		{T: collab.TBlockMove, ID: restore.ID, Block: left.ID, Parent: group.ID, Pos: "C"},
	} {
		if code := do(fmt.Sprintf("%032x", i+3), head, []collab.Op{invalid}); code != http.StatusBadRequest {
			t.Fatalf("invalid restore %d: %d", i, code)
		}
	}
	restoreKey := "55555555555555555555555555555555"
	if code := do(restoreKey, head-1, []collab.Op{restore}); code != http.StatusConflict {
		t.Fatalf("stale restore: %d", code)
	}
	if code := do(restoreKey, head, []collab.Op{restore}); code != http.StatusOK {
		t.Fatalf("restore: %d", code)
	}
	if code := do(restoreKey, head, []collab.Op{restore}); code != http.StatusOK {
		t.Fatalf("retry restore: %d", code)
	}
	state, head, err = StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if value, _, visible := state.VisibleBlockText(left.ID); !visible || value != "原文远端" {
		t.Fatalf("restored content: %q %v", value, visible)
	}
	redo := collab.Op{T: collab.TBlockMove, ID: collab.OpID{Client: uint64(writer), Clock: state.Clock() + 1}, Block: left.ID, Parent: id, Pos: "U"}
	if code := do("66666666666666666666666666666666", head, []collab.Op{redo}); code != http.StatusOK {
		t.Fatalf("redo: %d", code)
	}
	state, _, err = StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, visible := state.VisibleBlockText(left.ID); visible || state.Text(left.ID) != "原文远端" {
		t.Fatal("redo lost or exposed content")
	}
}

func TestMemoryConditionalColumnRestore(t *testing.T) {
	checkConditionalColumnRestore(t, store.NewMemory())
}
func TestPostgresConditionalColumnRestore(t *testing.T) {
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
	checkConditionalColumnRestore(t, pg)
}
