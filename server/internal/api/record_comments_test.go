package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestRecordCommentsAreScopedToVisibleRecords(t *testing.T) {
	f := newBaseSecurityFixture(t)
	pub := f.url + "/records/" + strconv.FormatInt(f.public.ID, 10) + "/comments"
	priv := f.url + "/records/" + strconv.FormatInt(f.private.ID, 10) + "/comments"
	if r := post(t, f.owner, pub, map[string]any{"body": "公开记录的评论"}); r.StatusCode != http.StatusCreated {
		t.Fatalf("add public comment %d", r.StatusCode)
	}
	if r := post(t, f.owner, priv, map[string]any{"body": "SECRET_RECORD_COMMENT"}); r.StatusCode != http.StatusCreated {
		t.Fatalf("add private comment %d", r.StatusCode)
	}
	var list struct{ Comments []store.Comment }
	json.NewDecoder(cGet(t, f.owner, pub).Body).Decode(&list)
	if len(list.Comments) != 1 || list.Comments[0].Body != "公开记录的评论" {
		t.Fatalf("public list %+v", list.Comments)
	}
	// generic doc comment list never includes record comments
	var docList struct{ Comments []store.Comment }
	json.NewDecoder(cGet(t, f.owner, f.url[:len(f.url)-len("/bases/"+strconv.FormatInt(f.base.ID, 10))]+"/docs/"+strconv.FormatInt(f.base.ID, 10)+"/comments").Body).Decode(&docList)
	if len(docList.Comments) != 0 {
		t.Fatalf("record comments leaked through doc list: %+v", docList.Comments)
	}
	if r := post(t, f.owner, f.url[:len(f.url)-len("/bases/"+strconv.FormatInt(f.base.ID, 10))]+"/docs/"+strconv.FormatInt(f.base.ID, 10)+"/comments", map[string]any{"body": "x", "block": "record:" + strconv.FormatInt(f.private.ID, 10)}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("generic endpoint must refuse record anchors, got %d", r.StatusCode)
	}
	setLockedFixture(t, f)
	if r := cGet(t, f.guest, priv); r.StatusCode != http.StatusNotFound {
		t.Fatalf("guest read of filtered record comments = %d", r.StatusCode)
	}
	if r := post(t, f.guest, priv, map[string]any{"body": "probe"}); r.StatusCode != http.StatusNotFound {
		t.Fatalf("guest comment on filtered record = %d", r.StatusCode)
	}
	var guestList struct{ Comments []store.Comment }
	json.NewDecoder(cGet(t, f.guest, pub).Body).Decode(&guestList)
	if len(guestList.Comments) != 1 {
		t.Fatalf("guest public list %+v", guestList.Comments)
	}
}
