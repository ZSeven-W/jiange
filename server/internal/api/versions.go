package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// StateAtHead rebuilds a doc's state from the latest snapshot + op log.
func StateAtHead(ctx context.Context, st store.DocStore, doc int64) (*collab.Doc, int64, error) {
	d := collab.NewDoc()
	var from int64
	if seq, state, err := st.LatestSnapshot(ctx, doc); err == nil {
		if d, err = collab.DecodeState(state); err != nil {
			return nil, 0, err
		}
		from = seq
	} else if !errors.Is(err, store.ErrNotFound) {
		return nil, 0, err
	}
	head, err := st.Head(ctx, doc)
	if err != nil {
		return nil, 0, err
	}
	for from < head {
		rows, err := st.OpsAfter(ctx, doc, from, 1000)
		if err != nil {
			return nil, 0, err
		}
		if len(rows) == 0 {
			break
		}
		for _, row := range rows {
			ops, err := collab.DecodeOps(row.Bytes)
			if err != nil {
				return nil, 0, err
			}
			for _, op := range ops {
				d.Apply(op)
			}
		}
		from = rows[len(rows)-1].Seq
	}
	return d, head, nil
}

// postVersion snapshots the doc at its current head and names it.
func (s *Server) postVersion(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	var in struct {
		Label string `json:"label"`
	}
	if r.ContentLength != 0 && !httpx.Decode(w, r, &in) {
		return
	}
	u, _ := UserFrom(r.Context())
	doc, head, err := StateAtHead(r.Context(), s.Store, d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if head == 0 {
		httpx.Error(w, http.StatusBadRequest, "empty", "文档还没有内容，无法创建版本")
		return
	}
	if err := s.Store.SaveSnapshot(r.Context(), d.ID, head, doc.EncodeState()); err != nil {
		s.fail(w, r, err)
		return
	}
	label := in.Label
	if label == "" {
		label = "手动版本"
	}
	if err := s.Store.SaveVersion(r.Context(), d.ID, head, label, u.ID); err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, store.Version{Seq: head, Label: label, CreatedBy: u.ID, CreatedByName: u.Name})
}

func (s *Server) listVersions(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	vs, err := s.Store.Versions(r.Context(), d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if vs == nil {
		vs = []store.Version{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"versions": vs})
}

// getVersion previews one version's materialized content (read-only).
func (s *Server) getVersion(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	seq, err := strconv.ParseInt(r.PathValue("seq"), 10, 64)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_seq", "bad seq")
		return
	}
	state, err := s.Store.VersionState(r.Context(), d.ID, seq)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "version not found")
		return
	}
	doc, err := collab.DecodeState(state)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"seq": seq, "view": doc.View()})
}

// restoreVersion transforms the current doc into the version's state by
// submitting ordinary ops (history is never rewritten; online users converge
// in realtime through the sync hub).
func (s *Server) restoreVersion(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	seq, err := strconv.ParseInt(r.PathValue("seq"), 10, 64)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_seq", "bad seq")
		return
	}
	state, err := s.Store.VersionState(r.Context(), d.ID, seq)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "version not found")
		return
	}
	target, err := collab.DecodeState(state)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	cur, _, err := StateAtHead(r.Context(), s.Store, d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	u, _ := UserFrom(r.Context())
	client, err := s.Store.AllocClient(r.Context(), u.ID, d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ops := collab.RestoreOps(cur, target, uint64(client))
	if len(ops) == 0 {
		httpx.JSON(w, http.StatusOK, map[string]any{"restored": 0})
		return
	}
	raws := make([]store.RawOp, len(ops))
	for i, op := range ops {
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			s.fail(w, r, err)
			return
		}
		raws[i] = store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b}
	}
	if _, err := s.Store.AppendOps(r.Context(), d.ID, raws); err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"restored": len(ops)})
}
