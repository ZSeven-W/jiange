package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

type docInput struct {
	WorkspaceID int64   `json:"workspaceId"`
	ParentID    *int64  `json:"parentId"`
	Title       *string `json:"title"`
	// Move: when true, ParentID (null = root) re-parents the doc.
	Move bool `json:"move"`
	// CopyProtected: watermark + copy/download restrictions (manage only).
	CopyProtected *bool `json:"copyProtected"`
}

func cleanTitle(w http.ResponseWriter, t string) (string, bool) {
	t = strings.TrimSpace(t)
	if utf8.RuneCountInString(t) > 200 {
		httpx.Error(w, http.StatusBadRequest, "invalid_title", "title must be at most 200 characters")
		return "", false
	}
	return t, true
}

func (s *Server) listDocs(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	docs, err := s.Store.ListDocs(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	docs, err = s.sanitizeDocList(r.Context(), u.ID, docs)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"docs": docs})
}

func (s *Server) createDoc(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	var in docInput
	if r.ContentLength != 0 && !httpx.Decode(w, r, &in) {
		return
	}
	if in.WorkspaceID == 0 {
		ws, err := s.Store.Workspaces(r.Context(), u.ID)
		if err != nil || len(ws) == 0 {
			s.fail(w, r, errors.New("user has no workspace"))
			return
		}
		in.WorkspaceID = ws[0].ID
	}
	if ok, err := s.Store.CanCreateIn(r.Context(), u.ID, in.WorkspaceID); err != nil || !ok {
		httpx.Error(w, http.StatusForbidden, "forbidden", "not a member of this workspace")
		return
	}
	if in.ParentID != nil {
		p, err := s.Store.GetDoc(r.Context(), u.ID, *in.ParentID)
		if err != nil || p.WorkspaceID != in.WorkspaceID {
			httpx.Error(w, http.StatusBadRequest, "invalid_parent", "parent not found")
			return
		}
	}
	title := ""
	if in.Title != nil {
		var ok bool
		if title, ok = cleanTitle(w, *in.Title); !ok {
			return
		}
	}
	d, err := s.Store.CreateDoc(r.Context(), in.WorkspaceID, u.ID, in.ParentID, title, syncsrv.InitialOps(title))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	d = s.sanitizeWrittenDocMeta(r.Context(), u.ID, d)
	httpx.JSON(w, http.StatusCreated, d)
}

func (s *Server) docFromPath(w http.ResponseWriter, r *http.Request) (store.DocMeta, bool) {
	u, _ := UserFrom(r.Context())
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err == nil {
		var d store.DocMeta
		if d, err = s.Store.GetDoc(r.Context(), u.ID, id); err == nil {
			return d, true
		}
	}
	if err != nil && !errors.Is(err, store.ErrNotFound) && !errors.Is(err, strconv.ErrSyntax) && !errors.Is(err, strconv.ErrRange) {
		s.fail(w, r, err)
		return store.DocMeta{}, false
	}
	httpx.Error(w, http.StatusNotFound, "not_found", "document not found")
	return store.DocMeta{}, false
}

func (s *Server) getDoc(w http.ResponseWriter, r *http.Request) {
	if d, ok := s.docFromPath(w, r); ok {
		u, _ := UserFrom(r.Context())
		var err error
		d, err = s.sanitizeDocMeta(r.Context(), u.ID, d, nil)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		httpx.JSON(w, http.StatusOK, d)
	}
}

// patchDoc updates directory metadata. The title shown in the editor is a
// collaborative block; clients mirror it here so the doc tree stays current.
func (s *Server) patchDoc(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	var in docInput
	if !httpx.Decode(w, r, &in) {
		return
	}
	// Check the permissions of the whole request before applying any changes.
	// In particular, an editor must not be able to change the title as a side
	// effect of a rejected request that also contains a manager-only field.
	if (in.CopyProtected != nil || in.Move) && d.Role != store.RoleManage {
		httpx.Error(w, http.StatusForbidden, "forbidden", "需要manage权限")
		return
	}
	if in.Move && in.ParentID != nil {
		u, _ := UserFrom(r.Context())
		if p, err := s.Store.GetDoc(r.Context(), u.ID, *in.ParentID); err != nil || p.WorkspaceID != d.WorkspaceID {
			httpx.Error(w, http.StatusBadRequest, "invalid_parent", "parent not found")
			return
		}
	}
	var title string
	if in.Title != nil {
		t, ok := cleanTitle(w, *in.Title)
		if !ok {
			return
		}
		title = t
	}
	// Move checks for cycles before changing the parent. Do it before changing
	// other fields so a reported cycle conflict does not change those fields.
	if in.Move {
		if err := s.Store.Move(r.Context(), d.ID, in.ParentID); errors.Is(err, store.ErrConflict) {
			httpx.Error(w, http.StatusConflict, "cycle", "cannot move a doc into its own subtree")
			return
		} else if err != nil {
			s.fail(w, r, err)
			return
		}
		d.ParentID = in.ParentID
	}
	if in.Title != nil {
		if _, err := s.Store.UpdateTitle(r.Context(), d.ID, title); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	if in.CopyProtected != nil {
		if err := s.Store.SetCopyProtected(r.Context(), d.ID, *in.CopyProtected); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	// UpdateTitle is a system-level store operation: its returned metadata is
	// not scoped to the caller and lacks Role and WorkspaceName. Reload the
	// final state through the same access check as GET, including after a move.
	if current, ok := s.docFromPath(w, r); ok {
		u, _ := UserFrom(r.Context())
		current = s.sanitizeWrittenDocMeta(r.Context(), u.ID, current)
		httpx.JSON(w, http.StatusOK, current)
	}
}

func (s *Server) trashDoc(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleManage)
	if !ok {
		return
	}
	if err := s.Store.Trash(r.Context(), d.ID); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listTrash(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	docs, err := s.Store.ListTrash(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	docs, err = s.sanitizeDocList(r.Context(), u.ID, docs)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"docs": docs})
}

func (s *Server) restoreDoc(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	trash, err := s.Store.ListTrash(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	for _, d := range trash {
		if d.ID == id {
			if err := s.Store.Restore(r.Context(), id); err != nil {
				s.fail(w, r, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	httpx.Error(w, http.StatusNotFound, "not_found", "not in trash")
}
