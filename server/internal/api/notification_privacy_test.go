package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type notificationHookStore struct {
	store.Store
	afterRead     func()
	afterComments func()
	afterAdd      func()
}

func (s *notificationHookStore) Comments(ctx context.Context, id int64) ([]store.Comment, error) {
	comments, err := s.Store.Comments(ctx, id)
	if s.afterComments != nil {
		f := s.afterComments
		s.afterComments = nil
		f()
	}
	return comments, err
}

func (s *notificationHookStore) AddCommentGuarded(ctx context.Context, guard store.RestoreGuard, c store.Comment) (store.Comment, error) {
	comment, err := s.Store.AddCommentGuarded(ctx, guard, c)
	if err == nil && s.afterAdd != nil {
		f := s.afterAdd
		s.afterAdd = nil
		f()
	}
	return comment, err
}

func (s *notificationHookStore) Notifications(ctx context.Context, uid int64, limit int) ([]store.Notification, error) {
	items, err := s.Store.Notifications(ctx, uid, limit)
	if s.afterRead != nil {
		f := s.afterRead
		s.afterRead = nil
		f()
	}
	return items, err
}

func TestCommentReadAndMutationRecheckAccess(t *testing.T) {
	st := &notificationHookStore{Store: store.NewMemory()}
	ts, owner := newTestServer(t, st, nil)
	guest := newCommentClient()
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "comment-owner@example.test", "name": "Owner", "password": "password123"}).Body.Close()
	post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "comment-guest@example.test", "name": "Guest", "password": "password123"}).Body.Close()
	var doc store.DocMeta
	r := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "Private"})
	json.NewDecoder(r.Body).Decode(&doc)
	r.Body.Close()
	docURL := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10)
	send(t, owner, "PUT", docURL+"/shares", map[string]string{"email": "comment-guest@example.test", "role": "view"}).Body.Close()
	post(t, owner, docURL+"/comments", map[string]any{"body": "hidden comment"}).Body.Close()
	st.afterComments = func() { _ = st.SetShare(context.Background(), doc.ID, 2, "") }
	r = cGet(t, guest, docURL+"/comments")
	data, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != http.StatusForbidden || strings.Contains(string(data), "hidden comment") {
		t.Fatalf("comment read revoke: %d %s", r.StatusCode, data)
	}
	if err := st.SetShare(context.Background(), doc.ID, 2, store.RoleView); err != nil {
		t.Fatal(err)
	}
	st.afterAdd = func() { _ = st.SetShare(context.Background(), doc.ID, 2, "") }
	r = post(t, guest, docURL+"/comments", map[string]any{"body": "committed before revoke"})
	data, _ = io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != http.StatusNoContent || strings.Contains(string(data), "committed before revoke") {
		t.Fatalf("committed mutation response: %d %s", r.StatusCode, data)
	}
	comments, err := st.Comments(context.Background(), doc.ID)
	if err != nil || len(comments) != 2 || comments[1].Body != "committed before revoke" {
		t.Fatalf("committed comment lost: %+v %v", comments, err)
	}
}

func TestDocumentNotificationRechecksAccessAndSession(t *testing.T) {
	st := &notificationHookStore{Store: store.NewMemory()}
	ts, owner := newTestServer(t, st, nil)
	guest := newCommentClient()
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "notify-owner@example.test", "name": "Owner", "password": "password123"}).Body.Close()
	post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "notify-guest@example.test", "name": "Guest", "password": "password123"}).Body.Close()
	var doc store.DocMeta
	r := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "Private"})
	json.NewDecoder(r.Body).Decode(&doc)
	r.Body.Close()
	docURL := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10)
	send(t, owner, "PUT", docURL+"/shares", map[string]string{"email": "notify-guest@example.test", "role": "view"}).Body.Close()
	post(t, owner, docURL+"/comments", map[string]any{"body": "confidential", "mentions": []int64{2}}).Body.Close()
	st.afterRead = func() { _ = st.SetShare(context.Background(), doc.ID, 2, "") }
	r = cGet(t, guest, ts.URL+"/api/notifications")
	data, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != http.StatusOK || strings.Contains(string(data), "confidential") || strings.Contains(string(data), "Private") {
		t.Fatalf("revocation leaked notification: %d %s", r.StatusCode, data)
	}
	var result struct {
		Notifications []store.Notification `json:"notifications"`
		Unread        int                  `json:"unread"`
	}
	if err := json.Unmarshal(data, &result); err != nil || len(result.Notifications) != 0 || result.Unread != 0 {
		t.Fatalf("revocation result: %+v %v", result, err)
	}
	// Re-grant access, then end the session after the notifications query. No
	// notification or document content may be returned to the ended session.
	if err := st.SetShare(context.Background(), doc.ID, 2, store.RoleView); err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(ts.URL)
	var session string
	for _, c := range guest.Jar.Cookies(u) {
		if c.Name == CookieName {
			session = c.Value
		}
	}
	if session == "" {
		t.Fatal("missing test session")
	}
	st.afterRead = func() { _ = st.DeleteSession(context.Background(), auth.HashToken(session)) }
	r = cGet(t, guest, ts.URL+"/api/notifications")
	data, _ = io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != http.StatusUnauthorized || strings.Contains(string(data), "confidential") {
		t.Fatalf("ended session leaked notification: %d %s", r.StatusCode, data)
	}
}

func TestCommentMentionDoesNotNotifyUnauthorizedRecipient(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	guest := newCommentClient()
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "private-owner@example.test", "name": "Owner", "password": "password123"}).Body.Close()
	post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "private-guest@example.test", "name": "Guest", "password": "password123"}).Body.Close()
	var doc store.DocMeta
	r := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "Private"})
	json.NewDecoder(r.Body).Decode(&doc)
	r.Body.Close()
	docURL := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10)
	r = post(t, owner, docURL+"/comments", map[string]any{"body": "secret body", "mentions": []int64{2, 999999}})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("comment should still be created: %d", r.StatusCode)
	}
	r.Body.Close()
	send(t, owner, "PUT", docURL+"/shares", map[string]string{"email": "private-guest@example.test", "role": "view"}).Body.Close()
	r = cGet(t, guest, ts.URL+"/api/notifications")
	data, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != http.StatusOK || strings.Contains(string(data), "secret body") || strings.Contains(string(data), "Private") {
		t.Fatalf("unauthorized mention persisted: %d %s", r.StatusCode, data)
	}
}
