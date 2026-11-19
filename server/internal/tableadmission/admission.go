// Package tableadmission contains an isolated, head-bound rich-table admission
// prototype. It is not wired into the live synchronization or API paths.
package tableadmission

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/tableexperimental"
)

var ErrInvalid = errors.New("invalid experimental table history or batch")

const (
	maxRecords      = 200000
	maxRecordBytes  = 64 << 10
	maxHistoryBytes = 32 << 20
	maxStateBytes   = 8 << 20
	maxBatch        = 4096
	maxPayloadBytes = 512
	maxSafeInteger  = uint64(1<<53 - 1)
)

// Record is one complete, ordered document log record from the authoritative store.
type Record struct {
	Seq  int64
	Data []byte
}

// Projection is privately held state reconstructed from a complete log.
type Projection struct {
	head  int64
	block collab.OpID
	doc   *collab.Doc
	table *tableexperimental.Table
}

// Prepared is a detached candidate. Its caller MUST still verify authorization,
// document epoch, current head and durable operation identities inside the same
// storage transaction that appends these frames. It is not a commit receipt.
type Prepared struct {
	head          int64
	docState      []byte
	tableSnapshot []byte
}

func (p *Prepared) BaseHead() int64       { return p.head }
func (p *Prepared) DocumentState() []byte { return append([]byte(nil), p.docState...) }
func (p *Prepared) TableSnapshot() []byte { return append([]byte(nil), p.tableSnapshot...) }

func invalid(message string) error { return fmt.Errorf("%w: %s", ErrInvalid, message) }

func decodePayload(op collab.Op) (tableexperimental.Op, error) {
	var inner tableexperimental.Op
	if op.T != collab.TTable || len(op.Payload) == 0 || len(op.Payload) > maxPayloadBytes || op.ID.Client == 0 || op.ID.Client > maxSafeInteger || op.ID.Clock == 0 || op.ID.Clock > maxSafeInteger {
		return inner, invalid("table frame")
	}
	if err := json.Unmarshal(op.Payload, &inner); err != nil {
		return inner, invalid("table payload")
	}
	if inner.ID.Client != int64(op.ID.Client) || inner.ID.Clock != int64(op.ID.Clock) {
		return inner, invalid("nested identity")
	}
	return inner, nil
}

// Rebuild verifies every sequence from genesis and compares the resulting full
// state with the caller's head snapshot. Histories requiring compaction, a
// missing record, or a second experimental table are refused for now.
func Rebuild(expected *collab.Doc, head int64, block collab.OpID, records []Record) (*Projection, error) {
	if expected == nil || expected.Pending() != 0 || head <= 0 || head > maxRecords || int64(len(records)) != head || block == collab.Root {
		return nil, invalid("head or scope")
	}
	expectedBytes := expected.EncodeState()
	if len(expectedBytes) > maxStateBytes {
		return nil, invalid("document state limit")
	}
	doc, table := collab.NewDoc(), tableexperimental.New()
	total, decoded, tableOps := 0, 0, 0
	for i, record := range records {
		if record.Seq != int64(i+1) || len(record.Data) == 0 || len(record.Data) > maxRecordBytes || len(record.Data) > maxHistoryBytes-total {
			return nil, invalid("log sequence or size")
		}
		total += len(record.Data)
		ops, err := collab.DecodeOps(record.Data)
		if err != nil || len(ops) == 0 || len(ops) > maxRecords-decoded {
			return nil, invalid("document record")
		}
		decoded += len(ops)
		for _, op := range ops {
			if op.T == collab.TTable {
				if op.Block != block {
					return nil, invalid("multiple experimental tables")
				}
				inner, err := decodePayload(op)
				if err != nil {
					return nil, err
				}
				if _, err = table.Apply(inner); err != nil {
					return nil, invalid("table history")
				}
				tableOps++
			}
			if err := doc.TryApply(op); err != nil {
				return nil, invalid("document history")
			}
		}
	}
	if tableOps == 0 || doc.Pending() != 0 || table.PendingCount() != 0 || len(table.Rejected()) != 0 || !bytes.Equal(doc.EncodeState(), expectedBytes) {
		return nil, invalid("incomplete or inconsistent state")
	}
	_, kind, visible := doc.VisibleBlockText(block)
	if !visible || kind != "table" {
		return nil, invalid("table block is not visible")
	}
	return &Projection{head: head, block: block, doc: doc, table: table}, nil
}

