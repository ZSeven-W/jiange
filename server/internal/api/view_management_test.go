package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

type interleavingViewStore struct {
	store.Store
	interleave func(context.Context, store.BaseWriteGuard, store.View) error
}

func (s *interleavingViewStore) UpdateViewGuarded(ctx context.Context, guard store.BaseWriteGuard, before, after store.View) (store.View, error) {
	if s.interleave != nil {
		f := s.interleave
		s.interleave = nil
		if err := f(ctx, guard, before); err != nil {
			return store.View{}, err
		}
	}
	return s.Store.UpdateViewGuarded(ctx, guard, before, after)
}

func TestViewManagementHTTP(t *testing.T) {
	_, c, u, _ := newBaseForViews(t)
	var full struct {
		Views []store.View `json:"views"`
	}
	response, err := c.Get(u)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.NewDecoder(response.Body).Decode(&full); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if len(full.Views) != 1 {
		t.Fatalf("views: %+v", full.Views)
	}
	first := full.Views[0]
	if res := send(t, c, "DELETE", u+"/views/"+strconv.FormatInt(first.ID, 10), nil); res.StatusCode != http.StatusConflict {
		t.Fatalf("delete last: %d", res.StatusCode)
	}
	created := post(t, c, u+"/views", map[string]any{"type": "kanban", "name": "看板"})
	var second store.View
	if err = json.NewDecoder(created.Body).Decode(&second); err != nil {
		t.Fatal(err)
	}
	created.Body.Close()
	dupResponse := post(t, c, u+"/views/"+strconv.FormatInt(first.ID, 10)+"/duplicate", map[string]any{})
	if dupResponse.StatusCode != http.StatusCreated {
		t.Fatalf("duplicate: %d", dupResponse.StatusCode)
	}
	var dup store.View
	if err = json.NewDecoder(dupResponse.Body).Decode(&dup); err != nil {
		t.Fatal(err)
	}
	dupResponse.Body.Close()
	if dup.Name != "表格 副本" || dup.Type != "grid" {
		t.Fatalf("duplicate: %+v", dup)
	}
	if res := post(t, c, u+"/views/reorder", map[string]any{"expectedViewIds": []int64{first.ID, second.ID}, "viewIds": []int64{second.ID, first.ID}}); res.StatusCode != http.StatusConflict {
		t.Fatalf("stale reorder: %d", res.StatusCode)
	}
	res := post(t, c, u+"/views/reorder", map[string]any{"expectedViewIds": []int64{first.ID, dup.ID, second.ID}, "viewIds": []int64{second.ID, dup.ID, first.ID}})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("reorder: %d", res.StatusCode)
	}
	var ordered struct {
		Views []store.View `json:"views"`
	}
	if err = json.NewDecoder(res.Body).Decode(&ordered); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if len(ordered.Views) != 3 || ordered.Views[0].ID != second.ID || ordered.Views[1].ID != dup.ID || ordered.Views[2].ID != first.ID {
		t.Fatalf("order: %+v", ordered)
	}
	if res := post(t, c, u+"/views/"+strconv.FormatInt(first.ID, 10)+"/duplicate", map[string]any{"name": ""}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty name: %d", res.StatusCode)
	}
}

func TestViewManagementRejectsRestrictedEditor(t *testing.T) {
	f := newBaseSecurityFixture(t)
	views, err := f.st.Views(t.Context(), f.base.ID)
	if err != nil || len(views) == 0 {
		t.Fatalf("views: %v %v", views, err)
	}
	id := strconv.FormatInt(views[0].ID, 10)
	setLockedFixture(t, f)
	if res := post(t, f.guest, f.url+"/views/"+id+"/duplicate", map[string]any{}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("copy restricted: %d", res.StatusCode)
	}
	if res := post(t, f.guest, f.url+"/views/reorder", map[string]any{"expectedViewIds": []int64{views[0].ID}, "viewIds": []int64{views[0].ID}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("reorder restricted: %d", res.StatusCode)
	}
	if res := send(t, f.guest, "DELETE", f.url+"/views/"+id, nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("delete restricted: %d", res.StatusCode)
	}
	dup := post(t, f.owner, f.url+"/views/"+id+"/duplicate", map[string]any{})
	if dup.StatusCode != http.StatusCreated {
		t.Fatalf("owner copy: %d", dup.StatusCode)
	}
}

func TestViewPatchCannotOverwriteConcurrentReorder(t *testing.T) {
	underlying := store.NewMemory()
	wrapped := &interleavingViewStore{Store: underlying}
	ts, c := newTestServer(t, wrapped, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "view-patch@example.test", "name": "Owner", "password": "password123"})
	var b store.DocMeta
	if err := json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b); err != nil {
		t.Fatal(err)
	}
	u := ts.URL + "/api/bases/" + strconv.FormatInt(b.ID, 10)
	views, err := underlying.Views(t.Context(), b.ID)
	if err != nil || len(views) != 1 {
		t.Fatalf("views=%v err=%v", views, err)
	}
	first := views[0]
	var second store.View
	if err := json.NewDecoder(post(t, c, u+"/views", map[string]any{"name": "Second", "type": "grid"}).Body).Decode(&second); err != nil {
		t.Fatal(err)
	}
	wrapped.interleave = func(ctx context.Context, guard store.BaseWriteGuard, before store.View) error {
		_, err := underlying.ReorderViews(ctx, guard, b.ID, []int64{first.ID, second.ID}, []int64{second.ID, first.ID})
		return err
	}
	r := send(t, c, "PATCH", u+"/views/"+strconv.FormatInt(first.ID, 10), map[string]any{"name": "Changed"})
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("stale patch: %d", r.StatusCode)
	}
	views, err = underlying.Views(t.Context(), b.ID)
	if err != nil || len(views) != 2 || views[0].ID != second.ID || views[1].ID != first.ID || views[1].Name != first.Name {
		t.Fatalf("lost reorder: %+v, %v", views, err)
	}
}
