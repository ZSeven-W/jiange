package syncsrv

import (
	"context"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestPartlyRejectedBatchRetainsUnacknowledgedOperations(t *testing.T) {
	st := store.NewMemory()
	e := newEnv(t, st, 1000)
	docID := e.newDoc()
	c := e.client(0, docID)
	var batch []collab.Op
	c.edit(func(d *collab.Doc, id uint64) []collab.Op {
		parent := d.InsertText(id, paragraph, 0, "P")
		orphan := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: id, Clock: parent.ID.Clock + 10}, Block: paragraph, Parent: parent.ID, Side: 1, Text: "C"}
		d.Apply(orphan)
		batch = []collab.Op{orphan, parent} // child is rejected until parent is persisted
		return batch
	})
	waitFor(t, "partial rejection", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return len(c.errors) > 0 && c.lastSeq == 3
	})
	c.mu.Lock()
	if len(c.inflight) != 1 || len(c.inflight[0]) != 2 || c.errors[0] != "not_ready" {
		t.Fatalf("rejected batch was incorrectly acknowledged: inflight=%v errors=%v", c.inflight, c.errors)
	}
	c.mu.Unlock()
	if head, err := st.Head(context.Background(), docID); err != nil || head != 3 {
		t.Fatalf("first write persisted unexpected operations: head=%d err=%v", head, err)
	}
	// New servers disconnect immediately after rejection so an old client
	// cannot accidentally consume a later batch's ACK for the rejected batch.
	<-c.done
	c.disconnect()
	c.connect("") // the old client's retained batch is automatically replayed
	waitFor(t, "retry acknowledged", c.idle)
	if head, err := st.Head(context.Background(), docID); err != nil || head != 4 {
		t.Fatalf("retry failed to deduplicate accepted operation: head=%d err=%v", head, err)
	}
	c.mu.Lock()
	got := c.doc.Text(paragraph)
	c.mu.Unlock()
	if got != "PC" {
		t.Fatalf("converged document = %q, want PC", got)
	}
}

func TestLegacyPipelinedWriteIsNotAcknowledgedAfterRejection(t *testing.T) {
	st := store.NewMemory()
	e := newEnv(t, st, 1000)
	docID := e.newDoc()
	c := e.client(0, docID)
	orphan := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: c.clientID, Clock: 500}, Block: paragraph, Parent: collab.OpID{Client: 77, Clock: 1}, Side: 1, Text: "missing"}
	valid := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: c.clientID, Clock: 600}, Block: paragraph, Parent: collab.Root, Side: 1, Text: "later"}
	first, err := collab.EncodeOps([]collab.Op{orphan})
	if err != nil { t.Fatal(err) }
	second, err := collab.EncodeOps([]collab.Op{valid})
	if err != nil { t.Fatal(err) }
	c.write(collab.EncodeClientOps(first))
	c.write(collab.EncodeClientOps(second))
	select {
	case <-c.done:
	case <-time.After(5 * time.Second): t.Fatal("connection remained open after rejection")
	}
	if head, err := st.Head(context.Background(), docID); err != nil || head != 2 {
		t.Fatalf("later legacy batch was processed after rejected batch: head=%d err=%v", head, err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.errors) != 1 || c.errors[0] != "not_ready" { t.Fatalf("unexpected errors: %v", c.errors) }
}
