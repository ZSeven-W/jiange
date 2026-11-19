package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"golang.org/x/text/cases"
)

const searchSegmentSep = "\x1f"

type searchFilters struct {
	Kind        string
	Owner       string
	FolderID    int64
	UpdatedFrom *time.Time
	UpdatedTo   *time.Time
}

func (f searchFilters) hasAny() bool {
	return (f.Kind != "" && f.Kind != "all") ||
		(f.Owner != "" && f.Owner != "all") ||
		f.FolderID > 0 ||
		f.UpdatedFrom != nil ||
		f.UpdatedTo != nil
}

func parseSearchDateBound(raw string, endOfDay bool) (*time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	if ts, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		if endOfDay {
			ts = ts.Add(time.Nanosecond)
		}
		return &ts, nil
	}
	if d, err := time.ParseInLocation("2006-01-02", raw, time.Local); err == nil {
		if endOfDay {
			d = d.AddDate(0, 0, 1)
		}
		return &d, nil
	}
	return nil, fmt.Errorf("invalid date %q", raw)
}

func parseSearchFilters(r *http.Request) (searchFilters, error) {
	q := r.URL.Query()
	var f searchFilters
	kind := strings.TrimSpace(q.Get("kind"))
	switch kind {
	case "", "all", "doc", "board", "sheet", "base", "slides", "survey", "folder", "file":
		f.Kind = kind
	default:
		return f, fmt.Errorf("invalid kind")
	}
	owner := strings.TrimSpace(q.Get("owner"))
	switch owner {
	case "", "all", "mine":
		f.Owner = owner
	default:
		return f, fmt.Errorf("invalid owner")
	}
	if rawFolder := strings.TrimSpace(q.Get("folderId")); rawFolder != "" {
		id, err := strconv.ParseInt(rawFolder, 10, 64)
		if err != nil || id <= 0 {
			return f, fmt.Errorf("invalid folderId")
		}
		f.FolderID = id
	}
	from, err := parseSearchDateBound(q.Get("updatedFrom"), false)
	if err != nil {
		return f, err
	}
	to, err := parseSearchDateBound(q.Get("updatedTo"), true)
	if err != nil {
		return f, err
	}
	f.UpdatedFrom = from
	f.UpdatedTo = to
	return f, nil
}

func matchesKindFilter(meta store.DocMeta, kind string) bool {
	if kind == "" || kind == "all" {
		return true
	}
	if kind == "board" {
		return meta.Kind == "doc" && meta.DocType == "board"
	}
	if kind == "doc" {
		return meta.Kind == "doc" && meta.DocType != "board"
	}
	return meta.Kind == kind
}

func (s *Server) searchDocs(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	q := r.URL.Query().Get("q")
	filters, err := parseSearchFilters(r)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_filter", "无效的搜索筛选参数。")
		return
	}
	if q == "" && !filters.hasAny() {
		httpx.JSON(w, http.StatusOK, map[string]any{"docs": []any{}})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	docs, err := s.searchMaterializedFiltered(ctx, u.ID, q, filters)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
		if s.Log != nil {
			s.Log.Error("document search incomplete", "err", err, "rid", httpx.RequestID(r))
		}
		httpx.Error(w, http.StatusServiceUnavailable, "search_incomplete", "搜索未完成，请稍后重试。")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"docs": docs})
}

// Each document is read at a captured head. Pages are not a global snapshot:
// changes concurrent with this scan can appear in the next search instead.
func (s *Server) searchMaterialized(ctx context.Context, uid int64, query string) ([]store.DocMeta, error) {
	return s.searchMaterializedFiltered(ctx, uid, query, searchFilters{})
}

