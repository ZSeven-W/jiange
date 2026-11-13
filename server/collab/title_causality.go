package collab

import (
	"context"
	"errors"
)

var ErrTitleReplayCausality = errors.New("title replay: unresolved or cyclic document dependencies")

const titleReplayMaxCausalWork = 50000000

const (
	titleNeedsBlock uint8 = iota + 1
	titleNeedsDelete
	titleNeedsMark
)

type titleCausalNeed struct {
	kind          uint8
	block         OpID
	first, second OpID
	length        uint64
}

type titleCausalBudget struct {
	ctx   context.Context
	steps int
}

func (b *titleCausalBudget) step() error {
	b.steps++
	if b.steps > titleReplayMaxCausalWork {
		return ErrTitleReplayLimit
	}
	if b.steps&255 == 0 {
		return b.ctx.Err()
	}
	return nil
}

func (r *TitleIdentityReplay) causalIdentity(id OpID, budget *titleCausalBudget) (*titleIdentityNode, error) {
	root := r.clients[id.Client]
	for root != nil {
		if err := budget.step(); err != nil {
			return nil, err
		}
		switch {
		case id.Clock < root.start:
			root = root.left
		case id.Clock > root.end:
			root = root.right
		default:
			return root, nil
		}
	}
	return nil, nil
}

func (r *TitleIdentityReplay) causalBlock(id OpID, budget *titleCausalBudget) (bool, error) {
	if id == Root {
		return true, nil
	}
	node, err := r.causalIdentity(id, budget)
	return node != nil && node.kind == TBlockCreate && node.start == id.Clock, err
}

func (r *TitleIdentityReplay) causalChar(block, id OpID, budget *titleCausalBudget) (*titleIdentityNode, error) {
	if id == Root {
		return nil, nil
	}
	node, err := r.causalIdentity(id, budget)
	if err != nil {
		return nil, err
	}
	if node == nil || node.kind != TTextInsert || node.block != block {
		return nil, ErrTitleReplayCausality
	}
	return node, nil
}

// ValidateFullCausality checks dependency completeness for an uncut replay
// from sequence 1 without retaining body text. It matches Doc.Apply's block,
// text-origin, deletion and mark readiness rules. It does not validate table
// payload semantics, operation authorization, live snapshot GC, log
// immutability across pages, database rollback, or deployment/version gates.
// The replay must not be modified concurrently while validation runs.
func (r *TitleIdentityReplay) ValidateFullCausality(ctx context.Context, expectedHead uint64) error {
	if r == nil || r.projection == nil {
		return ErrTitleProjectionState
	}
	if r.projection.head != expectedHead {
		return ErrTitleProjectionOrder
	}
	if r.projection.bad != nil {
		return r.projection.bad
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	budget := &titleCausalBudget{ctx: ctx}
	// Every insert has one origin. Resolve the functional graph iteratively so
	// long but valid text chains do not consume the goroutine stack.
	colors := make(map[*titleIdentityNode]uint8, len(r.insertions))
	path := make([]*titleIdentityNode, 0, 64)
	for _, start := range r.insertions {
		if err := budget.step(); err != nil {
			return err
		}
		if colors[start] == 2 {
			continue
		}
		path = path[:0]
		current := start
		for current != nil && colors[current] == 0 {
			if err := budget.step(); err != nil {
				return err
			}
			colors[current] = 1
			path = append(path, current)
			ok, err := r.causalBlock(current.block, budget)
			if err != nil {
				return err
			}
			if !ok {
				return ErrTitleReplayCausality
			}
			current, err = r.causalChar(current.block, current.origin, budget)
			if err != nil {
				return err
			}
		}
		if current != nil && colors[current] == 1 {
			return ErrTitleReplayCausality
		}
		for _, node := range path {
			colors[node] = 2
		}
	}
	for _, need := range r.needs {
		if err := budget.step(); err != nil {
			return err
		}
		ok, err := r.causalBlock(need.block, budget)
		if err != nil {
			return err
		}
		if !ok {
			return ErrTitleReplayCausality
		}
		switch need.kind {
		case titleNeedsBlock:
		case titleNeedsMark:
			if _, err = r.causalChar(need.block, need.first, budget); err != nil {
				return err
			}
			if _, err = r.causalChar(need.block, need.second, budget); err != nil {
				return err
			}
		case titleNeedsDelete:
			if need.length == 0 || need.length-1 > titleProjectionMaxInteger-need.first.Clock {
				return ErrTitleReplayCausality
			}
			end, cursor := need.first.Clock+need.length-1, need.first.Clock
			// Root is the one implicit character not represented by an insert.
			if need.first.Client == 0 && cursor == 0 {
				if end == 0 {
					continue
				}
				cursor++
			}
			for cursor <= end {
				if err := budget.step(); err != nil {
					return err
				}
				node, err := r.causalChar(need.block, OpID{Client: need.first.Client, Clock: cursor}, budget)
				if err != nil {
					return err
				}
				if node == nil {
					return ErrTitleReplayCausality
				}
				if node.end >= end {
					break
				}
				cursor = node.end + 1
			}
		default:
			return ErrTitleReplayCausality
		}
	}
	if r.projection.doc.Pending() != 0 {
		return ErrTitleProjectionPending
	}
	return ctx.Err()
}

// CausallyCheckedCandidate is still only a candidate for the supplied head;
// it cannot by itself authorize or atomically publish a directory title.
func (r *TitleIdentityReplay) CausallyCheckedCandidate(ctx context.Context, expectedHead uint64) (TitleProjectionCandidate, error) {
	candidate, err := r.CandidateAt(expectedHead)
	if err != nil {
		return TitleProjectionCandidate{}, err
	}
	if err = r.ValidateFullCausality(ctx, expectedHead); err != nil {
		return TitleProjectionCandidate{}, err
	}
	return candidate, nil
}
