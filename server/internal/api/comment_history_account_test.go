package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestCommentHistoryAccountBoundReopen(t *testing.T) {
	ts, owner := newTestServer(t, store.NewMemory(), nil)
	other := newCommentClient()
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "history-owner@example.test", "name": "Owner", "password": "password123"}).Body.Close()
	post(t, other, ts.URL+"/api/auth/register", map[string]string{"email": "history-other@example.test", "name": "Other", "password": "password123"}).Body.Close()
	var doc store.DocMeta
	r := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "History"})
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	base := fmt.Sprintf("%s/api/docs/%d", ts.URL, doc.ID)
	var comment store.Comment
	r = post(t, owner, base+"/comments", map[string]string{"body": "done"})
	if err := json.NewDecoder(r.Body).Decode(&comment); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	r = send(t, owner, "PATCH", fmt.Sprintf("%s/comments/%d", base, comment.ID), map[string]bool{"resolved": true})
	r.Body.Close()
	url := fmt.Sprintf("%s/account-comments/%d", base, comment.ID)
	patch := func(client *http.Client, account string) int {
		req, err := http.NewRequest("PATCH", url, bytes.NewBufferString(`{"resolved":false}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		if account != "" {
			req.Header.Set("X-Jiange-User-Id", account)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		return res.StatusCode
	}
	if got := patch(owner, ""); got != 400 {
		t.Fatalf("missing account: %d", got)
	}
	if got := patch(owner, "999"); got != 401 {
		t.Fatalf("wrong account: %d", got)
	}
	if got := patch(other, fmt.Sprint(doc.CreatorID)); got != 401 {
		t.Fatalf("switched session: %d", got)
	}
	cs, err := owner.Get(base + "/comments")
	if err != nil {
		t.Fatal(err)
	}
	var before struct {
		Comments []store.Comment `json:"comments"`
	}
	if err = json.NewDecoder(cs.Body).Decode(&before); err != nil {
		t.Fatal(err)
	}
	cs.Body.Close()
	if len(before.Comments) != 1 || !before.Comments[0].Resolved {
		t.Fatalf("rejected attempts changed comment: %+v", before.Comments)
	}
	if got := patch(owner, fmt.Sprint(doc.CreatorID)); got != 200 {
		t.Fatalf("reopen: %d", got)
	}
	cs, err = owner.Get(base + "/comments")
	if err != nil {
		t.Fatal(err)
	}
	var after struct {
		Comments []store.Comment `json:"comments"`
	}
	if err = json.NewDecoder(cs.Body).Decode(&after); err != nil {
		t.Fatal(err)
	}
	cs.Body.Close()
	if len(after.Comments) != 1 || after.Comments[0].Resolved {
		t.Fatalf("reopen not persisted: %+v", after.Comments)
	}
}