// PrepareMarks validates a content-free, single-table formatting batch on
// private clones. No live document or table state is changed by this method.
func (p *Projection) PrepareMarks(author uint64, frames []collab.Op) (*Prepared, error) {
	if p == nil || p.doc == nil || p.table == nil || author == 0 || author > maxSafeInteger || len(frames) == 0 || len(frames) > maxBatch || p.doc.Pending() != 0 || p.table.PendingCount() != 0 || len(p.table.Rejected()) != 0 || uint64(p.table.MaxClock()) > p.doc.Clock() {
		return nil, invalid("batch scope")
	}
	doc, err := collab.DecodeState(p.doc.EncodeState())
	if err != nil {
		return nil, invalid("document clone")
	}
	table, err := p.table.Clone()
	if err != nil {
		return nil, invalid("table clone")
	}
	clock, total := p.doc.Clock(), 0
	seen := make(map[string]bool, len(frames))
	for _, frame := range frames {
		if frame.Block != p.block || frame.ID.Client != author || frame.ID.Clock <= clock || frame.ID.Clock > maxSafeInteger || len(frame.Payload) > maxHistoryBytes-total {
			return nil, invalid("author, order or block")
		}
		clock = frame.ID.Clock
		total += len(frame.Payload)
		inner, err := decodePayload(frame)
		if err != nil {
			return nil, err
		}
		if inner.Kind != "text-mark" || inner.Row == nil || inner.Column == nil || inner.Target == nil {
			return nil, invalid("unsupported conditional operation")
		}
		key := fmt.Sprintf("%d:%d/%d:%d/%d:%d/%s", inner.Row.Client, inner.Row.Clock, inner.Column.Client, inner.Column.Clock, inner.Target.Client, inner.Target.Clock, inner.Key)
		if seen[key] {
			return nil, invalid("duplicate target")
		}
		seen[key] = true
		if _, ok := table.CellMark(*inner.Row, *inner.Column, *inner.Target, inner.Key, false); !ok {
			return nil, invalid("mark target")
		}
		if applied, err := table.Apply(inner); err != nil || !applied {
			return nil, invalid("table operation")
		}
		state, ok := table.CellMark(*inner.Row, *inner.Column, *inner.Target, inner.Key, false)
		if !ok || state.Version == nil || state.Version.Client != inner.ID.Client || state.Version.Clock != inner.ID.Clock {
			return nil, invalid("mark version")
		}
		if err := doc.TryApply(frame); err != nil {
			return nil, invalid("document operation")
		}
	}
	if table.PendingCount() != 0 || len(table.Rejected()) != 0 {
		return nil, invalid("unresolved table operation")
	}
	docState := doc.EncodeState()
	if len(docState) > maxStateBytes {
		return nil, invalid("document state limit")
	}
	if tableSnapshot, err := table.Snapshot(); err != nil {
		return nil, invalid("table snapshot")
	} else {
		return &Prepared{head: p.head, docState: docState, tableSnapshot: tableSnapshot}, nil
	}
}

// RebuildOrInit mirrors Rebuild but also allows bootstrapping the very first
// formal CRDT table batch on an existing visible "table" block (tableOps == 0).
func RebuildOrInit(expected *collab.Doc, head int64, block collab.OpID, records []Record) (*Projection, error) {
	if expected == nil || expected.Pending() != 0 || head <= 0 || head > maxRecords || int64(len(records)) != head || block == collab.Root {
		return nil, invalid("head or scope")
	}
	expectedBytes := expected.EncodeState()
	if len(expectedBytes) > maxStateBytes {
		return nil, invalid("document state limit")
	}
	doc, table := collab.NewDoc(), tableexperimental.New()
	total, decoded := 0, 0
	for i, record := range records {
		if record.Seq != int64(i+1) || len(record.Data) == 0 || len(record.Data) > maxRecordBytes || len(record.Data) > maxHistoryBytes-total {
			return nil, invalid("log sequence or size")
		}
		total += len(record.Data)
		ops, err := collab.DecodeOps(record.Data)
		if err != nil || len(ops) == 0 || len(ops) > maxRecords-decoded {
			return nil, invalid("document record")
		}
		decoded += len(ops)
		for _, op := range ops {
			if op.T == collab.TTable && op.Block == block {
				inner, err := decodePayload(op)
				if err != nil {
					return nil, err
				}
				if _, err = table.Apply(inner); err != nil {
					return nil, invalid("table history")
				}
			}
			if err := doc.TryApply(op); err != nil {
				return nil, invalid("document history")
			}
		}
	}
	if doc.Pending() != 0 || table.PendingCount() != 0 || len(table.Rejected()) != 0 || !bytes.Equal(doc.EncodeState(), expectedBytes) {
		return nil, invalid("incomplete or inconsistent state")
	}
	_, kind, visible := doc.VisibleBlockText(block)
	if !visible || kind != "table" {
		return nil, invalid("table block is not visible")
	}
	return &Projection{head: head, block: block, doc: doc, table: table}, nil
}

// PrepareBatch validates a single-table formal CRDT batch (structural ops, cell
// text ops, or rich text-mark ops) on private clones without mutating live state.
func (p *Projection) PrepareBatch(author uint64, frames []collab.Op) (*Prepared, error) {
	if p == nil || p.doc == nil || p.table == nil || author == 0 || author > maxSafeInteger || len(frames) == 0 || len(frames) > maxBatch || p.doc.Pending() != 0 || p.table.PendingCount() != 0 || len(p.table.Rejected()) != 0 || uint64(p.table.MaxClock()) > p.doc.Clock() {
		return nil, invalid("batch scope")
	}
	doc, err := collab.DecodeState(p.doc.EncodeState())
	if err != nil {
		return nil, invalid("document clone")
	}
	table, err := p.table.Clone()
	if err != nil {
		return nil, invalid("table clone")
	}
	clock, total := p.doc.Clock(), 0
	for _, frame := range frames {
		if frame.Block != p.block || frame.ID.Client != author || frame.ID.Clock <= clock || frame.ID.Clock > maxSafeInteger || len(frame.Payload) > maxHistoryBytes-total {
			return nil, invalid("author, order or block")
		}
		clock = frame.ID.Clock
		total += len(frame.Payload)
		inner, err := decodePayload(frame)
		if err != nil {
			return nil, err
		}
		if applied, err := table.Apply(inner); err != nil || !applied {
			return nil, invalid("table operation")
		}
		if err := doc.TryApply(frame); err != nil {
			return nil, invalid("document operation")
		}
	}
	if table.PendingCount() != 0 || len(table.Rejected()) != 0 {
		return nil, invalid("unresolved table operation")
	}
	docState := doc.EncodeState()
	if len(docState) > maxStateBytes {
		return nil, invalid("document state limit")
	}
	tableSnapshot, err := table.Snapshot()
	if err != nil {
		return nil, invalid("table snapshot")
	}
	return &Prepared{head: p.head, docState: docState, tableSnapshot: tableSnapshot}, nil
}
