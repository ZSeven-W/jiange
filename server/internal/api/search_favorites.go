package api

import (
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) searchDocs(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	q := r.URL.Query().Get("q")
	if q == "" {
		httpx.JSON(w, http.StatusOK, map[string]any{"docs": []any{}})
		return
	}
	docs, err := s.Store.SearchDocs(r.Context(), u.ID, q)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if docs == nil {
		docs = []store.DocMeta{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"docs": docs})
}

func (s *Server) listFavorites(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	docs, err := s.Store.ListFavorites(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if docs == nil {
		docs = []store.DocMeta{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"docs": docs})
}

func (s *Server) putFavorite(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	d, ok := s.docFromPath(w, r)
	if !ok {
		return
	}
	if r.Method == http.MethodDelete {
		if err := s.Store.RemoveFavorite(r.Context(), u.ID, d.ID); err != nil {
			s.fail(w, r, err)
			return
		}
	} else {
		if err := s.Store.AddFavorite(r.Context(), u.ID, d.ID); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getAncestors(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	d, ok := s.docFromPath(w, r)
	if !ok {
		return
	}
	chain, err := s.Store.Ancestors(r.Context(), u.ID, d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if chain == nil {
		chain = []store.DocMeta{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ancestors": chain})
}
