package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestRecordReplyNoticeNeedsRecordAccess(t *testing.T) {
	checkRecordReplyNoticeNeedsRecordAccess(t, newBaseSecurityFixture(t))
}

func TestPostgresRecordReplyNoticeNeedsRecordAccess(t *testing.T) {
	checkRecordReplyNoticeNeedsRecordAccess(t, newBaseSecurityFixtureWithStore(t, postgresBaseSecurityStore(t)))
}

func countKind(ns []store.Notification, kind string) int {
	n := 0
	for _, x := range ns {
		if x.Kind == kind {
			n++
		}
	}
	return n
}

func checkRecordReplyNoticeNeedsRecordAccess(t *testing.T, f baseSecurityFixture) {
	root := f.url[:strings.Index(f.url, "/api/")]
	pub := f.url + "/records/" + strconv.FormatInt(f.public.ID, 10) + "/comments"
	priv := f.url + "/records/" + strconv.FormatInt(f.private.ID, 10) + "/comments"
	// the guest starts threads on both records while they can still see both
	var onPriv, onPub store.Comment
	json.NewDecoder(post(t, f.guest, priv, map[string]any{"body": "guest root on private"}).Body).Decode(&onPriv)
	json.NewDecoder(post(t, f.guest, pub, map[string]any{"body": "guest root on public"}).Body).Decode(&onPub)
	if onPriv.ID == 0 || onPub.ID == 0 {
		t.Fatal("guest roots not created")
	}
	// lock the view: the guest loses sight of the private record only
	setLockedFixture(t, f)
	if r := post(t, f.owner, priv, map[string]any{"body": "SECRET_REPLY", "parentId": onPriv.ID}); r.StatusCode != http.StatusCreated {
		t.Fatalf("owner reply %d", r.StatusCode)
	}
	if r := send(t, f.owner, "PATCH", priv+"/"+strconv.FormatInt(onPriv.ID, 10), map[string]any{"resolved": true}); r.StatusCode != http.StatusOK {
		t.Fatalf("owner resolve %d", r.StatusCode)
	}
	for _, n := range notifications(t, f.guest, root) {
		if strings.Contains(n.Preview, "SECRET") || n.CommentID != nil && *n.CommentID == onPriv.ID {
			t.Fatalf("root author without record access was notified: %+v", n)
		}
	}
	// control: a reply on a record the guest can still see does notify them
	if r := post(t, f.owner, pub, map[string]any{"body": "公开回复", "parentId": onPub.ID}); r.StatusCode != http.StatusCreated {
		t.Fatalf("owner public reply %d", r.StatusCode)
	}
	if ns := notifications(t, f.guest, root); countKind(ns, "reply") != 1 || len(ns) != 1 {
		t.Fatalf("guest should get exactly the visible reply notice: %+v", ns)
	}
}

// Doc-level comments on non-doc nodes (a base here) must also stop notifying
// a parent author once their access is revoked.
func TestDocCommentReplyNoticeNeedsAccess(t *testing.T) {
	checkDocCommentReplyNoticeNeedsAccess(t, newBaseSecurityFixture(t))
}

func TestPostgresDocCommentReplyNoticeNeedsAccess(t *testing.T) {
	checkDocCommentReplyNoticeNeedsAccess(t, newBaseSecurityFixtureWithStore(t, postgresBaseSecurityStore(t)))
}

func checkDocCommentReplyNoticeNeedsAccess(t *testing.T, f baseSecurityFixture) {
	root := f.url[:strings.Index(f.url, "/api/")]
	docComments := root + "/api/docs/" + strconv.FormatInt(f.base.ID, 10) + "/comments"
	var c store.Comment
	json.NewDecoder(post(t, f.guest, docComments, map[string]any{"body": "guest base comment"}).Body).Decode(&c)
	if c.ID == 0 {
		t.Fatal("guest comment not created")
	}
	if r := send(t, f.owner, "PUT", root+"/api/docs/"+strconv.FormatInt(f.base.ID, 10)+"/shares", map[string]any{"email": "locked-guest@example.test", "role": ""}); r.StatusCode != http.StatusOK {
		t.Fatalf("revoke %d", r.StatusCode)
	}
	if r := post(t, f.owner, docComments, map[string]any{"body": "SECRET_AFTER_REVOKE", "parentId": c.ID}); r.StatusCode != http.StatusCreated {
		t.Fatalf("owner reply %d", r.StatusCode)
	}
	for _, n := range notifications(t, f.guest, root) {
		if strings.Contains(n.Preview, "SECRET_AFTER_REVOKE") {
			t.Fatalf("revoked parent author was notified: %+v", n)
		}
	}
}
