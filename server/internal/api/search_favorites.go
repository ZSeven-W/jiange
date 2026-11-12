package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"golang.org/x/text/cases"
)

func (s *Server) searchDocs(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	q := r.URL.Query().Get("q")
	if q == "" {
		httpx.JSON(w, http.StatusOK, map[string]any{"docs": []any{}})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	docs, err := s.searchMaterialized(ctx, u.ID, q)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
		s.Log.Error("document search incomplete", "err", err, "rid", httpx.RequestID(r))
		httpx.Error(w, http.StatusServiceUnavailable, "search_incomplete", "搜索未完成，请稍后重试。")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"docs": docs})
}

// Each document is read at a captured head. Pages are not a global snapshot:
// changes concurrent with this scan can appear in the next search instead.
func (s *Server) searchMaterialized(ctx context.Context, uid int64, query string) ([]store.DocMeta, error) {
	const pageSize = 100
	needle := cases.Fold().String(query)
	type scannedDoc struct {
		meta      store.DocMeta
		bodyMatch bool
	}
	scanned := []scannedDoc{}
	var after int64
	for {
		page, err := s.Store.SearchCandidates(ctx, uid, after, pageSize)
		if err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		for _, candidate := range page {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			after = candidate.ID
			bodyMatch := false
			if candidate.Kind == "doc" {
				doc, _, err := StateAtHead(ctx, s.Store, candidate.ID)
				if err != nil {
					// A node may have been deleted or its grant revoked while scanning.
					if _, accessErr := s.Store.GetDoc(ctx, uid, candidate.ID); errors.Is(accessErr, store.ErrNotFound) {
						continue
					}
					return nil, err
				}
				bodyMatch = searchableDocument(doc.View(), needle)
			}
			scanned = append(scanned, scannedDoc{candidate, bodyMatch})
		}
		if len(page) < pageSize {
			break
		}
	}
	// Recheck every candidate's grant and title. A rename may have happened
	// since enumeration, even for a candidate whose old title didn't match.
	checked := make([]store.DocMeta, 0)
	for _, scan := range scanned {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		fresh, err := s.Store.GetDoc(ctx, uid, scan.meta.ID)
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !scan.bodyMatch && !strings.Contains(cases.Fold().String(fresh.Title), needle) {
			continue
		}
		if fresh.WorkspaceName == "" {
			fresh.WorkspaceName = scan.meta.WorkspaceName
		}
		checked = append(checked, fresh)
	}
	sort.Slice(checked, func(i, j int) bool {
		if checked[i].UpdatedAt.Equal(checked[j].UpdatedAt) {
			return checked[i].ID > checked[j].ID
		}
		return checked[i].UpdatedAt.After(checked[j].UpdatedAt)
	})
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	checked, err := s.sanitizeDocList(ctx, uid, checked)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return checked, nil
}

// Search text the editor actually displays. Formula/diagram source and inline
// formula marks are intentionally excluded; they are not visible body text.
func searchableDocument(view collab.DocView, needle string) bool {
	fold := cases.Fold()
	contains := func(s string) bool { return strings.Contains(fold.String(s), needle) }
	for _, block := range view.Blocks {
		switch block.Type {
		case "title", "math", "diagram", "image", "divider", "columns":
			continue
		case "table":
			if cells := tableRows(block.Props); cells != nil {
				for _, row := range cells {
					for _, cell := range row {
						if contains(cell) {
							return true
						}
					}
				}
			}
			continue
		case "flowchart":
			// Editable flowchart: node text and edge labels are stored per object (fc.n.* / fc.e.*).
			for key, raw := range block.Props {
				if raw == "" || !(strings.HasPrefix(key, "fc.n.") || strings.HasPrefix(key, "fc.e.")) {
					continue
				}
				var obj struct {
					Text  string `json:"text"`
					Label string `json:"label"`
				}
				if json.Unmarshal([]byte(raw), &obj) == nil && (contains(obj.Text) || contains(obj.Label)) {
					return true
				}
			}
			continue
		case "file", "video", "bookmark":
			if contains(block.Props["name"]) || (block.Type == "bookmark" && contains(block.Props["url"])) {
				return true
			}
			continue
		}
		var text strings.Builder
		for _, span := range block.Spans {
			if span.Marks["math"] != "" {
				if contains(text.String()) {
					return true
				}
				text.Reset()
			} else {
				text.WriteString(span.Text)
			}
		}
		if contains(text.String()) {
			return true
		}
	}
	return false
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
	docs, err = s.sanitizeDocList(r.Context(), u.ID, docs)
	if err != nil {
		s.fail(w, r, err)
		return
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
	chain, err = s.sanitizeDocList(r.Context(), u.ID, chain)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ancestors": chain})
}

// pinStore is implemented by stores that support 置顶文档 (Postgres, Memory).
type pinStore interface {
	ListPins(ctx context.Context, userID int64) ([]store.DocMeta, error)
	AddPin(ctx context.Context, userID, docID int64) error
	RemovePin(ctx context.Context, userID, docID int64) error
}

func (s *Server) listPins(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	ps, ok := s.Store.(pinStore)
	if !ok {
		httpx.JSON(w, http.StatusOK, map[string]any{"docs": []store.DocMeta{}})
		return
	}
	docs, err := ps.ListPins(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if docs == nil {
		docs = []store.DocMeta{}
	}
	docs, err = s.sanitizeDocList(r.Context(), u.ID, docs)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"docs": docs})
}

func (s *Server) putPin(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	ps, ok := s.Store.(pinStore)
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "unsupported", "置顶不可用")
		return
	}
	d, ok := s.docFromPath(w, r)
	if !ok {
		return
	}
	var err error
	if r.Method == http.MethodDelete {
		err = ps.RemovePin(r.Context(), u.ID, d.ID)
	} else {
		err = ps.AddPin(r.Context(), u.ID, d.ID)
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
