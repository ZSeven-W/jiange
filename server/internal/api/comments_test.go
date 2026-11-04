package api

import (
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newCommentClient() *http.Client {
	j, _ := cookiejar.New(nil)
	return &http.Client{Jar: j}
}

// two users share a doc; kay comments and mentions bob
func TestCommentsMentionsReplyResolve(t *testing.T) {
	st := store.NewMemory()
	ts, _ := newTestServer(t, st, nil)
	client := func() *http.Client { return newCommentClient() }
	kay, bob := client(), client()
	post(t, kay, ts.URL+"/api/auth/register", map[string]string{"email": "kc@x.com", "name": "Kay", "password": "password123"})
	post(t, bob, ts.URL+"/api/auth/register", map[string]string{"email": "bc@x.com", "name": "Bob", "password": "password123"})
	var d store.DocMeta
	json.NewDecoder(post(t, kay, ts.URL+"/api/docs", map[string]string{"title": "评审"}).Body).Decode(&d)
	docURL := ts.URL + "/api/docs/" + strconv.FormatInt(d.ID, 10)

	// bob gets edit via share
	send(t, kay, "PUT", docURL+"/shares", map[string]any{"email": "bc@x.com", "role": "edit"})

	// kay comments, @-ing bob
	var c1 store.Comment
	body := post(t, kay, docURL+"/comments", map[string]any{
		"block": "3:1", "startChar": "3:2", "endChar": "3:4",
		"quote": "这段要改", "body": "@Bob 请看一下这段", "mentions": []int64{2},
	})
	json.NewDecoder(body.Body).Decode(&c1)
	if c1.ID == 0 || c1.UserName != "Kay" {
		t.Fatalf("create: %+v", c1)
	}

	// bob was notified (mention), kay was not
	var notif struct {
		Notifications []store.Notification
		Unread        int64
	}
	r, _ := bob.Get(ts.URL + "/api/notifications")
	json.NewDecoder(r.Body).Decode(&notif)
	if notif.Unread != 1 || len(notif.Notifications) != 1 || notif.Notifications[0].Kind != "mention" {
		t.Fatalf("bob notifications: %+v", notif)
	}
	if notif.Notifications[0].DocTitle != "评审" || notif.Notifications[0].ActorName != "Kay" {
		t.Fatalf("notification fields: %+v", notif.Notifications[0])
	}
	r, _ = kay.Get(ts.URL + "/api/notifications")
	json.NewDecoder(r.Body).Decode(&notif)
	if notif.Unread != 0 {
		t.Fatalf("kay should have no notifications: %+v", notif)
	}

	// bob replies to the thread → kay gets a reply notification
	var c2 store.Comment
	json.NewDecoder(post(t, bob, docURL+"/comments", map[string]any{
		"parentId": c1.ID, "body": "收到，今天改",
	}).Body).Decode(&c2)
	if c2.ParentID == nil || *c2.ParentID != c1.ID {
		t.Fatalf("reply parent: %+v", c2)
	}
	r, _ = kay.Get(ts.URL + "/api/notifications")
	json.NewDecoder(r.Body).Decode(&notif)
	if notif.Unread != 1 || notif.Notifications[0].Kind != "reply" {
		t.Fatalf("kay reply notification: %+v", notif)
	}

	// bob resolves his own view? no — kay resolves her thread; bob gets notified
	if res := send(t, kay, "PATCH", docURL+"/comments/"+strconv.FormatInt(c1.ID, 10), map[string]any{"resolved": true}); res.StatusCode != 200 {
		t.Fatalf("resolve: %d", res.StatusCode)
	}
	r, _ = bob.Get(ts.URL + "/api/notifications")
	json.NewDecoder(r.Body).Decode(&notif)
	if notif.Unread != 2 || notif.Notifications[0].Kind != "resolve" {
		t.Fatalf("bob resolve notification: %+v", notif)
	}

	// mark one read
	if res := send(t, bob, "POST", ts.URL+"/api/notifications/read", map[string]any{"ids": []int64{notif.Notifications[0].ID}}); res.StatusCode != 204 {
		t.Fatalf("mark read: %d", res.StatusCode)
	}
	r, _ = bob.Get(ts.URL + "/api/notifications")
	json.NewDecoder(r.Body).Decode(&notif)
	if notif.Unread != 1 {
		t.Fatalf("after mark read: %+v", notif)
	}

	// bob cannot edit kay's comment; kay can delete her own
	if res := send(t, bob, "PATCH", docURL+"/comments/"+strconv.FormatInt(c1.ID, 10), map[string]any{"body": "改"}); res.StatusCode != 403 {
		t.Fatalf("edit other's comment: %d", res.StatusCode)
	}

	// view-only users cannot comment
	send(t, kay, "PUT", docURL+"/shares", map[string]any{"email": "bc@x.com", "role": "view"})
	if res := post(t, bob, docURL+"/comments", map[string]any{"body": "看看"}); res.StatusCode != 403 {
		t.Fatalf("view role comment: %d", res.StatusCode)
	}

	// deleting a thread removes its replies
	if res := send(t, kay, "DELETE", docURL+"/comments/"+strconv.FormatInt(c1.ID, 10), nil); res.StatusCode != 204 {
		t.Fatalf("delete: %d", res.StatusCode)
	}
	r, _ = kay.Get(docURL + "/comments")
	var list struct{ Comments []store.Comment }
	json.NewDecoder(r.Body).Decode(&list)
	if len(list.Comments) != 0 {
		t.Fatalf("thread should be gone: %+v", list.Comments)
	}
}
