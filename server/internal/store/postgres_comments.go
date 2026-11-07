package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

const commentCols = `c.id, c.doc_id, c.user_id, COALESCE(u.name, ''), c.parent_id, c.block, c.start_char, c.end_char, c.quote, c.body, c.mentions, c.resolved, c.created_at, c.updated_at`

func scanComment(r pgx.Row) (c Comment, err error) {
	err = r.Scan(&c.ID, &c.DocID, &c.UserID, &c.UserName, &c.ParentID, &c.Block, &c.StartChar, &c.EndChar, &c.Quote, &c.Body, &c.Mentions, &c.Resolved, &c.CreatedAt, &c.UpdatedAt)
	return c, notFound(err)
}

func (p *Postgres) AddComment(ctx context.Context, c Comment) (Comment, error) {
	if c.Mentions == nil {
		c.Mentions = []int64{}
	}
	err := p.Pool.QueryRow(ctx, `INSERT INTO comments (doc_id, user_id, parent_id, block, start_char, end_char, quote, body, mentions)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at, updated_at`,
		c.DocID, c.UserID, c.ParentID, c.Block, c.StartChar, c.EndChar, c.Quote, c.Body, c.Mentions).
		Scan(&c.ID, &c.CreatedAt, &c.UpdatedAt)
	return c, err
}

func (p *Postgres) Comments(ctx context.Context, doc int64) ([]Comment, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+commentCols+` FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.doc_id = $1 ORDER BY c.id`, doc)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Comment, error) { return scanComment(r) })
}

func (p *Postgres) UpdateComment(ctx context.Context, c Comment) (Comment, error) {
	err := p.Pool.QueryRow(ctx, `UPDATE comments SET body = $3, resolved = $4, updated_at = now()
		WHERE id = $1 AND doc_id = $2 RETURNING created_at, updated_at`,
		c.ID, c.DocID, c.Body, c.Resolved).Scan(&c.CreatedAt, &c.UpdatedAt)
	return c, notFound(err)
}

func (p *Postgres) DeleteComment(ctx context.Context, doc, id int64) error {
	t, err := p.Pool.Exec(ctx, `DELETE FROM comments WHERE id = $1 AND doc_id = $2`, id, doc)
	if err == nil && t.RowsAffected() == 0 {
		err = ErrNotFound
	}
	return err
}

func (p *Postgres) CommentAuthor(ctx context.Context, doc, id int64) (int64, error) {
	var uid int64
	err := p.Pool.QueryRow(ctx, `SELECT user_id FROM comments WHERE id = $1 AND doc_id = $2`, id, doc).Scan(&uid)
	return uid, notFound(err)
}

const notificationCols = `notice.id, notice.user_id, notice.doc_id, n.title,
	notice.actor_id, COALESCE((SELECT name FROM users WHERE id = notice.actor_id), ''), notice.comment_id, notice.kind, notice.read, notice.created_at`

// Document notifications are visible only to a current document reader.
// Other node kinds retain their existing notification authorization semantics.
const visibleDocumentNotification = `(n.kind <> 'doc' OR (n.deleted_at IS NULL AND (` + roleSQL + `) <> '' AND
	(notice.comment_id IS NULL OR EXISTS (SELECT 1 FROM comments c WHERE c.id=notice.comment_id AND c.doc_id=n.id))))`

func (p *Postgres) AddNotifications(ctx context.Context, items []Notification) error {
	b := &pgx.Batch{}
	for _, n := range items {
		b.Queue(`INSERT INTO notifications (user_id, doc_id, actor_id, comment_id, kind, preview)
			SELECT $1,n.id,$3,$4,$5,$6 FROM nodes n`+roleJoins+`
			WHERE n.id=$2 AND (n.kind <> 'doc' OR (n.deleted_at IS NULL AND (`+roleSQL+`) <> ''
				AND ($4::bigint IS NULL OR EXISTS (SELECT 1 FROM comments c WHERE c.id=$4 AND c.doc_id=n.id))))`,
			n.UserID, n.DocID, n.ActorID, n.CommentID, n.Kind, n.Preview)
	}
	return p.Pool.SendBatch(ctx, b).Close()
}

func (p *Postgres) Notifications(ctx context.Context, userID int64, limit int) ([]Notification, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+notificationCols+`,
		CASE WHEN n.kind='doc' AND notice.comment_id IS NOT NULL THEN
			COALESCE((SELECT CASE WHEN length(c.body)>60 THEN left(c.body,60)||'…' ELSE c.body END
				FROM comments c WHERE c.id=notice.comment_id AND c.doc_id=n.id), '')
		ELSE notice.preview END AS preview
		FROM notifications notice JOIN nodes n ON n.id=notice.doc_id`+roleJoins+`
		WHERE notice.user_id=$1 AND `+visibleDocumentNotification+` ORDER BY notice.id DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (n Notification, err error) {
		err = r.Scan(&n.ID, &n.UserID, &n.DocID, &n.DocTitle, &n.ActorID, &n.ActorName, &n.CommentID, &n.Kind, &n.Read, &n.CreatedAt, &n.Preview)
		return
	})
}

func (p *Postgres) UnreadCount(ctx context.Context, userID int64) (int64, error) {
	var n int64
	err := p.Pool.QueryRow(ctx, `SELECT count(*) FROM notifications notice JOIN nodes n ON n.id=notice.doc_id`+roleJoins+`
		WHERE notice.user_id=$1 AND NOT notice.read AND `+visibleDocumentNotification, userID).Scan(&n)
	return n, err
}

func (p *Postgres) MarkRead(ctx context.Context, userID int64, ids []int64) error {
	if len(ids) == 0 {
		_, err := p.Pool.Exec(ctx, `UPDATE notifications SET read = true WHERE user_id = $1 AND NOT read`, userID)
		return err
	}
	_, err := p.Pool.Exec(ctx, `UPDATE notifications SET read = true WHERE user_id = $1 AND id = ANY($2)`, userID, ids)
	return err
}
