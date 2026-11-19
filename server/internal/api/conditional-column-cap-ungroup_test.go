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
)

func TestConditionalColumnCapAndUngroup(t *testing.T) {
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
		"email": "colcap@test.io", "name": "ColCap", "password": "password123",
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

	resp, raw = postJSON("POST", "/api/docs", map[string]any{"title": "分栏测试"}, nil)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create doc status=%d body=%s", resp.StatusCode, raw)
	}
	var docMeta struct {
		ID int64 `json:"id"`
	}
	_ = json.Unmarshal(raw, &docMeta)

	// Register a client ID for this user & doc.
	ctx := context.Background()
	cid, err := st.AllocClient(ctx, reg.User.ID, docMeta.ID)
	if err != nil {
		t.Fatal(err)
	}
	epoch, head, err := st.HeadVersion(ctx, docMeta.ID)
	if err != nil {
		t.Fatal(err)
	}

	// Append a root-level columns container with 2 initial columns via store ops.
	d := collab.NewDoc()
	var clock uint64 = 10
	nextID := func() collab.OpID {
		clock++
		return collab.OpID{Client: uint64(cid), Clock: clock}
	}
	groupID := nextID()
	col1ID := nextID()
	col2ID := nextID()
	nestedID := nextID()
	initOps := []collab.Op{
		{T: collab.TBlockCreate, ID: groupID, Parent: collab.Root, Pos: "M", Type: "columns"},
		{T: collab.TBlockCreate, ID: col1ID, Parent: groupID, Pos: "A", Type: "paragraph"},
		{T: collab.TBlockCreate, ID: col2ID, Parent: groupID, Pos: "B", Type: "paragraph"},
		{T: collab.TBlockCreate, ID: nestedID, Parent: col1ID, Pos: "A", Type: "h2"},
	}
	for _, op := range initOps {
		d.Apply(op)
		enc, _ := collab.EncodeOps([]collab.Op{op})
		if _, err := st.AppendOps(ctx, docMeta.ID, []store.RawOp{{ClientID: cid, Clock: int64(op.ID.Clock), Bytes: enc}}); err != nil {
			t.Fatal(err)
		}
	}
	epoch, head, _ = st.HeadVersion(ctx, docMeta.ID)
	headers := map[string]string{"X-Jiange-User-Id": fmt.Sprint(reg.User.ID)}

	// Add 8 more columns conditionally (bringing total to MaxColumns = 10).
	posList := []string{"C", "D", "E", "F", "G", "H", "I", "J"}
	for idx, pos := range posList {
		newColID := nextID()
		flagID := nextID()
		one := "1"
		batch, _ := collab.EncodeOps([]collab.Op{
			{T: collab.TBlockCreate, ID: newColID, Parent: groupID, Pos: pos, Type: "paragraph"},
			{T: collab.TBlockSet, ID: flagID, Block: newColID, Key: "_column_created", Value: &one},
		})
		resp, raw = postJSON("POST", fmt.Sprintf("/api/docs/%d/conditional-ops", docMeta.ID), map[string]any{
			"historyEpoch": epoch,
			"expectedSeq":  head,
			"requestId":    fmt.Sprintf("1111111111111111111111111111%04d", idx+1),
			"batch":        batch,
		}, headers)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("add col %d status=%d body=%s", idx+3, resp.StatusCode, raw)
		}
		epoch, head, _ = st.HeadVersion(ctx, docMeta.ID)
	}

	// Attempting to add an 11th column must be rejected with 400 column_limit!
	eleventhID := nextID()
	batch11, _ := collab.EncodeOps([]collab.Op{
		{T: collab.TBlockCreate, ID: eleventhID, Parent: groupID, Pos: "K", Type: "paragraph"},
	})
	resp, raw = postJSON("POST", fmt.Sprintf("/api/docs/%d/conditional-ops", docMeta.ID), map[string]any{
		"historyEpoch": epoch,
		"expectedSeq":  head,
		"requestId":    "11111111111111111111111111110099",
		"batch":        batch11,
	}, headers)
	if resp.StatusCode != http.StatusBadRequest || !bytes.Contains(raw, []byte("column_limit")) {
		t.Fatalf("expected 400 column_limit for 11th column, got status=%d body=%s", resp.StatusCode, raw)
	}

	// Conditional column move succeeds at current head, and rejects stale head with 409.
	moveID := nextID()
	moveBatch, _ := collab.EncodeOps([]collab.Op{
		{T: collab.TBlockMove, ID: moveID, Block: col2ID, Parent: groupID, Pos: "Aa"},
	})
	resp, raw = postJSON("POST", fmt.Sprintf("/api/docs/%d/conditional-ops", docMeta.ID), map[string]any{
		"historyEpoch": epoch,
		"expectedSeq":  head - 1, // stale head
		"requestId":    "22222222222222222222222222220001",
		"batch":        moveBatch,
	}, headers)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 on stale column move, got %d body=%s", resp.StatusCode, raw)
	}
	resp, raw = postJSON("POST", fmt.Sprintf("/api/docs/%d/conditional-ops", docMeta.ID), map[string]any{
		"historyEpoch": epoch,
		"expectedSeq":  head,
		"requestId":    "22222222222222222222222222220002",
		"batch":        moveBatch,
	}, headers)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on conditional column move, got %d body=%s", resp.StatusCode, raw)
	}
	epoch, head, _ = st.HeadVersion(ctx, docMeta.ID)

	// Conditional ungroup on a fresh 2-column group promotes both columns to Root and archives the container.
	g2 := nextID()
	g2c1 := nextID()
	g2c2 := nextID()
	for _, op := range []collab.Op{
		{T: collab.TBlockCreate, ID: g2, Parent: collab.Root, Pos: "N", Type: "columns"},
		{T: collab.TBlockCreate, ID: g2c1, Parent: g2, Pos: "A", Type: "paragraph"},
		{T: collab.TBlockCreate, ID: g2c2, Parent: g2, Pos: "B", Type: "paragraph"},
	} {
		enc, _ := collab.EncodeOps([]collab.Op{op})
		if _, err := st.AppendOps(ctx, docMeta.ID, []store.RawOp{{ClientID: cid, Clock: int64(op.ID.Clock), Bytes: enc}}); err != nil {
			t.Fatal(err)
		}
	}
	epoch, head, _ = st.HeadVersion(ctx, docMeta.ID)

	archID := nextID()
	delID := nextID()
	metaID := nextID()
	gMoveID := nextID()
	metaVal := fmt.Sprintf("v1|%s|%s|%s", collab.Root.Key(), "N", archID.Key())
	ungroupOps := []collab.Op{
		{T: collab.TBlockMove, ID: nextID(), Block: g2c1, Parent: collab.Root, Pos: "Na"},
		{T: collab.TBlockMove, ID: nextID(), Block: g2c2, Parent: collab.Root, Pos: "Nb"},
		{T: collab.TBlockCreate, ID: archID, Parent: collab.Root, Pos: "U", Type: "jiange-column-archive-v1"},
		{T: collab.TBlockDelete, ID: delID, Block: archID},
		{T: collab.TBlockSet, ID: metaID, Block: g2, Key: "_column_archive_v1", Value: &metaVal},
		{T: collab.TBlockMove, ID: gMoveID, Block: g2, Parent: archID, Pos: "U"},
	}
	ungroupBatch, _ := collab.EncodeOps(ungroupOps)
	resp, raw = postJSON("POST", fmt.Sprintf("/api/docs/%d/conditional-ops", docMeta.ID), map[string]any{
		"historyEpoch": epoch,
		"expectedSeq":  head,
		"requestId":    "33333333333333333333333333330001",
		"batch":        ungroupBatch,
	}, headers)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on conditional ungroup, got %d body=%s", resp.StatusCode, raw)
	}

	// Verify state at head: g2c1 and g2c2 are now visible root blocks, and g2 is hidden under archID.
	finalState, _, err := StateAtHead(ctx, st, docMeta.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, vis := finalState.VisibleBlockText(g2c1); !vis {
		t.Fatalf("promoted column 1 should be visible")
	}
	if _, _, vis := finalState.VisibleBlockText(g2c2); !vis {
		t.Fatalf("promoted column 2 should be visible")
	}
	if _, _, vis := finalState.VisibleBlockText(g2); vis {
		t.Fatalf("archived columns group should no longer be visible")
	}
}