func (s *Server) searchMaterializedFiltered(ctx context.Context, uid int64, query string, filters searchFilters) ([]store.DocMeta, error) {
	const pageSize = 100
	if filters.FolderID > 0 {
		if _, err := s.Store.GetDoc(ctx, uid, filters.FolderID); errors.Is(err, store.ErrNotFound) {
			return []store.DocMeta{}, nil
		} else if err != nil {
			return nil, err
		}
	}
	needle := cases.Fold().String(query)
	idxStore, hasIndex := s.Store.(store.SearchIndexStore)
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
			if !matchesKindFilter(candidate, filters.Kind) {
				continue
			}
			if filters.Owner == "mine" && candidate.CreatorID != uid {
				continue
			}
			bodyMatch := false
			if needle != "" {
				var skip bool
				switch candidate.Kind {
				case "doc":
					bodyMatch, skip, err = s.matchDocBody(ctx, uid, candidate, needle, idxStore, hasIndex)
				case "sheet":
					matched, sheetErr := s.Store.SearchSheetContent(ctx, uid, candidate.ID, needle)
					if sheetErr != nil {
						if _, accessErr := s.Store.GetDoc(ctx, uid, candidate.ID); errors.Is(accessErr, store.ErrNotFound) {
							skip = true
							err = nil
						} else {
							err = sheetErr
						}
					} else {
						bodyMatch = matched
					}
				case "base":
					bodyMatch, skip, err = s.matchBaseBody(ctx, uid, candidate, needle, idxStore, hasIndex)
				case "slides":
					bodyMatch, skip, err = s.matchSlidesBody(ctx, uid, candidate, needle, idxStore, hasIndex)
				case "survey":
					bodyMatch, skip, err = s.matchSurveyBody(ctx, uid, candidate, needle, idxStore, hasIndex)
				}
				if err != nil {
					return nil, err
				}
				if skip {
					continue
				}
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
		if !matchesKindFilter(fresh, filters.Kind) {
			continue
		}
		if filters.Owner == "mine" && fresh.CreatorID != uid {
			continue
		}
		if filters.UpdatedFrom != nil && fresh.UpdatedAt.Before(*filters.UpdatedFrom) {
			continue
		}
		if filters.UpdatedTo != nil && !fresh.UpdatedAt.Before(*filters.UpdatedTo) {
			continue
		}
		if needle != "" && !scan.bodyMatch && !strings.Contains(cases.Fold().String(fresh.Title), needle) {
			continue
		}
		if filters.FolderID > 0 {
			if fresh.ID == filters.FolderID {
				continue
			}
			inFolder, err := s.nodeInFolder(ctx, uid, fresh, filters.FolderID)
			if err != nil {
				if errors.Is(err, store.ErrNotFound) {
					continue
				}
				return nil, err
			}
			if !inFolder {
				continue
			}
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

func (s *Server) nodeInFolder(ctx context.Context, uid int64, doc store.DocMeta, folderID int64) (bool, error) {
	if doc.ParentID != nil && *doc.ParentID == folderID {
		return true, nil
	}
	ancestors, err := s.Store.Ancestors(ctx, uid, doc.ID)
	if err != nil {
		return false, err
	}
	for _, anc := range ancestors {
		if anc.ID == folderID {
			return true, nil
		}
	}
	return false, nil
}

func (s *Server) matchDocBody(ctx context.Context, uid int64, candidate store.DocMeta, needle string, idxStore store.SearchIndexStore, hasIndex bool) (matched bool, skip bool, err error) {
	epoch, head, err := s.Store.HeadVersion(ctx, candidate.ID)
	if err != nil {
		if _, accessErr := s.Store.GetDoc(ctx, uid, candidate.ID); errors.Is(accessErr, store.ErrNotFound) {
			return false, true, nil
		}
		return false, false, err
	}
	if hasIndex {
		if entry, err := idxStore.GetSearchIndex(ctx, candidate.ID); err == nil && entry.SourceEpoch == epoch && entry.SourceSeq == head {
			return matchSearchSegments(entry.BodyText, needle), false, nil
		}
	}
	doc, seq, err := StateAtHead(ctx, s.Store, candidate.ID)
	if err != nil {
		// A node may have been deleted or its grant revoked while scanning.
		if _, accessErr := s.Store.GetDoc(ctx, uid, candidate.ID); errors.Is(accessErr, store.ErrNotFound) {
			return false, true, nil
		}
		return false, false, err
	}
	if doc.HasTables() {
		if _, accessErr := s.Store.GetDoc(ctx, uid, candidate.ID); errors.Is(accessErr, store.ErrNotFound) {
			return false, true, nil
		} else if accessErr != nil {
			return false, false, accessErr
		}
		return false, false, errors.New("unsupported experimental table content in search candidate")
	}
	bodyText := extractSearchableDocumentText(doc.View())
	if hasIndex {
		if afterEpoch, afterHead, err := s.Store.HeadVersion(ctx, candidate.ID); err == nil && afterHead == seq {
			if upsertErr := idxStore.UpsertSearchIndex(ctx, store.SearchIndexEntry{
				NodeID:      candidate.ID,
				SourceEpoch: afterEpoch,
				SourceSeq:   seq,
				SourceStamp: candidate.UpdatedAt,
				BodyText:    bodyText,
			}); upsertErr != nil && s.Log != nil {
				s.Log.Warn("search index upsert failed", "nodeId", candidate.ID, "err", upsertErr)
			}
		}
	}
	return matchSearchSegments(bodyText, needle), false, nil
}

func (s *Server) matchBaseBody(ctx context.Context, uid int64, candidate store.DocMeta, needle string, idxStore store.SearchIndexStore, hasIndex bool) (matched bool, skip bool, err error) {
	fresh, err := s.Store.GetDoc(ctx, uid, candidate.ID)
	if errors.Is(err, store.ErrNotFound) {
		return false, true, nil
	}
	if err != nil {
		return false, false, err
	}
	restricted, err := s.baseRestricted(ctx, fresh)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return false, true, nil
		}
		return false, false, err
	}
	if restricted {
		// Locked views hide rows/fields for non-managers; never read the shared index.
		tables, err := s.Store.BaseTables(ctx, candidate.ID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return false, true, nil
			}
			return false, false, err
		}
		if len(tables) == 0 {
			allowed, err := s.readBaseAllowed(ctx, uid, candidate.ID)
			if errors.Is(err, store.ErrNotFound) {
				return false, true, nil
			}
			if err != nil {
				return false, false, err
			}
			return matchSearchSegments(extractSearchableBaseText(allowed.tables, allowed.fields, allowed.records), needle), false, nil
		}
		for _, tbl := range tables {
			allowed, err := readBaseTableAllowedWith(ctx, s.Store, uid, candidate.ID, tbl.ID)
			if errors.Is(err, store.ErrNotFound) {
				continue
			}
			if err != nil {
				return false, false, err
			}
			if matchSearchSegments(extractSearchableBaseText([]store.BaseTable{tbl}, allowed.fields, allowed.records), needle) {
				return true, false, nil
			}
		}
		return false, false, nil
	}
	btHead, err := s.Store.BtHead(ctx, candidate.ID)
	if err != nil {
		return false, false, err
	}
	if hasIndex && btHead > 0 {
		if entry, err := idxStore.GetSearchIndex(ctx, candidate.ID); err == nil && entry.SourceSeq == btHead && !entry.SourceStamp.Before(fresh.UpdatedAt) {
			return matchSearchSegments(entry.BodyText, needle), false, nil
		}
	}
	tables, err := s.Store.BaseTables(ctx, candidate.ID)
	if err != nil {
		return false, false, err
	}
	fields, err := s.Store.Fields(ctx, candidate.ID)
	if err != nil {
		return false, false, err
	}
	records, err := s.Store.Records(ctx, candidate.ID)
	if err != nil {
		return false, false, err
	}
	bodyText := extractSearchableBaseText(tables, fields, records)
	if hasIndex {
		if upsertErr := idxStore.UpsertSearchIndex(ctx, store.SearchIndexEntry{
			NodeID:      candidate.ID,
			SourceSeq:   btHead,
			SourceStamp: fresh.UpdatedAt,
			BodyText:    bodyText,
		}); upsertErr != nil && s.Log != nil {
			s.Log.Warn("search index upsert failed", "nodeId", candidate.ID, "err", upsertErr)
		}
	}
	return matchSearchSegments(bodyText, needle), false, nil
}

