package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestRecordCommentThreads(t *testing.T) { checkRecordCommentThreads(t, newBaseSecurityFixture(t)) }

func TestPostgresRecordCommentThreads(t *testing.T) {
	checkRecordCommentThreads(t, newBaseSecurityFixtureWithStore(t, postgresBaseSecurityStore(t)))
}

func meID(t *testing.T, c *http.Client, root string) int64 {
	t.Helper()
	var me struct{ User store.User }
	json.NewDecoder(cGet(t, c, root+"/api/me").Body).Decode(&me)
	return me.User.ID
}

func notifications(t *testing.T, c *http.Client, root string) []store.Notification {
	t.Helper()
	var out struct{ Notifications []store.Notification }
	json.NewDecoder(cGet(t, c, root+"/api/notifications").Body).Decode(&out)
	return out.Notifications
}

func checkRecordCommentThreads(t *testing.T, f baseSecurityFixture) {
	root := f.url[:strings.Index(f.url, "/api/")]
	guestID := meID(t, f.guest, root)
	pub := f.url + "/records/" + strconv.FormatInt(f.public.ID, 10) + "/comments"
	priv := f.url + "/records/" + strconv.FormatInt(f.private.ID, 10) + "/comments"

	// root comment from the owner mentioning the guest → mention notification
	var rootC store.Comment
	json.NewDecoder(post(t, f.owner, pub, map[string]any{"body": "@Guest 请确认", "mentions": []int64{guestID}}).Body).Decode(&rootC)
	if rootC.ID == 0 || len(rootC.Mentions) != 1 {
		t.Fatalf("root comment %+v", rootC)
	}
	if ns := notifications(t, f.guest, root); len(ns) != 1 || ns[0].Kind != "mention" || ns[0].DocID != f.base.ID {
		t.Fatalf("guest mention notification: %+v", ns)
	}
	// the guest replies; owner gets a reply notification
	var reply store.Comment
	res := post(t, f.guest, pub, map[string]any{"body": "已确认", "parentId": rootC.ID})
	json.NewDecoder(res.Body).Decode(&reply)
	if res.StatusCode != http.StatusCreated || reply.ParentID == nil || *reply.ParentID != rootC.ID {
		t.Fatalf("reply %d %+v", res.StatusCode, reply)
	}
	if ns := notifications(t, f.owner, root); len(ns) != 1 || ns[0].Kind != "reply" {
		t.Fatalf("owner reply notification: %+v", ns)
	}
	// replies only one level deep, and only under the same record
	if r := post(t, f.guest, pub, map[string]any{"body": "x", "parentId": reply.ID}); r.StatusCode != http.StatusNotFound {
		t.Fatalf("nested reply = %d", r.StatusCode)
	}
	if r := post(t, f.owner, priv, map[string]any{"body": "x", "parentId": rootC.ID}); r.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-record reply = %d", r.StatusCode)
	}
	// resolve and reopen through the record route
	cid := pub + "/" + strconv.FormatInt(rootC.ID, 10)
	var patched store.Comment
	json.NewDecoder(send(t, f.owner, "PATCH", cid, map[string]any{"resolved": true}).Body).Decode(&patched)
	if !patched.Resolved {
		t.Fatalf("resolve %+v", patched)
	}
	// the generic doc route cannot touch record comments
	generic := root + "/api/docs/" + strconv.FormatInt(f.base.ID, 10) + "/comments/" + strconv.FormatInt(rootC.ID, 10)
	if r := send(t, f.owner, "PATCH", generic, map[string]any{"resolved": false}); r.StatusCode != http.StatusNotFound {
		t.Fatalf("generic patch of record comment = %d", r.StatusCode)
	}
	if r := send(t, f.owner, "DELETE", generic, nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("generic delete of record comment = %d", r.StatusCode)
	}
	json.NewDecoder(send(t, f.owner, "PATCH", cid, map[string]any{"resolved": false}).Body).Decode(&patched)
	if patched.Resolved {
		t.Fatalf("reopen %+v", patched)
	}
	// a comment id from another record is not reachable through this record
	var privC store.Comment
	json.NewDecoder(post(t, f.owner, priv, map[string]any{"body": "SECRET"}).Body).Decode(&privC)
	if r := send(t, f.owner, "PATCH", pub+"/"+strconv.FormatInt(privC.ID, 10), map[string]any{"resolved": true}); r.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-record patch = %d", r.StatusCode)
	}

	// after locking, the guest can't see the private record: mentioning them
	// there must not notify (the preview would leak), nor may they resolve it.
	setLockedFixture(t, f)
	before := len(notifications(t, f.guest, root))
	var m store.Comment
	json.NewDecoder(post(t, f.owner, priv, map[string]any{"body": "@Guest SECRET_MENTION", "mentions": []int64{guestID}}).Body).Decode(&m)
	if len(m.Mentions) != 0 {
		t.Fatalf("mention of a reader without access kept: %+v", m.Mentions)
	}
	if after := notifications(t, f.guest, root); len(after) != before {
		t.Fatalf("guest notified about a hidden record: %+v", after)
	}
	if r := send(t, f.guest, "PATCH", priv+"/"+strconv.FormatInt(privC.ID, 10), map[string]any{"resolved": true}); r.StatusCode != http.StatusNotFound {
		t.Fatalf("guest resolve on hidden record = %d", r.StatusCode)
	}
	if r := send(t, f.guest, "PATCH", generic[:strings.LastIndex(generic, "/")+1]+strconv.FormatInt(privC.ID, 10), map[string]any{"resolved": true}); r.StatusCode != http.StatusNotFound {
		t.Fatalf("guest generic resolve on hidden record = %d", r.StatusCode)
	}
}
