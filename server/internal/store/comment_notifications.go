package store

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// commentRecipients preserves the existing notification semantics: a reply
// notifies its parent author and mentions, while a resolve notifies the
// original author and mentions. The actor is never notified of their action.
func commentRecipients(ctx context.Context, c Comment, actor int64, parentAuthor int64, resolve bool) ([]int64, string) {
	ids := make(map[int64]bool, len(c.Mentions)+1)
	kind := "mention"
	if resolve {
		kind = "resolve"
		ids[c.UserID] = true
	} else if c.ParentID != nil {
		kind = "reply"
		ids[parentAuthor] = true
	}
	for _, id := range c.Mentions {
		ids[id] = true
	}
	delete(ids, actor)
	delete(ids, 0)
	for _, id := range notifySkip(ctx) {
		delete(ids, id)
	}
	recipients := make([]int64, 0, len(ids))
	for id := range ids {
		if id > 0 {
			recipients = append(recipients, id)
		}
	}
	sort.Slice(recipients, func(i, j int) bool { return recipients[i] < recipients[j] })
	return recipients, kind
}

// commentNotificationsLocked prepares notifications without mutating Memory.
// Their publication and the comment mutation happen together under m.mu.
func (m *Memory) commentNotificationsLocked(ctx context.Context, c Comment, actor int64, parentAuthor int64, resolve bool) []Notification {
	recipients, kind := commentRecipients(ctx, c, actor, parentAuthor, resolve)
	doc := m.doc(c.DocID)
	if doc == nil {
		return nil
	}
	name := ""
	if user := m.userByID(actor); user != nil {
		name = user.Name
	}
	items := make([]Notification, 0, len(recipients))
	for _, uid := range recipients {
		// Invalid IDs must not prevent a valid comment from being saved. Every
		// node kind (doc, base, slides, file) requires current view access, so a
		// reply or resolve never sends a preview to someone who lost access.
		if m.userByID(uid) == nil || doc.deleted || RoleRank(m.roleLocked(uid, doc)) < RoleRank(RoleView) {
			continue
		}
		id := c.ID
		items = append(items, Notification{UserID: uid, DocID: c.DocID, DocTitle: doc.meta.Title, ActorID: actor, ActorName: name, CommentID: &id, Kind: kind, Preview: notificationPreview(c.Body)})
	}
	return items
}

func (m *Memory) publishCommentNotificationsLocked(items []Notification, now time.Time) {
	for _, n := range items {
		n.ID = int64(len(m.notifications)) + 1
		n.CreatedAt = now
		m.notifications = append(m.notifications, n)
	}
}

// insertCommentNotificationsTx locks existing recipient authorization rows
// until the comment and notices commit together. Stable recipient order limits
// lock-order inversions; database deadlocks still abort the entire transaction.
func insertCommentNotificationsTx(ctx context.Context, tx pgx.Tx, c Comment, actor int64, parentAuthor int64, resolve bool) error {
	recipients, kind := commentRecipients(ctx, c, actor, parentAuthor, resolve)
	if len(recipients) == 0 {
		return nil
	}
	for _, uid := range recipients {
		var existing int64
		err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 FOR KEY SHARE`, uid).Scan(&existing)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		role, _, _, err := lockCopySource(ctx, tx, c.DocID, uid)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		if RoleRank(role) < RoleRank(RoleView) {
			continue
		}
		if _, err = tx.Exec(ctx, `INSERT INTO notifications (user_id,doc_id,actor_id,comment_id,kind,preview) VALUES ($1,$2,$3,$4,$5,$6)`, uid, c.DocID, actor, c.ID, kind, notificationPreview(c.Body)); err != nil {
			return err
		}
	}
	return nil
}

type notifySkipKey struct{}

// WithNotifySkip excludes users from comment notifications written under ctx.
// The API uses it for record comments: base access is not enough, the
// recipient must also see the record under the base's locked-view policy.
func WithNotifySkip(ctx context.Context, ids []int64) context.Context {
	return context.WithValue(ctx, notifySkipKey{}, append([]int64(nil), ids...))
}

func notifySkip(ctx context.Context) []int64 {
	ids, _ := ctx.Value(notifySkipKey{}).([]int64)
	return ids
}
