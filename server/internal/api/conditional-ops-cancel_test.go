package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
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

func cancelAPIDigest(epoch, head int64, ops []collab.Op) string {
	h := sha256.New()
	var word [8]byte
	put := func(n uint64) { binary.BigEndian.PutUint64(word[:], n); _, _ = h.Write(word[:]) }
	put(uint64(epoch))
	put(uint64(head))
	put(uint64(len(ops)))
	for _, op := range ops {
		encoded, _ := collab.EncodeOps([]collab.Op{op})
		put(op.ID.Client)
		put(op.ID.Clock)
		put(uint64(len(encoded)))
		_, _ = h.Write(encoded)
	}
	return hex.EncodeToString(h.Sum(nil))
}
func checkConditionalCancelAPI(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	ts, client := newTestServer(t, st, nil, true)
	resp := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "cancel-api@test.dev", "name": "Owner", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	resp = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "目标计划"})
	var doc store.DocMeta
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
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
	op := state.InsertText(uint64(replica), collab.OpID{Client: 0, Clock: 2}, 0, "保密内容")
	ops := []collab.Op{op}
	batch, _ := collab.EncodeOps(ops)
	request := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	input := conditionalCancelInput{Epoch: epoch, Head: head, Count: 1, ClientID: replica, Digest: cancelAPIDigest(epoch, head, ops)}
	url := fmt.Sprintf("%s/api/docs/%d/conditional-ops/%s/cancel", ts.URL, doc.ID, request)
	sendCancel := func(account string, value any) (int, store.ConditionalOpsStatus) {
		t.Helper()
		raw, _ := json.Marshal(value)
		req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		if account != "" {
			req.Header.Set("X-Jiange-User-Id", account)
		}
		r, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer r.Body.Close()
		var status store.ConditionalOpsStatus
		_ = json.NewDecoder(r.Body).Decode(&status)
		if r.Header.Get("Cache-Control") != "private, no-store" {
			t.Fatalf("cache: %q", r.Header.Get("Cache-Control"))
		}
		return r.StatusCode, status
	}
	account := strconv.FormatInt(me.User.ID, 10)
	disabled, disabledClient := newTestServer(t, st, nil)
	disabledClient.Jar = client.Jar
	requestBody, _ := json.Marshal(input)
	disabledRequest, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/docs/%d/conditional-ops/%s/cancel", disabled.URL, doc.ID, request), bytes.NewReader(requestBody))
	disabledRequest.Header.Set("Content-Type", "application/json")
	disabledRequest.Header.Set("X-Jiange-User-Id", account)
	disabledResponse, err := disabledClient.Do(disabledRequest)
	if err != nil {
		t.Fatal(err)
	}
	var disabledResult struct {
		Error string `json:"error"`
	}
	if err := json.NewDecoder(disabledResponse.Body).Decode(&disabledResult); err != nil {
		t.Fatal(err)
	}
	disabledResponse.Body.Close()
	if disabledResponse.StatusCode != http.StatusServiceUnavailable || disabledResult.Error != "conditional_cancel_disabled" {
		t.Fatalf("disabled cancellation: %d %+v", disabledResponse.StatusCode, disabledResult)
	}
	checkRequest, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/api/docs/%d/conditional-ops/%s", ts.URL, doc.ID, request), nil)
	checkRequest.Header.Set("X-Jiange-User-Id", account)
	checkResponse, err := client.Do(checkRequest)
	if err != nil {
		t.Fatal(err)
	}
	var existing store.ConditionalOpsStatus
	if err := json.NewDecoder(checkResponse.Body).Decode(&existing); err != nil {
		t.Fatal(err)
	}
	checkResponse.Body.Close()
	if checkResponse.StatusCode != http.StatusOK || existing.State != "unknown" {
		t.Fatalf("disabled endpoint must not create fence: %d %+v", checkResponse.StatusCode, existing)
	}
	if code, _ := sendCancel("", input); code != 400 {
		t.Fatalf("missing account %d", code)
	}
	if code, _ := sendCancel("999999", input); code != 401 {
		t.Fatalf("wrong account %d", code)
	}
	invalid := input
	invalid.Digest = "not-a-digest"
	if code, _ := sendCancel(account, invalid); code != 400 {
		t.Fatalf("invalid digest %d", code)
	}
	code, status := sendCancel(account, input)
	if code != 200 || status.State != "cancelled" || status.ClientID != replica || status.Digest != input.Digest {
		t.Fatalf("cancel %d %+v", code, status)
	}
	code, status = sendCancel(account, input)
	if code != 200 || status.State != "cancelled" {
		t.Fatalf("retry %d %+v", code, status)
	}
	get, err := client.Get(fmt.Sprintf("%s/api/docs/%d/conditional-ops/%s", ts.URL, doc.ID, request))
	if err != nil {
		t.Fatal(err)
	}
	var confirmed store.ConditionalOpsStatus
	_ = json.NewDecoder(get.Body).Decode(&confirmed)
	get.Body.Close()
	if get.StatusCode != 400 {
		t.Fatalf("missing status account %d", get.StatusCode)
	}
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/api/docs/%d/conditional-ops/%s", ts.URL, doc.ID, request), nil)
	req.Header.Set("X-Jiange-User-Id", account)
	get, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = json.NewDecoder(get.Body).Decode(&confirmed)
	get.Body.Close()
	if get.StatusCode != 200 || confirmed.State != "cancelled" {
		t.Fatalf("status %d %+v", get.StatusCode, confirmed)
	}
	raw, _ := json.Marshal(conditionalOpsInput{Epoch: epoch, Head: head, RequestID: request, Batch: batch})
	req, _ = http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/docs/%d/conditional-ops", ts.URL, doc.ID), bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Jiange-User-Id", account)
	late, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	late.Body.Close()
	if late.StatusCode != 409 {
		t.Fatalf("late commit %d", late.StatusCode)
	}
	_, actualHead, err := st.HeadVersion(ctx, doc.ID)
	if err != nil || actualHead != head {
		t.Fatalf("cancel changed content head=%d %v", actualHead, err)
	}
	// If commit wins the race, stopping returns its receipt and never reverts content.
	request = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	url = fmt.Sprintf("%s/api/docs/%d/conditional-ops/%s/cancel", ts.URL, doc.ID, request)
	raw, _ = json.Marshal(conditionalOpsInput{Epoch: epoch, Head: head, RequestID: request, Batch: batch})
	req, _ = http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/docs/%d/conditional-ops", ts.URL, doc.ID), bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Jiange-User-Id", account)
	committed, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	committed.Body.Close()
	if committed.StatusCode != 200 {
		t.Fatalf("commit %d", committed.StatusCode)
	}
	code, status = sendCancel(account, input)
	if code != 200 || status.State != "committed" {
		t.Fatalf("already committed %d %+v", code, status)
	}
}
func TestMemoryConditionalCancelAPI(t *testing.T) { checkConditionalCancelAPI(t, store.NewMemory()) }
func TestPostgresConditionalCancelAPI(t *testing.T) {
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
	checkConditionalCancelAPI(t, pg)
}
