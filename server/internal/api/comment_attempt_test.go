package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestCommentAttemptAPI(t *testing.T) {
	st := store.NewMemory()
	ts, client := newTestServer(t, st, nil)
	r := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "attempt@example.test", "name": "Example", "password": "password123"})
	r.Body.Close()
	var doc store.DocMeta
	r = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "attempt"})
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	url := fmt.Sprintf("%s/api/docs/%d/comment-attempts", ts.URL, doc.ID)
	r = send(t, client, "GET", fmt.Sprintf("%s/capabilities?expectedUserId=%d", url, doc.CreatorID), nil)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("capabilities %d", r.StatusCode)
	}
	r.Body.Close()
	request := map[string]any{"mutationId": "0123456789abcdef0123456789abcdef", "expectedUserId": doc.CreatorID, "body": "hello", "quote": "", "block": "", "startChar": "", "endChar": "", "mentions": []int64{}}
	sendAttempt := func(want int) store.CommentAttemptResult {
		t.Helper()
		r := post(t, client, url, request)
		defer r.Body.Close()
		if r.StatusCode != want {
			t.Fatalf("status=%d, want=%d", r.StatusCode, want)
		}
		var result store.CommentAttemptResult
		if want == http.StatusOK {
			if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
				t.Fatal(err)
			}
		}
		return result
	}
	status := func(key string) store.CommentAttemptResult {
		t.Helper()
		r := send(t, client, "GET", fmt.Sprintf("%s/%s?expectedUserId=%d", url, key, doc.CreatorID), nil)
		defer r.Body.Close()
		if r.StatusCode != http.StatusOK {
			t.Fatalf("status query: %d", r.StatusCode)
		}
		var result store.CommentAttemptResult
		if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	key := request["mutationId"].(string)
	if unknown := status(key); unknown.State != "unknown" || unknown.CommentID != 0 {
		t.Fatalf("unknown: %+v", unknown)
	}
	first := sendAttempt(http.StatusOK)
	second := sendAttempt(http.StatusOK)
	if got := status(key); got.State != "committed" || got.CommentID != first.CommentID || got.Comment != nil {
		t.Fatalf("committed query: %+v", got)
	}
	if first.CommentID == 0 || first.CommentID != second.CommentID || first.MutationID != request["mutationId"] || first.State != "committed" || first.Comment == nil {
		t.Fatalf("receipt: %+v %+v", first, second)
	}
	request["body"] = "changed"
	sendAttempt(http.StatusConflict)
	request["body"] = "hello"
	r = send(t, client, "DELETE", fmt.Sprintf("%s/api/docs/%d/comments/%d", ts.URL, doc.ID, first.CommentID), nil)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: %d", r.StatusCode)
	}
	r.Body.Close()
	if got := status(key); got.State != "deleted" || got.CommentID != first.CommentID || got.Comment != nil {
		t.Fatalf("deleted query: %+v", got)
	}
	deleted := sendAttempt(http.StatusOK)
	if deleted.State != "deleted" || deleted.Comment != nil || deleted.CommentID != first.CommentID {
		t.Fatalf("tombstone: %+v", deleted)
	}
	request["mutationId"] = "BAD"
	sendAttempt(http.StatusBadRequest)
}

type attemptRevokeStore struct {
	store.Store
	afterCommit bool
}

func (s *attemptRevokeStore) AddCommentAttemptGuarded(ctx context.Context, guard store.RestoreGuard, mutationID string, c store.Comment) (store.CommentAttemptResult, error) {
	result, err := s.Store.AddCommentAttemptGuarded(ctx, guard, mutationID, c)
	if err == nil && s.afterCommit {
		s.afterCommit = false
		_ = s.Store.DeleteSession(ctx, guard.SessionHash)
	}
	return result, err
}

func TestCommentAttemptCommittedThenRevoked(t *testing.T) {
	st := &attemptRevokeStore{Store: store.NewMemory()}
	ts, client := newTestServer(t, st, nil)
	r := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "revoked-attempt@example.test", "name": "Example", "password": "password123"})
	r.Body.Close()
	var doc store.DocMeta
	r = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "attempt"})
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	key := "0123456789abcdef0123456789abcdef"
	st.afterCommit = true
	r = post(t, client, fmt.Sprintf("%s/api/docs/%d/comment-attempts", ts.URL, doc.ID), map[string]any{"mutationId": key, "expectedUserId": doc.CreatorID, "body": "secret"})
	defer r.Body.Close()
	if r.StatusCode != http.StatusNoContent || r.Header.Get("X-Comment-Result") != "committed" || r.Header.Get("X-Comment-Mutation-Id") != key {
		t.Fatalf("committed result: status=%d headers=%v", r.StatusCode, r.Header)
	}
	comments, err := st.Comments(context.Background(), doc.ID)
	if err != nil || len(comments) != 1 {
		t.Fatalf("comment committed: %+v %v", comments, err)
	}
}

