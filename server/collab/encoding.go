package collab

import (
	"errors"
	"fmt"
	"unicode/utf8"
)

const (
	Magic   = 0x4a
	Version = 1
)

var tags = map[string]byte{TBlockCreate: 1, TBlockMove: 2, TBlockSet: 3, TBlockDelete: 4, TTextInsert: 5, TTextDelete: 6, TMark: 7}

var ErrShort = errors.New("collab: unexpected end of input")

type writer struct{ b []byte }

func (w *writer) u8(v byte) { w.b = append(w.b, v) }
func (w *writer) uvar(v uint64) {
	for v >= 0x80 {
		w.b = append(w.b, byte(v)|0x80)
		v >>= 7
	}
	w.b = append(w.b, byte(v))
}
func (w *writer) str(s string) { w.uvar(uint64(len(s))); w.b = append(w.b, s...) }
func (w *writer) id(id OpID)   { w.uvar(id.Client); w.uvar(id.Clock) }

type reader struct {
	b []byte
	i int
}

func (r *reader) u8() (byte, error) {
	if r.i >= len(r.b) {
		return 0, ErrShort
	}
	r.i++
	return r.b[r.i-1], nil
}

func (r *reader) uvar() (uint64, error) {
	var v uint64
	for k := 0; k < 8; k++ {
		x, err := r.u8()
		if err != nil {
			return 0, err
		}
		v |= uint64(x&0x7f) << (7 * k)
		if x < 0x80 {
			if v > 1<<53-1 {
				return 0, errors.New("collab: varint exceeds 2^53-1")
			}
			return v, nil
		}
	}
	return 0, errors.New("collab: varint too long")
}

func (r *reader) str() (string, error) {
	n, err := r.uvar()
	if err != nil {
		return "", err
	}
	if uint64(len(r.b)-r.i) < n {
		return "", ErrShort
	}
	s := string(r.b[r.i : r.i+int(n)])
	r.i += int(n)
	if !utf8.ValidString(s) {
		return "", errors.New("collab: invalid utf-8")
	}
	return s, nil
}

func (r *reader) id() (OpID, error) {
	c, err := r.uvar()
	if err != nil {
		return OpID{}, err
	}
	k, err := r.uvar()
	return OpID{c, k}, err
}

func (r *reader) side() (uint8, error) {
	s, err := r.u8()
	if err == nil && s > 1 {
		err = fmt.Errorf("collab: bad side %d", s)
	}
	return s, err
}

// EncodeOps encodes a batch of ops (spec/PROTOCOL.md §Encoding).
func EncodeOps(ops []Op) ([]byte, error) {
	w := &writer{b: make([]byte, 0, 64)}
	w.u8(Magic)
	w.u8(Version)
	w.uvar(uint64(len(ops)))
	for i := range ops {
		op := &ops[i]
		tag, ok := tags[op.T]
		if !ok {
			return nil, fmt.Errorf("collab: unknown op type %q", op.T)
		}
		w.u8(tag)
		w.id(op.ID)
		switch op.T {
		case TBlockCreate:
			w.id(op.Parent)
			w.str(op.Pos)
			w.str(op.Type)
		case TBlockMove:
			w.id(op.Block)
			w.id(op.Parent)
			w.str(op.Pos)
		case TBlockSet:
			w.id(op.Block)
			w.str(op.Key)
			if op.Value == nil {
				return nil, errors.New("collab: bset requires value")
			}
			w.str(*op.Value)
		case TBlockDelete:
			w.id(op.Block)
		case TTextInsert:
			w.id(op.Block)
			w.id(op.Parent)
			w.u8(op.Side)
			w.str(op.Text)
		case TTextDelete:
			w.id(op.Block)
			w.id(op.Target)
			w.uvar(op.Len)
		case TMark:
			w.id(op.Block)
			w.str(op.Key)
			if op.Value == nil {
				w.u8(0)
			} else {
				w.u8(1)
				w.str(*op.Value)
			}
			w.id(op.Start.Char)
			w.u8(op.Start.Side)
			w.id(op.End.Char)
			w.u8(op.End.Side)
		}
	}
	return w.b, nil
}

// DecodeOps decodes a batch produced by EncodeOps (or the TS encoder).
func DecodeOps(b []byte) (ops []Op, err error) {
	r := &reader{b: b}
	m, err := r.u8()
	if err != nil {
		return nil, err
	}
	if m != Magic {
		return nil, errors.New("collab: bad magic")
	}
	v, err := r.u8()
	if err != nil {
		return nil, err
	}
	if v != Version {
		return nil, fmt.Errorf("collab: unsupported version %d", v)
	}
	n, err := r.uvar()
	if err != nil {
		return nil, err
	}
	if n > uint64(len(b)) {
		return nil, ErrShort
	}
	ops = make([]Op, 0, n)
	for i := uint64(0); i < n; i++ {
		op, err := readOp(r)
		if err != nil {
			return nil, err
		}
		ops = append(ops, op)
	}
	if r.i != len(b) {
		return nil, errors.New("collab: trailing bytes")
	}
	return ops, nil
}

func readOp(r *reader) (op Op, err error) {
	tag, err := r.u8()
	if err != nil {
		return op, err
	}
	if op.ID, err = r.id(); err != nil {
		return op, err
	}
	// sequential reads; first error wins
	e := func(f func() error) {
		if err == nil {
			err = f()
		}
	}
	rid := func(dst *OpID) func() error { return func() (x error) { *dst, x = r.id(); return } }
	rstr := func(dst *string) func() error { return func() (x error) { *dst, x = r.str(); return } }
	rside := func(dst *uint8) func() error { return func() (x error) { *dst, x = r.side(); return } }
	switch tag {
	case 1:
		op.T = TBlockCreate
		e(rid(&op.Parent))
		e(rstr(&op.Pos))
		e(rstr(&op.Type))
	case 2:
		op.T = TBlockMove
		e(rid(&op.Block))
		e(rid(&op.Parent))
		e(rstr(&op.Pos))
	case 3:
		op.T = TBlockSet
		var v string
		e(rid(&op.Block))
		e(rstr(&op.Key))
		e(rstr(&v))
		op.Value = &v
	case 4:
		op.T = TBlockDelete
		e(rid(&op.Block))
	case 5:
		op.T = TTextInsert
		e(rid(&op.Block))
		e(rid(&op.Parent))
		e(rside(&op.Side))
		e(rstr(&op.Text))
	case 6:
		op.T = TTextDelete
		e(rid(&op.Block))
		e(rid(&op.Target))
		e(func() (x error) { op.Len, x = r.uvar(); return })
	case 7:
		op.T = TMark
		e(rid(&op.Block))
		e(rstr(&op.Key))
		e(func() error {
			has, x := r.u8()
			if x != nil {
				return x
			}
			if has > 1 {
				return errors.New("collab: bad value flag")
			}
			if has == 1 {
				v, x := r.str()
				op.Value = &v
				return x
			}
			return nil
		})
		e(rid(&op.Start.Char))
		e(rside(&op.Start.Side))
		e(rid(&op.End.Char))
		e(rside(&op.End.Side))
	default:
		return op, fmt.Errorf("collab: unknown op tag %d", tag)
	}
	return op, err
}
