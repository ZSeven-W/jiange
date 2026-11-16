package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestUnsupportedTableViewAndCopyAreNotProjected(t *testing.T) {
	e := newCopyTestEnv(t)
	ctx := context.Background()
	state, _, err := StateAtHead(ctx, e.store, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	block := state.CreateBlock(17, collab.Root, "Z", "table")
	table := collab.Op{T: collab.TTable, ID: collab.OpID{Client: 17, Clock: state.Clock() + 1}, Block: block.ID, Payload: []byte(`{"kind":"axis-insert"}`)}
	for _, op := range []collab.Op{block, table} {
		encoded, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.store.AppendOps(ctx, e.source.ID, []store.RawOp{{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: encoded}}); err != nil {
			t.Fatal(err)
		}
	}
	linkResp := send(t, e.owner, "PUT", e.url()+"/link", map[string]string{"role": "anon"})
	var link store.Link
	if err := json.NewDecoder(linkResp.Body).Decode(&link); err != nil || linkResp.StatusCode != http.StatusOK {
		t.Fatalf("link: %d %v", linkResp.StatusCode, err)
	}
	linkResp.Body.Close()
	public, err := http.Get(e.server.URL + "/api/public/" + link.Token)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(public.Body)
	public.Body.Close()
	if public.StatusCode != http.StatusConflict || !strings.Contains(string(body), `"error":"table_unsupported"`) || strings.Contains(string(body), `"view"`) {
		t.Fatalf("public projection: %d %s", public.StatusCode, body)
	}
	version := post(t, e.owner, e.url()+"/versions", map[string]string{"label": "实验历史"})
	var saved store.Version
	if err := json.NewDecoder(version.Body).Decode(&saved); err != nil || version.StatusCode != http.StatusCreated {
		t.Fatalf("version: %d %v", version.StatusCode, err)
	}
	version.Body.Close()
	preview, err := e.owner.Get(e.url() + "/versions/" + strconv.FormatInt(saved.Seq, 10))
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(preview.Body)
	preview.Body.Close()
	if preview.StatusCode != http.StatusConflict || !strings.Contains(string(body), `"error":"table_unsupported"`) || strings.Contains(string(body), `"view"`) {
		t.Fatalf("version projection: %d %s", preview.StatusCode, body)
	}
	search, err := e.owner.Get(e.server.URL + "/api/search?q=project")
	if err != nil {
		t.Fatal(err)
	}
	search.Body.Close()
	if search.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("search returned an incomplete result: %d", search.StatusCode)
	}
	guestSearch, err := e.guest.Get(e.server.URL + "/api/search?q=project")
	if err != nil {
		t.Fatal(err)
	}
	guestSearch.Body.Close()
	if guestSearch.StatusCode != http.StatusOK {
		t.Fatalf("private document affected another account's search: %d", guestSearch.StatusCode)
	}
	restore := post(t, e.owner, e.url()+"/versions/"+strconv.FormatInt(saved.Seq, 10)+"/restore", nil)
	restore.Body.Close()
	if restore.StatusCode != http.StatusConflict {
		t.Fatalf("unsupported restore: %d", restore.StatusCode)
	}
	clientID, err := e.store.AllocClient(ctx, e.ownerUser.ID, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	epoch, head, err := e.store.HeadVersion(ctx, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	current, _, err := StateAtHead(ctx, e.store, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	op := current.InsertText(uint64(clientID), collab.OpID{Client: 0, Clock: 2}, 0, "new")
	batch, err := collab.EncodeOps([]collab.Op{op})
	if err != nil {
		t.Fatal(err)
	}
	request, _ := json.Marshal(map[string]any{"historyEpoch": epoch, "expectedSeq": head, "requestId": "abababababababababababababababab", "batch": batch})
	conditional, _ := http.NewRequest(http.MethodPost, e.url()+"/conditional-ops", bytes.NewReader(request))
	conditional.Header.Set("Content-Type", "application/json")
	conditional.Header.Set("X-Jiange-User-Id", strconv.FormatInt(e.ownerUser.ID, 10))
	result, err := e.owner.Do(conditional)
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(result.Body)
	result.Body.Close()
	if result.StatusCode != http.StatusConflict || !strings.Contains(string(body), `"error":"table_unsupported"`) {
		t.Fatalf("conditional write: %d %s", result.StatusCode, body)
	}
	if got, _ := e.store.Head(ctx, e.source.ID); got != head {
		t.Fatal("unsupported write advanced history")
	}
	before, err := e.store.ListDocs(ctx, e.ownerUser.ID)
	if err != nil {
		t.Fatal(err)
	}
	copy := post(t, e.owner, e.url()+"/duplicate", nil)
	body, _ = io.ReadAll(copy.Body)
	copy.Body.Close()
	if copy.StatusCode != http.StatusConflict || !strings.Contains(string(body), `"error":"table_unsupported"`) {
		t.Fatalf("copy: %d %s", copy.StatusCode, body)
	}
	after, err := e.store.ListDocs(ctx, e.ownerUser.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatal("failed copy created a document")
	}
}
