package store

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"slices"

	"github.com/jackc/pgx/v5"
)

var ErrTitleSnapshotTooLarge = errors.New("store: title snapshot exceeds resource limit")

const titleMaxBytes = 2 << 20
const titleMaxOps = 10000

// decodeTitleSnapshot rejects corrupted gzip and bounds uncompressed content.
func decodeTitleSnapshot(b []byte) ([]byte, error) {
	if len(b) > titleMaxBytes {
		return nil, ErrTitleSnapshotTooLarge
	}
	if len(b) < 2 || !bytes.Equal(b[:2], gzipMagic) {
		return slices.Clone(b), nil
	}
	z, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	defer z.Close()
	out, err := io.ReadAll(io.LimitReader(z, titleMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(out) > titleMaxBytes {
		return nil, ErrTitleSnapshotTooLarge
	}
	return out, nil
}

func (m *Memory) ReadTitleSnapshot(ctx context.Context, docID int64) (TitleSnapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return TitleSnapshot{}, err
	}
	d := m.doc(docID)
	if d == nil || d.deleted || d.meta.Kind != "doc" {
		return TitleSnapshot{}, ErrNotFound
	}
	out := TitleSnapshot{DirectoryTitle: d.meta.Title, Head: int64(len(d.ops))}
	best := int64(-1)
	for seq := range d.snaps {
		if err := ctx.Err(); err != nil {
			return TitleSnapshot{}, err
		}
		if seq >= 0 && seq <= out.Head && seq > best {
			best = seq
			out.SnapshotSeq = seq
			out.Snapshot = d.snaps[seq]
		}
	}
	if best >= 0 && len(out.Snapshot) == 0 {
		return TitleSnapshot{}, fmt.Errorf("title snapshot: empty state at sequence %d", best)
	}
	if len(out.Snapshot) > titleMaxBytes || out.Head-out.SnapshotSeq > titleMaxOps {
		return TitleSnapshot{}, ErrTitleSnapshotTooLarge
	}
	out.Snapshot = slices.Clone(out.Snapshot)
	size := len(out.Snapshot)
	for _, op := range d.ops {
		if err := ctx.Err(); err != nil {
			return TitleSnapshot{}, err
		}
		if op.Seq <= out.SnapshotSeq || op.Seq > out.Head {
			continue
		}
		if op.Seq != out.SnapshotSeq+int64(len(out.Ops))+1 {
			return TitleSnapshot{}, fmt.Errorf("title snapshot: missing sequence")
		}
		size += len(op.Bytes)
		if size > titleMaxBytes {
			return TitleSnapshot{}, ErrTitleSnapshotTooLarge
		}
		op.Bytes = slices.Clone(op.Bytes)
		out.Ops = append(out.Ops, op)
	}
	if out.SnapshotSeq+int64(len(out.Ops)) != out.Head {
		return TitleSnapshot{}, fmt.Errorf("title snapshot: missing sequence")
	}
	return out, nil
}

func (p *Postgres) ReadTitleSnapshot(ctx context.Context, docID int64) (out TitleSnapshot, err error) {
	err = pgx.BeginTxFunc(ctx, p.Pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT n.title,h.seq FROM nodes n JOIN doc_heads h ON h.doc_id=n.id WHERE n.id=$1 AND n.kind='doc' AND n.deleted_at IS NULL`, docID).Scan(&out.DirectoryTitle, &out.Head); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		if out.Head < 0 {
			return fmt.Errorf("title snapshot: invalid head")
		}
		var packed []byte
		err := tx.QueryRow(ctx, `SELECT seq, CASE WHEN octet_length(state) <= $3 THEN state END FROM doc_snapshots WHERE doc_id=$1 AND seq >= 0 AND seq <= $2 ORDER BY seq DESC LIMIT 1`, docID, out.Head, titleMaxBytes).Scan(&out.SnapshotSeq, &packed)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err == nil {
			if packed == nil {
				return ErrTitleSnapshotTooLarge
			}
			out.Snapshot, err = decodeTitleSnapshot(packed)
			if err != nil {
				return fmt.Errorf("title snapshot: %w", err)
			}
			if len(out.Snapshot) == 0 {
				return fmt.Errorf("title snapshot: empty state at sequence %d", out.SnapshotSeq)
			}
		}
		if out.Head-out.SnapshotSeq > titleMaxOps {
			return ErrTitleSnapshotTooLarge
		}
		rows, err := tx.Query(ctx, `SELECT seq,client_id,CASE WHEN octet_length(op) <= $4 THEN op END FROM doc_ops WHERE doc_id=$1 AND seq > $2 AND seq <= $3 ORDER BY seq`, docID, out.SnapshotSeq, out.Head, titleMaxBytes)
		if err != nil {
			return err
		}
		defer rows.Close()
		size := len(out.Snapshot)
		for rows.Next() {
			var op SeqOp
			if err := rows.Scan(&op.Seq, &op.ClientID, &op.Bytes); err != nil {
				return err
			}
			if op.Bytes == nil {
				return ErrTitleSnapshotTooLarge
			}
			if op.Seq != out.SnapshotSeq+int64(len(out.Ops))+1 {
				return fmt.Errorf("title snapshot: missing sequence")
			}
			size += len(op.Bytes)
			if size > titleMaxBytes {
				return ErrTitleSnapshotTooLarge
			}
			out.Ops = append(out.Ops, op)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if out.SnapshotSeq+int64(len(out.Ops)) != out.Head {
			return fmt.Errorf("title snapshot: missing sequence")
		}
		return nil
	})
	if err != nil {
		return TitleSnapshot{}, err
	}
	return out, nil
}
