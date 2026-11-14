package api

import (
	"errors"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// These routes are intentionally separate from the legacy comment endpoint:
// older servers must fail closed instead of silently ignoring mutation IDs.
func (s *Server) recordAttemptStore(w http.ResponseWriter) (store.RecordCommentAttemptStore, bool) {
	st, ok := s.Store.(store.RecordCommentAttemptStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "record_comment_attempt_unavailable", "服务器不支持安全发送记录评论")
	}
	return st, ok
}

func (s *Server) recordCommentAttemptCapabilities(w http.ResponseWriter, r *http.Request) {
	expected, ok := s.expectedCommentAccountQuery(w, r)
	if !ok {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	st, ok := s.recordAttemptStore(w)
	if !ok {
		return
	}
	if err := st.RecordCommentAttemptCapability(r.Context(), guard, pathID(r, "id"), pathID(r, "rid")); err != nil {
		s.commentAttemptCapabilityError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"version": 1, "userId": expected, "baseId": pathID(r, "id"), "recordId": pathID(r, "rid")})
}

func (s *Server) addRecordCommentAttempt(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Body           string  `json:"body"`
		Mentions       []int64 `json:"mentions"`
		ParentID       *int64  `json:"parentId"`
		MutationID     string  `json:"mutationId"`
		ExpectedUserID int64   `json:"expectedUserId"`
	}
	if !httpx.Decode(w, r, &in) || !s.expectCommentAccount(w, r, in.ExpectedUserID) {
		return
	}
	if !validCommentMutationID.MatchString(in.MutationID) {
		httpx.Error(w, http.StatusBadRequest, "invalid_mutation_id", "评论操作标识无效")
		return
	}
	baseID, recordID := pathID(r, "id"), pathID(r, "rid")
	ci := commentInput{Body: in.Body, Mentions: in.Mentions, ParentID: in.ParentID, Block: recordAnchor(recordID)}
	c, ok := ci.clean(w)
	if !ok {
		return
	}
	c.DocID, c.UserID = baseID, in.ExpectedUserID
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	st, ok := s.recordAttemptStore(w)
	if !ok {
		return
	}
	result, err := st.AddRecordCommentAttempt(r.Context(), guard, baseID, recordID, in.MutationID, c)
	if errors.Is(err, store.ErrCommentAttemptMismatch) {
		httpx.Error(w, http.StatusConflict, "comment_attempt_mismatch", "相同操作标识的评论内容不一致")
		return
	}
	if err != nil {
		s.commentAttemptCapabilityError(w, r, err)
		return
	}
	// The receipt contains only the caller's own operation identity, never the
	// comment or record content, even if access changes after commit.
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, result)
}

func (s *Server) getRecordCommentAttempt(w http.ResponseWriter, r *http.Request) {
	_, ok := s.expectedCommentAccountQuery(w, r)
	if !ok {
		return
	}
	id := r.PathValue("mutationId")
	if !validCommentMutationID.MatchString(id) {
		httpx.Error(w, http.StatusBadRequest, "invalid_mutation_id", "评论操作标识无效")
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	st, ok := s.recordAttemptStore(w)
	if !ok {
		return
	}
	result, err := st.GetRecordCommentAttempt(r.Context(), guard, pathID(r, "id"), pathID(r, "rid"), id)
	if err != nil {
		s.commentAttemptCapabilityError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, result)
}
