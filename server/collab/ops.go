// Package collab is the Go implementation of the Jiange collaborative document
// model (spec/PROTOCOL.md). It must stay byte- and state-compatible with
// packages/collab (TypeScript); spec/vectors enforce that.
package collab

import "fmt"

// OpID identifies an operation: (Client, Clock). Clock is a Lamport timestamp.
type OpID struct {
	Client uint64 `json:"client"`
	Clock  uint64 `json:"clock"`
}

// Root is the virtual root of the block tree and of every text sequence.
var Root = OpID{}

func (a OpID) Key() string { return fmt.Sprintf("%d:%d", a.Client, a.Clock) }

// Cmp orders by clock, then client.
func (a OpID) Cmp(b OpID) int {
	switch {
	case a.Clock < b.Clock:
		return -1
	case a.Clock > b.Clock:
		return 1
	case a.Client < b.Client:
		return -1
	case a.Client > b.Client:
		return 1
	}
	return 0
}

// Anchor points just before (Side 0) or just after (Side 1) a character.
type Anchor struct {
	Char OpID  `json:"char"`
	Side uint8 `json:"side"`
}

// Op kinds.
const (
	TBlockCreate = "bcreate"
	TBlockMove   = "bmove"
	TBlockSet    = "bset"
	TBlockDelete = "bdel"
	TTextInsert  = "tins"
	TTextDelete  = "tdel"
	TMark        = "mark"
)

// Op is a tagged union mirroring the TypeScript Op type; unused fields are zero.
type Op struct {
	T      string  `json:"t"`
	ID     OpID    `json:"id"`
	Block  OpID    `json:"block"`
	Parent OpID    `json:"parent"`
	Pos    string  `json:"pos"`
	Type   string  `json:"type"`
	Key    string  `json:"key"`
	Value  *string `json:"value"`
	Side   uint8   `json:"side"`
	Text   string  `json:"text"`
	Target OpID    `json:"target"`
	Len    uint64  `json:"len"`
	Start  Anchor  `json:"start"`
	End    Anchor  `json:"end"`
}

// Span is the number of Lamport ticks the op consumes.
func (o *Op) Span() uint64 {
	if o.T == TTextInsert {
		return uint64(len([]rune(o.Text)))
	}
	return 1
}
