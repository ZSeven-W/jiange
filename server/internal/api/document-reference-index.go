package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

var (
	maxIndexedReferenceCandidates = 2000
	maxColdReferenceReplayBytes   = 32 << 20
	maxReferenceGraphNodes        = 120
	maxReferenceGraphEdges        = 400
)

var inlineResourceLinkPattern = regexp.MustCompile(`#/(doc|sheet|base|slides|survey)/([1-9][0-9]*)(?:\?block=([0-9]+(?::|%3A)[0-9]+))?|#/(s|p)/([A-Za-z0-9_-]{1,256})`)

type referenceGraphNodeDTO struct {
	ID      int64  `json:"id"`
	Title   string `json:"title"`
	Kind    string `json:"kind"`
	DocType string `json:"docType,omitempty"`
	Href    string `json:"href,omitempty"`
	Depth   int    `json:"depth"`
}

type referenceGraphEdgeDTO struct {
	SourceID     int64  `json:"sourceId"`
	TargetID     int64  `json:"targetId"`
	RelationKind string `json:"relationKind"`
}

type referenceGraphResult struct {
	CenterID  int64                   `json:"centerId"`
	Depth     int                     `json:"depth"`
	Nodes     []referenceGraphNodeDTO `json:"nodes"`
	Edges     []referenceGraphEdgeDTO `json:"edges"`
	Truncated bool                    `json:"truncated"`
	Indexed   bool                    `json:"indexed"`
}

// resourceReferenceTarget parses canonical internal resource links:
// #/doc/<id>, #/doc/<id>?block=<c>:<k>, #/sheet/<id>, #/base/<id>,
// #/slides/<id>, and #/survey/<id>.
func resourceReferenceTarget(href string) (int64, string) {
	if !strings.HasPrefix(href, "#/") {
		return 0, ""
	}
	body := strings.TrimPrefix(href, "#/")
	kind, rest, ok := strings.Cut(body, "/")
	if !ok || !store.IsReferenceableKind(kind) {
		return 0, ""
	}
	raw, query, hasQuery := strings.Cut(rest, "?")
	id, err := strconv.ParseInt(raw, 10, 53)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != raw {
		return 0, ""
	}
	if hasQuery {
		if kind != "doc" {
			return 0, ""
		}
		values, err := url.ParseQuery(query)
		if err != nil || len(values) != 1 || len(values["block"]) != 1 || !referenceBlock.MatchString(values.Get("block")) {
			return 0, ""
		}
	}
	return id, kind
}

func embedKindLabel(kind string) string {
	switch kind {
	case "sheet":
		return "电子表格"
	case "base":
		return "多维表格"
	case "slides":
		return "幻灯片"
	case "survey":
		return "问卷"
	default:
		return "资源"
	}
}

type refEdgeDedupKey struct {
	targetID    int64
	targetToken string
	scheme      string
	block       string
	relation    string
}

func appendUniqueRefEdge(edges *[]store.ReferenceEdge, seen map[refEdgeDedupKey]bool, edge store.ReferenceEdge) {
	if edge.SourceNodeID <= 0 {
		return
	}
	if edge.TargetNodeID == edge.SourceNodeID && edge.TargetToken == "" {
		return
	}
	if edge.RelationKind == "" {
		edge.RelationKind = "link"
	}
	key := refEdgeDedupKey{
		targetID:    edge.TargetNodeID,
		targetToken: edge.TargetToken,
		scheme:      edge.TargetScheme,
		block:       edge.SourceBlock,
		relation:    edge.RelationKind,
	}
	if seen[key] {
		return
	}
	seen[key] = true
	*edges = append(*edges, edge)
}

func extractInlineTextRefEdges(sourceID int64, blockID, text string, edges *[]store.ReferenceEdge, seen map[refEdgeDedupKey]bool) {
	if !strings.Contains(text, "#/") {
		return
	}
	snippet := clipReferenceText(text, 180)
	matches := inlineResourceLinkPattern.FindAllStringSubmatchIndex(text, 32)
	for _, m := range matches {
		end := m[1]
		if end < len(text) {
			next := text[end]
			if next == '?' || next == '&' || next == '/' || (next >= '0' && next <= '9') || (next >= 'a' && next <= 'z') || (next >= 'A' && next <= 'Z') || next == '_' || next == '-' {
				continue
			}
		}
		if m[4] >= 0 && m[5] > m[4] {
			rawID := text[m[4]:m[5]]
			id, err := strconv.ParseInt(rawID, 10, 53)
			if err != nil || id <= 0 || strconv.FormatInt(id, 10) != rawID || id == sourceID {
				continue
			}
			appendUniqueRefEdge(edges, seen, store.ReferenceEdge{
				SourceNodeID: sourceID,
				TargetNodeID: id,
				SourceBlock:  blockID,
				Excerpt:      snippet,
				RelationKind: "link",
			})
			continue
		}
		if m[8] >= 0 && m[10] >= 0 {
			scheme := text[m[8]:m[9]]
			token := text[m[10]:m[11]]
			appendUniqueRefEdge(edges, seen, store.ReferenceEdge{
				SourceNodeID: sourceID,
				TargetToken:  token,
				TargetScheme: scheme,
				SourceBlock:  blockID,
				Excerpt:      snippet,
				RelationKind: "link",
			})
		}
	}
}