func (s *Server) matchSlidesBody(ctx context.Context, uid int64, candidate store.DocMeta, needle string, idxStore store.SearchIndexStore, hasIndex bool) (matched bool, skip bool, err error) {
	pages, err := s.Store.ListSlidesPages(ctx, uid, candidate.ID)
	if errors.Is(err, store.ErrNotFound) {
		return false, true, nil
	}
	if err != nil {
		return false, false, err
	}
	var revSum int64
	maxStamp := candidate.UpdatedAt
	for _, p := range pages {
		revSum += p.Revision
		if p.UpdatedAt.After(maxStamp) {
			maxStamp = p.UpdatedAt
		}
	}
	sourceSeq := int64(len(pages))*1_000_000 + revSum
	if hasIndex && len(pages) > 0 {
		if entry, err := idxStore.GetSearchIndex(ctx, candidate.ID); err == nil && entry.SourceSeq == sourceSeq && !entry.SourceStamp.Before(maxStamp) {
			return matchSearchSegments(entry.BodyText, needle), false, nil
		}
	}
	bodyText := extractSearchableSlidesText(pages)
	if hasIndex {
		if upsertErr := idxStore.UpsertSearchIndex(ctx, store.SearchIndexEntry{
			NodeID:      candidate.ID,
			SourceSeq:   sourceSeq,
			SourceStamp: maxStamp,
			BodyText:    bodyText,
		}); upsertErr != nil && s.Log != nil {
			s.Log.Warn("search index upsert failed", "nodeId", candidate.ID, "err", upsertErr)
		}
	}
	return matchSearchSegments(bodyText, needle), false, nil
}

