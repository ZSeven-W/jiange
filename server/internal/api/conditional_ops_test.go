package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
	"strconv"
	"sync"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func checkConditionalOpsAPI(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	ts, client := newTestServer(t, st, nil)
	response := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "conditional-api@test.dev", "name": "Tester", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(response.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	response = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "条件提交"})
	var doc store.DocMeta
	if err := json.NewDecoder(response.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	replica, err := st.AllocClient(ctx, me.User.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	epoch, head, err := st.HeadVersion(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	state, _, err := StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	op := state.InsertText(uint64(replica), collab.OpID{Client: 0, Clock: 2}, 0, "目标")
	batch, err := collab.EncodeOps([]collab.Op{op})
	if err != nil {
		t.Fatal(err)
	}
	url := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10) + "/conditional-ops"
	type input struct {
		Epoch   int64  `json:"historyEpoch"`
		Head    int64  `json:"expectedSeq"`
		Request string `json:"requestId"`
		Batch   []byte `json:"batch"`
	}
	request := input{epoch, head, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", batch}
	do := func(account string, body any) (int, []byte) {
		t.Helper()
		raw, _ := json.Marshal(body)
		req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		if account != "" {
			req.Header.Set("X-Jiange-User-Id", account)
		}
		r, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		bodyBytes, _ := io.ReadAll(r.Body)
		return r.StatusCode, bodyBytes
	}
	account := strconv.FormatInt(me.User.ID, 10)
	if status, _ := do("", request); status != http.StatusBadRequest {
		t.Fatalf("missing account: %d", status)
	}
	if status, _ := do(strconv.FormatInt(me.User.ID+1, 10), request); status != http.StatusUnauthorized {
		t.Fatalf("wrong account: %d", status)
	}
	status, body := do(account, request)
	var receipt struct {
		Sequences []int64 `json:"sequences"`
	}
	if status != http.StatusOK || json.Unmarshal(body, &receipt) != nil || len(receipt.Sequences) != 1 || receipt.Sequences[0] != head+1 {
		t.Fatalf("commit: %d %s", status, body)
	}
	actual, newHead, err := StateAtHead(ctx, st, doc.ID)
	if err != nil || newHead != head+1 || actual.Text(collab.OpID{Client: 0, Clock: 2}) != "目标" {
		t.Fatalf("committed state: %d %v", newHead, err)
	}
	other := actual.InsertText(uint64(replica), collab.OpID{Client: 0, Clock: 2}, 2, "后")
	encoded, _ := collab.EncodeOps([]collab.Op{other})
	if _, err = st.AppendOps(ctx, doc.ID, []store.RawOp{{ClientID: replica, Clock: int64(other.ID.Clock), Bytes: encoded}}); err != nil {
		t.Fatal(err)
	}
	status, body = do(account, request)
	var retry struct {
		Sequences []int64 `json:"sequences"`
	}
	if status != http.StatusOK || json.Unmarshal(body, &retry) != nil || len(retry.Sequences) != 1 || retry.Sequences[0] != receipt.Sequences[0] {
		t.Fatalf("idempotent retry: %d %s", status, body)
	}
	changed := request
	changed.Batch = encoded
	if status, _ = do(account, changed); status != http.StatusConflict {
		t.Fatalf("changed payload: %d", status)
	}

	// A replica assigned to another account cannot author a conditional batch.
	otherUser, _, err := st.CreateUser(ctx, "conditional-foreign@test.dev", "Other", "hash")
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := st.AllocClient(ctx, otherUser.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	foreignOp := actual.InsertText(uint64(foreign), collab.OpID{Client: 0, Clock: 2}, 0, "外")
	foreignBytes, _ := collab.EncodeOps([]collab.Op{foreignOp})
	bad := input{epoch, head + 2, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", foreignBytes}
	if status, _ = do(account, bad); status != http.StatusForbidden {
		t.Fatalf("foreign author: %d", status)
	}

	// Invalid targets, unsupported structural operations, and stale heads do not write.
	invalid := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: uint64(replica), Clock: actual.Clock() + 1}, Block: collab.OpID{Client: 88, Clock: 1}, Parent: collab.Root, Side: 1, Text: "x"}
	invalidBytes, _ := collab.EncodeOps([]collab.Op{invalid})
	bad.Batch, bad.Request = invalidBytes, "cccccccccccccccccccccccccccccccc"
	if status, _ = do(account, bad); status != http.StatusBadRequest {
		t.Fatalf("invalid target: %d", status)
	}
	missing := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: uint64(replica), Clock: actual.Clock() + 1}, Block: collab.OpID{Client: 0, Clock: 2}, Parent: collab.OpID{Client: 77, Clock: 1}, Side: 1, Text: "x"}
	bad.Batch, _ = collab.EncodeOps([]collab.Op{missing})
	bad.Request = "cccccccccccccccccccccccccccccccd"
	if status, _ = do(account, bad); status != http.StatusConflict {
		t.Fatalf("missing dependency: %d", status)
	}
	structural := actual.CreateBlock(uint64(replica), collab.Root, "Z", "paragraph")
	bad.Batch, _ = collab.EncodeOps([]collab.Op{structural})
	bad.Request = "dddddddddddddddddddddddddddddddd"
	if status, _ = do(account, bad); status != http.StatusBadRequest {
		t.Fatalf("structural operation: %d", status)
	}
	bad = input{epoch, head, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", batch}
	if status, _ = do(account, bad); status != http.StatusConflict {
		t.Fatalf("stale head: %d", status)
	}
	if current, err := st.Head(ctx, doc.ID); err != nil || current != head+2 {
		t.Fatalf("invalid request wrote operations: %d %v", current, err)
	}
	if err = st.BumpHistoryEpoch(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	if status, _ = do(account, request); status != http.StatusConflict {
		t.Fatalf("receipt from old epoch: %d", status)
	}
}

func TestConditionalOpsAPI(t *testing.T) { checkConditionalOpsAPI(t, store.NewMemory()) }

func TestPostgresConditionalOpsAPI(t *testing.T) {
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
	checkConditionalOpsAPI(t, pg)
}

func checkConditionalOpsConcurrentRetry(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	ts, client := newTestServer(t, st, nil)
	response := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "conditional-race@test.dev", "name": "Tester", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	_ = json.NewDecoder(response.Body).Decode(&me)
	response.Body.Close()
	response = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "并发"})
	var doc store.DocMeta
	_ = json.NewDecoder(response.Body).Decode(&doc)
	response.Body.Close()
	replica, _ := st.AllocClient(ctx, me.User.ID, doc.ID)
	epoch, head, _ := st.HeadVersion(ctx, doc.ID)
	state, _, _ := StateAtHead(ctx, st, doc.ID)
	op := state.InsertText(uint64(replica), collab.OpID{Client: 0, Clock: 2}, 0, "一次")
	batch, _ := collab.EncodeOps([]collab.Op{op})
	raw, _ := json.Marshal(conditionalOpsInput{epoch, head, "ffffffffffffffffffffffffffffffff", batch})
	url := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10) + "/conditional-ops"
	start := make(chan struct{})
	out := make(chan int, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(me.User.ID, 10))
			r, err := client.Do(req)
			if err != nil {
				out <- 0
				return
			}
			io.Copy(io.Discard, r.Body)
			r.Body.Close()
			out <- r.StatusCode
		}()
	}
	close(start)
	wg.Wait()
	close(out)
	for status := range out {
		if status != http.StatusOK {
			t.Fatalf("concurrent request: %d", status)
		}
	}
	if actual, err := st.Head(ctx, doc.ID); err != nil || actual != head+1 {
		t.Fatalf("duplicate commit: %d %v", actual, err)
	}
	state, nextHead, err := StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	other, err := collab.DecodeState(state.EncodeState())
	if err != nil {
		t.Fatal(err)
	}
	a := state.InsertText(uint64(replica), collab.OpID{Client: 0, Clock: 2}, 2, "甲")
	b := other.InsertText(uint64(replica), collab.OpID{Client: 0, Clock: 2}, 2, "乙")
	aBytes, _ := collab.EncodeOps([]collab.Op{a})
	bBytes, _ := collab.EncodeOps([]collab.Op{b})
	variants := make([][]byte, 2)
	for i, value := range [][]byte{aBytes, bBytes} {
		variants[i], _ = json.Marshal(conditionalOpsInput{epoch, nextHead, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", value})
	}
	start = make(chan struct{})
	out = make(chan int, 2)
	for i := range variants {
		wg.Add(1)
		go func(raw []byte) {
			defer wg.Done()
			<-start
			req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(me.User.ID, 10))
			r, err := client.Do(req)
			if err != nil {
				out <- 0
				return
			}
			io.Copy(io.Discard, r.Body)
			r.Body.Close()
			out <- r.StatusCode
		}(variants[i])
	}
	close(start)
	wg.Wait()
	close(out)
	var okCount, conflicts int
	for status := range out {
		if status == http.StatusOK {
			okCount++
		} else if status == http.StatusConflict {
			conflicts++
		} else {
			t.Fatalf("different concurrent bodies: %d", status)
		}
	}
	if okCount != 1 || conflicts != 1 {
		t.Fatalf("different body results: ok=%d conflicts=%d", okCount, conflicts)
	}
	if actual, err := st.Head(ctx, doc.ID); err != nil || actual != nextHead+1 {
		t.Fatalf("different bodies changed head: %d %v", actual, err)
	}
}