func extractDocReferenceEdges(sourceID int64, view collab.DocView) ([]store.ReferenceEdge, error) {
	edges := []store.ReferenceEdge{}
	seen := map[refEdgeDedupKey]bool{}
	for _, block := range view.Blocks {
		switch {
		case referenceTextBlock(block.Type):
			var text strings.Builder
			for _, span := range block.Spans {
				if span.Marks["math"] == "" {
					text.WriteString(span.Text)
				}
			}
			snippet := clipReferenceText(text.String(), 180)
			for _, span := range block.Spans {
				if span.Text == "" || span.Marks["math"] != "" || span.Marks["linkKind"] == "text" {
					continue
				}
				href := span.Marks["link"]
				if href == "" {
					continue
				}
				if id, _ := resourceReferenceTarget(href); id > 0 {
					if id == sourceID {
						continue
					}
					if !validPublicCharID(block.ID) {
						return nil, errReferenceIncomplete
					}
					appendUniqueRefEdge(&edges, seen, store.ReferenceEdge{
						SourceNodeID: sourceID,
						TargetNodeID: id,
						SourceBlock:  block.ID,
						Excerpt:      snippet,
						RelationKind: "link",
					})
					continue
				}
				if match := referenceToken.FindStringSubmatch(href); match != nil {
					if !validPublicCharID(block.ID) {
						return nil, errReferenceIncomplete
					}
					appendUniqueRefEdge(&edges, seen, store.ReferenceEdge{
						SourceNodeID: sourceID,
						TargetToken:  match[2],
						TargetScheme: match[1],
						SourceBlock:  block.ID,
						Excerpt:      snippet,
						RelationKind: "link",
					})
				}
			}

		case block.Type == "embed":
			kind := block.Props["resourceKind"]
			rawID := block.Props["resourceId"]
			if (kind == "sheet" || kind == "base" || kind == "slides" || kind == "survey") && rawID != "" {
				id, err := strconv.ParseInt(rawID, 10, 53)
				if err == nil && id > 0 && id != sourceID && validPublicCharID(block.ID) {
					title := strings.TrimSpace(block.Props["title"])
					excerpt := "嵌入" + embedKindLabel(kind)
					if title != "" {
						excerpt = clipReferenceText(excerpt+"："+title, 180)
					}
					appendUniqueRefEdge(&edges, seen, store.ReferenceEdge{
						SourceNodeID: sourceID,
						TargetNodeID: id,
						SourceBlock:  block.ID,
						Excerpt:      excerpt,
						RelationKind: "embed",
					})
				}
			}

		case block.Type == "table":
			if validPublicCharID(block.ID) {
				if cells := tableRows(block.Props); cells != nil {
					for _, row := range cells {
						for _, cell := range row {
							extractInlineTextRefEdges(sourceID, block.ID, cell, &edges, seen)
						}
					}
				}
			}

		case block.Type == "flowchart":
			if validPublicCharID(block.ID) {
				for _, topic := range collectSearchableMindTopics(block.Props) {
					extractInlineTextRefEdges(sourceID, block.ID, topic, &edges, seen)
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
						extractInlineTextRefEdges(sourceID, block.ID, obj.Text, &edges, seen)
						extractInlineTextRefEdges(sourceID, block.ID, obj.Label, &edges, seen)
					}
				}
			}
		}
	}
	return edges, nil
}

func extractJSONValueRefEdges(sourceID int64, blockID string, v any, edges *[]store.ReferenceEdge, seen map[refEdgeDedupKey]bool) {
	switch x := v.(type) {
	case string:
		extractInlineTextRefEdges(sourceID, blockID, x, edges, seen)
	case []any:
		for _, item := range x {
			extractJSONValueRefEdges(sourceID, blockID, item, edges, seen)
		}
	case map[string]any:
		for _, key := range []string{"url", "text", "name", "label"} {
			if val, ok := x[key]; ok {
				extractJSONValueRefEdges(sourceID, blockID, val, edges, seen)
			}
		}
	}
}

func extractBaseReferenceEdges(sourceID int64, fields []store.Field, records []store.Record) []store.ReferenceEdge {
	edges := []store.ReferenceEdge{}
	seen := map[refEdgeDedupKey]bool{}
	for _, f := range fields {
		if f.Description != "" {
			extractInlineTextRefEdges(sourceID, fmt.Sprintf("rec:%d", f.ID), f.Description, &edges, seen)
		}
	}
	for _, rec := range records {
		blockID := fmt.Sprintf("rec:%d", rec.ID)
		for _, raw := range rec.Cells {
			if len(raw) == 0 {
				continue
			}
			var val any
			if json.Unmarshal(raw, &val) == nil {
				extractJSONValueRefEdges(sourceID, blockID, val, &edges, seen)
			}
		}
	}
	return edges
}

func extractSlidesReferenceEdges(sourceID int64, pages []store.SlidesPage) []store.ReferenceEdge {
	edges := []store.ReferenceEdge{}
	seen := map[refEdgeDedupKey]bool{}
	for _, p := range pages {
		blockID := fmt.Sprintf("slide:%d", p.ID)
		extractInlineTextRefEdges(sourceID, blockID, p.Title, &edges, seen)
		extractInlineTextRefEdges(sourceID, blockID, p.Body, &edges, seen)
		extractInlineTextRefEdges(sourceID, blockID, p.Notes, &edges, seen)
		if len(p.Shapes) > 0 {
			var shapes []struct {
				Text string `json:"text"`
			}
			if json.Unmarshal(p.Shapes, &shapes) == nil {
				for _, sh := range shapes {
					extractInlineTextRefEdges(sourceID, blockID, sh.Text, &edges, seen)
				}
			}
		}
	}
	return edges
}

func extractSheetReferenceEdges(sourceID int64, snap store.SheetSnapshot) []store.ReferenceEdge {
	edges := []store.ReferenceEdge{}
	seen := map[refEdgeDedupKey]bool{}
	for _, ws := range snap.Sheets {
		blockID := fmt.Sprintf("sheet:%d", ws.ID)
		for _, c := range ws.Cells {
			if c.Raw == "" || !strings.Contains(c.Raw, "#/") {
				continue
			}
			extractInlineTextRefEdges(sourceID, blockID, c.Raw, &edges, seen)
		}
	}
	return edges
}

func extractSurveyReferenceEdges(sourceID int64, sv store.Survey) []store.ReferenceEdge {
	edges := []store.ReferenceEdge{}
	seen := map[refEdgeDedupKey]bool{}
	extractInlineTextRefEdges(sourceID, "survey:desc", sv.Description, &edges, seen)
	for _, q := range sv.Questions {
		qid := q.ID
		if qid == "" {
			qid = "q"
		}
		blockID := "survey:" + qid
		extractInlineTextRefEdges(sourceID, blockID, q.Title, &edges, seen)
		extractInlineTextRefEdges(sourceID, blockID, q.Description, &edges, seen)
	}
	return edges
}

