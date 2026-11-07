package api

import (
	"context"
	"errors"
	"net/http"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type commentInput struct {
	ParentID  *int64  `json:"parentId"`
	Block     string  `json:"block"`
	StartChar string  `json:"startChar"`
	EndChar   string  `json:"endChar"`
	Quote     string  `json:"quote"`
	Body      string  `json:"body"`
	Mentions  []int64 `json:"mentions"`
}

func (in *commentInput) clean(w http.ResponseWriter) (store.Comment, bool) {
	c := store.Comment{ParentID: in.ParentID, Block: in.Block, StartChar: in.StartChar, EndChar: in.EndChar}
	if utf8.RuneCountInString(in.Body) == 0 || utf8.RuneCountInString(in.Body) > 2000 {
		httpx.Error(w, http.StatusBadRequest, "invalid_body", "评论需要 1-2000 字")
		return c, false
	}
	c.Body = in.Body
	if utf8.RuneCountInString(in.Quote) > 500 {
		httpx.Error(w, http.StatusBadRequest, "invalid_quote", "引用文本过长")
		return c, false
	}
	c.Quote = in.Quote
	if len(in.Mentions) > 20 {
		httpx.Error(w, http.StatusBadRequest, "invalid_mentions", "最多 @ 20 人")
		return c, false
	}
	c.Mentions = in.Mentions
	for _, s := range []string{in.Block, in.StartChar, in.EndChar} {
		if utf8.RuneCountInString(s) > 64 {
			httpx.Error(w, http.StatusBadRequest, "invalid_anchor", "锚点过长")
			return c, false
		}
	}
	return c, true
}

// snippet is the notification preview (first 60 runes of the body).
func snippet(body string) string {
	r := []rune(body)
	if len(r) > 60 {
		return string(r[:60]) + "…"
	}
	return body
}

func (s *Server) addComment(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	var in commentInput
	if !httpx.Decode(w, r, &in) {
		return
	}
	c, ok := in.clean(w)
	if !ok {
		return
	}
	u, _ := UserFrom(r.Context())
	c.DocID = d.ID
	c.UserID = u.ID
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	c, err := s.Store.AddCommentGuarded(r.Context(), guard, c)
	if err != nil {
		s.commentMutationError(w, r, err)
		return
	}
	s.commentResultAfterMutation(w, r, guard, d.ID, http.StatusCreated, c)
}

func (s *Server) listComments(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	cs, err := s.Store.Comments(r.Context(), d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if cs == nil {
		cs = []store.Comment{}
	}
	if err := s.checkCommentReadAccess(r.Context(), guard, d.ID); err != nil {
		s.commentMutationError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"comments": cs})
}

type commentPatch struct {
	Body     *string `json:"body"`
	Resolved *bool   `json:"resolved"`
}

func (s *Server) patchComment(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	var in commentPatch
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Body != nil {
		if utf8.RuneCountInString(*in.Body) == 0 || utf8.RuneCountInString(*in.Body) > 2000 {
			httpx.Error(w, http.StatusBadRequest, "invalid_body", "评论需要 1-2000 字")
			return
		}
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	cur, _, err := s.Store.PatchCommentGuarded(r.Context(), guard, d.ID, pathID(r, "cid"), in.Body, in.Resolved)
	if err != nil {
		s.commentMutationError(w, r, err)
		return
	}
	s.commentResultAfterMutation(w, r, guard, d.ID, http.StatusOK, cur)
}

func (s *Server) checkCommentReadAccess(ctx context.Context, guard store.RestoreGuard, docID int64) error {
	doc, err := s.Store.GetDoc(ctx, guard.UserID, docID)
	if errors.Is(err, store.ErrNotFound) || err == nil && store.RoleRank(doc.Role) < store.RoleRank(store.RoleView) {
		return store.ErrForbidden
	}
	if err != nil {
		return err
	}
	u, err := s.Store.SessionUser(ctx, guard.SessionHash, s.now())
	if errors.Is(err, store.ErrNotFound) || err == nil && u.ID != guard.UserID {
		return store.ErrUnauthenticated
	}
	return err
}

// An authorized mutation may have committed just before its caller lost
// access. Avoid both leaking the comment and falsely reporting a failed write.
func (s *Server) commentResultAfterMutation(w http.ResponseWriter, r *http.Request, guard store.RestoreGuard, docID int64, status int, c store.Comment) {
	w.Header().Set("Cache-Control", "no-store")
	if err := s.checkCommentReadAccess(r.Context(), guard, docID); err != nil {
		w.Header().Set("X-Comment-Refresh-Required", "true")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	httpx.JSON(w, status, c)
}

func (s *Server) deleteComment(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	if err := s.Store.DeleteCommentGuarded(r.Context(), guard, d.ID, pathID(r, "cid")); err != nil {
		s.commentMutationError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) commentMutationError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
	case errors.Is(err, store.ErrCommentPermissionDenied):
		httpx.Error(w, http.StatusForbidden, "comment_permission_denied", "当前没有评论权限")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前没有评论权限")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "评论或文档不存在")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "comment_conflict", "文档或评论已变化，请重试")
	default:
		s.fail(w, r, err)
	}
}

// ---- notification center ----

func (s *Server) listNotifications(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	items, err := s.Store.Notifications(r.Context(), u.ID, 50)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// Recheck document access after collecting previews. This narrows the
	// interval in which a concurrent revoke could expose an already-read
	// notification; it cannot make the network send itself atomic with revoke.
	allowed := map[int64]bool{}
	checked := map[int64]bool{}
	visible := make([]store.Notification, 0, len(items))
	for _, item := range items {
		if !checked[item.DocID] {
			checked[item.DocID] = true
			meta, e := s.Store.GetDocSystem(r.Context(), item.DocID)
			if e != nil && !errors.Is(e, store.ErrNotFound) {
				s.fail(w, r, e)
				return
			}
			if e == nil && meta.Kind != "doc" {
				allowed[item.DocID] = true
			} else if e == nil {
				current, e := s.Store.GetDoc(r.Context(), u.ID, item.DocID)
				if e != nil && !errors.Is(e, store.ErrNotFound) {
					s.fail(w, r, e)
					return
				}
				allowed[item.DocID] = e == nil && store.RoleRank(current.Role) >= store.RoleRank(store.RoleView)
			}
		}
		if allowed[item.DocID] {
			visible = append(visible, item)
		}
	}
	unread, err := s.Store.UnreadCount(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	current, err := s.Store.SessionUser(r.Context(), guard.SessionHash, s.now())
	if errors.Is(err, store.ErrNotFound) || err == nil && current.ID != u.ID {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"notifications": visible, "unread": unread})
}

func (s *Server) markNotificationsRead(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if r.ContentLength != 0 && !httpx.Decode(w, r, &in) {
		return
	}
	if err := s.Store.MarkRead(r.Context(), u.ID, in.IDs); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// docMembers lists autocomplete candidates without exposing the workspace
// directory to external document collaborators.
func (s *Server) docMembers(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	u, _ := UserFrom(r.Context())
	spaces, err := s.Store.Workspaces(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	isMember := func(spaces []store.Workspace) bool {
		for _, space := range spaces {
			if space.ID == d.WorkspaceID {
				return true
			}
		}
		return false
	}
	member := isMember(spaces)
	ms, err := s.Store.WorkspaceMembers(r.Context(), d.WorkspaceID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	shares, err := s.Store.ListShares(r.Context(), d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	seen := map[int64]bool{}
	out := make([]store.User, 0, len(ms)+len(shares))
	for _, m := range ms {
		if (member || m.ID == d.CreatorID) && !seen[m.ID] {
			seen[m.ID] = true
			out = append(out, store.User{ID: m.ID, Email: m.Email, Name: m.Name, CreatedAt: m.CreatedAt})
		}
	}
	for _, sh := range shares {
		if !seen[sh.UserID] {
			seen[sh.UserID] = true
			out = append(out, store.User{ID: sh.UserID, Email: sh.Email, Name: sh.Name})
		}
	}
	// Link or inherited access may not have a direct share on this document.
	if !seen[u.ID] {
		out = append(out, store.User{ID: u.ID, Email: u.Email, Name: u.Name})
	}
	// A revocation during candidate collection must not leak the old result.
	current, err := s.Store.GetDoc(r.Context(), u.ID, d.ID)
	if errors.Is(err, store.ErrNotFound) || err == nil && (store.RoleRank(current.Role) < store.RoleRank(store.RoleView) || current.WorkspaceID != d.WorkspaceID) {
		httpx.Error(w, http.StatusForbidden, "forbidden", "文档权限已变化")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	spaces, err = s.Store.Workspaces(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if member && !isMember(spaces) {
		httpx.Error(w, http.StatusForbidden, "forbidden", "工作区权限已变化")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"members": out})
}
