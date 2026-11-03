package collab

import (
	"errors"
	"fmt"
)

// Sync protocol message types (spec/PROTOCOL.md §Sync).
const (
	MsgHello   = 0x01
	MsgOps     = 0x02
	MsgAck     = 0x03
	MsgAware   = 0x04
	MsgWelcome = 0x11
	MsgSOps    = 0x12
	MsgSAck    = 0x13
	MsgSAware  = 0x14
	MsgError   = 0x15
)

// ClientMsg is a decoded client→server message.
type ClientMsg struct {
	Type     byte
	DocID    uint64
	ClientID uint64
	LastSeq  uint64
	Batch    []byte
	Seq      uint64
	State    string
}

func (w *writer) bytes(b []byte) { w.uvar(uint64(len(b))); w.b = append(w.b, b...) }

func (r *reader) bytes() ([]byte, error) {
	n, err := r.uvar()
	if err != nil {
		return nil, err
	}
	if uint64(len(r.b)-r.i) < n {
		return nil, ErrShort
	}
	out := r.b[r.i : r.i+int(n)]
	r.i += int(n)
	return out, nil
}

func DecodeClientMsg(b []byte) (m ClientMsg, err error) {
	r := &reader{b: b}
	if m.Type, err = r.u8(); err != nil {
		return
	}
	switch m.Type {
	case MsgHello:
		if m.DocID, err = r.uvar(); err == nil {
			if m.ClientID, err = r.uvar(); err == nil {
				m.LastSeq, err = r.uvar()
			}
		}
	case MsgOps:
		m.Batch, err = r.bytes()
	case MsgAck:
		m.Seq, err = r.uvar()
	case MsgAware:
		m.State, err = r.str()
	default:
		return m, fmt.Errorf("collab: unknown client message %d", m.Type)
	}
	if err == nil && r.i != len(b) {
		err = errors.New("collab: trailing bytes")
	}
	return
}

func EncodeHello(docID, clientID, lastSeq uint64) []byte {
	w := &writer{}
	w.u8(MsgHello)
	w.uvar(docID)
	w.uvar(clientID)
	w.uvar(lastSeq)
	return w.b
}

func EncodeClientOps(batch []byte) []byte { w := &writer{}; w.u8(MsgOps); w.bytes(batch); return w.b }
func EncodeClientAck(seq uint64) []byte   { w := &writer{}; w.u8(MsgAck); w.uvar(seq); return w.b }
func EncodeClientAware(s string) []byte   { w := &writer{}; w.u8(MsgAware); w.str(s); return w.b }

// ServerMsg is a decoded server→client message.
type ServerMsg struct {
	Type     byte
	ClientID uint64
	HeadSeq  uint64
	HasSnap  bool
	SnapSeq  uint64
	State    []byte
	FirstSeq uint64
	Batch    []byte
	Count    uint64
	Aware    string
	Code     string
	Message  string
}

func EncodeWelcome(clientID, head uint64, snapSeq uint64, state []byte) []byte {
	w := &writer{}
	w.u8(MsgWelcome)
	w.uvar(clientID)
	w.uvar(head)
	if state != nil {
		w.u8(1)
		w.uvar(snapSeq)
		w.bytes(state)
	} else {
		w.u8(0)
	}
	return w.b
}

func EncodeServerOps(first uint64, batch []byte) []byte {
	w := &writer{}
	w.u8(MsgSOps)
	w.uvar(first)
	w.bytes(batch)
	return w.b
}

func EncodeServerAck(first, count uint64) []byte {
	w := &writer{}
	w.u8(MsgSAck)
	w.uvar(first)
	w.uvar(count)
	return w.b
}

func EncodeServerAware(clientID uint64, s string) []byte {
	w := &writer{}
	w.u8(MsgSAware)
	w.uvar(clientID)
	w.str(s)
	return w.b
}

func EncodeError(code, msg string) []byte {
	w := &writer{}
	w.u8(MsgError)
	w.str(code)
	w.str(msg)
	return w.b
}

func DecodeServerMsg(b []byte) (m ServerMsg, err error) {
	r := &reader{b: b}
	if m.Type, err = r.u8(); err != nil {
		return
	}
	switch m.Type {
	case MsgWelcome:
		if m.ClientID, err = r.uvar(); err != nil {
			return
		}
		if m.HeadSeq, err = r.uvar(); err != nil {
			return
		}
		var has byte
		if has, err = r.u8(); err != nil {
			return
		}
		if has == 1 {
			m.HasSnap = true
			if m.SnapSeq, err = r.uvar(); err == nil {
				m.State, err = r.bytes()
			}
		}
	case MsgSOps:
		if m.FirstSeq, err = r.uvar(); err == nil {
			m.Batch, err = r.bytes()
		}
	case MsgSAck:
		if m.FirstSeq, err = r.uvar(); err == nil {
			m.Count, err = r.uvar()
		}
	case MsgSAware:
		if m.ClientID, err = r.uvar(); err == nil {
			m.Aware, err = r.str()
		}
	case MsgError:
		if m.Code, err = r.str(); err == nil {
			m.Message, err = r.str()
		}
	default:
		return m, fmt.Errorf("collab: unknown server message %d", m.Type)
	}
	if err == nil && r.i != len(b) {
		err = errors.New("collab: trailing bytes")
	}
	return
}
