package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestMemoryRecordCommentAttemptHTTP(t *testing.T) {
	checkRecordCommentAttemptHTTP(t, newBaseSecurityFixture(t))
}
func TestPostgresRecordCommentAttemptHTTP(t *testing.T) {
	checkRecordCommentAttemptHTTP(t, newBaseSecurityFixtureWithStore(t, postgresBaseSecurityStore(t)))
}

func checkRecordCommentAttemptHTTP(t *testing.T, f baseSecurityFixture) {
	t.Helper()
	root := f.url[:strings.Index(f.url, "/api/")]
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(cGet(t, f.guest, root+"/api/me").Body).Decode(&me); err != nil || me.User.ID <= 0 {
		t.Fatalf("guest identity: %+v %v", me, err)
	}
	path := f.url + "/records/" + strconv.FormatInt(f.private.ID, 10) + "/comment-attempts"
	ownerID := f.base.CreatorID
	if r := cGet(t, f.owner, fmt.Sprintf("%s/capabilities?expectedUserId=%d", path, ownerID)); r.StatusCode != http.StatusOK {
		t.Fatalf("capability: %d", r.StatusCode)
	}
	key := "1234567890abcdef1234567890abcdef"
	payload := map[string]any{"expectedUserId": ownerID, "mutationId": key, "body": "one comment", "mentions": []int64{me.User.ID}}
	if r := post(t, f.guest, path, payload); r.StatusCode != http.StatusConflict {
		t.Fatalf("account mismatch: %d", r.StatusCode)
	}
	var first, retry store.RecordCommentAttemptResult
	r := post(t, f.owner, path, payload)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("create: %d", r.StatusCode)
	}
	if err := json.NewDecoder(r.Body).Decode(&first); err != nil {
		t.Fatal(err)
	}
	r = post(t, f.owner, path, payload)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("retry: %d", r.StatusCode)
	}
	if err := json.NewDecoder(r.Body).Decode(&retry); err != nil {
		t.Fatal(err)
	}
	if first.CommentID <= 0 || first.CommentID != retry.CommentID || first.RecordID != f.private.ID || first.State != "committed" {
		t.Fatalf("receipts: %+v %+v", first, retry)
	}
	changed := map[string]any{"expectedUserId": ownerID, "mutationId": key, "body": "different"}
	if r := post(t, f.owner, path, changed); r.StatusCode != http.StatusConflict {
		t.Fatalf("changed request: %d", r.StatusCode)
	}
	var status store.RecordCommentAttemptResult
	r = cGet(t, f.owner, fmt.Sprintf("%s/%s?expectedUserId=%d", path, key, ownerID))
	if r.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", r.StatusCode)
	}
	if err := json.NewDecoder(r.Body).Decode(&status); err != nil || status.CommentID != first.CommentID {
		t.Fatalf("status=%+v err=%v", status, err)
	}
	// The ordinary doc receipt endpoint cannot expose record comments.
	docPath := fmt.Sprintf("%s/api/docs/%d/comment-attempts/%s?expectedUserId=%d", root, f.base.ID, key, ownerID)
	var docReceipt store.CommentAttemptResult
	r = cGet(t, f.owner, docPath)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("doc receipt: %d", r.StatusCode)
	}
	if err := json.NewDecoder(r.Body).Decode(&docReceipt); err != nil || docReceipt.State != "unknown" {
		t.Fatalf("doc receipt %+v %v", docReceipt, err)
	}
	setLockedFixture(t, f)
	r = post(t, f.owner, path, payload)
	var lockedRetry store.RecordCommentAttemptResult
	if r.StatusCode != http.StatusOK || json.NewDecoder(r.Body).Decode(&lockedRetry) != nil || lockedRetry.CommentID != first.CommentID {
		t.Fatalf("retry after visibility change: %d %+v", r.StatusCode, lockedRetry)
	}
	if r := post(t, f.guest, path, map[string]any{"expectedUserId": me.User.ID, "mutationId": "abcdef0123456789abcdef0123456789", "body": "not allowed"}); r.StatusCode != http.StatusForbidden {
		t.Fatalf("restricted writer: %d", r.StatusCode)
	}
	// A new comment on a filtered row must not create a notification or retain
	// a mention for an editor who can no longer see that row.
	privateKey := "ffffffffffffffffffffffffffffffff"
	r = post(t, f.owner, path, map[string]any{"expectedUserId": ownerID, "mutationId": privateKey, "body": "SECRET", "mentions": []int64{me.User.ID}})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("private create: %d", r.StatusCode)
	}
	for _, n := range notifications(t, f.guest, root) {
		if strings.Contains(n.Preview, "SECRET") {
			t.Fatalf("private notification: %+v", n)
		}
	}
	comments, err := f.st.Comments(context.Background(), f.base.ID)
	if err != nil {
		t.Fatal(err)
	}
	foundSecret := false
	for _, c := range comments {
		if c.Body == "SECRET" {
			foundSecret = true
			if len(c.Mentions) != 0 {
				t.Fatalf("hidden-row mention retained: %+v", c)
			}
		}
	}
	if !foundSecret {
		t.Fatal("missing private comment")
	}
	wrongParent := f.url + "/records/" + strconv.FormatInt(f.public.ID, 10) + "/comment-attempts"
	r = post(t, f.owner, wrongParent, map[string]any{"expectedUserId": ownerID, "mutationId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "body": "wrong parent", "parentId": first.CommentID})
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-record parent: %d", r.StatusCode)
	}
}
