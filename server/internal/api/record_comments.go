package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// Record comments reuse the document comment store with the anchor
// "record:<rid>" on the base node. They are only served through these
// endpoints, which first check that the reader can see the record under the
// base's locked-view policy; the generic /api/docs/{id}/comments list hides them.
const recordCommentPrefix = "record:"

func recordAnchor(rid int64) string { return recordCommentPrefix + strconv.FormatInt(rid, 10) }

func isRecordComment(c store.Comment) bool { return strings.HasPrefix(c.Block, recordCommentPrefix) }

// visibleRecord authorizes the base and confirms rid is readable by the caller.
func (s *Server) visibleRecord(w http.ResponseWriter, r *http.Request) (store.DocMeta, int64, bool) {
	b, ok := s.needBase(w, r, store.RoleView)
	if !ok {
		return b, 0, false
	}
	rid := pathID(r, "rid")
	u, _ := UserFrom(r.Context())
	read, err := s.readBaseAllowed(r.Context(), u.ID, b.ID)
	if err != nil {
		s.fail(w, r, err)
		return b, 0, false
	}
	for _, rec := range read.records {
		if rec.ID == rid {
			return b, rid, true
		}
	}
	httpx.Error(w, http.StatusNotFound, "not_found", "record not found")
	return b, 0, false
}

func (s *Server) listRecordComments(w http.ResponseWriter, r *http.Request) {
	b, rid, ok := s.visibleRecord(w, r)
	if !ok {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	cs, err := s.Store.Comments(r.Context(), b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	anchor := recordAnchor(rid)
	out := []store.Comment{}
	for _, c := range cs {
		if c.Block == anchor {
			out = append(out, c)
		}
	}
	if err := s.checkCommentReadAccess(r.Context(), guard, b.ID); err != nil {
		s.commentMutationError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"comments": out})
}

func (s *Server) addRecordComment(w http.ResponseWriter, r *http.Request) {
	b, rid, ok := s.visibleRecord(w, r)
	if !ok {
		return
	}
	var in struct {
		Body     string  `json:"body"`
		Mentions []int64 `json:"mentions"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	ci := commentInput{Body: in.Body, Mentions: in.Mentions, Block: recordAnchor(rid)}
	c, ok := ci.clean(w)
	if !ok {
		return
	}
	u, _ := UserFrom(r.Context())
	c.DocID, c.UserID = b.ID, u.ID
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	c, err := s.Store.AddCommentGuarded(r.Context(), guard, c)
	if err != nil {
		s.commentMutationError(w, r, err)
		return
	}
	s.commentResultAfterMutation(w, r, guard, b.ID, http.StatusCreated, c)
}
