package store

import (
	"context"
	"errors"
	"slices"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// ReactionEmojis is the fixed reaction palette (飞书评论常用表情). A closed
// set keeps reactions from becoming an unmoderated free-text channel.
var ReactionEmojis = []string{"👍", "✅", "😄", "❤️", "🎉", "👀", "🙏", "💪"}

var ErrInvalidReaction = errors.New("store: invalid reaction")

// CommentReaction aggregates one emoji on one comment.
type CommentReaction struct {
	Emoji   string  `json:"emoji"`
	UserIDs []int64 `json:"userIds"`
}

type reactionKey struct {
	comment, user int64
	emoji         string
}

func validReaction(emoji string) bool { return slices.Contains(ReactionEmojis, emoji) }

// groupReactions orders emojis by the palette and users by first reaction.
func groupReactions(rows []reactionRow) map[int64][]CommentReaction {
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].at.Before(rows[j].at) })
	out := map[int64][]CommentReaction{}
	for _, r := range rows {
		list := out[r.comment]
		i := slices.IndexFunc(list, func(c CommentReaction) bool { return c.Emoji == r.emoji })
		if i < 0 {
			list = append(list, CommentReaction{Emoji: r.emoji})
			i = len(list) - 1
		}
		list[i].UserIDs = append(list[i].UserIDs, r.user)
		out[r.comment] = list
	}
	for id, list := range out {
		sort.SliceStable(list, func(i, j int) bool {
			return slices.Index(ReactionEmojis, list[i].Emoji) < slices.Index(ReactionEmojis, list[j].Emoji)
		})
		out[id] = list
	}
	return out
}

type reactionRow struct {
	comment, user int64
	emoji         string
	at            time.Time
}

func (m *Memory) SetCommentReactionGuarded(ctx context.Context, guard RestoreGuard, docID, commentID int64, emoji string, on bool) error {
	if !validReaction(emoji) {
		return ErrInvalidReaction
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expiry, err := m.checkCommentLocked(ctx, guard, docID)
	if err != nil {
		return err
	}
	if !slices.ContainsFunc(m.comments, func(c Comment) bool { return c.ID == commentID && c.DocID == docID }) {
		return ErrNotFound
	}
	if !guard.currentTime().Before(expiry) {
		return ErrUnauthenticated
	}
	key := reactionKey{commentID, guard.UserID, emoji}
	if on {
		if m.reactions == nil {
			m.reactions = map[reactionKey]time.Time{}
		}
		if _, ok := m.reactions[key]; !ok {
			m.reactions[key] = time.Now()
		}
	} else {
		delete(m.reactions, key)
	}
	return nil
}

func (m *Memory) CommentReactions(ctx context.Context, docID int64) (map[int64][]CommentReaction, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	live := map[int64]bool{}
	for _, c := range m.comments {
		if c.DocID == docID {
			live[c.ID] = true
		}
	}
	var rows []reactionRow
	for k, at := range m.reactions {
		// Reactions of deleted comments are dropped on read (FK cascade in SQL).
		if live[k.comment] {
			rows = append(rows, reactionRow{k.comment, k.user, k.emoji, at})
		}
	}
	return groupReactions(rows), nil
}

func (p *Postgres) SetCommentReactionGuarded(ctx context.Context, guard RestoreGuard, docID, commentID int64, emoji string, on bool) error {
	if !validReaction(emoji) {
		return ErrInvalidReaction
	}
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expiry, err := lockCommentAccess(ctx, tx, guard, docID)
		if err != nil {
			return err
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM comments WHERE id=$1 AND doc_id=$2 FOR SHARE)`, commentID, docID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		if on {
			_, err = tx.Exec(ctx, `INSERT INTO comment_reactions (comment_id,user_id,emoji) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, commentID, guard.UserID, emoji)
		} else {
			_, err = tx.Exec(ctx, `DELETE FROM comment_reactions WHERE comment_id=$1 AND user_id=$2 AND emoji=$3`, commentID, guard.UserID, emoji)
		}
		if err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if retryableRestoreConflict(err) {
		return ErrConflict
	}
	return err
}

func (p *Postgres) CommentReactions(ctx context.Context, docID int64) (map[int64][]CommentReaction, error) {
	rows, err := p.Pool.Query(ctx, `SELECT r.comment_id,r.user_id,r.emoji,r.created_at FROM comment_reactions r JOIN comments c ON c.id=r.comment_id WHERE c.doc_id=$1`, docID)
	if err != nil {
		return nil, err
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (reactionRow, error) {
		var x reactionRow
		err := r.Scan(&x.comment, &x.user, &x.emoji, &x.at)
		return x, err
	})
	if err != nil {
		return nil, err
	}
	return groupReactions(list), nil
}