func TestConditionalOpsConcurrentRetry(t *testing.T) {
	checkConditionalOpsConcurrentRetry(t, store.NewMemory())
}

func TestPostgresConditionalOpsConcurrentRetry(t *testing.T) {
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
	checkConditionalOpsConcurrentRetry(t, pg)
}

func TestConditionalOpsTableProperties(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	ts, client := newTestServer(t, st, nil)
	r := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "conditional-table@test.dev", "name": "Tester", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	_ = json.NewDecoder(r.Body).Decode(&me)
	r.Body.Close()
	r = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "表格"})
	var doc store.DocMeta
	_ = json.NewDecoder(r.Body).Decode(&doc)
	r.Body.Close()
	replica, _ := st.AllocClient(ctx, me.User.ID, doc.ID)
	state, _, _ := StateAtHead(ctx, st, doc.ID)
	table := state.CreateBlock(uint64(replica), collab.Root, "X", "table")
	rawTable, _ := collab.EncodeOps([]collab.Op{table})
	if _, err := st.AppendOps(ctx, doc.ID, []store.RawOp{{ClientID: replica, Clock: int64(table.ID.Clock), Bytes: rawTable}}); err != nil {
		t.Fatal(err)
	}
	epoch, head, _ := st.HeadVersion(ctx, doc.ID)
	state, _, _ = StateAtHead(ctx, st, doc.ID)
	value := `[["目标"]]`
	set := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: uint64(replica), Clock: state.Clock() + 1}, Block: table.ID, Key: "tableData", Value: &value}
	batch, _ := collab.EncodeOps([]collab.Op{set})
	do := func(input conditionalOpsInput) int {
		t.Helper()
		body, _ := json.Marshal(input)
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/docs/"+strconv.FormatInt(doc.ID, 10)+"/conditional-ops", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(me.User.ID, 10))
		r, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		return r.StatusCode
	}
	if status := do(conditionalOpsInput{epoch, head, "11112222333344445555666677778888", batch}); status != http.StatusOK {
		t.Fatalf("table property: %d", status)
	}
	current, currentHead, err := StateAtHead(ctx, st, doc.ID)
	if err != nil || currentHead != head+1 {
		t.Fatalf("table state: %d %v", currentHead, err)
	}
	var found bool
	for _, block := range current.View().Blocks {
		if block.ID == table.ID.Key() && block.Props["tableData"] == value {
			found = true
		}
	}
	if !found {
		t.Fatal("table value not committed")
	}
	for i, bad := range []collab.Op{
		{T: collab.TBlockSet, ID: collab.OpID{Client: uint64(replica), Clock: current.Clock() + 1}, Block: table.ID, Key: "type", Value: &value},
		{T: collab.TBlockSet, ID: collab.OpID{Client: uint64(replica), Clock: current.Clock() + 1}, Block: collab.OpID{Client: 0, Clock: 2}, Key: "tableData", Value: &value},
	} {
		badBatch, _ := collab.EncodeOps([]collab.Op{bad})
		if status := do(conditionalOpsInput{epoch, currentHead, []string{"22222222333344445555666677778888", "33332222333344445555666677778888"}[i], badBatch}); status != http.StatusBadRequest {
			t.Fatalf("invalid table op %d: %d", i, status)
		}
	}
	if actual, err := st.Head(ctx, doc.ID); err != nil || actual != currentHead {
		t.Fatalf("invalid table request changed head: %d %v", actual, err)
	}
}

