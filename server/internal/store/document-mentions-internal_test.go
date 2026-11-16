package store

import (
	"context"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
)

func TestCommittedDocumentMentionsRequireNewMatchingMark(t *testing.T) {
	value := "7"
	mark := collab.Op{T: collab.TMark, ID: collab.OpID{Client: 2, Clock: 8}, Block: collab.OpID{Client: 2, Clock: 1}, Key: "mention", Value: &value, Start: collab.Anchor{Char: collab.OpID{Client: 2, Clock: 3}}, End: collab.Anchor{Char: collab.OpID{Client: 2, Clock: 4}, Side: 1}}
	raw, err := collab.EncodeOps([]collab.Op{mark})
	if err != nil {
		t.Fatal(err)
	}
	ops := []RawOp{{ClientID: 2, Clock: 8, Bytes: raw}}
	ctx := WithDocumentMentions(context.Background(), []DocumentMention{{ClientID: 2, Clock: 8, RecipientID: 7}, {ClientID: 2, Clock: 8, RecipientID: 7}, {ClientID: 2, Clock: 8, RecipientID: 8}, {ClientID: 2, Clock: 9, RecipientID: 7}})
	if got := committedDocumentMentions(ctx, ops, []int64{10}, 1); len(got) != 1 || got[0].RecipientID != 7 {
		t.Fatalf("unexpected candidates: %+v", got)
	}
	if got := committedDocumentMentions(ctx, ops, []int64{0}, 1); len(got) != 0 {
		t.Fatalf("duplicate sent: %+v", got)
	}
	if got := committedDocumentMentions(ctx, ops, []int64{10}, 7); len(got) != 0 {
		t.Fatalf("self mention sent: %+v", got)
	}
}
