package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// CreateDocImportImage binds attachment publication to the original session
// and current document permission, including after a slow object upload.
func (m *Memory) CreateDocImportImage(ctx context.Context, g RestoreGuard, id int64, file FileMeta) (FileMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return FileMeta{}, err
	}
	s, ok := m.sessions[string(g.SessionHash)]
	if !ok || s.userID != g.UserID || !g.currentTime().Before(s.expires) {
		return FileMeta{}, ErrUnauthenticated
	}
	d := m.doc(id)
	if d == nil || d.meta.Kind != "doc" || d.deleted || d.purged {
		return FileMeta{}, ErrNotFound
	}
	if RoleRank(m.roleLocked(g.UserID, d)) < RoleRank(RoleEdit) {
		return FileMeta{}, ErrForbidden
	}
	if !slideImageMIME(file.Mime) {
		return FileMeta{}, ErrConflict
	}
	file.ID = int64(len(m.sh.files) + 1)
	file.DocID, file.UploaderID, file.CreatedAt = id, g.UserID, time.Now()
	m.sh.files = append(m.sh.files, file)
	return file, nil
}

func (p *Postgres) CreateDocImportImage(ctx context.Context, g RestoreGuard, id int64, file FileMeta) (out FileMeta, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := drivePGSession(ctx, tx, g)
		if e != nil {
			return e
		}
		if !g.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		role, _, kind, e := lockCopySource(ctx, tx, id, g.UserID)
		if e != nil {
			return e
		}
		if kind != "doc" {
			return ErrNotFound
		}
		if RoleRank(role) < RoleRank(RoleEdit) {
			return ErrForbidden
		}
		if !slideImageMIME(file.Mime) {
			return ErrConflict
		}
		out = file
		out.DocID, out.UploaderID = id, g.UserID
		if e = tx.QueryRow(ctx, `INSERT INTO attachments (doc_id,uploader_id,name,mime,size,object_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,created_at`, id, g.UserID, file.Name, file.Mime, file.Size, file.ObjectKey).Scan(&out.ID, &out.CreatedAt); e != nil {
			return e
		}
		expires, e = drivePGSession(ctx, tx, g)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, g, expires)
	})
	if err != nil {
		return FileMeta{}, err
	}
	return out, nil
}
