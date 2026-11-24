package store

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
)

// DocReactionEmojis is the closed Feishu document reaction palette.
var DocReactionEmojis = []string{"👍", "❤️", "🎉", "👏", "🔥", "😄", "🚀", "👀", "💯", "🙏"}

// DocReactionItem aggregates one emoji reaction on a document for a caller.
type DocReactionItem struct {
	Emoji   string `json:"emoji"`
	Count   int    `json:"count"`
	Reacted bool   `json:"reacted"`
}

// DocReactionsSnapshot is the reaction tally and unique viewer count of a document.
type DocReactionsSnapshot struct {
	Reactions   []DocReactionItem `json:"reactions"`
	ViewerCount int               `json:"viewerCount"`
}

// DocReactionsStore persists document footer reactions and reads unique viewer counts.
type DocReactionsStore interface {
	DocReactions(ctx context.Context, userID, docID int64) (DocReactionsSnapshot, error)
	ToggleDocReactionGuarded(ctx context.Context, guard RestoreGuard, docID int64, emoji string, on *bool) (DocReactionsSnapshot, error)
}

var (
	_ DocReactionsStore = (*Memory)(nil)
	_ DocReactionsStore = (*Postgres)(nil)
)

type docReactionKey struct {
	docID  int64
	userID int64
	emoji  string
}

func validDocReaction(emoji string) bool {
	return slices.Contains(DocReactionEmojis, emoji)
}

func (m *Memory) checkDocReactionReadLocked(ctx context.Context, userID, docID int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	d := m.doc(docID)
	if d == nil || d.deleted || d.purged {
		return ErrNotFound
	}
	seen := map[int64]bool{}
	for cur := d; cur != nil; {
		if seen[cur.meta.ID] || cur.deleted || cur.purged || cur.meta.WorkspaceID != d.meta.WorkspaceID {
			return ErrNotFound
		}
		seen[cur.meta.ID] = true
		if cur.meta.ParentID == nil {
			break
		}
		cur = m.doc(*cur.meta.ParentID)
		if cur == nil {
			return ErrNotFound
		}
	}
	if RoleRank(m.roleLocked(userID, d)) < RoleRank(RoleView) {
		return ErrForbidden
	}
	return nil
}

func (m *Memory) docReactionsSnapshotLocked(userID, docID int64) DocReactionsSnapshot {
	counts := make(map[string]int)
	reacted := make(map[string]bool)
	for k := range m.docReactions {
		if k.docID != docID {
			continue
		}
		counts[k.emoji]++
		if k.userID == userID {
			reacted[k.emoji] = true
		}
	}
	items := make([]DocReactionItem, 0, len(counts))
	for _, emoji := range DocReactionEmojis {
		if c := counts[emoji]; c > 0 {
			items = append(items, DocReactionItem{
				Emoji:   emoji,
				Count:   c,
				Reacted: reacted[emoji],
			})
		}
	}
	viewers := 0
	for key := range m.recent {
		if key[1] == docID {
			viewers++
		}
	}
	if viewers < 1 {
		viewers = 1
	}
	return DocReactionsSnapshot{
		Reactions:   items,
		ViewerCount: viewers,
	}
}

