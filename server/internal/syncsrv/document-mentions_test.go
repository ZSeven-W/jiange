package syncsrv

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func checkDocumentMentions(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	e := newEnv(t, st, 1000)
	doc := e.newDoc()
	c := e.client(0, doc)
	var mark collab.Op
	c.edit(func(d *collab.Doc, id uint64) []collab.Op {
		insert := d.InsertText(id, paragraph, 0, "@alice ")
		value := fmt.Sprint(e.users[1].ID)
		mark = collab.Op{T: collab.TMark, ID: collab.OpID{Client: id, Clock: d.Clock() + 1}, Block: paragraph, Key: "mention", Value: &value, Start: collab.Anchor{Char: insert.ID}, End: collab.Anchor{Char: collab.OpID{Client: id, Clock: insert.ID.Clock + 5}, Side: 1}}
		d.Apply(mark)
		return []collab.Op{insert, mark}
	})
	waitFor(t, "mention commit", c.idle)
	notes, err := st.Notifications(ctx, e.users[1].ID, 20)
	if err != nil || len(notes) != 1 || notes[0].CommentID != nil || notes[0].Kind != "mention" {
		t.Fatalf("notice: %+v %v", notes, err)
	}
	comments, err := st.Comments(ctx, doc)
	if err != nil || len(comments) != 0 {
		t.Fatalf("mention created a comment: %+v %v", comments, err)
	}
	// Replaying the identical operation must not produce another notice.
	batch, _ := collab.EncodeOps([]collab.Op{mark})
	head, err := st.Head(ctx, doc)
	if err != nil {
		t.Fatal(err)
	}
	retryCtx := store.WithDocumentMentions(ctx, []store.DocumentMention{{ClientID: int64(mark.ID.Client), Clock: int64(mark.ID.Clock), RecipientID: e.users[1].ID}})
	seqs, err := st.AppendOpsAtHeadGuarded(retryCtx, e.guards[0], doc, head, []store.RawOp{{ClientID: int64(mark.ID.Client), Clock: int64(mark.ID.Clock), Bytes: batch}})
	if err != nil || len(seqs) != 1 || seqs[0] != 0 {
		t.Fatalf("retry: %v %v", seqs, err)
	}
	notes, err = st.Notifications(ctx, e.users[1].ID, 20)
	if err != nil || len(notes) != 1 {
		t.Fatalf("duplicate notification: %+v %v", notes, err)
	}
	// A valid mention for a user without document access must not notify them.
	c.edit(func(d *collab.Doc, id uint64) []collab.Op {
		insert := d.InsertText(id, paragraph, len([]rune(d.Text(paragraph))), "@mallory")
		value := fmt.Sprint(e.users[2].ID)
		op := collab.Op{T: collab.TMark, ID: collab.OpID{Client: id, Clock: d.Clock() + 1}, Block: paragraph, Key: "mention", Value: &value, Start: collab.Anchor{Char: insert.ID}, End: collab.Anchor{Char: collab.OpID{Client: id, Clock: insert.ID.Clock + 7}, Side: 1}}
		d.Apply(op)
		return []collab.Op{insert, op}
	})
	waitFor(t, "outsider mention commit", c.idle)
	notes, err = st.Notifications(ctx, e.users[2].ID, 20)
	if err != nil || len(notes) != 0 {
		t.Fatalf("outsider notified: %+v %v", notes, err)
	}
	// A mention removed before the batch commits does not create a notice.
	c.edit(func(d *collab.Doc, id uint64) []collab.Op {
		at := len([]rune(d.Text(paragraph)))
		insert := d.InsertText(id, paragraph, at, "@alice")
		value := fmt.Sprint(e.users[1].ID)
		op := collab.Op{T: collab.TMark, ID: collab.OpID{Client: id, Clock: d.Clock() + 1}, Block: paragraph, Key: "mention", Value: &value, Start: collab.Anchor{Char: insert.ID}, End: collab.Anchor{Char: collab.OpID{Client: id, Clock: insert.ID.Clock + 5}, Side: 1}}
		d.Apply(op)
		return append([]collab.Op{insert, op}, d.DeleteText(id, paragraph, at, 6)...)
	})
	waitFor(t, "removed mention commit", c.idle)
	notes, err = st.Notifications(ctx, e.users[1].ID, 20)
	if err != nil || len(notes) != 1 {
		t.Fatalf("removed mention notified: %+v %v", notes, err)
	}
	// Access revocation hides already delivered notices, including their title.
	if err = st.SetShare(ctx, doc, e.users[2].ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	c.edit(func(d *collab.Doc, id uint64) []collab.Op {
		at := len([]rune(d.Text(paragraph)))
		insert := d.InsertText(id, paragraph, at, "@mallory")
		value := fmt.Sprint(e.users[2].ID)
		op := collab.Op{T: collab.TMark, ID: collab.OpID{Client: id, Clock: d.Clock() + 1}, Block: paragraph, Key: "mention", Value: &value, Start: collab.Anchor{Char: insert.ID}, End: collab.Anchor{Char: collab.OpID{Client: id, Clock: insert.ID.Clock + 7}, Side: 1}}
		d.Apply(op)
		return []collab.Op{insert, op}
	})
	waitFor(t, "authorized mention commit", c.idle)
	notes, err = st.Notifications(ctx, e.users[2].ID, 20)
	if err != nil || len(notes) != 1 {
		t.Fatalf("authorized user not notified: %+v %v", notes, err)
	}
	if err = st.SetShare(ctx, doc, e.users[2].ID, ""); err != nil {
		t.Fatal(err)
	}
	notes, err = st.Notifications(ctx, e.users[2].ID, 20)
	if err != nil || len(notes) != 0 {
		t.Fatalf("revoked user still sees notice: %+v %v", notes, err)
	}
}

func TestMemoryDocumentMentions(t *testing.T) { checkDocumentMentions(t, store.NewMemory()) }
func TestPostgresDocumentMentions(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	pg, err := store.NewPostgres(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err = migrate.Up(context.Background(), pg.Pool); err != nil {
		t.Fatal(err)
	}
	checkDocumentMentions(t, pg)
}
