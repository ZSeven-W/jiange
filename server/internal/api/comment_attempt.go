package api

import (
	"errors"
	"net/http"
	"regexp"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

var validCommentMutationID = regexp.MustCompile(`^[0-9a-f]{32}$`)

type commentAttemptInput struct {
	commentInput
	MutationID     string `json:"mutationId"`
	ExpectedUserID int64  `json:"expectedUserId"`
}

// Check the account before resolving any document. An old tab's cookies may
// now belong to another user, and must not be treated as a document revoke.
func (s *Server) expectCommentAccount(w http.ResponseWriter, r *http.Request, expected int64) bool {
	if expected <= 0 || expected > 9007199254740991 {
		httpx.Error(w, http.StatusBadRequest, "invalid_expected_user", "评论账号标识无效")
		return false
	}
	u, ok := UserFrom(r.Context())
	if !ok || u.ID != expected {
		httpx.Error(w, http.StatusConflict, "comment_attempt_account_changed", "当前账号已变化，请切回原账号")
		return false
	}
	return true
}

func (s *Server) expectedCommentAccountQuery(w http.ResponseWriter, r *http.Request) (int64, bool) {
	values := r.URL.Query()["expectedUserId"]
	if len(values) != 1 {
		httpx.Error(w, http.StatusBadRequest, "invalid_expected_user", "评论账号标识无效")
		return 0, false
	}
	id, err := strconv.ParseInt(values[0], 10, 64)
	if err != nil || !s.expectCommentAccount(w, r, id) {
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_expected_user", "评论账号标识无效")
		}
		return 0, false
	}
	return id, true
}

func (s *Server) commentAttemptCapabilityError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrCommentAttemptAccountChanged):
		httpx.Error(w, http.StatusConflict, "comment_attempt_account_changed", "当前账号已变化，请切回原账号")
	case errors.Is(err, store.ErrForbidden), errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusForbidden, "comment_attempt_document_denied", "当前账号无法访问文档")
	default:
		s.commentMutationError(w, r, err)
	}
}

// The distinct route is an explicit capability boundary. Old servers return
// 404 rather than accidentally treating an idempotent request as a legacy POST.
func (s *Server) commentAttemptCapabilities(w http.ResponseWriter, r *http.Request) {
	expected, ok := s.expectedCommentAccountQuery(w, r)
	if !ok {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	docID := pathID(r, "id")
	canCopyQuote, err := s.Store.CommentAttemptCapabilityGuarded(r.Context(), guard, expected, docID)
	if err != nil {
		s.commentAttemptCapabilityError(w, r, err)
		return
	}
	if err := s.checkCommentReadAccess(r.Context(), guard, docID); err != nil {
		s.commentAttemptCapabilityError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"version": 1, "userId": expected, "canCopyQuote": canCopyQuote})
}

func (s *Server) addCommentAttempt(w http.ResponseWriter, r *http.Request) {
	var in commentAttemptInput
	if !httpx.Decode(w, r, &in) {
		return
	}
	if !s.expectCommentAccount(w, r, in.ExpectedUserID) {
		return
	}
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	if !validCommentMutationID.MatchString(in.MutationID) {
		httpx.Error(w, http.StatusBadRequest, "invalid_mutation_id", "评论操作标识无效")
		return
	}
	c, ok := in.commentInput.clean(w)
	if !ok {
		return
	}
	if d.Kind == "base" && isRecordComment(c) {
		httpx.Error(w, http.StatusBadRequest, "invalid_anchor", "记录评论请使用记录评论接口")
		return
	}
	c.DocID, c.UserID = d.ID, in.ExpectedUserID
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	result, err := s.Store.AddCommentAttemptGuarded(r.Context(), guard, in.MutationID, c)
	if errors.Is(err, store.ErrCommentAttemptAccountChanged) {
		s.commentAttemptCapabilityError(w, r, err)
		return
	}
	if errors.Is(err, store.ErrCommentAttemptMismatch) {
		httpx.Error(w, http.StatusConflict, "comment_attempt_mismatch", "相同操作标识的评论内容不一致")
		return
	}
	if err != nil {
		s.commentMutationError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if err := s.checkCommentReadAccess(r.Context(), guard, d.ID); err != nil {
		// The transaction committed; report only the outcome of this request,
		// never comment contents, to a caller who has since lost access.
		w.Header().Set("X-Comment-Result", result.State)
		w.Header().Set("X-Comment-Mutation-Id", in.MutationID)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}

// A missing receipt is reported as unknown because an earlier request may
// still be in flight. Only current readers may query their own attempt.
func (s *Server) getCommentAttempt(w http.ResponseWriter, r *http.Request) {
	expected, ok := s.expectedCommentAccountQuery(w, r)
	if !ok {
		return
	}
	d, ok := s.need(w, r, store.RoleView)
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
	result, err := s.Store.GetCommentAttemptGuarded(r.Context(), guard, expected, d.ID, id)
	if err != nil {
		s.commentAttemptCapabilityError(w, r, err)
		return
	}
	if err := s.checkCommentReadAccess(r.Context(), guard, d.ID); err != nil {
		s.commentMutationError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, result)
}
