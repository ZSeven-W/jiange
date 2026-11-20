package store

import (
	"context"
	"time"
)

// IsReferenceableKind reports whether a node kind participates in
// bidirectional references and the knowledge graph.
func IsReferenceableKind(kind string) bool {
	switch kind {
	case "doc", "sheet", "base", "slides", "survey":
		return true
	}
	return false
}

// ReferenceIndexState records the exact source version at which outgoing
// reference edges were extracted and persisted.
type ReferenceIndexState struct {
	SourceNodeID int64
	SourceKind   string
	SourceEpoch  int64
	SourceSeq    int64
	SourceStamp  time.Time
	IndexedAt    time.Time
}

// ReferenceEdge is a single materialized outgoing reference extracted from a
// source node (document, board, sheet, base, slides, or survey).
type ReferenceEdge struct {
	SourceNodeID int64
	TargetNodeID int64  // >0 for direct resource links/embeds; 0 for share-token refs
	TargetToken  string // non-empty for #/s/<token> or #/p/<token>
	TargetScheme string // "s" or "p" when TargetToken != ""
	SourceBlock  string // CRDT block ID "c:k", or "rec:<id>", "slide:<id>", "sheet:<id>", "survey:<qid>"
	Excerpt      string // clipped <= 180 runes
	RelationKind string // "link" | "embed"
}

// ReferenceIndexStore persists incrementally refreshed bidirectional link edges.
type ReferenceIndexStore interface {
	GetReferenceIndexStates(ctx context.Context, sourceIDs []int64) (map[int64]ReferenceIndexState, error)
	ReplaceReferenceEdges(ctx context.Context, state ReferenceIndexState, edges []ReferenceEdge) error
	ListOutgoingReferenceEdges(ctx context.Context, sourceIDs []int64) ([]ReferenceEdge, error)
	ListIncomingReferenceEdges(ctx context.Context, targetIDs []int64, targetTokens []string) ([]ReferenceEdge, error)
	ListNodeLinkTokens(ctx context.Context, nodeIDs []int64) (map[int64]string, error)
	ListDocHeadVersions(ctx context.Context, docIDs []int64) (map[int64][2]int64, error)
	ListSheetWorkbookRevisions(ctx context.Context, sheetIDs []int64) (map[int64]int64, error)
}

func (m *Memory) GetReferenceIndexStates(_ context.Context, sourceIDs []int64) (map[int64]ReferenceIndexState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[int64]ReferenceIndexState, len(sourceIDs))
	if m.refIndexState == nil {
		return out, nil
	}
	for _, id := range sourceIDs {
		if st, ok := m.refIndexState[id]; ok {
			out[id] = st
		}
	}
	return out, nil
}

func (m *Memory) ReplaceReferenceEdges(_ context.Context, state ReferenceIndexState, edges []ReferenceEdge) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(state.SourceNodeID)
	if d == nil || d.deleted || d.purged {
		delete(m.refIndexState, state.SourceNodeID)
		delete(m.refIndexEdges, state.SourceNodeID)
		return nil
	}
	if m.refIndexState == nil {
		m.refIndexState = map[int64]ReferenceIndexState{}
	}
	if m.refIndexEdges == nil {
		m.refIndexEdges = map[int64][]ReferenceEdge{}
	}
	state.IndexedAt = time.Now()
	m.refIndexState[state.SourceNodeID] = state
	copied := make([]ReferenceEdge, len(edges))
	copy(copied, edges)
	m.refIndexEdges[state.SourceNodeID] = copied
	return nil
}

func (m *Memory) ListOutgoingReferenceEdges(_ context.Context, sourceIDs []int64) ([]ReferenceEdge, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []ReferenceEdge{}
	for _, sid := range sourceIDs {
		d := m.doc(sid)
		if d == nil || d.deleted || d.purged {
			continue
		}
		out = append(out, m.refIndexEdges[sid]...)
	}
	return out, nil
}

func (m *Memory) ListIncomingReferenceEdges(_ context.Context, targetIDs []int64, targetTokens []string) ([]ReferenceEdge, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	idSet := make(map[int64]bool, len(targetIDs))
	for _, id := range targetIDs {
		if id > 0 {
			idSet[id] = true
		}
	}
	tokSet := make(map[string]bool, len(targetTokens))
	for _, tok := range targetTokens {
		if tok != "" {
			tokSet[tok] = true
		}
	}
	if len(idSet) == 0 && len(tokSet) == 0 {
		return []ReferenceEdge{}, nil
	}
	out := []ReferenceEdge{}
	for sid, edges := range m.refIndexEdges {
		d := m.doc(sid)
		if d == nil || d.deleted || d.purged {
			continue
		}
		for _, e := range edges {
			if (e.TargetNodeID > 0 && idSet[e.TargetNodeID]) || (e.TargetToken != "" && tokSet[e.TargetToken]) {
				out = append(out, e)
			}
		}
	}
	return out, nil
}

func (m *Memory) ListNodeLinkTokens(_ context.Context, nodeIDs []int64) (map[int64]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[int64]string{}
	for _, id := range nodeIDs {
		d := m.doc(id)
		if d == nil || d.deleted || d.purged {
			continue
		}
		if link, ok := m.sh.links[id]; ok && link.Token != "" && link.Role != "" && link.Role != "none" {
			out[id] = link.Token
		}
	}
	return out, nil
}

func (m *Memory) ListDocHeadVersions(_ context.Context, docIDs []int64) (map[int64][2]int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[int64][2]int64, len(docIDs))
	for _, id := range docIDs {
		d := m.doc(id)
		if d == nil || d.deleted || d.purged || d.meta.Kind != "doc" {
			continue
		}
		epoch := d.historyEpoch
		if epoch < 1 {
			epoch = 1
		}
		out[id] = [2]int64{epoch, int64(len(d.ops))}
	}
	return out, nil
}

func (m *Memory) ListSheetWorkbookRevisions(_ context.Context, sheetIDs []int64) (map[int64]int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[int64]int64, len(sheetIDs))
	if m.sheets.books == nil {
		return out, nil
	}
	for _, id := range sheetIDs {
		d := m.doc(id)
		if d == nil || d.deleted || d.purged || d.meta.Kind != "sheet" {
			continue
		}
		if wb, ok := m.sheets.books[id]; ok {
			out[id] = wb.revision
		}
	}
	return out, nil
}
