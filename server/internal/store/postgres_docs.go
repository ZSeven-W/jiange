package store

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// NotifyChannel carries "docID:head" payloads after each append.
const NotifyChannel = "jiange_ops"

const docCols = `id, workspace_id, parent_id, title, icon, creator_id, created_at, updated_at`

// creatorName is appended to every doc SELECT/RETURNING list.
const creatorName = `, (SELECT name FROM users WHERE users.id = creator_id)`

func scanDoc(row pgx.Row) (d DocMeta, err error) {
	err = row.Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Title, &d.Icon, &d.CreatorID, &d.CreatedAt, &d.UpdatedAt, &d.CreatorName)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

func (p *Postgres) CanCreateIn(ctx context.Context, uid, ws int64) (ok bool, err error) {
	err = p.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2)`, ws, uid).Scan(&ok)
	return
}

func (p *Postgres) CreateDoc(ctx context.Context, ws, creator int64, parent *int64, title string, initial []RawOp) (d DocMeta, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var e error
		d, e = scanDoc(tx.QueryRow(ctx,
			`INSERT INTO nodes (workspace_id, parent_id, kind, sort_key, title, creator_id)
			 VALUES ($1, $2, 'doc', 'V', $3, $4) RETURNING `+docCols+creatorName, ws, parent, title, creator))
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO doc_heads (doc_id, seq) VALUES ($1, $2)`, d.ID, len(initial)); e != nil {
			return e
		}
		for i, op := range initial {
			if _, e = tx.Exec(ctx, `INSERT INTO doc_ops (doc_id, seq, client_id, clock, op) VALUES ($1, $2, $3, $4, $5)`,
				d.ID, i+1, op.ClientID, op.Clock, op.Bytes); e != nil {
				return e
			}
		}
		return nil
	})
	return
}