func (m *Memory) DocReactions(ctx context.Context, userID, docID int64) (DocReactionsSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return DocReactionsSnapshot{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.checkDocReactionReadLocked(ctx, userID, docID); err != nil {
		return DocReactionsSnapshot{}, err
	}
	return m.docReactionsSnapshotLocked(userID, docID), nil
}

func (m *Memory) ToggleDocReactionGuarded(ctx context.Context, guard RestoreGuard, docID int64, emoji string, on *bool) (DocReactionsSnapshot, error) {
	if !validDocReaction(emoji) {
		return DocReactionsSnapshot{}, ErrInvalidReaction
	}
	if err := ctx.Err(); err != nil {
		return DocReactionsSnapshot{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return DocReactionsSnapshot{}, err
	}
	s, ok := m.sessions[string(guard.SessionHash)]
	if !ok || s.userID != guard.UserID || !guard.currentTime().Before(s.expires) {
		return DocReactionsSnapshot{}, ErrUnauthenticated
	}
	if err := m.checkDocReactionReadLocked(ctx, guard.UserID, docID); err != nil {
		return DocReactionsSnapshot{}, err
	}
	if !guard.currentTime().Before(s.expires) {
		return DocReactionsSnapshot{}, ErrUnauthenticated
	}
	key := docReactionKey{docID: docID, userID: guard.UserID, emoji: emoji}
	var add bool
	if on != nil {
		add = *on
	} else {
		_, exists := m.docReactions[key]
		add = !exists
	}
	if add {
		if m.docReactions == nil {
			m.docReactions = map[docReactionKey]time.Time{}
		}
		if _, exists := m.docReactions[key]; !exists {
			m.docReactions[key] = time.Now()
		}
	} else {
		delete(m.docReactions, key)
	}
	return m.docReactionsSnapshotLocked(guard.UserID, docID), nil
}

func lockDocReactionReadTx(ctx context.Context, tx pgx.Tx, userID, docID int64) error {
	var exists int64
	err := tx.QueryRow(ctx, `SELECT id FROM nodes WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, docID).Scan(&exists)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	role, _, _, err := lockCopySource(ctx, tx, docID, userID)
	if errors.Is(err, ErrNotFound) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if RoleRank(role) < RoleRank(RoleView) {
		return ErrForbidden
	}
	var invalid bool
	err = tx.QueryRow(ctx, `WITH RECURSIVE a AS (
		SELECT id, parent_id, workspace_id, deleted_at, ARRAY[id] AS seen FROM nodes WHERE id=$1
		UNION ALL SELECT n.id, n.parent_id, n.workspace_id, n.deleted_at, a.seen || n.id
		FROM nodes n JOIN a ON n.id = a.parent_id WHERE NOT n.id = ANY(a.seen)
	) SELECT EXISTS(SELECT 1 FROM a WHERE deleted_at IS NOT NULL OR workspace_id <> (SELECT workspace_id FROM nodes WHERE id=$1))
		OR EXISTS(SELECT 1 FROM a WHERE parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM nodes p WHERE p.id = a.parent_id))`, docID).Scan(&invalid)
	if err != nil {
		return err
	}
	if invalid {
		return ErrNotFound
	}
	return nil
}

func queryDocReactionsSnapshotTx(ctx context.Context, tx pgx.Tx, userID, docID int64) (DocReactionsSnapshot, error) {
	rows, err := tx.Query(ctx, `SELECT emoji, COUNT(*)::int, BOOL_OR(user_id = $2) FROM doc_reactions WHERE doc_id = $1 GROUP BY emoji`, docID, userID)
	if err != nil {
		return DocReactionsSnapshot{}, err
	}
	defer rows.Close()
	counts := make(map[string]int)
	reacted := make(map[string]bool)
	for rows.Next() {
		var emoji string
		var count int
		var mine bool
		if err := rows.Scan(&emoji, &count, &mine); err != nil {
			return DocReactionsSnapshot{}, err
		}
		counts[emoji] = count
		reacted[emoji] = mine
	}
	if err := rows.Err(); err != nil {
		return DocReactionsSnapshot{}, err
	}
	items := make([]DocReactionItem, 0, len(counts))
	for _, emoji := range DocReactionEmojis {
		if c := counts[emoji]; c > 0 {
			items = append(items, DocReactionItem{
				Emoji:   emoji,
				Count:   c,
				Reacted: reacted[emoji],
			})
		}
	}
	var viewers int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*)::int FROM recent_visits WHERE node_id = $1`, docID).Scan(&viewers); err != nil {
		return DocReactionsSnapshot{}, err
	}
	if viewers < 1 {
		viewers = 1
	}
	return DocReactionsSnapshot{
		Reactions:   items,
		ViewerCount: viewers,
	}, nil
}

func (p *Postgres) DocReactions(ctx context.Context, userID, docID int64) (out DocReactionsSnapshot, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		if err := lockDocReactionReadTx(ctx, tx, userID, docID); err != nil {
			return err
		}
		snap, err := queryDocReactionsSnapshotTx(ctx, tx, userID, docID)
		if err != nil {
			return err
		}
		out = snap
		return nil
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	if err != nil {
		out = DocReactionsSnapshot{}
	}
	return out, err
}

func (p *Postgres) ToggleDocReactionGuarded(ctx context.Context, guard RestoreGuard, docID int64, emoji string, on *bool) (out DocReactionsSnapshot, err error) {
	if !validDocReaction(emoji) {
		return DocReactionsSnapshot{}, ErrInvalidReaction
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var uid int64
		var expiry time.Time
		err := tx.QueryRow(ctx, `SELECT user_id, expires_at FROM sessions WHERE token_hash=$1 FOR SHARE`, guard.SessionHash).Scan(&uid, &expiry)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && (uid != guard.UserID || !guard.currentTime().Before(expiry))) {
			return ErrUnauthenticated
		}
		if err != nil {
			return err
		}
		if err := lockDocReactionReadTx(ctx, tx, guard.UserID, docID); err != nil {
			return err
		}
		if on != nil {
			if *on {
				if _, err := tx.Exec(ctx, `INSERT INTO doc_reactions (doc_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, docID, guard.UserID, emoji); err != nil {
					return err
				}
			} else {
				if _, err := tx.Exec(ctx, `DELETE FROM doc_reactions WHERE doc_id=$1 AND user_id=$2 AND emoji=$3`, docID, guard.UserID, emoji); err != nil {
					return err
				}
			}
		} else {
			tag, err := tx.Exec(ctx, `DELETE FROM doc_reactions WHERE doc_id=$1 AND user_id=$2 AND emoji=$3`, docID, guard.UserID, emoji)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				if _, err := tx.Exec(ctx, `INSERT INTO doc_reactions (doc_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, docID, guard.UserID, emoji); err != nil {
					return err
				}
			}
		}
		snap, err := queryDocReactionsSnapshotTx(ctx, tx, guard.UserID, docID)
		if err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		out = snap
		return nil
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	if err != nil {
		out = DocReactionsSnapshot{}
	}
	return out, err
}
