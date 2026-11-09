package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

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
		ParentID *int64  `json:"parentId"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	anchor := recordAnchor(rid)
	if in.ParentID != nil {
		// Replies hang under a root comment of the same record (one level, as in Feishu).
		parent, found, err := s.recordComment(r.Context(), b.ID, *in.ParentID)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		if !found || parent.Block != anchor || parent.ParentID != nil {
			httpx.Error(w, http.StatusNotFound, "not_found", "comment not found")
			return
		}
	}
	ci := commentInput{Body: in.Body, Mentions: in.Mentions, Block: anchor, ParentID: in.ParentID}
	c, ok := ci.clean(w)
	if !ok {
		return
	}
	// Only people who can open this record are notified; otherwise the
	// notification preview would leak a comment on a record they cannot see.
	mentions, err := s.recordReaders(r.Context(), b.ID, rid, c.Mentions)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	c.Mentions = mentions
	u, _ := UserFrom(r.Context())
	c.DocID, c.UserID = b.ID, u.ID
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	c, err = s.Store.AddCommentGuarded(r.Context(), guard, c)
	if err != nil {
		s.commentMutationError(w, r, err)
		return
	}
	s.commentResultAfterMutation(w, r, guard, b.ID, http.StatusCreated, c)
}

// patchRecordComment resolves/reopens a thread or edits one's own comment.
func (s *Server) patchRecordComment(w http.ResponseWriter, r *http.Request) {
	b, rid, ok := s.visibleRecord(w, r)
	if !ok {
		return
	}
	var in commentPatch
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Body != nil && (utf8.RuneCountInString(*in.Body) == 0 || utf8.RuneCountInString(*in.Body) > 2000) {
		httpx.Error(w, http.StatusBadRequest, "invalid_body", "评论需要 1-2000 字")
		return
	}
	cid := pathID(r, "cid")
	if !s.ownRecordComment(w, r, b.ID, rid, cid) {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	cur, _, err := s.Store.PatchCommentGuarded(r.Context(), guard, b.ID, cid, in.Body, in.Resolved)
	if err != nil {
		s.commentMutationError(w, r, err)
		return
	}
	s.commentResultAfterMutation(w, r, guard, b.ID, http.StatusOK, cur)
}

func (s *Server) deleteRecordComment(w http.ResponseWriter, r *http.Request) {
	b, rid, ok := s.visibleRecord(w, r)
	if !ok {
		return
	}
	cid := pathID(r, "cid")
	if !s.ownRecordComment(w, r, b.ID, rid, cid) {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	if err := s.Store.DeleteCommentGuarded(r.Context(), guard, b.ID, cid); err != nil {
		s.commentMutationError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ownRecordComment confirms cid is a comment on record rid (404 otherwise).
func (s *Server) ownRecordComment(w http.ResponseWriter, r *http.Request, baseID, rid, cid int64) bool {
	c, found, err := s.recordComment(r.Context(), baseID, cid)
	if err != nil {
		s.fail(w, r, err)
		return false
	}
	if !found || c.Block != recordAnchor(rid) {
		httpx.Error(w, http.StatusNotFound, "not_found", "comment not found")
		return false
	}
	return true
}

func (s *Server) recordComment(ctx context.Context, baseID, cid int64) (store.Comment, bool, error) {
	cs, err := s.Store.Comments(ctx, baseID)
	if err != nil {
		return store.Comment{}, false, err
	}
	for _, c := range cs {
		if c.ID == cid {
			return c, true, nil
		}
	}
	return store.Comment{}, false, nil
}

// recordReaders keeps the users in ids who can currently read record rid.
func (s *Server) recordReaders(ctx context.Context, baseID, rid int64, ids []int64) ([]int64, error) {
	out := []int64{}
	seen := map[int64]bool{}
	for _, id := range ids {
		if id <= 0 || seen[id] {
			continue
		}
		seen[id] = true
		read, err := s.readBaseAllowed(ctx, id, baseID)
		if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrForbidden) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, rec := range read.records {
			if rec.ID == rid {
				out = append(out, id)
				break
			}
		}
	}
	return out, nil
}
