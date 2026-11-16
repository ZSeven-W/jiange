package store

import (
	"bytes"
	"errors"

	"github.com/ZSeven-W/jiange/server/collab"
)

// ErrOpIdentityConflict means that an operation reuses another operation's
// identity or an identity consumed by a multi-character insertion.
var ErrOpIdentityConflict = errors.New("document operation identity conflict")

// opIdentity decodes production operations; opaque legacy/test rows retain a
// single-tick identity. A decoded row must agree with its indexed identity.
func opIdentity(raw RawOp) (end int64, canonical []byte, decoded bool, err error) {
	const maxClock = uint64(1<<53 - 1)
	if raw.ClientID < 0 || raw.Clock < 0 || uint64(raw.Clock) > maxClock {
		return 0, nil, false, ErrOpIdentityConflict
	}
	ops, e := collab.DecodeOps(raw.Bytes)
	if e != nil || len(ops) != 1 {
		return raw.Clock, raw.Bytes, false, nil
	}
	op := ops[0]
	if op.ID.Client != uint64(raw.ClientID) || op.ID.Clock != uint64(raw.Clock) {
		return 0, nil, false, ErrOpIdentityConflict
	}
	span := op.Span()
	if span == 0 {
		span = 1
	}
	if op.ID.Clock > maxClock || span-1 > maxClock-op.ID.Clock {
		return 0, nil, false, ErrOpIdentityConflict
	}
	canonical, e = collab.EncodeOps(ops)
	if e != nil {
		return 0, nil, false, ErrOpIdentityConflict
	}
	return int64(op.ID.Clock + span - 1), canonical, true, nil
}

// compareIdentity returns true only for an exact retry. Unknown historical
// payloads are never assumed safe when a valid new op uses the same client.
func compareIdentity(incoming, existing RawOp) (bool, error) {
	if incoming.ClientID != existing.ClientID {
		return false, nil
	}
	end, a, valid, err := opIdentity(incoming)
	if err != nil {
		return false, err
	}
	otherEnd, b, otherValid, err := opIdentity(existing)
	if err != nil {
		return false, err
	}
	if valid && !otherValid {
		return false, ErrOpIdentityConflict
	}
	if incoming.Clock == existing.Clock && bytes.Equal(a, b) {
		return true, nil
	}
	if incoming.Clock <= otherEnd && existing.Clock <= end {
		return false, ErrOpIdentityConflict
	}
	return false, nil
}
