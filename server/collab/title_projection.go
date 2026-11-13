package collab

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"fmt"
	"unicode/utf8"
)

// TitleProjection is a compact, incremental candidate projection. It retains
// block topology and all title characters (including tombstones), but omits
// body text, marks and table payloads. It is not a full-history validator:
// callers must separately prove log identity, complete causality, and the
// provenance of checkpoints before using a candidate as directory metadata.
// It is not safe for concurrent use and is not connected to production writes.
type TitleProjection struct {
	docID uint64
	epoch uint64
	head  uint64
	doc   *Doc
	bad   error
	// Counts accepted title inserts, including those still awaiting a parent.
	reservedTitleChars uint64
}

const titleProjectionMaxInteger = uint64(1<<53 - 1)
const titleProjectionMaxRecord = 8 << 20
const titleProjectionMaxState = 16 << 20
const titleProjectionMaxPending = 1024

// Doc's current state encoder walks character ancestry recursively. Keep the
// prototype bounded until an iterative codec and long-title benchmarks exist.
const titleProjectionMaxChars = 32768
const titleProjectionMaxDelete = 1 << 20
const titleProjectionMaxBlocks = 50000
const titleProjectionMaxPositionBytes = 512
const titleProjectionMaxTypeBytes = 128

var (
	ErrTitleProjectionScope   = errors.New("title projection: document or epoch mismatch")
	ErrTitleProjectionOrder   = errors.New("title projection: non-contiguous sequence")
	ErrTitleProjectionRecord  = errors.New("title projection: invalid log record")
	ErrTitleProjectionPending = errors.New("title projection: unresolved relevant operations")
	ErrTitleProjectionState   = errors.New("title projection: invalid checkpoint")
	ErrTitleProjectionLimit   = errors.New("title projection: resource limit")
)

var projectedTitleID = OpID{Client: 0, Clock: 1}

// TitleProjectionRecord is one committed, identity-verified operation row.
// Seq is the original document sequence, including rows irrelevant to titles.
type TitleProjectionRecord struct {
	DocumentID uint64
	Epoch      uint64
	Seq        uint64
	ClientID   uint64
	Clock      uint64
	Bytes      []byte
}

// TitleProjectionCandidate describes visibility and text, not whether the
// entire document history is valid or whether this value may be published.
type TitleProjectionCandidate struct {
	DocumentID uint64
	Epoch      uint64
	Head       uint64
	Text       string
	Kind       string
	Visible    bool
}

// TitleProjectionCheckpoint must be stored in a trusted, document-scoped
// store. Digest detects accidental corruption; it does not prove provenance.
type TitleProjectionCheckpoint struct {
	DocumentID uint64
	Epoch      uint64
	Head       uint64
	State      []byte
	Digest     [32]byte
}

func NewTitleProjection(documentID, epoch uint64) (*TitleProjection, error) {
	if documentID == 0 || documentID > titleProjectionMaxInteger || epoch == 0 || epoch > titleProjectionMaxInteger {
		return nil, ErrTitleProjectionScope
	}
	return &TitleProjection{docID: documentID, epoch: epoch, doc: NewDoc()}, nil
}

