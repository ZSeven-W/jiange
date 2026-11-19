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

func TestDocSuggestionsLifecycleAndPermissions(t *testing.T) {
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
	viewer := newClient()

	resp, raw := doJSON(owner, "POST", "/api/auth/register", map[string]any{
		"email": "sug-owner@test.io", "name": "Owner", "password": "password123",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register owner: %d %s", resp.StatusCode, raw)
	}
	resp, raw = doJSON(viewer, "POST", "/api/auth/register", map[string]any{
		"email": "sug-viewer@test.io", "name": "Viewer", "password": "password123",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register viewer: %d %s", resp.StatusCode, raw)
	}

	resp, raw = doJSON(owner, "POST", "/api/docs", map[string]any{"title": "修订模式测试文档"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create doc: %d %s", resp.StatusCode, raw)
	}
	var docMeta struct {
		ID int64 `json:"id"`
	}
	_ = json.Unmarshal(raw, &docMeta)

	// Share with viewer as RoleView.
	resp, raw = doJSON(owner, "PUT", fmt.Sprintf("/api/docs/%d/shares", docMeta.ID), map[string]any{
		"email": "sug-viewer@test.io", "role": "view",
	})
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		t.Fatalf("add viewer: %d %s", resp.StatusCode, raw)
	}

	// 1. Viewer proposes a suggestion (allowed since CommentPerm != "edit").
	resp, raw = doJSON(viewer, "POST", fmt.Sprintf("/api/docs/%d/suggestions", docMeta.ID), map[string]any{
		"blockId":      "1:2",
		"kind":         "replace",
		"originalText": "旧文案",
		"proposedText": "更精准的新文案",
		"note":         "建议对齐最新术语",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("viewer create suggestion: %d %s", resp.StatusCode, raw)
	}
	var s1 store.DocSuggestion
	_ = json.Unmarshal(raw, &s1)
	if s1.Status != "open" || s1.AuthorName != "Viewer" || s1.Note != "建议对齐最新术语" {
		t.Fatalf("unexpected s1: %+v", s1)
	}

	// 2. Viewer updates own note; cannot accept own suggestion (403).
	resp, raw = doJSON(viewer, "PATCH", fmt.Sprintf("/api/docs/%d/suggestions/%d", docMeta.ID, s1.ID), map[string]any{
		"note": "更新后的修订理由",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("patch note: %d %s", resp.StatusCode, raw)
	}
	resp, raw = doJSON(viewer, "POST", fmt.Sprintf("/api/docs/%d/suggestions/%d/accept", docMeta.ID, s1.ID), nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer accept want 403 got %d %s", resp.StatusCode, raw)
	}

	// 3. Owner accepts s1; second accept returns 409 Conflict.
	resp, raw = doJSON(owner, "POST", fmt.Sprintf("/api/docs/%d/suggestions/%d/accept", docMeta.ID, s1.ID), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("owner accept: %d %s", resp.StatusCode, raw)
	}
	var accepted store.DocSuggestion
	_ = json.Unmarshal(raw, &accepted)
	if accepted.Status != "accepted" || accepted.ResolvedByName != "Owner" {
		t.Fatalf("unexpected accepted: %+v", accepted)
	}
	resp, _ = doJSON(owner, "POST", fmt.Sprintf("/api/docs/%d/suggestions/%d/accept", docMeta.ID, s1.ID), nil)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("double accept want 409 got %d", resp.StatusCode)
	}

	// 4. Viewer proposes s2 and withdraws it.
	resp, raw = doJSON(viewer, "POST", fmt.Sprintf("/api/docs/%d/suggestions", docMeta.ID), map[string]any{
		"blockId":      "1:2",
		"kind":         "replace",
		"originalText": "A",
		"proposedText": "B",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create s2: %d %s", resp.StatusCode, raw)
	}
	var s2 store.DocSuggestion
	_ = json.Unmarshal(raw, &s2)
	resp, raw = doJSON(viewer, "POST", fmt.Sprintf("/api/docs/%d/suggestions/%d/withdraw", docMeta.ID, s2.ID), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("withdraw s2: %d %s", resp.StatusCode, raw)
	}

	// 5. Owner creates 2 suggestions and batch-rejects all open.
	for i := 0; i < 2; i++ {
		resp, raw = doJSON(owner, "POST", fmt.Sprintf("/api/docs/%d/suggestions", docMeta.ID), map[string]any{
			"blockId":      fmt.Sprintf("1:%d", i+3),
			"kind":         "replace",
			"originalText": "原文",
			"proposedText": fmt.Sprintf("建议-%d", i),
		})
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("create batch sug %d: %d %s", i, resp.StatusCode, raw)
		}
	}
	resp, raw = doJSON(owner, "POST", fmt.Sprintf("/api/docs/%d/suggestions/reject-all", docMeta.ID), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reject-all: %d %s", resp.StatusCode, raw)
	}
	var batchRes struct {
		Suggestions []store.DocSuggestion `json:"suggestions"`
	}
	_ = json.Unmarshal(raw, &batchRes)
	if len(batchRes.Suggestions) != 2 {
		t.Fatalf("expected 2 rejected suggestions, got %d", len(batchRes.Suggestions))
	}

	// 6. List open suggestions should now be empty, all should be 4.
	resp, raw = doJSON(owner, "GET", fmt.Sprintf("/api/docs/%d/suggestions?status=open", docMeta.ID), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list open: %d %s", resp.StatusCode, raw)
	}
	_ = json.Unmarshal(raw, &batchRes)
	if len(batchRes.Suggestions) != 0 {
		t.Fatalf("expected 0 open, got %d", len(batchRes.Suggestions))
	}
	resp, raw = doJSON(owner, "GET", fmt.Sprintf("/api/docs/%d/suggestions?status=all", docMeta.ID), nil)
	_ = json.Unmarshal(raw, &batchRes)
	if len(batchRes.Suggestions) != 4 {
		t.Fatalf("expected 4 total, got %d", len(batchRes.Suggestions))
	}
}