type racingConditionalStore struct {
	store.Store
	store.ConditionalOpsCommitter
	once sync.Once
	hook func(context.Context) error
	err  error
}

func (s *racingConditionalStore) CommitConditionalOps(ctx context.Context, guard store.RestoreGuard, doc, epoch, head int64, request string, ops []store.RawOp) ([]int64, error) {
	s.once.Do(func() { s.err = s.hook(ctx) })
	if s.err != nil {
		return nil, s.err
	}
	return s.ConditionalOpsCommitter.CommitConditionalOps(ctx, guard, doc, epoch, head, request, ops)
}

func TestConditionalOpsRejectsChangesAtCommit(t *testing.T) {
	for _, kind := range []string{"append", "epoch"} {
		t.Run(kind, func(t *testing.T) {
			ctx := context.Background()
			base := store.NewMemory()
			wrapped := &racingConditionalStore{Store: base, ConditionalOpsCommitter: base}
			ts, client := newTestServer(t, wrapped, nil)
			r := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "conditional-commit-" + kind + "@test.dev", "name": "Tester", "password": "password123"})
			var me struct {
				User store.User `json:"user"`
			}
			_ = json.NewDecoder(r.Body).Decode(&me)
			r.Body.Close()
			r = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "竞争"})
			var doc store.DocMeta
			_ = json.NewDecoder(r.Body).Decode(&doc)
			r.Body.Close()
			replica, _ := base.AllocClient(ctx, me.User.ID, doc.ID)
			remote, _ := base.AllocClient(ctx, me.User.ID, doc.ID)
			epoch, head, _ := base.HeadVersion(ctx, doc.ID)
			state, _, _ := StateAtHead(ctx, base, doc.ID)
			remoteState, err := collab.DecodeState(state.EncodeState())
			if err != nil {
				t.Fatal(err)
			}
			remoteOp := remoteState.InsertText(uint64(remote), collab.OpID{Client: 0, Clock: 2}, 0, "远")
			remoteBytes, _ := collab.EncodeOps([]collab.Op{remoteOp})
			wrapped.hook = func(ctx context.Context) error {
				if kind == "epoch" {
					return base.BumpHistoryEpoch(ctx, doc.ID)
				}
				_, err := base.AppendOps(ctx, doc.ID, []store.RawOp{{ClientID: remote, Clock: int64(remoteOp.ID.Clock), Bytes: remoteBytes}})
				return err
			}
			localOp := state.InsertText(uint64(replica), collab.OpID{Client: 0, Clock: 2}, 0, "本")
			batch, _ := collab.EncodeOps([]collab.Op{localOp})
			raw, _ := json.Marshal(conditionalOpsInput{epoch, head, "1234567890abcdef1234567890abcdef", batch})
			req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/docs/"+strconv.FormatInt(doc.ID, 10)+"/conditional-ops", bytes.NewReader(raw))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(me.User.ID, 10))
			r, err = client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer r.Body.Close()
			if r.StatusCode != http.StatusConflict {
				body, _ := io.ReadAll(r.Body)
				t.Fatalf("status %d: %s", r.StatusCode, body)
			}
			actual, newHead, err := StateAtHead(ctx, base, doc.ID)
			if err != nil {
				t.Fatal(err)
			}
			want := ""
			if kind == "append" {
				want = "远"
				head++
			}
			if newHead != head || actual.Text(collab.OpID{Client: 0, Clock: 2}) != want {
				t.Fatalf("unexpected state: head=%d text=%q", newHead, actual.Text(collab.OpID{Client: 0, Clock: 2}))
			}
		})
	}
}