// ApplyRecord accepts one canonical operation at the next sequence. It does
// not deduplicate a replay at another sequence: the caller must verify the
// durable operation-identity ledger for every row, including ignored rows.
func (p *TitleProjection) ApplyRecord(row TitleProjectionRecord) error {
	if p == nil || p.doc == nil {
		return ErrTitleProjectionState
	}
	if p.bad != nil {
		return p.bad
	}
	if row.DocumentID != p.docID || row.Epoch != p.epoch {
		return ErrTitleProjectionScope
	}
	if p.head >= titleProjectionMaxInteger || row.Seq != p.head+1 {
		return ErrTitleProjectionOrder
	}
	if len(row.Bytes) == 0 || len(row.Bytes) > titleProjectionMaxRecord {
		return ErrTitleProjectionRecord
	}
	// DecodeOps preallocates for the declared operation count. Check the count
	// before calling it so an invalid single-row batch cannot force a huge allocation.
	header := &reader{b: row.Bytes}
	magic, e1 := header.u8()
	version, e2 := header.u8()
	count, e3 := header.uvar()
	if e1 != nil || e2 != nil || e3 != nil || magic != Magic || version != Version || count != 1 {
		return ErrTitleProjectionRecord
	}
	ops, err := DecodeOps(row.Bytes)
	if err != nil || len(ops) != 1 {
		return ErrTitleProjectionRecord
	}
	op := ops[0]
	if op.ID.Client != row.ClientID || op.ID.Clock != row.Clock || op.ID.Clock == 0 {
		return ErrTitleProjectionRecord
	}
	canonical, err := EncodeOps(ops)
	if err != nil || !bytes.Equal(canonical, row.Bytes) {
		return ErrTitleProjectionRecord
	}
	switch op.T {
	case TBlockCreate:
		if len(op.Pos) > titleProjectionMaxPositionBytes || len(op.Type) > titleProjectionMaxTypeBytes {
			return ErrTitleProjectionLimit
		}
	case TBlockMove:
		if op.Block != Root && len(op.Pos) > titleProjectionMaxPositionBytes {
			return ErrTitleProjectionLimit
		}
	case TBlockSet:
		if op.Block == projectedTitleID && op.Key == "type" && len(*op.Value) > titleProjectionMaxTypeBytes {
			return ErrTitleProjectionLimit
		}
	}
	var titleInsert uint64
	if op.T == TTextInsert {
		span := uint64(utf8.RuneCountInString(op.Text))
		if span == 0 || span-1 > titleProjectionMaxInteger-op.ID.Clock {
			return ErrTitleProjectionRecord
		}
		if op.Block == projectedTitleID {
			if p.reservedTitleChars > titleProjectionMaxChars || span > titleProjectionMaxChars-p.reservedTitleChars {
				return ErrTitleProjectionLimit
			}
			titleInsert = span
		}
	}
	if op.T == TTextDelete && (op.Len == 0 || op.Len-1 > titleProjectionMaxInteger-op.Target.Clock) {
		return ErrTitleProjectionRecord
	}
	if op.T == TTextDelete && op.Block == projectedTitleID && op.Len > titleProjectionMaxDelete {
		return ErrTitleProjectionLimit
	}
	if op.T == TBlockCreate && p.doc.blocks[op.ID] == nil && len(p.doc.blocks)-1 >= titleProjectionMaxBlocks {
		return ErrTitleProjectionLimit
	}
	if relevantTitleOperation(op) {
		if !p.doc.Apply(op) {
			return ErrTitleProjectionRecord
		}
		p.reservedTitleChars += titleInsert
		if p.doc.Pending() > titleProjectionMaxPending {
			p.bad = ErrTitleProjectionLimit
			return p.bad
		}
	}
	p.head = row.Seq
	return nil
}

func relevantTitleOperation(op Op) bool {
	switch op.T {
	case TBlockCreate:
		return true
	case TBlockMove, TBlockDelete:
		return op.Block != Root
	case TBlockSet:
		return op.Block == projectedTitleID && op.Key == "type"
	case TTextInsert, TTextDelete:
		return op.Block == projectedTitleID
	default:
		return false
	}
}

// Candidate refuses unresolved relevant dependencies. An ignored body op may
// still be unresolved in the full replica; that must be checked independently.
func (p *TitleProjection) Candidate() (TitleProjectionCandidate, error) {
	if p == nil || p.doc == nil {
		return TitleProjectionCandidate{}, ErrTitleProjectionState
	}
	if p.bad != nil {
		return TitleProjectionCandidate{}, p.bad
	}
	if p.doc.Pending() != 0 {
		return TitleProjectionCandidate{}, ErrTitleProjectionPending
	}
	if block := p.doc.blocks[projectedTitleID]; block != nil && len(block.chars) > titleProjectionMaxChars+1 {
		return TitleProjectionCandidate{}, ErrTitleProjectionLimit
	}
	text, kind, visible := p.doc.VisibleBlockText(projectedTitleID)
	return TitleProjectionCandidate{DocumentID: p.docID, Epoch: p.epoch, Head: p.head, Text: text, Kind: kind, Visible: visible}, nil
}