func TestCommentAttemptAccountBinding(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	jar, _ := cookiejar.New(nil)
	other := &http.Client{Jar: jar}
	for _, a := range []struct {
		c     *http.Client
		email string
	}{{owner, "attempt-owner@example.test"}, {other, "attempt-other@example.test"}} {
		r := post(t, a.c, ts.URL+"/api/auth/register", map[string]string{"email": a.email, "name": "Example", "password": "password123"})
		r.Body.Close()
	}
	var doc store.DocMeta
	r := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "scope"})
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	url := fmt.Sprintf("%s/api/docs/%d/comment-attempts", ts.URL, doc.ID)
	key := "0123456789abcdef0123456789abcdef"
	assertAccountChanged := func(r *http.Response) {
		t.Helper()
		defer r.Body.Close()
		var e struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(r.Body).Decode(&e)
		if r.StatusCode != http.StatusConflict || e.Error != "comment_attempt_account_changed" {
			t.Fatalf("status=%d error=%q", r.StatusCode, e.Error)
		}
	}
	// Account identity is checked before document access, even if the new
	// account does not have access to this document.
	assertAccountChanged(send(t, other, "GET", fmt.Sprintf("%s/capabilities?expectedUserId=%d", url, doc.CreatorID), nil))
	assertAccountChanged(send(t, other, "GET", fmt.Sprintf("%s/%s?expectedUserId=%d", url, key, doc.CreatorID), nil))
	assertAccountChanged(post(t, other, url, map[string]any{"expectedUserId": doc.CreatorID, "mutationId": key, "body": "old account draft"}))
	// Even when the new account is independently authorized to edit, it must
	// not commit an old tab's request for the first account.
	r = send(t, owner, "PUT", fmt.Sprintf("%s/api/docs/%d/shares", ts.URL, doc.ID), map[string]string{"email": "attempt-other@example.test", "role": "edit"})
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("share: %d", r.StatusCode)
	}
	assertAccountChanged(post(t, other, url, map[string]any{"expectedUserId": doc.CreatorID, "mutationId": key, "body": "old account draft"}))
	all, err := st.Comments(context.Background(), doc.ID)
	if err != nil || len(all) != 0 {
		t.Fatalf("wrong-account write: %+v %v", all, err)
	}
}

func TestCommentAttemptCapabilityCopyPolicyAndAccess(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	jar, _ := cookiejar.New(nil)
	viewer := &http.Client{Jar: jar}
	for _, a := range []struct {
		c     *http.Client
		email string
	}{{owner, "cap-owner@example.test"}, {viewer, "cap-viewer@example.test"}} {
		r := post(t, a.c, ts.URL+"/api/auth/register", map[string]string{"email": a.email, "name": "Example", "password": "password123"})
		r.Body.Close()
	}
	var doc store.DocMeta
	r := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "scope"})
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	viewerUser, err := st.UserByEmail(context.Background(), "cap-viewer@example.test")
	if err != nil {
		t.Fatal(err)
	}
	capURL := fmt.Sprintf("%s/api/docs/%d/comment-attempts/capabilities?expectedUserId=%d", ts.URL, doc.ID, viewerUser.ID)
	// Only this explicit bound-account denial is safe for client redaction.
	r = send(t, viewer, "GET", capURL, nil)
	var denied struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(r.Body).Decode(&denied)
	r.Body.Close()
	if r.StatusCode != http.StatusForbidden || denied.Error != "comment_attempt_document_denied" {
		t.Fatalf("denied status=%d code=%q", r.StatusCode, denied.Error)
	}
	r = send(t, owner, "PUT", fmt.Sprintf("%s/api/docs/%d/shares", ts.URL, doc.ID), map[string]string{"email": "cap-viewer@example.test", "role": "view"})
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatal(r.StatusCode)
	}
	get := func() bool {
		t.Helper()
		r := send(t, viewer, "GET", capURL, nil)
		defer r.Body.Close()
		if r.StatusCode != http.StatusOK {
			t.Fatalf("capability %d", r.StatusCode)
		}
		var cap struct {
			Version      int   `json:"version"`
			UserID       int64 `json:"userId"`
			CanCopyQuote bool  `json:"canCopyQuote"`
		}
		if err := json.NewDecoder(r.Body).Decode(&cap); err != nil {
			t.Fatal(err)
		}
		if cap.Version != 1 || cap.UserID != viewerUser.ID {
			t.Fatalf("capability: %+v", cap)
		}
		return cap.CanCopyQuote
	}
	if !get() {
		t.Fatal("view initially allowed to copy")
	}
	r = send(t, owner, "PATCH", fmt.Sprintf("%s/api/docs/%d", ts.URL, doc.ID), map[string]any{"copyMinRole": "edit", "expectedPermissionsRevision": 0})
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("set copy policy: %d", r.StatusCode)
	}
	if get() {
		t.Fatal("restricted viewer can copy quote")
	}
}
