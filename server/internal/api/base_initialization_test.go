package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

type failingBaseInitStore struct{ store.Store }

func (s failingBaseInitStore) CreateInitializedBase(context.Context, int64, int64, *int64, string) (store.DocMeta, error) {
	return store.DocMeta{}, errors.New("injected initialization error")
}

func TestCreateBaseDoesNotReportSuccessWhenInitializationFails(t *testing.T) {
	underlying := store.NewMemory()
	ts, client := newTestServer(t, failingBaseInitStore{underlying}, nil)
	if r := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "base-init-fail@example.test", "name": "Owner", "password": "password123"}); r.StatusCode != http.StatusCreated {
		t.Fatalf("register: %d", r.StatusCode)
	}
	res := post(t, client, ts.URL+"/api/bases", nil)
	if res.StatusCode != http.StatusInternalServerError {
		t.Fatalf("initialization failure was reported as success: %d", res.StatusCode)
	}
	docs, err := underlying.ListDocs(context.Background(), 1)
	if err != nil || len(docs) != 0 {
		t.Fatalf("failure left directory entries: %+v, %v", docs, err)
	}
}

func TestCreateBaseDefaultsAndParentAuthorization(t *testing.T) {
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	if r := post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "base-init-owner@example.test", "name": "Owner", "password": "password123"}); r.StatusCode != http.StatusCreated {
		t.Fatalf("owner: %d", r.StatusCode)
	}
	jar, _ := cookiejar.New(nil)
	other := &http.Client{Jar: jar}
	if r := post(t, other, ts.URL+"/api/auth/register", map[string]string{"email": "base-init-other@example.test", "name": "Other", "password": "password123"}); r.StatusCode != http.StatusCreated {
		t.Fatalf("other: %d", r.StatusCode)
	}
	var ownParent, foreignParent store.DocMeta
	if r := post(t, owner, ts.URL+"/api/docs", map[string]any{"title": "Own parent"}); r.StatusCode != http.StatusCreated {
		t.Fatalf("parent: %d", r.StatusCode)
	} else if err := json.NewDecoder(r.Body).Decode(&ownParent); err != nil {
		t.Fatal(err)
	}
	if r := post(t, other, ts.URL+"/api/docs", map[string]any{"title": "Foreign parent"}); r.StatusCode != http.StatusCreated {
		t.Fatalf("foreign parent: %d", r.StatusCode)
	} else if err := json.NewDecoder(r.Body).Decode(&foreignParent); err != nil {
		t.Fatal(err)
	}
	before, err := st.ListDocs(t.Context(), ownParent.CreatorID)
	if err != nil {
		t.Fatal(err)
	}
	for _, parent := range []int64{foreignParent.ID, 987654321} {
		r := post(t, owner, ts.URL+"/api/bases", map[string]any{"parentId": parent})
		if r.StatusCode != http.StatusBadRequest {
			t.Fatalf("invalid parent %d: %d", parent, r.StatusCode)
		}
	}
	if r := post(t, owner, ts.URL+"/api/bases", map[string]any{"workspaceId": foreignParent.WorkspaceID}); r.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign workspace: %d", r.StatusCode)
	}
	after, err := st.ListDocs(t.Context(), ownParent.CreatorID)
	if err != nil || len(after) != len(before) {
		t.Fatalf("failed create published node: before=%d after=%d err=%v", len(before), len(after), err)
	}
	r := post(t, owner, ts.URL+"/api/bases", map[string]any{"parentId": ownParent.ID})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("valid create: %d", r.StatusCode)
	}
	var base store.DocMeta
	if err := json.NewDecoder(r.Body).Decode(&base); err != nil {
		t.Fatal(err)
	}
	if base.ParentID == nil || *base.ParentID != ownParent.ID || base.Kind != "base" {
		t.Fatalf("base: %+v", base)
	}
	var full struct {
		Fields  []store.Field
		Views   []store.View
		Records []store.Record
	}
	get, err := owner.Get(ts.URL + "/api/bases/" + strconv.FormatInt(base.ID, 10))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewDecoder(get.Body).Decode(&full); err != nil {
		t.Fatal(err)
	}
	if len(full.Fields) != 1 || full.Fields[0].Name != "文本" || full.Fields[0].Type != "text" || len(full.Views) != 1 || full.Views[0].Name != "表格" || len(full.Records) != 5 {
		t.Fatalf("defaults: %+v", full)
	}
}
