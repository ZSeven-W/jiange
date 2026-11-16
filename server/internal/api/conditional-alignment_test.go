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

func checkConditionalAlignment(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	ts, client := newTestServer(t, st, nil)
	r := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "conditional-align@test.dev", "name": "Tester", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(r.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	r = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "分栏"})
	var doc store.DocMeta
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	owner, err := st.AllocClient(ctx, me.User.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	remote, err := st.AllocClient(ctx, me.User.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	state, _, err := StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	columns := state.CreateBlock(uint64(owner), collab.Root, "X", "columns")
	column := state.CreateBlock(uint64(owner), columns.ID, "U", "paragraph")
	secondColumn := state.CreateBlock(uint64(owner), columns.ID, "k", "paragraph")
	table := state.CreateBlock(uint64(owner), collab.Root, "Y", "table")
	code := state.CreateBlock(uint64(owner), collab.Root, "Z", "code")
	ops := []collab.Op{columns, column, secondColumn, table, code}
	var records []store.RawOp
	for _, op := range ops {
		raw, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		records = append(records, store.RawOp{ClientID: owner, Clock: int64(op.ID.Clock), Bytes: raw})
	}
	if _, err := st.AppendOps(ctx, doc.ID, records); err != nil {
		t.Fatal(err)
	}
	epoch, head, err := st.HeadVersion(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	state, _, err = StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	url := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10) + "/conditional-ops"
	do := func(request string, at int64, op collab.Op) int {
		t.Helper()
		batch, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		body, _ := json.Marshal(conditionalOpsInput{epoch, at, request, batch})
		req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(me.User.ID, 10))
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		return response.StatusCode
	}
	center := "center"
	set := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: uint64(owner), Clock: state.Clock() + 1}, Block: column.ID, Key: "align", Value: &center}
	if got := do("11111111111111111111111111111111", head, set); got != http.StatusOK {
		t.Fatalf("valid alignment: %d", got)
	}
	state, head, err = StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	for i, bad := range []struct {
		block      collab.OpID
		key, value string
	}{
		{column.ID, "align", "justify"}, {column.ID, "color", "red"}, {table.ID, "align", "center"}, {code.ID, "align", "center"}, {collab.OpID{Client: 0, Clock: 1}, "align", "center"},
	} {
		op := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: uint64(owner), Clock: state.Clock() + 1}, Block: bad.block, Key: bad.key, Value: &bad.value}
		if got := do(fmt.Sprintf("%032x", i+2), head, op); got != http.StatusBadRequest {
			t.Fatalf("invalid alignment %d: %d", i, got)
		}
	}
	// A concurrent write after the snapshot makes the conditional inverse fail;
	// the peer's winning value must remain intact.
	right, left := "right", "left"
	peer := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: uint64(remote), Clock: state.Clock() + 1}, Block: column.ID, Key: "align", Value: &right}
	peerBytes, _ := collab.EncodeOps([]collab.Op{peer})
	if _, err := st.AppendOps(ctx, doc.ID, []store.RawOp{{ClientID: remote, Clock: int64(peer.ID.Clock), Bytes: peerBytes}}); err != nil {
		t.Fatal(err)
	}
	inverse := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: uint64(owner), Clock: state.Clock() + 2}, Block: column.ID, Key: "align", Value: &left}
	if got := do("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", head, inverse); got != http.StatusConflict {
		t.Fatalf("stale inverse: %d", got)
	}
	if got := do("11111111111111111111111111111111", head-1, set); got != http.StatusOK {
		t.Fatalf("idempotent retry: %d", got)
	}
	actual, finalHead, err := StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if finalHead != head+1 {
		t.Fatalf("unexpected head: %d", finalHead)
	}
	found := false
	for _, block := range actual.View().Blocks {
		if block.ID == column.ID.Key() {
			if block.Props["align"] != "right" {
				t.Fatalf("peer alignment lost: %q", block.Props["align"])
			}
			found = true
		}
	}
	if !found {
		t.Fatal("column missing")
	}
	for i, value := range []string{"", "left", "right"} {
		op := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: uint64(owner), Clock: actual.Clock() + 1}, Block: column.ID, Key: "align", Value: &value}
		if got := do(fmt.Sprintf("%032x", i+100), finalHead, op); got != http.StatusOK {
			t.Fatalf("valid value %q: %d", value, got)
		}
		actual, finalHead, err = StateAtHead(ctx, st, doc.ID)
		if err != nil {
			t.Fatal(err)
		}
	}
	widths := fmt.Sprintf(`{"%s":1400}`, column.ID.Key())
	widthOp := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: uint64(owner), Clock: actual.Clock() + 1}, Block: columns.ID, Key: "columnWidths", Value: &widths}
	if got := do("cccccccccccccccccccccccccccccccc", finalHead, widthOp); got != http.StatusOK {
		t.Fatalf("valid column widths: %d", got)
	}
	actual, finalHead, err = StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	widthOp.ID.Clock = actual.Clock() + 1
	widthOp.Block = column.ID
	if got := do("dddddddddddddddddddddddddddddddd", finalHead, widthOp); got != http.StatusBadRequest {
		t.Fatalf("width on paragraph: %d", got)
	}
	move := collab.Op{T: collab.TBlockMove, ID: collab.OpID{Client: uint64(owner), Clock: actual.Clock() + 1}, Block: column.ID, Parent: columns.ID, Pos: "z"}
	if got := do("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", finalHead, move); got != http.StatusOK {
		t.Fatalf("valid column move: %d", got)
	}
	actual, finalHead, err = StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	for i, bad := range []collab.Op{
		{T: collab.TBlockMove, ID: collab.OpID{Client: uint64(owner), Clock: actual.Clock() + 1}, Block: column.ID, Parent: collab.Root, Pos: "A"},
		{T: collab.TBlockMove, ID: collab.OpID{Client: uint64(owner), Clock: actual.Clock() + 1}, Block: table.ID, Parent: columns.ID, Pos: "A"},
		{T: collab.TBlockMove, ID: collab.OpID{Client: uint64(owner), Clock: actual.Clock() + 1}, Block: column.ID, Parent: columns.ID, Pos: "k"},
		{T: collab.TBlockMove, ID: collab.OpID{Client: uint64(owner), Clock: actual.Clock() + 1}, Block: column.ID, Parent: columns.ID, Pos: "A0"},
	} {
		if got := do(fmt.Sprintf("%032x", i+200), finalHead, bad); got != http.StatusBadRequest {
			t.Fatalf("invalid move %d: %d", i, got)
		}
	}
	tableValue := `[140,180.25,null]`
	tableOp := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: uint64(owner), Clock: actual.Clock() + 1}, Block: table.ID, Key: "tableWidths", Value: &tableValue}
	if got := do("12121212121212121212121212121212", finalHead, tableOp); got != http.StatusOK {
		t.Fatalf("valid table widths: %d", got)
	}
	if got := do("12121212121212121212121212121212", finalHead, tableOp); got != http.StatusOK {
		t.Fatalf("table width idempotent retry: %d", got)
	}
	actual, finalHead, err = StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	tableOp.ID.Clock = actual.Clock() + 1
	tableOp.Block = column.ID
	if got := do("13131313131313131313131313131313", finalHead, tableOp); got != http.StatusBadRequest {
		t.Fatalf("table width on paragraph: %d", got)
	}
	peerWidth := `[160,180.25,null]`
	peerTable := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: uint64(remote), Clock: actual.Clock() + 1}, Block: table.ID, Key: "tableWidths", Value: &peerWidth}
	peerBatch, _ := collab.EncodeOps([]collab.Op{peerTable})
	if _, err := st.AppendOps(ctx, doc.ID, []store.RawOp{{ClientID: remote, Clock: int64(peerTable.ID.Clock), Bytes: peerBatch}}); err != nil {
		t.Fatal(err)
	}
	old := `[100,180.25,null]`
	tableOp.Block, tableOp.Value, tableOp.ID.Clock = table.ID, &old, actual.Clock()+2
	if got := do("14141414141414141414141414141414", finalHead, tableOp); got != http.StatusConflict {
		t.Fatalf("stale table width inverse: %d", got)
	}
	actual, _, err = StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, block := range actual.View().Blocks {
		if block.ID == table.ID.Key() && block.Props["tableWidths"] != peerWidth {
			t.Fatal("peer table width overwritten")
		}
	}
}