func TestConditionalOpsRechecksAccessAtCommit(t *testing.T) {
	ctx := context.Background()
	base := store.NewMemory()
	wrapped := &racingConditionalStore{Store: base, ConditionalOpsCommitter: base}
	ts, owner := newTestServer(t, wrapped, nil)
	jar, _ := cookiejar.New(nil)
	editor := &http.Client{Jar: jar}
	r := post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "conditional-owner@test.dev", "name": "Owner", "password": "password123"})
	r.Body.Close()
	r = post(t, editor, ts.URL+"/api/auth/register", map[string]string{"email": "conditional-editor@test.dev", "name": "Editor", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	_ = json.NewDecoder(r.Body).Decode(&me)
	r.Body.Close()
	r = post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "权限"})
	var doc store.DocMeta
	_ = json.NewDecoder(r.Body).Decode(&doc)
	r.Body.Close()
	if err := base.SetShare(ctx, doc.ID, me.User.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	replica, _ := base.AllocClient(ctx, me.User.ID, doc.ID)
	epoch, head, _ := base.HeadVersion(ctx, doc.ID)
	state, _, _ := StateAtHead(ctx, base, doc.ID)
	op := state.InsertText(uint64(replica), collab.OpID{Client: 0, Clock: 2}, 0, "不能提交")
	batch, _ := collab.EncodeOps([]collab.Op{op})
	body, _ := json.Marshal(conditionalOpsInput{epoch, head, "eeeeeeee11111111dddddddd22222222", batch})
	wrapped.hook = func(ctx context.Context) error { return base.SetShare(ctx, doc.ID, me.User.ID, store.RoleView) }
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/docs/"+strconv.FormatInt(doc.ID, 10)+"/conditional-ops", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(me.User.ID, 10))
	r, err := editor.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusForbidden {
		data, _ := io.ReadAll(r.Body)
		t.Fatalf("status %d: %s", r.StatusCode, data)
	}
	actual, newHead, err := StateAtHead(ctx, base, doc.ID)
	if err != nil || newHead != head || actual.Text(collab.OpID{Client: 0, Clock: 2}) != "" {
		t.Fatalf("revoked commit changed state: %d %v", newHead, err)
	}
}

type legacyConditionalStore struct{ store.Store }

func TestConditionalOpsFailsClosedWithoutCapability(t *testing.T) {
	base := store.NewMemory()
	ts, client := newTestServer(t, &legacyConditionalStore{Store: base}, nil)
	r := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "conditional-legacy@test.dev", "name": "Tester", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	_ = json.NewDecoder(r.Body).Decode(&me)
	r.Body.Close()
	r = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "旧服务"})
	var doc store.DocMeta
	_ = json.NewDecoder(r.Body).Decode(&doc)
	r.Body.Close()
	_, head, _ := base.HeadVersion(context.Background(), doc.ID)
	url := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10) + "/conditional-ops"
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader([]byte(`{}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(me.User.ID, 10))
	r, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("legacy capability: %d", r.StatusCode)
	}
	if actual, err := base.Head(context.Background(), doc.ID); err != nil || actual != head {
		t.Fatalf("legacy path changed head: %d %v", actual, err)
	}
}