func (p *Postgres) ListDocs(ctx context.Context, uid int64) ([]DocMeta, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+prefixed("n.", docCols)+`, (SELECT name FROM users u WHERE u.id = n.creator_id) FROM nodes n
		JOIN workspace_members m ON m.workspace_id = n.workspace_id AND m.user_id = $1
		WHERE n.kind = 'doc' AND n.deleted_at IS NULL ORDER BY n.updated_at DESC, n.id DESC LIMIT 500`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DocMeta{}
	for rows.Next() {
		d, err := scanDoc(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func prefixed(p, cols string) string {
	parts := strings.Split(cols, ", ")
	for i := range parts {
		parts[i] = p + parts[i]
	}
	return strings.Join(parts, ", ")
}

func (p *Postgres) GetDoc(ctx context.Context, uid, id int64) (DocMeta, error) {
	return scanDoc(p.Pool.QueryRow(ctx, `SELECT `+prefixed("n.", docCols)+`, (SELECT name FROM users u WHERE u.id = n.creator_id) FROM nodes n
		JOIN workspace_members m ON m.workspace_id = n.workspace_id AND m.user_id = $1
		WHERE n.id = $2 AND n.kind = 'doc' AND n.deleted_at IS NULL`, uid, id))
}

func (p *Postgres) UpdateTitle(ctx context.Context, id int64, title string) (DocMeta, error) {
	return scanDoc(p.Pool.QueryRow(ctx, `UPDATE nodes SET title=$2, updated_at=now() WHERE id=$1 RETURNING `+docCols+creatorName, id, title))
}

func (p *Postgres) AllocClient(ctx context.Context, uid, doc int64) (id int64, err error) {
	err = p.Pool.QueryRow(ctx, `INSERT INTO doc_clients (doc_id, user_id) VALUES ($1, $2) RETURNING id`, doc, uid).Scan(&id)
	return
}

func (p *Postgres) ClientOwner(ctx context.Context, id int64) (uid, doc int64, err error) {
	err = p.Pool.QueryRow(ctx, `SELECT user_id, doc_id FROM doc_clients WHERE id=$1`, id).Scan(&uid, &doc)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

func (p *Postgres) SetAck(ctx context.Context, id, seq int64, now time.Time) error {
	_, err := p.Pool.Exec(ctx, `UPDATE doc_clients SET acked_seq=GREATEST(acked_seq,$2), last_seen=$3 WHERE id=$1`, id, seq, now)
	return err
}

func (p *Postgres) Horizon(ctx context.Context, doc int64, since time.Time) (h int64, err error) {
	err = p.Pool.QueryRow(ctx, `SELECT LEAST(h.seq, COALESCE((SELECT min(acked_seq) FROM doc_clients
		WHERE doc_id=$1 AND last_seen >= $2), h.seq)) FROM doc_heads h WHERE h.doc_id=$1`, doc, since).Scan(&h)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

func (p *Postgres) AppendOps(ctx context.Context, doc int64, ops []RawOp) (seqs []int64, err error) {
	seqs = make([]int64, len(ops))
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var head int64
		if err := tx.QueryRow(ctx, `SELECT seq FROM doc_heads WHERE doc_id=$1 FOR UPDATE`, doc).Scan(&head); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		start := head
		for i, op := range ops {
			tag, err := tx.Exec(ctx, `INSERT INTO doc_ops (doc_id, seq, client_id, clock, op) VALUES ($1,$2,$3,$4,$5)
				ON CONFLICT (doc_id, client_id, clock) DO NOTHING`, doc, head+1, op.ClientID, op.Clock, op.Bytes)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 1 {
				head++
				seqs[i] = head
			}
		}
		if head == start {
			return nil
		}
		if _, err := tx.Exec(ctx, `UPDATE doc_heads SET seq=$2 WHERE doc_id=$1`, doc, head); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE nodes SET updated_at=now() WHERE id=$1`, doc); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `SELECT pg_notify($1, $2)`, NotifyChannel, strconv.FormatInt(doc, 10)+":"+strconv.FormatInt(head, 10))
		return err
	})
	return
}

func (p *Postgres) OpsAfter(ctx context.Context, doc, after int64, limit int) ([]SeqOp, error) {
	if limit <= 0 {
		limit = 1 << 30
	}
	rows, err := p.Pool.Query(ctx, `SELECT seq, client_id, op FROM doc_ops WHERE doc_id=$1 AND seq>$2 ORDER BY seq LIMIT $3`, doc, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SeqOp
	for rows.Next() {
		var o SeqOp
		if err := rows.Scan(&o.Seq, &o.ClientID, &o.Bytes); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (p *Postgres) Head(ctx context.Context, doc int64) (h int64, err error) {
	err = p.Pool.QueryRow(ctx, `SELECT seq FROM doc_heads WHERE doc_id=$1`, doc).Scan(&h)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

func (p *Postgres) LatestSnapshot(ctx context.Context, doc int64) (seq int64, state []byte, err error) {
	err = p.Pool.QueryRow(ctx, `SELECT seq, state FROM doc_snapshots WHERE doc_id=$1 AND NOT is_version ORDER BY seq DESC LIMIT 1`, doc).Scan(&seq, &state)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

func (p *Postgres) SaveSnapshot(ctx context.Context, doc, seq int64, state []byte) error {
	_, err := p.Pool.Exec(ctx, `INSERT INTO doc_snapshots (doc_id, seq, state) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, doc, seq, state)
	return err
}

// Listen holds a dedicated connection on LISTEN jiange_ops, reconnecting on failure.
func (p *Postgres) Listen(ctx context.Context, fn func(int64, int64)) error {
	for ctx.Err() == nil {
		err := p.listenOnce(ctx, fn)
		if ctx.Err() != nil {
			return nil
		}
		_ = err
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
		}
	}
	return nil
}

func (p *Postgres) listenOnce(ctx context.Context, fn func(int64, int64)) error {
	c, err := p.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer c.Release()
	if _, err := c.Exec(ctx, "LISTEN "+NotifyChannel); err != nil {
		return err
	}
	for {
		n, err := c.Conn().WaitForNotification(ctx)
		if err != nil {
			c.Conn().Close(context.Background()) // don't return a LISTENing conn to the pool
			return err
		}
		a, b, ok := strings.Cut(n.Payload, ":")
		doc, e1 := strconv.ParseInt(a, 10, 64)
		head, e2 := strconv.ParseInt(b, 10, 64)
		if ok && e1 == nil && e2 == nil {
			fn(doc, head)
		}
	}
}

const subtreeCTE = `WITH RECURSIVE t(id) AS (SELECT $1::bigint UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id = t.id) `

func (p *Postgres) Trash(ctx context.Context, id int64) error {
	_, err := p.Pool.Exec(ctx, subtreeCTE+`UPDATE nodes SET deleted_at = now() WHERE id IN (SELECT id FROM t) AND deleted_at IS NULL`, id)
	return err
}

func (p *Postgres) Restore(ctx context.Context, id int64) error {
	_, err := p.Pool.Exec(ctx, subtreeCTE+`UPDATE nodes SET deleted_at = NULL WHERE id IN (SELECT id FROM t)`, id)
	return err
}

func (p *Postgres) ListTrash(ctx context.Context, uid int64) ([]DocMeta, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+prefixed("n.", docCols)+`, (SELECT name FROM users u WHERE u.id = n.creator_id) FROM nodes n
		JOIN workspace_members m ON m.workspace_id = n.workspace_id AND m.user_id = $1
		WHERE n.kind = 'doc' AND n.deleted_at IS NOT NULL ORDER BY n.deleted_at DESC LIMIT 200`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DocMeta{}
	for rows.Next() {
		d, err := scanDoc(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (p *Postgres) Move(ctx context.Context, id int64, parent *int64) error {
	if parent != nil {
		var cyc bool
		if err := p.Pool.QueryRow(ctx, subtreeCTE+`SELECT EXISTS (SELECT 1 FROM t WHERE id = $2)`, id, *parent).Scan(&cyc); err != nil {
			return err
		}
		if cyc {
			return ErrConflict
		}
	}
	_, err := p.Pool.Exec(ctx, `UPDATE nodes SET parent_id = $2, updated_at = now() WHERE id = $1`, id, parent)
	return err
}
