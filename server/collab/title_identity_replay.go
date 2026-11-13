package collab

import (
	"encoding/binary"
	"errors"
	"hash/maphash"
)

var ErrTitleReplayIdentity = errors.New("title replay: overlapping operation identities")
var ErrTitleReplayLimit = errors.New("title replay: identity index limit")

const titleReplayMaxRecords = 1000000
const titleReplayMaxTreeDepth = 128

// TitleIdentityReplay reconstructs from sequence 1 and checks every operation
// identity range, including body operations omitted by the title projection.
// It is bounded and deliberately has no checkpoint restore: a projection-only
// checkpoint cannot prove the identities in the omitted log prefix. It still
// does not validate full-document causality, checkpoint provenance, database
// immutability, authorization, or old-writer deployment gates.
type TitleIdentityReplay struct {
	projection *TitleProjection
	clients    map[uint64]*titleIdentityNode
	seed       maphash.Seed
	count      uint64
	insertions []*titleIdentityNode
	needs      []titleCausalNeed
}

type titleIdentityNode struct {
	start, end uint64
	priority   uint64
	kind       string
	block      OpID
	origin     OpID
	left       *titleIdentityNode
	right      *titleIdentityNode
}

func NewTitleIdentityReplay(documentID, epoch uint64) (*TitleIdentityReplay, error) {
	projection, err := NewTitleProjection(documentID, epoch)
	if err != nil {
		return nil, err
	}
	return &TitleIdentityReplay{projection: projection, clients: make(map[uint64]*titleIdentityNode), seed: maphash.MakeSeed()}, nil
}

func titleIdentityPriority(seed maphash.Seed, client, clock uint64) uint64 {
	var raw [16]byte
	binary.BigEndian.PutUint64(raw[:8], client)
	binary.BigEndian.PutUint64(raw[8:], clock)
	return maphash.Bytes(seed, raw[:])
}

func titleIdentityCheck(root *titleIdentityNode, start, end uint64) error {
	depth := 0
	for root != nil {
		depth++
		if depth > titleReplayMaxTreeDepth {
			return ErrTitleReplayLimit
		}
		switch {
		case end < root.start:
			root = root.left
		case start > root.end:
			root = root.right
		default:
			return ErrTitleReplayIdentity
		}
	}
	return nil
}

func titleIdentityInsert(root, item *titleIdentityNode) *titleIdentityNode {
	if root == nil {
		return item
	}
	if item.start < root.start {
		root.left = titleIdentityInsert(root.left, item)
		if root.left.priority < root.priority {
			next := root.left
			root.left = next.right
			next.right = root
			return next
		}
	} else {
		root.right = titleIdentityInsert(root.right, item)
		if root.right.priority < root.priority {
			next := root.right
			root.right = next.left
			next.left = root
			return next
		}
	}
	return root
}

// ApplyRecord checks the interval before applying a row. If projection rejects
// a row, the identity index is not advanced; a poisoned projection stays
// unusable. Validation and decoding are shared with the projection.
func (r *TitleIdentityReplay) ApplyRecord(row TitleProjectionRecord) error {
	if r == nil || r.projection == nil {
		return ErrTitleProjectionState
	}
	p := r.projection
	if p.bad != nil {
		return p.bad
	}
	if row.DocumentID != p.docID || row.Epoch != p.epoch {
		return ErrTitleProjectionScope
	}
	if p.head >= titleProjectionMaxInteger || row.Seq != p.head+1 {
		return ErrTitleProjectionOrder
	}
	if r.count >= titleReplayMaxRecords {
		return ErrTitleReplayLimit
	}
	parsed, err := p.validateRecord(row)
	if err != nil {
		return err
	}
	op := parsed.op
	end := op.ID.Clock + parsed.span - 1
	if err := titleIdentityCheck(r.clients[op.ID.Client], op.ID.Clock, end); err != nil {
		return err
	}
	if err := p.applyValidated(row.Seq, parsed); err != nil {
		return err
	}
	item := &titleIdentityNode{start: op.ID.Clock, end: end, priority: titleIdentityPriority(r.seed, op.ID.Client, op.ID.Clock), kind: op.T}
	if op.T == TTextInsert {
		item.block, item.origin = op.Block, op.Parent
		r.insertions = append(r.insertions, item)
	}
	switch op.T {
	case TBlockMove, TBlockSet, TBlockDelete, TTable:
		r.needs = append(r.needs, titleCausalNeed{kind: titleNeedsBlock, block: op.Block})
	case TTextDelete:
		r.needs = append(r.needs, titleCausalNeed{kind: titleNeedsDelete, block: op.Block, first: op.Target, length: op.Len})
	case TMark:
		r.needs = append(r.needs, titleCausalNeed{kind: titleNeedsMark, block: op.Block, first: op.Start.Char, second: op.End.Char})
	}
	r.clients[op.ID.Client] = titleIdentityInsert(r.clients[op.ID.Client], item)
	r.count++
	return nil
}

// CandidateAt requires the caller's intended head. It proves only contiguous
// replay and non-overlapping identities, plus the projection's own dependency
// checks; body-only unresolved operations can still exist in the full doc.
func (r *TitleIdentityReplay) CandidateAt(expectedHead uint64) (TitleProjectionCandidate, error) {
	if r == nil || r.projection == nil {
		return TitleProjectionCandidate{}, ErrTitleProjectionState
	}
	if r.projection.head != expectedHead {
		return TitleProjectionCandidate{}, ErrTitleProjectionOrder
	}
	return r.projection.Candidate()
}
