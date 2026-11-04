package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// seedDoc rewrites the text of a doc's first paragraph through the op log.
func seedDoc(t *testing.T, s *Server, doc int64, text string) {
	t.Helper()
	d, _, err := StateAtHead(context.Background(), s.Store, doc)
	if err != nil {
		t.Fatal(err)
	}
	view := d.View()
	var para collab.OpID
	for _, b := range view.Blocks {
		if b.Type == "paragraph" {
			c, clock, _ := strings.Cut(b.ID, ":")
			client, _ := strconv.ParseUint(c, 10, 64)
			cl, _ := strconv.ParseUint(clock, 10, 64)
			para = collab.OpID{Client: client, Clock: cl}
			break
		}
	}
	var ops []collab.Op
	if n := len([]rune(d.Text(para))); n > 0 {
		ops = append(ops, d.DeleteText(9, para, 0, n)...)
	}
	if text != "" {
		ops = append(ops, d.InsertText(9, para, 0, text))
	}
	raws := make([]store.RawOp, len(ops))
	for i, op := range ops {
		b, _ := collab.EncodeOps([]collab.Op{op})
		raws[i] = store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b}
	}
	if _, err := s.Store.AppendOps(context.Background(), doc, raws); err != nil {
		t.Fatal(err)
	}
}

func viewText(v collab.DocView) string {
	var sb strings.Builder
	for _, b := range v.Blocks {
		for _, s := range b.Spans {
			sb.WriteString(s.Text)
		}
	}
	return sb.String()
}

func TestVersionsCreatePreviewRestore(t *testing.T) {
	st := store.NewMemory()
	s := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts, c := newTestServer(t, st, nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "ver@x.com", "name": "Ver", "password": "password123"})
	var d store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/docs", map[string]string{"title": "版本测试"}).Body).Decode(&d)
	seedDoc(t, s, d.ID, "第一版内容")

	// create a version
	res := post(t, c, ts.URL+"/api/docs/"+strconv.FormatInt(d.ID, 10)+"/versions", map[string]string{"label": "初稿"})
	if res.StatusCode != 201 {
		t.Fatalf("create version: %d", res.StatusCode)
	}

	// edit past the version
	seedDoc(t, s, d.ID, "第二版内容")

	// list + preview show the old text
	var list struct{ Versions []store.Version }
	r, _ := c.Get(ts.URL + "/api/docs/" + strconv.FormatInt(d.ID, 10) + "/versions")
	json.NewDecoder(r.Body).Decode(&list)
	if len(list.Versions) != 1 || list.Versions[0].Label != "初稿" {
		t.Fatalf("versions: %+v", list.Versions)
	}
	seq := list.Versions[0].Seq
	var preview struct{ View collab.DocView }
	r, _ = c.Get(ts.URL + "/api/docs/" + strconv.FormatInt(d.ID, 10) + "/versions/" + strconv.FormatInt(seq, 10))
	json.NewDecoder(r.Body).Decode(&preview)
	if !strings.Contains(viewText(preview.View), "第一版内容") {
		t.Fatalf("preview should show the version text: %q", viewText(preview.View))
	}

	// restore: ops are appended (history keeps growing), state converges
	headBefore, _ := st.Head(context.Background(), d.ID)
	res = post(t, c, ts.URL+"/api/docs/"+strconv.FormatInt(d.ID, 10)+"/versions/"+strconv.FormatInt(seq, 10)+"/restore", nil)
	if res.StatusCode != 200 {
		t.Fatalf("restore: %d", res.StatusCode)
	}
	headAfter, _ := st.Head(context.Background(), d.ID)
	if headAfter <= headBefore {
		t.Fatalf("restore must append ops (head %d → %d)", headBefore, headAfter)
	}
	cur, _, err := StateAtHead(context.Background(), st, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if text := viewText(cur.View()); !strings.Contains(text, "第一版内容") || strings.Contains(text, "第二版") {
		t.Fatalf("restored state wrong: %q", text)
	}

	// the old ops are still in the log (history not rewritten)
	rows, _ := st.OpsAfter(context.Background(), d.ID, 0, 10000)
	if int64(len(rows)) != headAfter {
		t.Fatalf("op log should keep all history: %d vs %d", len(rows), headAfter)
	}
}
