package syncsrv

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestConflictingRetryIsNotAcknowledgedAfterSnapshot(t *testing.T) {
	st := store.NewMemory()
	e := newEnv(t, st, 1)
	docID := e.newDoc()
	c := e.client(0, docID)
	var first collab.Op
	c.edit(func(d *collab.Doc, id uint64) []collab.Op {
		first = d.InsertText(id, paragraph, 0, "😀中")
		return []collab.Op{first}
	})
	waitFor(t, "original acknowledged", c.idle)
	head, err := st.Head(context.Background(), docID)
	if err != nil {
		t.Fatal(err)
	}
	bad := first
	bad.Text = "篡改"
	payload, err := collab.EncodeOps([]collab.Op{bad})
	if err != nil {
		t.Fatal(err)
	}
	c.write(collab.EncodeClientOps(payload))
	select {
	case <-c.done:
	case <-time.After(5 * time.Second):
		t.Fatal("conflicting retry did not close connection")
	}
	if got, _ := st.Head(context.Background(), docID); got != head {
		t.Fatalf("conflicting retry advanced head: %d -> %d", head, got)
	}
	c.disconnect()
	c.connect("")
	if got := converge(t, st, docID, c); !strings.Contains(got, "😀中") || strings.Contains(got, "篡改") {
		t.Fatalf("document changed after conflict: %s", got)
	}
}
