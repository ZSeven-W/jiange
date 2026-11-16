package store

import (
	"context"
	"errors"
	"sort"
	"strconv"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/jackc/pgx/v5"
)

// DocumentMention is derived by the sync server from an effective, visible
// mention mark, never from caller-supplied notification content.
type DocumentMention struct {
	ClientID, Clock, RecipientID int64
	Block, Character             string
	Epoch                        int64
}
type documentMentionsKey struct{}

func WithDocumentMentions(ctx context.Context, values []DocumentMention) context.Context {
	return context.WithValue(ctx, documentMentionsKey{}, append([]DocumentMention(nil), values...))
}

func committedDocumentMentions(ctx context.Context, ops []RawOp, seqs []int64, actor int64) []DocumentMention {
	if actor <= 0 || len(ops) != len(seqs) {
		return nil
	}
	ids := make(map[[2]int64]RawOp, len(ops))
	for i, op := range ops {
		if seqs[i] > 0 {
			ids[[2]int64{op.ClientID, op.Clock}] = op
		}
	}
	var out []DocumentMention
	seen := map[[3]int64]bool{}
	for _, v := range documentMentions(ctx) {
		key := [3]int64{v.ClientID, v.Clock, v.RecipientID}
		raw, ok := ids[[2]int64{v.ClientID, v.Clock}]
		if v.RecipientID <= 0 || v.RecipientID == actor || !ok || seen[key] {
			continue
		}
		decoded, err := collab.DecodeOps(raw.Bytes)
		if err != nil || len(decoded) != 1 || decoded[0].T != collab.TMark || decoded[0].Key != "mention" || decoded[0].Value == nil || *decoded[0].Value != strconv.FormatInt(v.RecipientID, 10) || decoded[0].ID.Client != uint64(v.ClientID) || decoded[0].ID.Clock != uint64(v.Clock) || v.Block != "" && v.Block != decoded[0].Block.Key() {
			continue
		}
		seen[key] = true
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].RecipientID != out[j].RecipientID {
			return out[i].RecipientID < out[j].RecipientID
		}
		if out[i].ClientID != out[j].ClientID {
			return out[i].ClientID < out[j].ClientID
		}
		return out[i].Clock < out[j].Clock
	})
	return out
}

func documentMentions(ctx context.Context) []DocumentMention {
	items, _ := ctx.Value(documentMentionsKey{}).([]DocumentMention)
	return items
}

// Memory caller holds the document/session lock, after a successful append.
func (m *Memory) addDocumentMentionsLocked(ctx context.Context, doc *memDoc, ops []RawOp, seqs []int64, actor int64) {
	name := ""
	if u := m.userByID(actor); u != nil {
		name = u.Name
	}
	var notes []Notification
	authorized := map[int64]bool{}
	checked := map[int64]bool{}
	for _, mention := range committedDocumentMentions(ctx, ops, seqs, actor) {
		if !checked[mention.RecipientID] {
			checked[mention.RecipientID] = true
			authorized[mention.RecipientID] = m.userByID(mention.RecipientID) != nil && !doc.deleted && m.driveValidChainLocked(doc, doc.meta.WorkspaceID, false) && RoleRank(m.roleLocked(mention.RecipientID, doc)) >= RoleRank(RoleView)
		}
		if !authorized[mention.RecipientID] {
			continue
		}
		notes = append(notes, Notification{UserID: mention.RecipientID, DocID: doc.meta.ID, ActorID: actor, ActorName: name, Kind: "mention", Preview: "在文档正文中提及了你", AnchorBlock: mention.Block, AnchorChar: mention.Character, AnchorEpoch: mention.Epoch})
	}
	m.publishCommentNotificationsLocked(notes, doc.meta.UpdatedAt)
}

// PostgreSQL caller holds the head and actor's authorization locks, and inserts
// notices in the same transaction as the newly accepted mark operation.
func insertDocumentMentionsTx(ctx context.Context, tx pgx.Tx, doc int64, ops []RawOp, seqs []int64, actor int64) error {
	var recipients []int64
	var blocks, chars []string
	var epochs []int64
	authorized := map[int64]bool{}
	checked := map[int64]bool{}
	for _, mention := range committedDocumentMentions(ctx, ops, seqs, actor) {
		if !checked[mention.RecipientID] {
			checked[mention.RecipientID] = true
			var exists int64
			err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 FOR KEY SHARE`, mention.RecipientID).Scan(&exists)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return err
			}
			role, _, kind, err := lockCopySource(ctx, tx, doc, mention.RecipientID)
			if errors.Is(err, ErrNotFound) || errors.Is(err, ErrForbidden) {
				continue
			}
			if err != nil {
				return err
			}
			authorized[mention.RecipientID] = kind == "doc" && RoleRank(role) >= RoleRank(RoleView)
		}
		if !authorized[mention.RecipientID] {
			continue
		}
		recipients = append(recipients, mention.RecipientID)
		blocks = append(blocks, mention.Block)
		chars = append(chars, mention.Character)
		epochs = append(epochs, mention.Epoch)
	}
	if len(recipients) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO notifications(user_id,doc_id,actor_id,kind,preview,anchor_block,anchor_char,anchor_epoch)
	 SELECT v.uid,$1,$2,'mention','在文档正文中提及了你',v.block,v.char,v.epoch
	 FROM unnest($3::bigint[],$4::text[],$5::text[],$6::bigint[]) AS v(uid,block,char,epoch)`, doc, actor, recipients, blocks, chars, epochs)
	return err
}
