package store

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
)

// DocCover is document metadata. A file cover refers only to an attachment
// owned by this document; URLs and arbitrary object keys are never accepted.
type DocCover struct {
	Kind     string  `json:"kind"`
	Asset    string  `json:"asset,omitempty"`
	FileID   int64   `json:"fileId,omitempty"`
	Position float64 `json:"position"`
	Revision int64   `json:"revision"`
}

const maxCoverRevision = int64(9007199254740991)

func ValidDocCover(c DocCover) bool {
	if math.IsNaN(c.Position) || math.IsInf(c.Position, 0) || c.Position < 0 || c.Position > 1 {
		return false
	}
	switch c.Kind {
	case "none":
		return c.Asset == "" && c.FileID == 0
	case "builtin":
		return c.Asset == "misty-lake" && c.FileID == 0
	case "file":
		return c.Asset == "" && c.FileID > 0 && c.FileID <= maxCoverRevision
	default:
		return false
	}
}

func memoryCover(c DocCover) DocCover {
	if c.Kind == "" {
		return DocCover{Kind: "none", Position: 0.5}
	}
	return c
}

func (m *Memory) DocCoverGuarded(ctx context.Context, guard RestoreGuard, id int64) (DocCover, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, expiry, err := m.checkIconAccessLocked(ctx, guard, id, RoleView)
	if err != nil {
		return DocCover{}, err
	}
	if !guard.currentTime().Before(expiry) {
		return DocCover{}, ErrUnauthenticated
	}
	return memoryCover(d.cover), nil
}

func (m *Memory) DocCoverSystem(ctx context.Context, id int64) (DocCover, error) {
	if err := ctx.Err(); err != nil {
		return DocCover{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(id)
	if d == nil || d.deleted || d.meta.Kind != "doc" {
		return DocCover{}, ErrNotFound
	}
	return memoryCover(d.cover), nil
}

func (m *Memory) SetDocCoverGuarded(ctx context.Context, guard RestoreGuard, id int64, cover DocCover, expected int64) (DocCover, error) {
	if !ValidDocCover(cover) || expected < 0 || expected >= maxCoverRevision {
		return DocCover{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d, expiry, err := m.checkIconAccessLocked(ctx, guard, id, RoleEdit)
	if err != nil {
		return DocCover{}, err
	}
	if memoryCover(d.cover).Revision != expected {
		return DocCover{}, ErrConflict
	}
	if cover.Kind == "file" {
		found := false
		for _, file := range m.sh.files {
			if file.ID == cover.FileID && file.DocID == id {
				found = true
				break
			}
		}
		if !found {
			return DocCover{}, ErrNotFound
		}
	}
	if err := ctx.Err(); err != nil {
		return DocCover{}, err
	}
	if !guard.currentTime().Before(expiry) {
		return DocCover{}, ErrUnauthenticated
	}
	cover.Revision = expected + 1
	d.cover = cover
	d.meta.UpdatedAt = time.Now()
	return cover, nil
}

func scanCover(row pgx.Row) (DocCover, error) {
	var c DocCover
	var fileID *int64
	err := row.Scan(&c.Kind, &c.Asset, &fileID, &c.Position, &c.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return DocCover{}, ErrNotFound
	}
	if err != nil {
		return DocCover{}, err
	}
	if fileID != nil {
		c.FileID = *fileID
	}
	return c, nil
}

func (p *Postgres) DocCoverSystem(ctx context.Context, id int64) (DocCover, error) {
	return scanCover(p.Pool.QueryRow(ctx, `SELECT cover_kind,cover_asset,cover_file_id,cover_position,cover_revision FROM nodes WHERE id=$1 AND kind='doc' AND deleted_at IS NULL`, id))
}

func (p *Postgres) DocCoverGuarded(ctx context.Context, guard RestoreGuard, id int64) (result DocCover, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expiry, e := lockIconAccess(ctx, tx, guard, id, RoleView, false)
		if e != nil {
			return e
		}
		result, e = scanCover(tx.QueryRow(ctx, `SELECT cover_kind,cover_asset,cover_file_id,cover_position,cover_revision FROM nodes WHERE id=$1`, id))
		if e != nil {
			return e
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		result = DocCover{}
	}
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	return result, err
}

func (p *Postgres) SetDocCoverGuarded(ctx context.Context, guard RestoreGuard, id int64, cover DocCover, expected int64) (result DocCover, err error) {
	if !ValidDocCover(cover) || expected < 0 || expected >= maxCoverRevision {
		return DocCover{}, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expiry, e := lockIconAccess(ctx, tx, guard, id, RoleEdit, true)
		if e != nil {
			return e
		}
		current, e := scanCover(tx.QueryRow(ctx, `SELECT cover_kind,cover_asset,cover_file_id,cover_position,cover_revision FROM nodes WHERE id=$1`, id))
		if e != nil {
			return e
		}
		if current.Revision != expected {
			return ErrConflict
		}
		var fileID *int64
		if cover.Kind == "file" {
			var found int64
			e = tx.QueryRow(ctx, `SELECT id FROM attachments WHERE id=$1 AND doc_id=$2 FOR SHARE`, cover.FileID, id).Scan(&found)
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			if e != nil {
				return e
			}
			fileID = &found
		}
		if _, e = tx.Exec(ctx, `UPDATE nodes SET cover_kind=$2,cover_asset=$3,cover_file_id=$4,cover_position=$5,cover_revision=cover_revision+1,updated_at=now() WHERE id=$1`, id, cover.Kind, cover.Asset, fileID, cover.Position); e != nil {
			return e
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		result = cover
		result.Revision = expected + 1
		return nil
	})
	if err != nil {
		result = DocCover{}
	}
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	return result, err
}
