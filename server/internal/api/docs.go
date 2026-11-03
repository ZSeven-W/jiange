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
	if in.Title != nil {
		t, ok := cleanTitle(w, *in.Title)
		if !ok {
			return
		}
		var err error
		if d, err = s.Store.UpdateTitle(r.Context(), d.ID, t); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	if in.Move {
		if d.Role != store.RoleManage {
			httpx.Error(w, http.StatusForbidden, "forbidden", "需要manage权限")
			return
		}
		if in.ParentID != nil {
			u, _ := UserFrom(r.Context())
			if p, err := s.Store.GetDoc(r.Context(), u.ID, *in.ParentID); err != nil || p.WorkspaceID != d.WorkspaceID {
				httpx.Error(w, http.StatusBadRequest, "invalid_parent", "parent not found")
				return
			}
		}
		if err := s.Store.Move(r.Context(), d.ID, in.ParentID); errors.Is(err, store.ErrConflict) {
			httpx.Error(w, http.StatusConflict, "cycle", "cannot move a doc into its own subtree")
			return
		} else if err != nil {
			s.fail(w, r, err)
			return
		}
		d.ParentID = in.ParentID
	}
	httpx.JSON(w, http.StatusOK, d)
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
