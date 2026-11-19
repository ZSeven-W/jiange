package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/tableadmission"
)

func TestConditionalTableAdmission(t *testing.T) {
	st := store.NewMemory()
	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	postJSON := func(method, path string, body any, headers map[string]string) (*http.Response, []byte) {
		t.Helper()
		b, _ := json.Marshal(body)
		req, err := http.NewRequest(method, ts.URL+path, bytes.NewReader(b))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, raw
	}

	resp, raw := postJSON("POST", "/api/auth/register", map[string]any{
		"email": "tbladm@test.io", "name": "TblAdm", "password": "password123",
	}, nil)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register status=%d body=%s", resp.StatusCode, raw)
	}
	var reg struct {
		User struct {
			ID int64 `json:"id"`
		} `json:"user"`
	}
	_ = json.Unmarshal(raw, &reg)

	resp, raw = postJSON("POST", "/api/docs", map[string]any{"title": "表格富文本准入"}, nil)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create doc status=%d body=%s", resp.StatusCode, raw)
	}
	var docMeta struct {
		ID int64 `json:"id"`
	}
	_ = json.Unmarshal(raw, &docMeta)

	ctx := context.Background()
	cid, err := st.AllocClient(ctx, reg.User.ID, docMeta.ID)
	if err != nil {
		t.Fatal(err)
	}
	headers := map[string]string{"X-Jiange-User-Id": fmt.Sprint(reg.User.ID)}

	// Create a visible table block in the document.
	state0, _, err := StateAtHead(ctx, st, docMeta.ID)
	if err != nil {
		t.Fatal(err)
	}
	clock := state0.Clock() + 10
	nextID := func() collab.OpID {
		clock++
		return collab.OpID{Client: uint64(cid), Clock: clock}
	}
	tableBlock := nextID()
	encTable, _ := collab.EncodeOps([]collab.Op{
		{T: collab.TBlockCreate, ID: tableBlock, Parent: collab.Root, Pos: "M", Type: "table"},
	})
	if _, err := st.AppendOps(ctx, docMeta.ID, []store.RawOp{{ClientID: cid, Clock: int64(tableBlock.Clock), Bytes: encTable}}); err != nil {
		t.Fatal(err)
	}
	epoch, head, _ := st.HeadVersion(ctx, docMeta.ID)

	// 1. Verify tbl.fmt.r0.c0 rich-text formatting property is admitted conditionally.
	fmtVal := `[{"text":"重点","marks":{"bold":true}}]`
	fmtBatch, _ := collab.EncodeOps([]collab.Op{
		{T: collab.TBlockSet, ID: nextID(), Block: tableBlock, Key: "tbl.fmt.r0.c0", Value: &fmtVal},
	})
	resp, raw = postJSON("POST", fmt.Sprintf("/api/docs/%d/conditional-ops", docMeta.ID), map[string]any{
		"historyEpoch": epoch,
		"expectedSeq":  head,
		"requestId":    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"batch":        fmtBatch,
	}, headers)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("tbl.fmt conditional commit status=%d body=%s", resp.StatusCode, raw)
	}
	epoch, head, _ = st.HeadVersion(ctx, docMeta.ID)

	// 2. Bootstrap formal CRDT table ops (insert-row, insert-column, text-insert, text-mark) via tableadmission!
	makeFrame := func(id collab.OpID, inner map[string]any) collab.Op {
		inner["id"] = map[string]any{"client": id.Client, "clock": id.Clock}
		payload, _ := json.Marshal(inner)
		return collab.Op{T: collab.TTable, ID: id, Block: tableBlock, Payload: payload}
	}
	rowID := nextID()
	colID := nextID()
	charID := nextID()
	markID := nextID()
	bootstrapOps := []collab.Op{
		makeFrame(rowID, map[string]any{"kind": "axis-insert", "axis": "row", "after": nil}),
		makeFrame(colID, map[string]any{"kind": "axis-insert", "axis": "column", "after": nil}),
		makeFrame(charID, map[string]any{
			"kind":   "text-insert",
			"row":    map[string]any{"client": rowID.Client, "clock": rowID.Clock},
			"column": map[string]any{"client": colID.Client, "clock": colID.Clock},
			"after":  nil,
			"char":   "A",
		}),
		makeFrame(markID, map[string]any{
			"kind":   "text-mark",
			"row":    map[string]any{"client": rowID.Client, "clock": rowID.Clock},
			"column": map[string]any{"client": colID.Client, "clock": colID.Clock},
			"target": map[string]any{"client": charID.Client, "clock": charID.Clock},
			"key":    "bold",
			"value":  "1",
		}),
	}
	bootstrapBatch, _ := collab.EncodeOps(bootstrapOps)
	resp, raw = postJSON("POST", fmt.Sprintf("/api/docs/%d/conditional-ops", docMeta.ID), map[string]any{
		"historyEpoch": epoch,
		"expectedSeq":  head,
		"requestId":    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"batch":        bootstrapBatch,
	}, headers)
	if resp.StatusCode != http.StatusOK {
		st2, _, _ := StateAtHead(ctx, st, docMeta.ID)
		stored, _ := st.OpsAfter(ctx, docMeta.ID, 0, int(head)+1)
		recs := make([]tableadmission.Record, len(stored))
		for i, r := range stored {
			recs[i] = tableadmission.Record{Seq: r.Seq, Data: r.Bytes}
		}
		proj, perr := tableadmission.RebuildOrInit(st2, head, tableBlock, recs)
		var berr error
		if proj != nil {
			_, berr = proj.PrepareBatch(uint64(cid), bootstrapOps)
		}
		t.Fatalf("formal CRDT table bootstrap status=%d body=%s docClock=%d stored=%d head=%d perr=%v berr=%v", resp.StatusCode, raw, st2.Clock(), len(stored), head, perr, berr)
	}
	epoch, head, _ = st.HeadVersion(ctx, docMeta.ID)

	// 3. Stale head ttable batch must be rejected with 409.
	markID2 := nextID()
	mark2Batch, _ := collab.EncodeOps([]collab.Op{
		makeFrame(markID2, map[string]any{
			"kind":   "text-mark",
			"row":    map[string]any{"client": rowID.Client, "clock": rowID.Clock},
			"column": map[string]any{"client": colID.Client, "clock": colID.Clock},
			"target": map[string]any{"client": charID.Client, "clock": charID.Clock},
			"key":    "italic",
			"value":  "1",
		}),
	})
	resp, raw = postJSON("POST", fmt.Sprintf("/api/docs/%d/conditional-ops", docMeta.ID), map[string]any{
		"historyEpoch": epoch,
		"expectedSeq":  head - 1,
		"requestId":    "cccccccccccccccccccccccccccccccc",
		"batch":        mark2Batch,
	}, headers)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("stale head ttable status=%d want 409 body=%s", resp.StatusCode, raw)
	}

	// 4. Current head ttable batch succeeds with 200.
	resp, raw = postJSON("POST", fmt.Sprintf("/api/docs/%d/conditional-ops", docMeta.ID), map[string]any{
		"historyEpoch": epoch,
		"expectedSeq":  head,
		"requestId":    "dddddddddddddddddddddddddddddddd",
		"batch":        mark2Batch,
	}, headers)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("valid follow-up ttable mark status=%d body=%s", resp.StatusCode, raw)
	}
}