func (s *Server) matchSurveyBody(ctx context.Context, uid int64, candidate store.DocMeta, needle string, idxStore store.SearchIndexStore, hasIndex bool) (matched bool, skip bool, err error) {
	ss, ok := s.Store.(store.SurveyStore)
	if !ok {
		return false, false, nil
	}
	sv, err := ss.GetSurvey(ctx, candidate.ID)
	if errors.Is(err, store.ErrNotFound) {
		if _, accessErr := s.Store.GetDoc(ctx, uid, candidate.ID); errors.Is(accessErr, store.ErrNotFound) {
			return false, true, nil
		}
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	if hasIndex && sv.Revision > 0 {
		if entry, err := idxStore.GetSearchIndex(ctx, candidate.ID); err == nil && entry.SourceSeq == sv.Revision && !entry.SourceStamp.Before(sv.UpdatedAt) {
			return matchSearchSegments(entry.BodyText, needle), false, nil
		}
	}
	bodyText := extractSearchableSurveyText(sv)
	if hasIndex {
		if upsertErr := idxStore.UpsertSearchIndex(ctx, store.SearchIndexEntry{
			NodeID:      candidate.ID,
			SourceSeq:   sv.Revision,
			SourceStamp: sv.UpdatedAt,
			BodyText:    bodyText,
		}); upsertErr != nil && s.Log != nil {
			s.Log.Warn("search index upsert failed", "nodeId", candidate.ID, "err", upsertErr)
		}
	}
	return matchSearchSegments(bodyText, needle), false, nil
}

func appendSearchSegment(b *strings.Builder, s string) {
	if s == "" {
		return
	}
	s = strings.ReplaceAll(s, "\x00", "")
	s = strings.ReplaceAll(s, searchSegmentSep, " ")
	if s == "" {
		return
	}
	if b.Len() > 0 {
		b.WriteString(searchSegmentSep)
	}
	b.WriteString(s)
}

func matchSearchSegments(bodyText, needle string) bool {
	if needle == "" {
		return true
	}
	if bodyText == "" {
		return false
	}
	fold := cases.Fold()
	for _, seg := range strings.Split(bodyText, searchSegmentSep) {
		if seg != "" && strings.Contains(fold.String(seg), needle) {
			return true
		}
	}
	return false
}

// extractSearchableDocumentText extracts only text the editor actually displays.
// Formula/diagram source and inline formula marks are excluded, and segments are
// separated by ASCII Unit Separator (0x1F) so queries cannot match across boundaries.
func extractSearchableDocumentText(view collab.DocView) string {
	var b strings.Builder
	for _, block := range view.Blocks {
		switch block.Type {
		case "title", "math", "diagram", "image", "divider", "columns":
			continue
		case "table":
			if cells := tableRows(block.Props); cells != nil {
				for _, row := range cells {
					for _, cell := range row {
						appendSearchSegment(&b, cell)
					}
				}
			}
			continue
		case "flowchart":
			// Editable flowchart: node text, mind-map topics and edge labels are stored per object.
			for _, topic := range collectSearchableMindTopics(block.Props) {
				appendSearchSegment(&b, topic)
			}
			for key, raw := range block.Props {
				if raw == "" || !(strings.HasPrefix(key, "fc.n.") || strings.HasPrefix(key, "fc.e.")) {
					continue
				}
				var obj struct {
					Text  string `json:"text"`
					Label string `json:"label"`
				}
				if json.Unmarshal([]byte(raw), &obj) == nil {
					appendSearchSegment(&b, obj.Text)
					appendSearchSegment(&b, obj.Label)
				}
			}
			continue
		case "file", "video", "bookmark":
			appendSearchSegment(&b, block.Props["name"])
			if block.Type == "bookmark" {
				appendSearchSegment(&b, block.Props["url"])
			}
			continue
		}
		var text strings.Builder
		for _, span := range block.Spans {
			if span.Marks["math"] != "" {
				appendSearchSegment(&b, text.String())
				text.Reset()
			} else {
				text.WriteString(span.Text)
			}
		}
		appendSearchSegment(&b, text.String())
	}
	return b.String()
}

func appendJSONSearchValues(b *strings.Builder, v any) {
	switch x := v.(type) {
	case string:
		appendSearchSegment(b, x)
	case float64:
		appendSearchSegment(b, strconv.FormatFloat(x, 'f', -1, 64))
	case []any:
		for _, item := range x {
			appendJSONSearchValues(b, item)
		}
	case map[string]any:
		for _, key := range []string{"name", "text", "label", "url", "email", "phone"} {
			if val, ok := x[key]; ok {
				appendJSONSearchValues(b, val)
			}
		}
	}
}

func extractSearchableBaseText(tables []store.BaseTable, fields []store.Field, records []store.Record) string {
	var b strings.Builder
	for _, t := range tables {
		appendSearchSegment(&b, t.Name)
	}
	for _, f := range fields {
		appendSearchSegment(&b, f.Name)
		appendSearchSegment(&b, f.Description)
		for _, opt := range f.Options {
			appendSearchSegment(&b, opt)
		}
	}
	for _, rec := range records {
		for _, raw := range rec.Cells {
			if len(raw) == 0 {
				continue
			}
			var val any
			if json.Unmarshal(raw, &val) == nil {
				appendJSONSearchValues(&b, val)
			}
		}
	}
	return b.String()
}

func extractSearchableSlidesText(pages []store.SlidesPage) string {
	var b strings.Builder
	for _, p := range pages {
		appendSearchSegment(&b, p.Title)
		appendSearchSegment(&b, p.Body)
		appendSearchSegment(&b, p.Notes)
		if len(p.Shapes) > 0 {
			var shapes []struct {
				Text string `json:"text"`
			}
			if json.Unmarshal(p.Shapes, &shapes) == nil {
				for _, sh := range shapes {
					appendSearchSegment(&b, sh.Text)
				}
			}
		}
	}
	return b.String()
}

func extractSearchableSurveyText(sv store.Survey) string {
	var b strings.Builder
	appendSearchSegment(&b, sv.Description)
	for _, q := range sv.Questions {
		appendSearchSegment(&b, q.Title)
		appendSearchSegment(&b, q.Description)
		for _, opt := range q.Options {
			appendSearchSegment(&b, opt)
		}
		for _, row := range q.MatrixRows {
			appendSearchSegment(&b, row)
		}
		for _, col := range q.MatrixCols {
			appendSearchSegment(&b, col)
		}
	}
	return b.String()
}

// Search text the editor actually displays. Formula/diagram source and inline
// formula marks are intentionally excluded; they are not visible body text.
func searchableDocument(view collab.DocView, needle string) bool {
	return matchSearchSegments(extractSearchableDocumentText(view), needle)
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
