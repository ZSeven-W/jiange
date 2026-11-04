package api

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

// duplicateDoc creates a copy of a doc (创建副本/从模板新建): the snapshot at
// head is transformed into the new empty doc via RestoreOps, so the copy is
// ordinary ops — collaborators converge and undo stays local.
func (s *Server) duplicateDoc(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	if d.Kind == "base" {
		httpx.Error(w, http.StatusBadRequest, "unsupported", "多维表格暂不支持复制")
		return
	}
	var in struct{ Title string }
	if r.ContentLength != 0 && !httpx.Decode(w, r, &in) {
		return
	}
	title := ""
	if in.Title != "" {
		if utf8.RuneCountInString(in.Title) > 200 {
			httpx.Error(w, http.StatusBadRequest, "invalid_title", "标题最多 200 字")
			return
		}
		title = strings.TrimSpace(in.Title)
	}
	src, _, err := StateAtHead(r.Context(), s.Store, d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	u, _ := UserFrom(r.Context())
	title = strings.TrimSuffix(title, " ")
	if title == "" {
		title = strings.TrimSpace(d.Title)
		if title == "" {
			title = "未命名文档"
		}
		title += " 副本"
	}
	nd, err := s.Store.CreateDoc(r.Context(), d.WorkspaceID, u.ID, d.ParentID, title, syncsrv.InitialOps(title))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	client, err := s.Store.AllocClient(r.Context(), u.ID, nd.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	empty := collab.NewDoc()
	ops := collab.RestoreOps(empty, src, uint64(client))
	for i, op := range ops {
		println("DBG op", i, op.T, "block=", op.Block.Key(), "text=", op.Text, "parent=", op.Parent.Key())
	}
	raws := make([]store.RawOp, 0, len(ops))
	for _, op := range ops {
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			s.fail(w, r, err)
			return
		}
		raws = append(raws, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
	}
	if len(raws) > 0 {
		if _, err := s.Store.AppendOps(r.Context(), nd.ID, raws); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	httpx.JSON(w, http.StatusCreated, nd)
}