func TestConditionalColumnWidthsValidation(t *testing.T) {
	for _, value := range []string{"", "{}", `{"1:2":1400,"0:4":600}`, `{"1:2":1e3}`} {
		if !conditionalColumnWidths(collab.Op{Key: "columnWidths", Value: &value}) {
			t.Fatalf("rejected valid width %q", value)
		}
	}
	for _, value := range []string{"null", "[]", "{", `{"__proto__":1}`, `{"1:2":0}`, `{"1:2":1.5}`, `{"1:2":true}`, `{"1:2":1000000000,"2:3":1}`, `{"9007199254740992:1":1}`} {
		if conditionalColumnWidths(collab.Op{Key: "columnWidths", Value: &value}) {
			t.Fatalf("accepted invalid width %q", value)
		}
	}
}

func TestConditionalTableWidthsValidation(t *testing.T) {
	for _, value := range []string{"", "[]", `[100,null,180.25]`, `[1e3]`} {
		if !conditionalTableWidths(collab.Op{Key: "tableWidths", Value: &value}) {
			t.Fatalf("rejected valid width %q", value)
		}
	}
	for _, value := range []string{"null", "{}", "[", `[0]`, `[-1]`, `[100001]`, `[true]`, `["text"]`, `[1e999]`, `[1] {}`} {
		if conditionalTableWidths(collab.Op{Key: "tableWidths", Value: &value}) {
			t.Fatalf("accepted invalid width %q", value)
		}
	}
}