// syncReferenceIndex incrementally refreshes stale visible nodes into the
// persistent reference index. Warm cache hits skip CRDT/content loading
// entirely. Restricted Bases (with locked views) are never persisted into the
// shared index; their caller-scoped edges are returned in restrictedLive.
func (s *Server) syncReferenceIndex(ctx context.Context, guard store.RestoreGuard, idxStore store.ReferenceIndexStore) (restrictedLive map[int64][]store.ReferenceEdge, err error) {
	const pageSize = 200
	restrictedLive = map[int64][]store.ReferenceEdge{}
	var after int64
	count, replayBytes := 0, 0

	for {
		page, err := s.Store.SearchCandidates(ctx, guard.UserID, after, pageSize)
		if err != nil {
			return nil, err
		}
		if len(page) == 0 {
			break
		}
		var pageIDs, docIDs, sheetIDs []int64
		for _, candidate := range page {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if candidate.ID <= after {
				return nil, errReferenceIncomplete
			}
			after = candidate.ID
			count++
			if count > maxIndexedReferenceCandidates {
				return nil, errReferenceIncomplete
			}
			if !store.IsReferenceableKind(candidate.Kind) {
				continue
			}
			pageIDs = append(pageIDs, candidate.ID)
			if candidate.Kind == "doc" {
				docIDs = append(docIDs, candidate.ID)
			} else if candidate.Kind == "sheet" {
				sheetIDs = append(sheetIDs, candidate.ID)
			}
		}
		if len(pageIDs) > 0 {
			states, err := idxStore.GetReferenceIndexStates(ctx, pageIDs)
			if err != nil {
				return nil, err
			}
			docHeads, err := idxStore.ListDocHeadVersions(ctx, docIDs)
			if err != nil {
				return nil, err
			}
			sheetRevs, err := idxStore.ListSheetWorkbookRevisions(ctx, sheetIDs)
			if err != nil {
				return nil, err
			}
			for _, candidate := range page {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				if !store.IsReferenceableKind(candidate.Kind) {
					continue
				}
				st, hasState := states[candidate.ID]
				switch candidate.Kind {
				case "doc":
					hv, ok := docHeads[candidate.ID]
					if !ok {
						// Doc may have been deleted concurrently.
						continue
					}
					if hasState && st.SourceKind == "doc" && st.SourceEpoch == hv[0] && st.SourceSeq == hv[1] {
						continue
					}
					used, refreshErr := s.refreshDocReferenceIndex(ctx, guard.UserID, candidate, hv[0], idxStore)
					if refreshErr != nil {
						return nil, refreshErr
					}
					replayBytes += used
					if replayBytes > maxColdReferenceReplayBytes {
						return nil, errReferenceIncomplete
					}

				case "base":
					live, baseErr := s.refreshBaseReferenceIndex(ctx, guard.UserID, candidate, st, hasState, idxStore)
					if baseErr != nil {
						return nil, baseErr
					}
					if live != nil {
						restrictedLive[candidate.ID] = live
					}

				case "slides":
					if err := s.refreshSlidesReferenceIndex(ctx, guard.UserID, candidate, st, hasState, idxStore); err != nil {
						return nil, err
					}

				case "sheet":
					wbRev, ok := sheetRevs[candidate.ID]
					if ok && hasState && st.SourceKind == "sheet" && st.SourceSeq == wbRev {
						continue
					}
					if err := s.refreshSheetReferenceIndex(ctx, guard, candidate, st, hasState, idxStore); err != nil {
						return nil, err
					}

				case "survey":
					if err := s.refreshSurveyReferenceIndex(ctx, guard.UserID, candidate, st, hasState, idxStore); err != nil {
						return nil, err
					}
				}
			}
		}
		if len(page) < pageSize {
			break
		}
	}
	return restrictedLive, nil
}

func (s *Server) refreshDocReferenceIndex(ctx context.Context, uid int64, candidate store.DocMeta, expectedEpoch int64, idxStore store.ReferenceIndexStore) (int, error) {
	snapshot, err := s.Store.ReadTitleSnapshot(ctx, candidate.ID)
	if err != nil {
		if _, accessErr := s.Store.GetDoc(ctx, uid, candidate.ID); errors.Is(accessErr, store.ErrNotFound) {
			return 0, nil
		}
		return 0, err
	}
	used := len(snapshot.Snapshot)
	for _, op := range snapshot.Ops {
		used += len(op.Bytes)
	}
	doc := collab.NewDoc()
	if len(snapshot.Snapshot) > 0 {
		doc, err = collab.DecodeState(snapshot.Snapshot)
		if err != nil {
			return used, err
		}
	}
	seq := snapshot.SnapshotSeq
	for _, row := range snapshot.Ops {
		if err := ctx.Err(); err != nil {
			return used, err
		}
		if row.Seq != seq+1 {
			return used, errReferenceIncomplete
		}
		if len(row.Bytes) < 3 || row.Bytes[0] != collab.Magic || row.Bytes[1] != collab.Version || row.Bytes[2] != 1 {
			return used, errReferenceIncomplete
		}
		ops, e := collab.DecodeOps(row.Bytes)
		if e != nil || len(ops) != 1 || row.ClientID < 0 || uint64(row.ClientID) != ops[0].ID.Client || !doc.Apply(ops[0]) {
			return used, errReferenceIncomplete
		}
		seq = row.Seq
	}
	if seq != snapshot.Head || doc.Pending() != 0 || doc.HasTables() {
		return used, errReferenceIncomplete
	}
	edges, err := extractDocReferenceEdges(candidate.ID, doc.View())
	if err != nil {
		return used, err
	}
	afterEpoch, afterHead, err := s.Store.HeadVersion(ctx, candidate.ID)
	if errors.Is(err, store.ErrNotFound) {
		return used, nil
	}
	if err != nil {
		return used, err
	}
	if afterEpoch != expectedEpoch || afterHead != seq {
		return used, errReferenceIncomplete
	}
	err = idxStore.ReplaceReferenceEdges(ctx, store.ReferenceIndexState{
		SourceNodeID: candidate.ID,
		SourceKind:   "doc",
		SourceEpoch:  afterEpoch,
		SourceSeq:    afterHead,
		SourceStamp:  candidate.UpdatedAt,
	}, edges)
	return used, err
}

