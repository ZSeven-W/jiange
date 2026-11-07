package api

import (
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
	d, ok := s.need(w, r, store.RoleEdit)
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
	c, err := s.Store.AddComment(r.Context(), c)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.notifyComment(r, d.ID, u, &c, in.ParentID)
	httpx.JSON(w, http.StatusCreated, c)
}

// notifyComment fans notifications out to the mentioned users and, for a
// reply, the parent comment's author.
func (s *Server) notifyComment(r *http.Request, docID int64, actor store.User, c *store.Comment, parentID *int64) {
	kind := "mention"
	recipients := map[int64]bool{}
	if parentID != nil {
		kind = "reply"
		if uid, err := s.Store.CommentAuthor(r.Context(), docID, *parentID); err == nil && uid != actor.ID {
			recipients[uid] = true
		}
	}
	for _, uid := range c.Mentions {
		if uid != actor.ID {
			recipients[uid] = true
		}
	}
	if len(recipients) == 0 {
		return
	}
	items := make([]store.Notification, 0, len(recipients))
	for uid := range recipients {
		commentID := c.ID
		items = append(items, store.Notification{
			UserID: uid, DocID: docID, ActorID: actor.ID, ActorName: actor.Name,
			CommentID: &commentID, Kind: kind, Preview: snippet(c.Body),
		})
	}
	if err := s.Store.AddNotifications(r.Context(), items); err != nil {
		s.Log.Error("notify comment", "err", err)
	}
}

func (s *Server) listComments(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
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
	httpx.JSON(w, http.StatusOK, map[string]any{"comments": cs})
}

type commentPatch struct {
	Body     *string `json:"body"`
	Resolved *bool   `json:"resolved"`
}

func (s *Server) patchComment(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	var in commentPatch
	if !httpx.Decode(w, r, &in) {
		return
	}
	cs, err := s.Store.Comments(r.Context(), d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	u, _ := UserFrom(r.Context())
	var cur *store.Comment
	for i := range cs {
		if cs[i].ID == pathID(r, "cid") {
			cur = &cs[i]
			break
		}
	}
	if cur == nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "comment not found")
		return
	}
	if in.Body != nil && cur.UserID != u.ID {
		httpx.Error(w, http.StatusForbidden, "forbidden", "只能编辑自己的评论")
		return
	}
	if in.Body != nil {
		if utf8.RuneCountInString(*in.Body) == 0 || utf8.RuneCountInString(*in.Body) > 2000 {
			httpx.Error(w, http.StatusBadRequest, "invalid_body", "评论需要 1-2000 字")
			return
		}
		cur.Body = *in.Body
	}
	if in.Resolved != nil && *in.Resolved != cur.Resolved {
		cur.Resolved = *in.Resolved
		if *in.Resolved {
			// notify thread participants (author + mentioned) except the resolver
			commentID := cur.ID
			recipients := map[int64]bool{}
			if cur.UserID != u.ID {
				recipients[cur.UserID] = true
			}
			for _, uid := range cur.Mentions {
				if uid != u.ID {
					recipients[uid] = true
				}
			}
			items := make([]store.Notification, 0, len(recipients))
			for uid := range recipients {
				items = append(items, store.Notification{
					UserID: uid, DocID: d.ID, ActorID: u.ID, ActorName: u.Name,
					CommentID: &commentID, Kind: "resolve", Preview: snippet(cur.Body),
				})
			}
			if len(items) > 0 {
				_ = s.Store.AddNotifications(r.Context(), items)
			}
		}
	}
	c, err := s.Store.UpdateComment(r.Context(), *cur)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "comment not found")
		return
	} else if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, c)
}

func (s *Server) deleteComment(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	u, _ := UserFrom(r.Context())
	cs, err := s.Store.Comments(r.Context(), d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	for _, c := range cs {
		if c.ID == pathID(r, "cid") {
			if c.UserID != u.ID && d.Role != store.RoleManage {
				httpx.Error(w, http.StatusForbidden, "forbidden", "只能删除自己的评论")
				return
			}
			if err := s.Store.DeleteComment(r.Context(), d.ID, c.ID); err != nil {
				s.fail(w, r, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	httpx.Error(w, http.StatusNotFound, "not_found", "comment not found")
}

// ---- notification center ----

func (s *Server) listNotifications(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	items, err := s.Store.Notifications(r.Context(), u.ID, 50)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if items == nil {
		items = []store.Notification{}
	}
	unread, err := s.Store.UnreadCount(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"notifications": items, "unread": unread})
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