func titleCheckpointDigest(docID, epoch, head uint64, state []byte) [32]byte {
	h := sha256.New()
	h.Write([]byte("jiange:title-projection:v1\x00"))
	var raw [8]byte
	for _, value := range []uint64{docID, epoch, head, uint64(len(state))} {
		binary.BigEndian.PutUint64(raw[:], value)
		h.Write(raw[:])
	}
	h.Write(state)
	var sum [32]byte
	copy(sum[:], h.Sum(nil))
	return sum
}

// Checkpoint preserves tombstones. It refuses incomplete or oversized state
// rather than truncating the title or pretending the projection is complete.
func (p *TitleProjection) Checkpoint() (TitleProjectionCheckpoint, error) {
	if p == nil || p.doc == nil {
		return TitleProjectionCheckpoint{}, ErrTitleProjectionState
	}
	if p.bad != nil {
		return TitleProjectionCheckpoint{}, p.bad
	}
	if p.doc.Pending() != 0 {
		return TitleProjectionCheckpoint{}, ErrTitleProjectionPending
	}
	if !titleProjectionFitsStateBudget(p.doc) {
		return TitleProjectionCheckpoint{}, ErrTitleProjectionLimit
	}
	state := p.doc.EncodeState()
	if len(state) > titleProjectionMaxState {
		return TitleProjectionCheckpoint{}, ErrTitleProjectionLimit
	}
	if err := preflightTitleProjectionState(state); err != nil {
		return TitleProjectionCheckpoint{}, ErrTitleProjectionState
	}
	return TitleProjectionCheckpoint{DocumentID: p.docID, Epoch: p.epoch, Head: p.head, State: state, Digest: titleCheckpointDigest(p.docID, p.epoch, p.head, state)}, nil
}

// Bound the allocation before encoding; estimates deliberately overcount
// varints and UTF-8 bytes. An over-budget index stays available in memory and
// must be handled by a future streaming checkpoint rather than truncated.
func titleProjectionFitsStateBudget(doc *Doc) bool {
	if len(doc.blocks)-1 > titleProjectionMaxBlocks {
		return false
	}
	remaining := titleProjectionMaxState - 64
	for id, block := range doc.blocks {
		if id == Root {
			continue
		}
		for _, size := range []int{128, len(block.pos), len(block.props["type"].value)} {
			if size > remaining {
				return false
			}
			remaining -= size
		}
		if len(block.chars) > remaining/40 {
			return false
		}
		remaining -= len(block.chars) * 40
	}
	return true
}

// RestoreTitleProjection checks scope, canonical projected shape and checksum.
// A checksum is not authorization, a history identity ledger, or proof that
// the checkpoint was produced from the claimed authoritative log.
func RestoreTitleProjection(documentID, epoch uint64, checkpoint TitleProjectionCheckpoint) (*TitleProjection, error) {
	if documentID == 0 || documentID > titleProjectionMaxInteger || epoch == 0 || epoch > titleProjectionMaxInteger || checkpoint.DocumentID != documentID || checkpoint.Epoch != epoch {
		return nil, ErrTitleProjectionScope
	}
	if checkpoint.Head > titleProjectionMaxInteger || len(checkpoint.State) == 0 || len(checkpoint.State) > titleProjectionMaxState {
		return nil, ErrTitleProjectionState
	}
	digest := titleCheckpointDigest(documentID, epoch, checkpoint.Head, checkpoint.State)
	if subtle.ConstantTimeCompare(digest[:], checkpoint.Digest[:]) != 1 {
		return nil, ErrTitleProjectionState
	}
	if err := preflightTitleProjectionState(checkpoint.State); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrTitleProjectionState, err)
	}
	doc, err := DecodeState(checkpoint.State)
	if err != nil || !validTitleProjectionShape(doc) || !titleProjectionFitsStateBudget(doc) || !bytes.Equal(doc.EncodeState(), checkpoint.State) {
		return nil, fmt.Errorf("%w: malformed projected state", ErrTitleProjectionState)
	}
	var chars uint64
	if block := doc.blocks[projectedTitleID]; block != nil {
		chars = uint64(len(block.chars) - 1)
	}
	if chars > titleProjectionMaxChars {
		return nil, ErrTitleProjectionLimit
	}
	return &TitleProjection{docID: documentID, epoch: epoch, head: checkpoint.Head, doc: doc, reservedTitleChars: chars}, nil
}

