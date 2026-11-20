package api

import (
	"context"
	"errors"
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

var referenceSlots = make(chan struct{}, 2)
var referenceToken = regexp.MustCompile(`^#/(s|p)/([A-Za-z0-9_-]{1,256})$`)
var referenceBlock = regexp.MustCompile(`^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$`)
var errReferenceIncomplete = errors.New("document reference scan incomplete")

type referenceContext struct {
	Block        string `json:"block"`
	Text         string `json:"text,omitempty"`
	RelationKind string `json:"relationKind,omitempty"`
}
type referenceItem struct {
	ID           int64              `json:"id"`
	Title        string             `json:"title"`
	Kind         string             `json:"kind,omitempty"`
	DocType      string             `json:"docType,omitempty"`
	Href         string             `json:"href,omitempty"`
	RelationKind string             `json:"relationKind,omitempty"`
	Contexts     []referenceContext `json:"contexts,omitempty"`
}
type referenceResult struct {
	Incoming []referenceItem `json:"incoming"`
	Outgoing []referenceItem `json:"outgoing"`
	Indexed  bool            `json:"indexed,omitempty"`
}
type scannedReference struct {
	id, head int64
	edges    map[int64][]referenceContext
	links    map[int64]string
}
type resolvedReferenceToken struct {
	id      int64
	role    string
	title   string
	kind    string
	docType string
}

func (s *Server) resolveReferenceToken(ctx context.Context, guard store.RestoreGuard, token string) (resolvedReferenceToken, error) {
	reader, ok := s.Store.(store.PasteShareTargetReader)
	if !ok {
		return resolvedReferenceToken{}, errReferenceIncomplete
	}
	value, err := reader.ResolvePasteShareTarget(ctx, guard, token)
	if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrForbidden) {
		return resolvedReferenceToken{}, nil
	}
	if err != nil {
		return resolvedReferenceToken{}, err
	}
	return resolvedReferenceToken{id: value.ID, role: value.Role, title: value.Title, kind: value.Kind, docType: value.DocType}, nil
}

