package api

import (
	"context"
	"encoding/json"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestFavoritesSearchAncestors(t *testing.T) {
	st := store.NewMemory()
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "fs@x.com", "name": "FS", "password": "password123"})

	// parent + child docs; write body text into the child
	var parent, child store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/docs", map[string]string{"title": "产品需求"}).Body).Decode(&parent)
	json.NewDecoder(post(t, c, ts.URL+"/api/docs", map[string]any{"title": "登录页细节", "parentId": parent.ID}).Body).Decode(&child)

	// seed searchable body text (ops authored by client 9)
	d, _, err := StateAtHead(context.Background(), st, child.ID)
	if err != nil {
		t.Fatal(err)
	}
	var para collab.OpID
	for _, b := range d.View().Blocks {
		if b.Type == "paragraph" {
			a, cl, _ := strings.Cut(b.ID, ":")
			ca, _ := strconv.ParseUint(a, 10, 64)
			cc, _ := strconv.ParseUint(cl, 10, 64)
			para = collab.OpID{Client: ca, Clock: cc}
			break
		}
	}
	ops := []collab.Op{d.InsertText(9, para, 0, "独特的暗夜精灵语")}
	raws := make([]store.RawOp, len(ops))
	for i, op := range ops {
		b, _ := collab.EncodeOps([]collab.Op{op})
		raws[i] = store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b}
	}
	if _, err := st.AppendOps(context.Background(), child.ID, raws); err != nil {
		t.Fatal(err)
	}

	// title search
	r, _ := c.Get(ts.URL + "/api/search?q=" + url.QueryEscape("登录"))
	var res struct{ Docs []store.DocMeta }
	json.NewDecoder(r.Body).Decode(&res)
	if len(res.Docs) != 1 || res.Docs[0].ID != child.ID {
		t.Fatalf("title search: %+v", res.Docs)
	}
	// body search hits the child
	r, _ = c.Get(ts.URL + "/api/search?q=" + url.QueryEscape("暗夜精灵"))
	json.NewDecoder(r.Body).Decode(&res)
	if len(res.Docs) != 1 || res.Docs[0].ID != child.ID {
		t.Fatalf("body search: %+v", res.Docs)
	}

	// ancestors of child = [parent]
	r, _ = c.Get(ts.URL + "/api/docs/" + strconv.FormatInt(child.ID, 10) + "/ancestors")
	var anc struct{ Ancestors []store.DocMeta }
	json.NewDecoder(r.Body).Decode(&anc)
	if len(anc.Ancestors) != 1 || anc.Ancestors[0].ID != parent.ID {
		t.Fatalf("ancestors: %+v", anc.Ancestors)
	}

	// star the child; it shows in favorites; unstar removes it
	if res2 := send(t, c, "PUT", ts.URL+"/api/docs/"+strconv.FormatInt(child.ID, 10)+"/star", nil); res2.StatusCode != 204 {
		t.Fatalf("star: %d", res2.StatusCode)
	}
	r, _ = c.Get(ts.URL + "/api/favorites")
	json.NewDecoder(r.Body).Decode(&res)
	if len(res.Docs) != 1 || res.Docs[0].ID != child.ID {
		t.Fatalf("favorites: %+v", res.Docs)
	}
	if res2 := send(t, c, "DELETE", ts.URL+"/api/docs/"+strconv.FormatInt(child.ID, 10)+"/star", nil); res2.StatusCode != 204 {
		t.Fatalf("unstar: %d", res2.StatusCode)
	}
	r, _ = c.Get(ts.URL + "/api/favorites")
	json.NewDecoder(r.Body).Decode(&res)
	if len(res.Docs) != 0 {
		t.Fatalf("favorites after unstar: %+v", res.Docs)
	}
}
