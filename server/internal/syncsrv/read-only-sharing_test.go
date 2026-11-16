package syncsrv

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
)

func testProjectionViewer(p *ViewProjector) *conn {
	c := &conn{projector: p, projection: make(chan []byte, 1), out: make(chan []byte, 2), cancel: func() {}}
	c.wireMode.Store(2)
	return c
}

func TestReadOnlyBroadcastSharesOnlyIdenticalPolicy(t *testing.T) {
	aCalls, bCalls, failCalls := 0, 0, 0
	a := NewViewProjector(func(*collab.Doc) ([]byte, error) { aCalls++; return []byte("policy-a"), nil })
	b := NewViewProjector(func(*collab.Doc) ([]byte, error) { bCalls++; return []byte("policy-b"), nil })
	failure := NewViewProjector(func(*collab.Doc) ([]byte, error) { failCalls++; return nil, errors.New("unavailable") })
	if NewViewProjector(nil) != nil {
		t.Fatal("nil policy must not authorize a viewer")
	}
	a1, a2, b1, f1, f2 := testProjectionViewer(a), testProjectionViewer(a), testProjectionViewer(b), testProjectionViewer(failure), testProjectionViewer(failure)
	r := &room{doc: collab.NewDoc(), head: 12, epoch: 4, conns: map[*conn]struct{}{a1: {}, a2: {}, b1: {}, f1: {}, f2: {}}}
	r.sendViewProjections()
	if aCalls != 1 || bCalls != 1 || failCalls != 1 {
		t.Fatalf("per-policy calls: a=%d b=%d failure=%d", aCalls, bCalls, failCalls)
	}
	for _, tc := range []struct {
		c     *conn
		state string
	}{{a1, "policy-a"}, {a2, "policy-a"}, {b1, "policy-b"}} {
		msg, err := collab.DecodeServerMsg(<-tc.c.projection)
		if err != nil || msg.Type != collab.MsgProjection || msg.HeadSeq != 12 || msg.HistoryEpoch != 4 || !bytes.Equal(msg.State, []byte(tc.state)) {
			t.Fatalf("incorrect policy output: %+v %v", msg, err)
		}
	}
	for _, c := range []*conn{f1, f2} {
		msg, err := collab.DecodeServerMsg(<-c.out)
		if err != nil || msg.Type != collab.MsgError || msg.Code != "projection_unavailable" {
			t.Fatalf("failed policy sent content: %+v %v", msg, err)
		}
	}
	r.head = 13
	r.sendViewProjections()
	if aCalls != 2 || bCalls != 2 || failCalls != 1 {
		t.Fatalf("cache reused across heads or closed connections: a=%d b=%d failure=%d", aCalls, bCalls, failCalls)
	}
	for _, c := range []*conn{a1, a2, b1} {
		msg, err := collab.DecodeServerMsg(<-c.projection)
		if err != nil || msg.HeadSeq != 13 {
			t.Fatalf("stale head: %+v %v", msg, err)
		}
	}
}

var projectionBenchmarkSink []byte

// The independent variant reproduces the prior per-recipient computation.
// This benchmark excludes network I/O and uses the same document and policy.
func BenchmarkReadOnlyBroadcast(b *testing.B) {
	doc := collab.NewDoc()
	block := doc.CreateBlock(1, collab.Root, "A", "paragraph")
	doc.InsertText(1, block.ID, 0, strings.Repeat("协作文档内容", 1000))
	policy := NewViewProjector(func(d *collab.Doc) ([]byte, error) {
		view, err := d.ReadOnlyProjectionView()
		if err != nil {
			return nil, err
		}
		p, err := d.ReadOnlyProjection(view)
		if err != nil {
			return nil, err
		}
		return p.EncodeState(), nil
	})
	for _, count := range []int{1, 10, 50} {
		b.Run(fmt.Sprintf("independent-%d", count), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				for n := 0; n < count; n++ {
					state, err := policy.project(doc)
					if err != nil {
						b.Fatal(err)
					}
					projectionBenchmarkSink = collab.EncodeProjection(3, 1, state)
				}
			}
		})
		b.Run(fmt.Sprintf("shared-%d", count), func(b *testing.B) {
			r := &room{doc: doc, head: 3, epoch: 1, conns: map[*conn]struct{}{}}
			for n := 0; n < count; n++ {
				r.conns[testProjectionViewer(policy)] = struct{}{}
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				r.sendViewProjections()
			}
		})
	}
}

func BenchmarkReadOnlyProjectionFormatted(b *testing.B) {
	doc := collab.NewDoc()
	block := doc.CreateBlock(1, collab.Root, "A", "paragraph")
	insert := doc.InsertText(1, block.ID, 0, strings.Repeat("协作文档内容", 1000))
	value := "true"
	mark := collab.Op{T: collab.TMark, ID: collab.OpID{Client: 1, Clock: doc.Clock() + 1}, Block: block.ID, Key: "bold", Value: &value, Start: collab.Anchor{Char: insert.ID}, End: collab.Anchor{Char: collab.OpID{Client: insert.ID.Client, Clock: insert.ID.Clock + 2999}, Side: 1}}
	doc.Apply(mark)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		view, err := doc.ReadOnlyProjectionView()
		if err != nil {
			b.Fatal(err)
		}
		p, err := doc.ReadOnlyProjection(view)
		if err != nil {
			b.Fatal(err)
		}
		projectionBenchmarkSink = p.EncodeState()
	}
}