// documentReferences returns bidirectional links (incoming backlinks and
// outgoing links/embeds) using the persistent incremental reference index when
// supported by the store, falling back to a bounded read-only scan otherwise.
func (s *Server) documentReferences(w http.ResponseWriter, r *http.Request) {
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
	select {
	case referenceSlots <- struct{}{}:
		defer func() { <-referenceSlots }()
	default:
		httpx.Error(w, http.StatusServiceUnavailable, "references_busy", "文档引用正在查询，请稍后重试。")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	result, err := s.scanDocumentReferences(ctx, guard, target.ID)
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
		httpx.Error(w, http.StatusServiceUnavailable, "references_incomplete", "引用查询未完成，文档过多、内容过大或服务暂不可用。")
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}

func (s *Server) scanDocumentReferences(ctx context.Context, guard store.RestoreGuard, target int64) (referenceResult, error) {
	if idxStore, ok := s.Store.(store.ReferenceIndexStore); ok {
		return s.queryIndexedDocumentReferences(ctx, guard, target, idxStore)
	}
	return s.scanDocumentReferencesFallback(ctx, guard, target)
}

func (s *Server) scanDocumentReferencesFallback(ctx context.Context, guard store.RestoreGuard, target int64) (referenceResult, error) {
	result := referenceResult{Incoming: []referenceItem{}, Outgoing: []referenceItem{}}
	const pageSize = 50
	const maxDocs = 200
	const maxBytes = 16 << 20
	const maxTokens = 200
	const maxEdges = 2000
	var after int64
	count, used, edgesCount := 0, 0, 0
	var scanned []scannedReference
	tokens := make(map[string]resolvedReferenceToken)
	for {
		page, err := s.Store.SearchCandidates(ctx, guard.UserID, after, pageSize)
		if err != nil {
			return result, err
		}
		if len(page) == 0 {
			break
		}
		for _, candidate := range page {
			if err := ctx.Err(); err != nil {
				return result, err
			}
			if candidate.ID <= after {
				return result, errReferenceIncomplete
			}
			after = candidate.ID
			count++
			if count > maxDocs {
				return result, errReferenceIncomplete
			}
			if candidate.Kind != "doc" {
				continue
			}
			current, err := s.Store.GetDoc(ctx, guard.UserID, candidate.ID)
			if errors.Is(err, store.ErrNotFound) {
				continue
			}
			if err != nil {
				return result, err
			}
			snapshot, err := s.Store.ReadTitleSnapshot(ctx, candidate.ID)
			if err != nil {
				if _, accessErr := s.Store.GetDoc(ctx, guard.UserID, candidate.ID); errors.Is(accessErr, store.ErrNotFound) {
					continue
				}
				return result, err
			}
			used += len(snapshot.Snapshot)
			for _, op := range snapshot.Ops {
				used += len(op.Bytes)
			}
			if used > maxBytes {
				return result, errReferenceIncomplete
			}
			doc := collab.NewDoc()
			if len(snapshot.Snapshot) > 0 {
				doc, err = collab.DecodeState(snapshot.Snapshot)
				if err != nil {
					return result, err
				}
			}
			seq := snapshot.SnapshotSeq
			for _, row := range snapshot.Ops {
				if err := ctx.Err(); err != nil {
					return result, err
				}
				if row.Seq != seq+1 {
					return result, errReferenceIncomplete
				}
				if len(row.Bytes) < 3 || row.Bytes[0] != collab.Magic || row.Bytes[1] != collab.Version || row.Bytes[2] != 1 {
					return result, errReferenceIncomplete
				}
				ops, e := collab.DecodeOps(row.Bytes)
				if e != nil || len(ops) != 1 || row.ClientID < 0 || uint64(row.ClientID) != ops[0].ID.Client || !doc.Apply(ops[0]) {
					return result, errReferenceIncomplete
				}
				seq = row.Seq
			}
			if seq != snapshot.Head || doc.Pending() != 0 || doc.HasTables() {
				return result, errReferenceIncomplete
			}
			if _, err := s.Store.GetDoc(ctx, guard.UserID, candidate.ID); errors.Is(err, store.ErrNotFound) {
				continue
			} else if err != nil {
				return result, err
			}
			found := map[int64][]referenceContext{}
			links := map[int64]string{}
			for _, block := range doc.View().Blocks {
				if !referenceTextBlock(block.Type) {
					continue
				}
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
					id := documentReferenceID(href)
					if match := referenceToken.FindStringSubmatch(href); match != nil {
						token := match[2]
						cached, seen := tokens[token]
						if !seen {
							if len(tokens) >= maxTokens {
								return result, errReferenceIncomplete
							}
							resolved, e := s.resolveReferenceToken(ctx, guard, token)
							if e != nil {
								return result, e
							}
							cached = resolved
							tokens[token] = cached
						}
						if match[1] == "p" && cached.role != "anon" {
							continue
						}
						id = cached.id
						if id > 0 && candidate.ID == target && links[id] == "" {
							links[id] = href
						}
					}
					if id <= 0 || id == candidate.ID {
						continue
					}
					if !validPublicCharID(block.ID) {
						return result, errReferenceIncomplete
					}
					exists := false
					for _, c := range found[id] {
						if c.Block == block.ID {
							exists = true
							break
						}
					}
					if exists {
						continue
					}
					found[id] = append(found[id], referenceContext{Block: block.ID, Text: snippet})
					edgesCount++
					if edgesCount > maxEdges {
						return result, errReferenceIncomplete
					}
				}
			}
			// Keep context only if the source's current role permits copying; its
			// title and link can still be listed for a read-only collaborator.
			if store.RoleRank(current.Role) == 0 || store.RoleRank(current.CopyMinRole) == 0 || store.RoleRank(current.Role) < store.RoleRank(current.CopyMinRole) {
				for id := range found {
					for i := range found[id] {
						found[id][i].Text = ""
					}
				}
			}
			scanned = append(scanned, scannedReference{id: candidate.ID, head: snapshot.Head, edges: found, links: links})
		}
		if len(page) < pageSize {
			break
		}
	}
	for token, old := range tokens {
		current, err := s.resolveReferenceToken(ctx, guard, token)
		if err != nil {
			return result, err
		}
		if current.id != old.id || current.role != old.role {
			return result, errReferenceIncomplete
		}
		tokens[token] = current
	}
	// Resolve only ids represented in the result and recheck every permission.
	wanted := map[int64]bool{target: true}
	for _, scan := range scanned {
		if scan.id == target {
			for id := range scan.edges {
				wanted[id] = true
			}
		}
		if len(scan.edges[target]) > 0 {
			wanted[scan.id] = true
		}
	}
	metadata := map[int64]store.DocMeta{}
	for id := range wanted {
		d, err := s.Store.GetDoc(ctx, guard.UserID, id)
		if errors.Is(err, store.ErrNotFound) {
			if id == target {
				return result, store.ErrNotFound
			}
			continue
		}
		if err != nil {
			return result, err
		}
		if d.Kind == "doc" {
			metadata[id] = d
		}
	}
	if _, ok := metadata[target]; !ok {
		return result, store.ErrNotFound
	}
	for _, scan := range scanned {
		if scan.id != target && len(scan.edges[target]) == 0 {
			continue
		}
		if _, ok := metadata[scan.id]; !ok {
			continue
		}
		head, err := s.Store.Head(ctx, scan.id)
		if err != nil || head != scan.head {
			return result, errReferenceIncomplete
		}
		if scan.id == target {
			for id := range scan.edges {
				if d, ok := metadata[id]; ok {
					result.Outgoing = append(result.Outgoing, referenceItem{ID: id, Title: d.Title})
				} else if match := referenceToken.FindStringSubmatch(scan.links[id]); match != nil {
					resolved := tokens[match[2]]
					if resolved.id == id && (match[1] != "p" || resolved.role == "anon") {
						result.Outgoing = append(result.Outgoing, referenceItem{ID: id, Title: resolved.title, Href: scan.links[id]})
					}
				}
			}
		} else if d, ok := metadata[scan.id]; ok {
			contexts := scan.edges[target]
			if store.RoleRank(d.CopyMinRole) == 0 || store.RoleRank(d.Role) < store.RoleRank(d.CopyMinRole) {
				for i := range contexts {
					contexts[i].Text = ""
				}
			}
			result.Incoming = append(result.Incoming, referenceItem{ID: d.ID, Title: d.Title, Contexts: contexts})
		}
	}
	sort.Slice(result.Incoming, func(i, j int) bool { return result.Incoming[i].ID < result.Incoming[j].ID })
	sort.Slice(result.Outgoing, func(i, j int) bool { return result.Outgoing[i].ID < result.Outgoing[j].ID })
	if err := ctx.Err(); err != nil {
		return result, err
	}
	user, err := s.Store.SessionUser(ctx, guard.SessionHash, s.now())
	if err != nil || user.ID != guard.UserID {
		return referenceResult{}, store.ErrUnauthenticated
	}
	if _, err = s.Store.GetDoc(ctx, guard.UserID, target); err != nil {
		return referenceResult{}, err
	}
	// Source access and copy policy can change while the scan is running.
	// Refresh again before returning and never return a previously captured
	// excerpt after the current policy stops allowing it.
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
		outgoing = append(outgoing, item)
	}
	result.Outgoing = outgoing
	return result, nil
}

func referenceTextBlock(kind string) bool {
	switch kind {
	case "paragraph", "h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9", "bullet", "ordered", "todo", "quote", "callout":
		return true
	}
	return false
}
func clipReferenceText(text string, limit int) string {
	text = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(text, "\r", " "), "\n", " "))
	runes := []rune(text)
	if len(runes) > limit {
		return string(runes[:limit]) + "…"
	}
	return text
}
func documentReferenceID(href string) int64 {
	rest, ok := strings.CutPrefix(href, "#/doc/")
	if !ok {
		return 0
	}
	raw, query, hasQuery := strings.Cut(rest, "?")
	id, err := strconv.ParseInt(raw, 10, 53)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != raw {
		return 0
	}
	if hasQuery {
		values, err := url.ParseQuery(query)
		if err != nil || len(values) != 1 || len(values["block"]) != 1 || !referenceBlock.MatchString(values.Get("block")) {
			return 0
		}
	}
	return id
}
