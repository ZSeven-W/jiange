package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestSyncedBlocksAndPermissionFilteredSubpages(t *testing.T) {
	st := store.NewMemory()
	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	newClient := func() *http.Client {
		jar, _ := cookiejar.New(nil)
		return &http.Client{Jar: jar}
	}
	doJSON := func(c *http.Client, method, path string, body any) (*http.Response, []byte) {
		t.Helper()
		var reader io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			reader = bytes.NewReader(b)
		}
		req, err := http.NewRequest(method, ts.URL+path, reader)
		if err != nil {
			t.Fatal(err)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, raw
	}

	owner := newClient()
	outsider := newClient()

	resp, raw := doJSON(owner, "POST", "/api/auth/register", map[string]any{
		"email": "sb-owner@test.io", "name": "Owner", "password": "password123",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register owner: %d %s", resp.StatusCode, raw)
	}
	resp, raw = doJSON(outsider, "POST", "/api/auth/register", map[string]any{
		"email": "sb-outsider@test.io", "name": "Outsider", "password": "password123",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register outsider: %d %s", resp.StatusCode, raw)
	}

	// Create parent doc + two child docs (one shared with outsider, one private).
	resp, raw = doJSON(owner, "POST", "/api/docs", map[string]any{"title": "项目总览"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create parent: %d %s", resp.StatusCode, raw)
	}
	var parent struct {
		ID int64 `json:"id"`
	}
	_ = json.Unmarshal(raw, &parent)

	resp, raw = doJSON(owner, "POST", "/api/docs", map[string]any{"title": "公开子页面", "parentId": parent.ID})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create child1: %d %s", resp.StatusCode, raw)
	}
	var child1 struct {
		ID int64 `json:"id"`
	}
	_ = json.Unmarshal(raw, &child1)

	resp, raw = doJSON(owner, "POST", "/api/docs", map[string]any{"title": "私密子页面", "parentId": parent.ID})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create child2: %d %s", resp.StatusCode, raw)
	}

	// Share parent + child1 (NOT child2) with outsider as RoleView.
	for _, docID := range []int64{parent.ID, child1.ID} {
		resp, raw = doJSON(owner, "PUT", fmt.Sprintf("/api/docs/%d/shares", docID), map[string]any{
			"email": "sb-outsider@test.io", "role": "view",
		})
		if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
			t.Fatalf("share doc %d: %d %s", docID, resp.StatusCode, raw)
		}
	}

	// 1. Subpages list for owner sees both children; outsider sees ONLY child1!
	resp, raw = doJSON(owner, "GET", fmt.Sprintf("/api/docs/%d/subpages", parent.ID), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("owner subpages: %d %s", resp.StatusCode, raw)
	}
	var subRes struct {
		Subpages []struct {
			ID    int64  `json:"id"`
			Title string `json:"title"`
		} `json:"subpages"`
	}
	_ = json.Unmarshal(raw, &subRes)
	if len(subRes.Subpages) != 2 {
		t.Fatalf("owner expected 2 subpages, got %d", len(subRes.Subpages))
	}

	resp, raw = doJSON(outsider, "GET", fmt.Sprintf("/api/docs/%d/subpages", parent.ID), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("outsider subpages: %d %s", resp.StatusCode, raw)
	}
	_ = json.Unmarshal(raw, &subRes)
	if len(subRes.Subpages) != 1 || subRes.Subpages[0].ID != child1.ID {
		t.Fatalf("outsider expected only child1 (%d), got %+v", child1.ID, subRes.Subpages)
	}

	// 2. Create a synced block in parent doc.
	resp, raw = doJSON(owner, "POST", fmt.Sprintf("/api/docs/%d/synced-blocks", parent.ID), map[string]any{
		"content": "跨文档实时同步公告 v1",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create synced block: %d %s", resp.StatusCode, raw)
	}
	var sbResp struct {
		SyncedBlock store.SyncedBlock `json:"syncedBlock"`
		CanEdit     bool              `json:"canEdit"`
	}
	_ = json.Unmarshal(raw, &sbResp)
	sid := sbResp.SyncedBlock.ID
	if sid == "" || sbResp.SyncedBlock.Revision != 1 || !sbResp.CanEdit {
		t.Fatalf("unexpected created synced block: %+v", sbResp)
	}

	// 3. Outsider (viewer on parent) can read synced block with canEdit=false, cannot edit (403).
	resp, raw = doJSON(outsider, "GET", "/api/synced-blocks/"+sid, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("outsider get synced block: %d %s", resp.StatusCode, raw)
	}
	_ = json.Unmarshal(raw, &sbResp)
	if sbResp.CanEdit || sbResp.SyncedBlock.Content != "跨文档实时同步公告 v1" {
		t.Fatalf("unexpected outsider synced block: %+v", sbResp)
	}
	resp, raw = doJSON(outsider, "PUT", "/api/synced-blocks/"+sid, map[string]any{
		"content": "越权修改", "expectedRevision": 1,
	})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("outsider update synced block want 403 got %d %s", resp.StatusCode, raw)
	}

	// 4. Owner updates synced block (rev 1 -> 2); stale rev 1 returns 409 Conflict.
	resp, raw = doJSON(owner, "PUT", "/api/synced-blocks/"+sid, map[string]any{
		"content": "跨文档实时同步公告 v2", "expectedRevision": 1,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("owner update synced block: %d %s", resp.StatusCode, raw)
	}
	_ = json.Unmarshal(raw, &sbResp)
	if sbResp.SyncedBlock.Revision != 2 || sbResp.SyncedBlock.Content != "跨文档实时同步公告 v2" {
		t.Fatalf("unexpected updated synced block: %+v", sbResp)
	}
	resp, _ = doJSON(owner, "PUT", "/api/synced-blocks/"+sid, map[string]any{
		"content": "stale write", "expectedRevision": 1,
	})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("stale revision want 409 got %d", resp.StatusCode)
	}
}