// Preflight counts and shape before DecodeState allocates block or character
// nodes. Checkpoints are still trusted inputs: this is not log authentication.
func preflightTitleProjectionState(state []byte) error {
	r := &reader{b: state}
	for _, want := range []byte{Magic, StateTag, Version} {
		got, err := r.u8()
		if err != nil || got != want {
			return ErrTitleProjectionState
		}
	}
	if _, err := r.uvar(); err != nil {
		return err
	} // projected Lamport clock
	blocks, err := r.uvar()
	if err != nil || blocks > titleProjectionMaxBlocks {
		return ErrTitleProjectionState
	}
	seen := make(map[OpID]struct{})
	var previousBlock OpID
	for i := uint64(0); i < blocks; i++ {
		id, err := r.id()
		if err != nil || id == Root || (i > 0 && previousBlock.Cmp(id) >= 0) {
			return ErrTitleProjectionState
		}
		previousBlock = id
		if _, ok := seen[id]; ok {
			return ErrTitleProjectionState
		}
		seen[id] = struct{}{}
		if _, err = r.id(); err != nil {
			return err
		} // parent
		position, err := r.str()
		if err != nil || len(position) > titleProjectionMaxPositionBytes {
			return ErrTitleProjectionState
		} // position
		if _, err = r.id(); err != nil {
			return err
		} // location timestamp
		deleted, err := r.u8()
		if err != nil || deleted > 1 {
			return ErrTitleProjectionState
		}
		props, err := r.uvar()
		if err != nil || props != 1 {
			return ErrTitleProjectionState
		}
		key, err := r.str()
		if err != nil || key != "type" {
			return ErrTitleProjectionState
		}
		typ, err := r.str()
		if err != nil || len(typ) > titleProjectionMaxTypeBytes {
			return ErrTitleProjectionState
		}
		if _, err = r.id(); err != nil {
			return err
		}
		chars, err := r.uvar()
		if err != nil || chars > titleProjectionMaxChars || (id != projectedTitleID && chars != 0) {
			return ErrTitleProjectionState
		}
		type childSlot struct {
			parent uint64
			side   uint8
		}
		lastChild := make(map[childSlot]OpID)
		for j := uint64(0); j < chars; j++ {
			cid, err := r.id()
			if err != nil || cid == Root {
				return ErrTitleProjectionState
			}
			if _, ok := seen[cid]; ok {
				return ErrTitleProjectionState
			}
			seen[cid] = struct{}{}
			side, err := r.side()
			if err != nil {
				return err
			}
			parent, err := r.uvar()
			if err != nil || parent > j {
				return ErrTitleProjectionState
			}
			slot := childSlot{parent: parent, side: side}
			if last, ok := lastChild[slot]; ok && last.Cmp(cid) >= 0 {
				return ErrTitleProjectionState
			}
			lastChild[slot] = cid
			deleted, err := r.u8()
			if err != nil || deleted > 1 {
				return ErrTitleProjectionState
			}
			char, err := r.str()
			if err != nil || utf8.RuneCountInString(char) != 1 {
				return ErrTitleProjectionState
			}
		}
		marks, err := r.uvar()
		if err != nil || marks != 0 {
			return ErrTitleProjectionState
		}
	}
	if r.i != len(state) {
		return ErrTitleProjectionState
	}
	return nil
}

func validTitleProjectionShape(doc *Doc) bool {
	if doc == nil || doc.Pending() != 0 || doc.HasTables() {
		return false
	}
	for id, block := range doc.blocks {
		if id == Root {
			continue
		}
		if len(block.marks) != 0 || len(block.props) != 1 {
			return false
		}
		for key := range block.props {
			if key != "type" {
				return false
			}
		}
		if id != projectedTitleID && len(block.chars) != 1 {
			return false
		}
	}
	return true
}