func (s *Server) refreshBaseReferenceIndex(ctx context.Context, uid int64, candidate store.DocMeta, st store.ReferenceIndexState, hasState bool, idxStore store.ReferenceIndexStore) ([]store.ReferenceEdge, error) {
	restricted, err := s.baseRestricted(ctx, candidate)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if restricted {
		// Locked views hide rows/fields for non-managers; compute edges live
		// from only the caller's allowed view and never persist into shared index.
		tables, err := s.Store.BaseTables(ctx, candidate.ID)
		if errors.Is(err, store.ErrNotFound) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		var out []store.ReferenceEdge
		if len(tables) == 0 {
			allowed, err := s.readBaseAllowed(ctx, uid, candidate.ID)
			if errors.Is(err, store.ErrNotFound) {
				return nil, nil
			}
			if err != nil {
				return nil, err
			}
			return extractBaseReferenceEdges(candidate.ID, allowed.fields, allowed.records), nil
		}
		for _, tbl := range tables {
			allowed, err := readBaseTableAllowedWith(ctx, s.Store, uid, candidate.ID, tbl.ID)
			if errors.Is(err, store.ErrNotFound) {
				continue
			}
			if err != nil {
				return nil, err
			}
			out = append(out, extractBaseReferenceEdges(candidate.ID, allowed.fields, allowed.records)...)
		}
		return out, nil
	}
	btHead, err := s.Store.BtHead(ctx, candidate.ID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if hasState && st.SourceKind == "base" && st.SourceSeq == btHead && !st.SourceStamp.Before(candidate.UpdatedAt) {
		return nil, nil
	}
	fields, err := s.Store.Fields(ctx, candidate.ID)
	if err != nil {
		return nil, err
	}
	records, err := s.Store.Records(ctx, candidate.ID)
	if err != nil {
		return nil, err
	}
	edges := extractBaseReferenceEdges(candidate.ID, fields, records)
	err = idxStore.ReplaceReferenceEdges(ctx, store.ReferenceIndexState{
		SourceNodeID: candidate.ID,
		SourceKind:   "base",
		SourceSeq:    btHead,
		SourceStamp:  candidate.UpdatedAt,
	}, edges)
	return nil, err
}

func (s *Server) refreshSlidesReferenceIndex(ctx context.Context, uid int64, candidate store.DocMeta, st store.ReferenceIndexState, hasState bool, idxStore store.ReferenceIndexStore) error {
	pages, err := s.Store.ListSlidesPages(ctx, uid, candidate.ID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
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
	if hasState && st.SourceKind == "slides" && st.SourceSeq == sourceSeq && !st.SourceStamp.Before(maxStamp) {
		return nil
	}
	edges := extractSlidesReferenceEdges(candidate.ID, pages)
	return idxStore.ReplaceReferenceEdges(ctx, store.ReferenceIndexState{
		SourceNodeID: candidate.ID,
		SourceKind:   "slides",
		SourceSeq:    sourceSeq,
		SourceStamp:  maxStamp,
	}, edges)
}

func (s *Server) refreshSheetReferenceIndex(ctx context.Context, guard store.RestoreGuard, candidate store.DocMeta, st store.ReferenceIndexState, hasState bool, idxStore store.ReferenceIndexStore) error {
	snap, err := s.Store.GetSheetWorkbook(ctx, guard, candidate.ID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	stamp := snap.UpdatedAt
	if candidate.UpdatedAt.After(stamp) {
		stamp = candidate.UpdatedAt
	}
	if hasState && st.SourceKind == "sheet" && st.SourceSeq == snap.WorkbookRevision {
		return nil
	}
	edges := extractSheetReferenceEdges(candidate.ID, snap)
	return idxStore.ReplaceReferenceEdges(ctx, store.ReferenceIndexState{
		SourceNodeID: candidate.ID,
		SourceKind:   "sheet",
		SourceSeq:    snap.WorkbookRevision,
		SourceStamp:  stamp,
	}, edges)
}

func (s *Server) refreshSurveyReferenceIndex(ctx context.Context, uid int64, candidate store.DocMeta, st store.ReferenceIndexState, hasState bool, idxStore store.ReferenceIndexStore) error {
	ss, ok := s.Store.(store.SurveyStore)
	if !ok {
		return nil
	}
	sv, err := ss.GetSurvey(ctx, candidate.ID)
	if errors.Is(err, store.ErrNotFound) {
		if _, accessErr := s.Store.GetDoc(ctx, uid, candidate.ID); errors.Is(accessErr, store.ErrNotFound) {
			return nil
		}
		return nil
	}
	if err != nil {
		return err
	}
	if hasState && st.SourceKind == "survey" && st.SourceSeq == sv.Revision && !st.SourceStamp.Before(sv.UpdatedAt) {
		return nil
	}
	edges := extractSurveyReferenceEdges(candidate.ID, sv)
	return idxStore.ReplaceReferenceEdges(ctx, store.ReferenceIndexState{
		SourceNodeID: candidate.ID,
		SourceKind:   "survey",
		SourceSeq:    sv.Revision,
		SourceStamp:  sv.UpdatedAt,
	}, edges)
}

func (s *Server) queryIndexedDocumentReferences(ctx context.Context, guard store.RestoreGuard, target int64, idxStore store.ReferenceIndexStore) (referenceResult, error) {
	result := referenceResult{Incoming: []referenceItem{}, Outgoing: []referenceItem{}, Indexed: true}
	targetMeta, err := s.Store.GetDoc(ctx, guard.UserID, target)
	if err != nil {
		return result, err
	}
	if !store.IsReferenceableKind(targetMeta.Kind) {
		return result, store.ErrNotFound
	}
	restrictedLive, err := s.syncReferenceIndex(ctx, guard, idxStore)
	if err != nil {
		return result, err
	}

	// Outgoing edges from target
	var outEdges []store.ReferenceEdge
	if live, ok := restrictedLive[target]; ok {
		outEdges = live
	} else {
		outEdges, err = idxStore.ListOutgoingReferenceEdges(ctx, []int64{target})
		if err != nil {
			return result, err
		}
	}

	// Incoming edges to target (both direct node ID and active share token)
	tokMap, err := idxStore.ListNodeLinkTokens(ctx, []int64{target})
	if err != nil {
		return result, err
	}
	var targetTokens []string
	if tok := tokMap[target]; tok != "" {
		targetTokens = []string{tok}
	}
	inEdges, err := idxStore.ListIncomingReferenceEdges(ctx, []int64{target}, targetTokens)
	if err != nil {
		return result, err
	}
	// Include caller-scoped edges from restricted Bases that point to target.
	for srcID, edges := range restrictedLive {
		if srcID == target {
			continue
		}
		for _, e := range edges {
			if e.TargetNodeID == target || (e.TargetToken != "" && tokMap[target] != "" && e.TargetToken == tokMap[target]) {
				inEdges = append(inEdges, e)
			}
		}
	}

	tokens := map[string]resolvedReferenceToken{}
	resolveTok := func(token string) (resolvedReferenceToken, error) {
		if cached, ok := tokens[token]; ok {
			return cached, nil
		}
		if len(tokens) >= 200 {
			return resolvedReferenceToken{}, errReferenceIncomplete
		}
		val, e := s.resolveReferenceToken(ctx, guard, token)
		if e != nil {
			return resolvedReferenceToken{}, e
		}
		tokens[token] = val
		return val, nil
	}

	// Group outgoing targets (prefer direct access; preserve unjoined share link href when not directly accessible).
	type outAgg struct {
		href    string
		relKind string
	}
	outByTarget := map[int64]*outAgg{}
	for _, e := range outEdges {
		tid := e.TargetNodeID
		href := ""
		if e.TargetToken != "" {
			resolved, e2 := resolveTok(e.TargetToken)
			if e2 != nil {
				return result, e2
			}
			if resolved.id <= 0 || (e.TargetScheme == "p" && resolved.role != "anon") {
				continue
			}
			tid = resolved.id
			href = "#/" + e.TargetScheme + "/" + e.TargetToken
		}
		if tid <= 0 || tid == target {
			continue
		}
		agg, exists := outByTarget[tid]
		if !exists {
			outByTarget[tid] = &outAgg{href: href, relKind: e.RelationKind}
		} else {
			if agg.href == "" && href != "" {
				agg.href = href
			}
			if agg.relKind != "embed" && e.RelationKind == "embed" {
				agg.relKind = "embed"
			}
		}
	}

	// Group incoming contexts by source node ID.
	inBySource := map[int64][]referenceContext{}
	inRelBySource := map[int64]string{}
	for _, e := range inEdges {
		if e.SourceNodeID <= 0 || e.SourceNodeID == target {
			continue
		}
		// Skip stale shared-index rows for a Base that is currently restricted for this caller
		// (its live edges were already appended above).
		if _, isRestricted := restrictedLive[e.SourceNodeID]; isRestricted {
			// Verify this edge came from restrictedLive rather than stale shared index by checking live slice.
			matched := false
			for _, le := range restrictedLive[e.SourceNodeID] {
				if le.SourceBlock == e.SourceBlock && le.TargetNodeID == e.TargetNodeID && le.TargetToken == e.TargetToken && le.RelationKind == e.RelationKind {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}
		if e.TargetToken != "" {
			resolved, e2 := resolveTok(e.TargetToken)
			if e2 != nil {
				return result, e2
			}
			if resolved.id != target || (e.TargetScheme == "p" && resolved.role != "anon") {
				continue
			}
		}
		dup := false
		for _, c := range inBySource[e.SourceNodeID] {
			if c.Block == e.SourceBlock {
				dup = true
				break
			}
		}
		if dup {
			continue
		}
		inBySource[e.SourceNodeID] = append(inBySource[e.SourceNodeID], referenceContext{
			Block:        e.SourceBlock,
			Text:         e.Excerpt,
			RelationKind: e.RelationKind,
		})
		if inRelBySource[e.SourceNodeID] != "embed" && e.RelationKind == "embed" {
			inRelBySource[e.SourceNodeID] = "embed"
		} else if inRelBySource[e.SourceNodeID] == "" {
			inRelBySource[e.SourceNodeID] = e.RelationKind
		}
	}

	// Build outgoing items with live metadata & access verification.
	for tid, agg := range outByTarget {
		d, e := s.Store.GetDoc(ctx, guard.UserID, tid)
		if errors.Is(e, store.ErrNotFound) {
			if agg.href != "" {
				match := referenceToken.FindStringSubmatch(agg.href)
				if match != nil {
					resolved, re := s.resolveReferenceToken(ctx, guard, match[2])
					if re != nil {
						return result, re
					}
					if resolved.id == tid && (match[1] != "p" || resolved.role == "anon") {
						result.Outgoing = append(result.Outgoing, referenceItem{
							ID:           tid,
							Title:        resolved.title,
							Kind:         resolved.kind,
							DocType:      resolved.docType,
							Href:         agg.href,
							RelationKind: agg.relKind,
						})
					}
				}
			}
			continue
		}
		if e != nil {
			return result, e
		}
		if !store.IsReferenceableKind(d.Kind) {
			continue
		}
		result.Outgoing = append(result.Outgoing, referenceItem{
			ID:           d.ID,
			Title:        d.Title,
			Kind:         d.Kind,
			DocType:      d.DocType,
			RelationKind: agg.relKind,
		})
	}

	// Build incoming items with live metadata & copy-policy filtering.
	for sid, contexts := range inBySource {
		d, e := s.Store.GetDoc(ctx, guard.UserID, sid)
		if errors.Is(e, store.ErrNotFound) {
			continue
		}
		if e != nil {
			return result, e
		}
		if !store.IsReferenceableKind(d.Kind) {
			continue
		}
		copyAllowed := store.RoleRank(d.Role) > 0 && store.RoleRank(d.CopyMinRole) > 0 && store.RoleRank(d.Role) >= store.RoleRank(d.CopyMinRole)
		if !copyAllowed {
			for i := range contexts {
				contexts[i].Text = ""
			}
		}
		result.Incoming = append(result.Incoming, referenceItem{
			ID:           d.ID,
			Title:        d.Title,
			Kind:         d.Kind,
			DocType:      d.DocType,
			RelationKind: inRelBySource[sid],
			Contexts:     contexts,
		})
	}

	sort.Slice(result.Incoming, func(i, j int) bool { return result.Incoming[i].ID < result.Incoming[j].ID })
	sort.Slice(result.Outgoing, func(i, j int) bool { return result.Outgoing[i].ID < result.Outgoing[j].ID })

	// Final pre-return TOCTOU check on session, target, and every listed item.
	if err := ctx.Err(); err != nil {
		return referenceResult{}, err
	}
	user, err := s.Store.SessionUser(ctx, guard.SessionHash, s.now())
	if err != nil || user.ID != guard.UserID {
		return referenceResult{}, store.ErrUnauthenticated
	}
	if _, err := s.Store.GetDoc(ctx, guard.UserID, target); err != nil {
		return referenceResult{}, err
	}
	return s.recheckReferenceResult(ctx, guard, result)
}

func (s *Server) recheckReferenceResult(ctx context.Context, guard store.RestoreGuard, result referenceResult) (referenceResult, error) {
	incoming := result.Incoming[:0]
	for _, item := range result.Incoming {
		d, e := s.Store.GetDoc(ctx, guard.UserID, item.ID)
		if errors.Is(e, store.ErrNotFound) {
			continue
		}
		if e != nil {
			return referenceResult{}, e
		}
		item.Title = d.Title
		item.Kind = d.Kind
		item.DocType = d.DocType
		if store.RoleRank(d.CopyMinRole) == 0 || store.RoleRank(d.Role) < store.RoleRank(d.CopyMinRole) {
			for i := range item.Contexts {
				item.Contexts[i].Text = ""
			}
		}
		incoming = append(incoming, item)
	}
	result.Incoming = incoming

	outgoing := result.Outgoing[:0]
	for _, item := range result.Outgoing {
		if item.Href != "" {
			match := referenceToken.FindStringSubmatch(item.Href)
			if match == nil {
				return referenceResult{}, errReferenceIncomplete
			}
			resolved, e := s.resolveReferenceToken(ctx, guard, match[2])
			if e != nil {
				return referenceResult{}, e
			}
			if resolved.id != item.ID || (match[1] == "p" && resolved.role != "anon") {
				continue
			}
			item.Title = resolved.title
			item.Kind = resolved.kind
			item.DocType = resolved.docType
			outgoing = append(outgoing, item)
			continue
		}
		d, e := s.Store.GetDoc(ctx, guard.UserID, item.ID)
		if errors.Is(e, store.ErrNotFound) {
			continue
		}
		if e != nil {
			return referenceResult{}, e
		}
		item.Title = d.Title
		item.Kind = d.Kind
		item.DocType = d.DocType
		outgoing = append(outgoing, item)
	}
	result.Outgoing = outgoing
	return result, nil
}

// documentReferenceGraph handles GET /api/docs/{id}/reference-graph?depth=1..3
func (s *Server) documentReferenceGraph(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	if !requireActionAccount(w, r) {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	target, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	if !store.IsReferenceableKind(target.Kind) {
		httpx.Error(w, http.StatusNotFound, "not_found", "文档不存在或无权访问")
		return
	}
	depth := 2
	if rawDepth := strings.TrimSpace(r.URL.Query().Get("depth")); rawDepth != "" {
		d, err := strconv.Atoi(rawDepth)
		if err != nil || d < 1 || d > 3 {
			httpx.Error(w, http.StatusBadRequest, "invalid_depth", "图谱深度必须为 1 至 3 跳。")
			return
		}
		depth = d
	}
	select {
	case referenceSlots <- struct{}{}:
		defer func() { <-referenceSlots }()
	default:
		httpx.Error(w, http.StatusServiceUnavailable, "references_busy", "关系图正在查询，请稍后重试。")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	graph, err := s.buildMultiHopReferenceGraph(ctx, guard, target.ID, depth)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
		if errors.Is(err, store.ErrUnauthenticated) {
			httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
			return
		}
		if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrForbidden) {
			httpx.Error(w, http.StatusNotFound, "not_found", "文档不存在或无权访问")
			return
		}
		httpx.Error(w, http.StatusServiceUnavailable, "references_incomplete", "关系图查询未完成，文档过多、内容过大或服务暂不可用。")
		return
	}
	httpx.JSON(w, http.StatusOK, graph)
}

func (s *Server) buildMultiHopReferenceGraph(ctx context.Context, guard store.RestoreGuard, centerID int64, depth int) (referenceGraphResult, error) {
	centerMeta, err := s.Store.GetDoc(ctx, guard.UserID, centerID)
	if err != nil {
		return referenceGraphResult{}, err
	}
	if !store.IsReferenceableKind(centerMeta.Kind) {
		return referenceGraphResult{}, store.ErrNotFound
	}
	idxStore, hasIndex := s.Store.(store.ReferenceIndexStore)
	if !hasIndex {
		// Graceful fallback to 1-hop scan when store lacks ReferenceIndexStore.
		refs, err := s.scanDocumentReferencesFallback(ctx, guard, centerID)
		if err != nil {
			return referenceGraphResult{}, err
		}
		return graphFromSingleHop(centerMeta, refs), nil
	}
	restrictedLive, err := s.syncReferenceIndex(ctx, guard, idxStore)
	if err != nil {
		return referenceGraphResult{}, err
	}

	nodes := map[int64]referenceGraphNodeDTO{
		centerID: {
			ID:      centerMeta.ID,
			Title:   centerMeta.Title,
			Kind:    centerMeta.Kind,
			DocType: centerMeta.DocType,
			Depth:   0,
		},
	}
	metaCache := map[int64]*store.DocMeta{centerID: &centerMeta}
	getMeta := func(id int64) (*store.DocMeta, error) {
		if m, seen := metaCache[id]; seen {
			return m, nil
		}
		d, e := s.Store.GetDoc(ctx, guard.UserID, id)
		if errors.Is(e, store.ErrNotFound) {
			metaCache[id] = nil
			return nil, nil
		}
		if e != nil {
			return nil, e
		}
		if !store.IsReferenceableKind(d.Kind) {
			metaCache[id] = nil
			return nil, nil
		}
		metaCache[id] = &d
		return &d, nil
	}

	tokenCache := map[string]resolvedReferenceToken{}
	resolveTok := func(token string) (resolvedReferenceToken, error) {
		if cached, ok := tokenCache[token]; ok {
			return cached, nil
		}
		if len(tokenCache) >= 200 {
			return resolvedReferenceToken{}, errReferenceIncomplete
		}
		val, e := s.resolveReferenceToken(ctx, guard, token)
		if e != nil {
			return resolvedReferenceToken{}, e
		}
		tokenCache[token] = val
		return val, nil
	}

	type edgeKey struct {
		src, dst int64
		rel      string
	}
	edges := map[edgeKey]referenceGraphEdgeDTO{}
	truncated := false
	frontier := []int64{centerID}
	expanded := map[int64]bool{centerID: true}

	addEdge := func(src, dst int64, rel string) {
		if src <= 0 || dst <= 0 || src == dst {
			return
		}
		if rel == "" {
			rel = "link"
		}
		k := edgeKey{src: src, dst: dst, rel: rel}
		if _, ok := edges[k]; ok {
			return
		}
		if len(edges) >= maxReferenceGraphEdges {
			truncated = true
			return
		}
		edges[k] = referenceGraphEdgeDTO{SourceID: src, TargetID: dst, RelationKind: rel}
	}

	for hop := 1; hop <= depth && len(frontier) > 0; hop++ {
		if err := ctx.Err(); err != nil {
			return referenceGraphResult{}, err
		}
		// Outgoing edges from frontier nodes
		var queryOut []int64
		var outEdges []store.ReferenceEdge
		for _, fid := range frontier {
			if live, ok := restrictedLive[fid]; ok {
				outEdges = append(outEdges, live...)
			} else {
				queryOut = append(queryOut, fid)
			}
		}
		if len(queryOut) > 0 {
			persistedOut, err := idxStore.ListOutgoingReferenceEdges(ctx, queryOut)
			if err != nil {
				return referenceGraphResult{}, err
			}
			outEdges = append(outEdges, persistedOut...)
		}

		// Incoming edges into frontier nodes (direct + active link tokens)
		tokMap, err := idxStore.ListNodeLinkTokens(ctx, frontier)
		if err != nil {
			return referenceGraphResult{}, err
		}
		tokenToNode := map[string]int64{}
		frontierSet := make(map[int64]bool, len(frontier))
		var frontierTokens []string
		for _, fid := range frontier {
			frontierSet[fid] = true
			if tok := tokMap[fid]; tok != "" {
				tokenToNode[tok] = fid
				frontierTokens = append(frontierTokens, tok)
			}
		}
		inEdges, err := idxStore.ListIncomingReferenceEdges(ctx, frontier, frontierTokens)
		if err != nil {
			return referenceGraphResult{}, err
		}
		for srcID, liveEdges := range restrictedLive {
			for _, e := range liveEdges {
				if (e.TargetNodeID > 0 && frontierSet[e.TargetNodeID]) || (e.TargetToken != "" && tokenToNode[e.TargetToken] > 0) {
					if srcID != e.TargetNodeID {
						inEdges = append(inEdges, e)
					}
				}
			}
		}

		var nextFrontier []int64
		addNode := func(dto referenceGraphNodeDTO, canExpand bool) bool {
			if existing, exists := nodes[dto.ID]; exists {
				// Prefer direct access over share-link-only leaf if both seen.
				if existing.Href != "" && dto.Href == "" {
					existing.Href = ""
					existing.Title = dto.Title
					existing.Kind = dto.Kind
					existing.DocType = dto.DocType
					nodes[dto.ID] = existing
				}
				return true
			}
			if len(nodes) >= maxReferenceGraphNodes {
				truncated = true
				return false
			}
			nodes[dto.ID] = dto
			if canExpand && !expanded[dto.ID] {
				expanded[dto.ID] = true
				nextFrontier = append(nextFrontier, dto.ID)
			}
			return true
		}

		// Process outgoing edges: src (in frontier) -> dst
		for _, e := range outEdges {
			dst := e.TargetNodeID
			href := ""
			if e.TargetToken != "" {
				resolved, re := resolveTok(e.TargetToken)
				if re != nil {
					return referenceGraphResult{}, re
				}
				if resolved.id <= 0 || (e.TargetScheme == "p" && resolved.role != "anon") {
					continue
				}
				dst = resolved.id
				href = "#/" + e.TargetScheme + "/" + e.TargetToken
			}
			if dst <= 0 || dst == e.SourceNodeID {
				continue
			}
			meta, me := getMeta(dst)
			if me != nil {
				return referenceGraphResult{}, me
			}
			if meta != nil {
				if addNode(referenceGraphNodeDTO{
					ID:      meta.ID,
					Title:   meta.Title,
					Kind:    meta.Kind,
					DocType: meta.DocType,
					Depth:   hop,
				}, true) {
					addEdge(e.SourceNodeID, meta.ID, e.RelationKind)
				}
			} else if href != "" {
				resolved := tokenCache[e.TargetToken]
				if resolved.id == dst {
					// Unjoined share link target: render as leaf node without traversing beyond it.
					if addNode(referenceGraphNodeDTO{
						ID:      resolved.id,
						Title:   resolved.title,
						Kind:    resolved.kind,
						DocType: resolved.docType,
						Href:    href,
						Depth:   hop,
					}, false) {
						addEdge(e.SourceNodeID, resolved.id, e.RelationKind)
					}
				}
			}
		}

		// Process incoming edges: src -> dst (in frontier)
		for _, e := range inEdges {
			if e.SourceNodeID <= 0 {
				continue
			}
			// Guard against stale shared-index rows for a restricted Base.
			if live, isRestricted := restrictedLive[e.SourceNodeID]; isRestricted {
				matched := false
				for _, le := range live {
					if le.SourceBlock == e.SourceBlock && le.TargetNodeID == e.TargetNodeID && le.TargetToken == e.TargetToken && le.RelationKind == e.RelationKind {
						matched = true
						break
					}
				}
				if !matched {
					continue
				}
			}
			dst := e.TargetNodeID
			if e.TargetToken != "" {
				resolved, re := resolveTok(e.TargetToken)
				if re != nil {
					return referenceGraphResult{}, re
				}
				if resolved.id <= 0 || !frontierSet[resolved.id] || (e.TargetScheme == "p" && resolved.role != "anon") {
					continue
				}
				dst = resolved.id
			}
			if dst <= 0 || dst == e.SourceNodeID || !frontierSet[dst] {
				continue
			}
			meta, me := getMeta(e.SourceNodeID)
			if me != nil {
				return referenceGraphResult{}, me
			}
			if meta == nil {
				continue
			}
			if addNode(referenceGraphNodeDTO{
				ID:      meta.ID,
				Title:   meta.Title,
				Kind:    meta.Kind,
				DocType: meta.DocType,
				Depth:   hop,
			}, true) {
				addEdge(meta.ID, dst, e.RelationKind)
			}
		}

		frontier = nextFrontier
	}

	// Final pre-return TOCTOU session + per-node permission recheck.
	if err := ctx.Err(); err != nil {
		return referenceGraphResult{}, err
	}
	user, err := s.Store.SessionUser(ctx, guard.SessionHash, s.now())
	if err != nil || user.ID != guard.UserID {
		return referenceGraphResult{}, store.ErrUnauthenticated
	}
	if _, err := s.Store.GetDoc(ctx, guard.UserID, centerID); err != nil {
		return referenceGraphResult{}, err
	}

	finalNodes := make([]referenceGraphNodeDTO, 0, len(nodes))
	alive := make(map[int64]bool, len(nodes))
	for _, n := range nodes {
		if n.Href != "" {
			match := referenceToken.FindStringSubmatch(n.Href)
			if match == nil {
				continue
			}
			resolved, re := s.resolveReferenceToken(ctx, guard, match[2])
			if re != nil {
				return referenceGraphResult{}, re
			}
			if resolved.id != n.ID || (match[1] == "p" && resolved.role != "anon") {
				continue
			}
			n.Title = resolved.title
			n.Kind = resolved.kind
			n.DocType = resolved.docType
			finalNodes = append(finalNodes, n)
			alive[n.ID] = true
			continue
		}
		d, e := s.Store.GetDoc(ctx, guard.UserID, n.ID)
		if errors.Is(e, store.ErrNotFound) {
			continue
		}
		if e != nil {
			return referenceGraphResult{}, e
		}
		n.Title = d.Title
		n.Kind = d.Kind
		n.DocType = d.DocType
		finalNodes = append(finalNodes, n)
		alive[n.ID] = true
	}
	if !alive[centerID] {
		return referenceGraphResult{}, store.ErrNotFound
	}
	finalEdges := make([]referenceGraphEdgeDTO, 0, len(edges))
	for _, e := range edges {
		if alive[e.SourceID] && alive[e.TargetID] {
			finalEdges = append(finalEdges, e)
		}
	}
	sort.Slice(finalNodes, func(i, j int) bool {
		if finalNodes[i].Depth != finalNodes[j].Depth {
			return finalNodes[i].Depth < finalNodes[j].Depth
		}
		return finalNodes[i].ID < finalNodes[j].ID
	})
	sort.Slice(finalEdges, func(i, j int) bool {
		if finalEdges[i].SourceID != finalEdges[j].SourceID {
			return finalEdges[i].SourceID < finalEdges[j].SourceID
		}
		if finalEdges[i].TargetID != finalEdges[j].TargetID {
			return finalEdges[i].TargetID < finalEdges[j].TargetID
		}
		return finalEdges[i].RelationKind < finalEdges[j].RelationKind
	})
	return referenceGraphResult{
		CenterID:  centerID,
		Depth:     depth,
		Nodes:     finalNodes,
		Edges:     finalEdges,
		Truncated: truncated,
		Indexed:   true,
	}, nil
}

func graphFromSingleHop(center store.DocMeta, refs referenceResult) referenceGraphResult {
	nodesMap := map[int64]referenceGraphNodeDTO{
		center.ID: {ID: center.ID, Title: center.Title, Kind: center.Kind, DocType: center.DocType, Depth: 0},
	}
	edges := []referenceGraphEdgeDTO{}
	for _, in := range refs.Incoming {
		k := in.Kind
		if k == "" {
			k = "doc"
		}
		nodesMap[in.ID] = referenceGraphNodeDTO{ID: in.ID, Title: in.Title, Kind: k, DocType: in.DocType, Depth: 1}
		rel := in.RelationKind
		if rel == "" {
			rel = "link"
		}
		edges = append(edges, referenceGraphEdgeDTO{SourceID: in.ID, TargetID: center.ID, RelationKind: rel})
	}
	for _, out := range refs.Outgoing {
		k := out.Kind
		if k == "" {
			k = "doc"
		}
		if _, exists := nodesMap[out.ID]; !exists {
			nodesMap[out.ID] = referenceGraphNodeDTO{ID: out.ID, Title: out.Title, Kind: k, DocType: out.DocType, Href: out.Href, Depth: 1}
		}
		rel := out.RelationKind
		if rel == "" {
			rel = "link"
		}
		edges = append(edges, referenceGraphEdgeDTO{SourceID: center.ID, TargetID: out.ID, RelationKind: rel})
	}
	nodes := make([]referenceGraphNodeDTO, 0, len(nodesMap))
	for _, n := range nodesMap {
		nodes = append(nodes, n)
	}
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].Depth != nodes[j].Depth {
			return nodes[i].Depth < nodes[j].Depth
		}
		return nodes[i].ID < nodes[j].ID
	})
	return referenceGraphResult{
		CenterID: center.ID,
		Depth:    1,
		Nodes:    nodes,
		Edges:    edges,
		Indexed:  refs.Indexed,
	}
}