func TestConditionalAlignment(t *testing.T) { checkConditionalAlignment(t, store.NewMemory()) }

func TestConditionalAlignmentRechecksHeadAtCommit(t *testing.T) {
	ctx := context.Background()
	base := store.NewMemory()
	wrapped := &racingConditionalStore{Store: base, ConditionalOpsCommitter: base}
	ts, client := newTestServer(t, wrapped, nil)
	r := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "conditional-align-race@test.dev", "name": "Tester", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(r.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	r = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "竞争"})
	var doc store.DocMeta
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	owner, _ := base.AllocClient(ctx, me.User.ID, doc.ID)
	remote, _ := base.AllocClient(ctx, me.User.ID, doc.ID)
	epoch, head, err := base.HeadVersion(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	state, _, err := StateAtHead(ctx, base, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	block := collab.OpID{Client: 0, Clock: 2}
	right, center := "right", "center"
	peer := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: uint64(remote), Clock: state.Clock() + 1}, Block: block, Key: "align", Value: &right}
	peerBytes, _ := collab.EncodeOps([]collab.Op{peer})
	wrapped.hook = func(ctx context.Context) error {
		_, err := base.AppendOps(ctx, doc.ID, []store.RawOp{{ClientID: remote, Clock: int64(peer.ID.Clock), Bytes: peerBytes}})
		return err
	}
	local := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: uint64(owner), Clock: state.Clock() + 1}, Block: block, Key: "align", Value: &center}
	batch, _ := collab.EncodeOps([]collab.Op{local})
	body, _ := json.Marshal(conditionalOpsInput{epoch, head, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", batch})
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/docs/"+strconv.FormatInt(doc.ID, 10)+"/conditional-ops", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(me.User.ID, 10))
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("racing alignment: %d", response.StatusCode)
	}
	actual, finalHead, err := StateAtHead(ctx, base, doc.ID)
	if err != nil || finalHead != head+1 {
		t.Fatalf("head %d: %v", finalHead, err)
	}
	for _, value := range actual.View().Blocks {
		if value.ID == block.Key() {
			if value.Props["align"] != "right" {
				t.Fatal("peer alignment was overwritten")
			}
			return
		}
	}
	t.Fatal("paragraph missing")
}

func TestPostgresConditionalAlignment(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	pg, err := store.NewPostgres(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err := migrate.Up(context.Background(), pg.Pool); err != nil {
		t.Fatal(err)
	}
	checkConditionalAlignment(t, pg)
}
