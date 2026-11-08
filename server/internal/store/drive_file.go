package store

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// ValidDriveFileName rejects path separators and controls in stored download names.
func ValidDriveFileName(name string) bool {
	return name != "" && name != "." && name != ".." && utf8.ValidString(name) && utf8.RuneCountInString(name) <= 100 && !strings.ContainsAny(name, "/\\") && strings.IndexFunc(name, unicode.IsControl) < 0
}

// CreateDriveFile atomically publishes the directory node and its one blob reference.
func (m *Memory) CreateDriveFile(ctx context.Context, g RestoreGuard, ws int64, parent *int64, f FileMeta, personal bool) (DriveEntry, error) {
	if ws <= 0 || !ValidDriveFileName(f.Name) || f.ObjectKey == "" || f.Size < 0 {
		return DriveEntry{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, g)
	if err != nil {
		return DriveEntry{}, err
	}
	if !m.member(g.UserID, ws) {
		return DriveEntry{}, ErrForbidden
	}
	if err = m.driveDestinationLocked(g.UserID, ws, parent, RoleEdit); err != nil {
		return DriveEntry{}, err
	}
	if parent != nil {
		personal = m.doc(*parent).personal
	}
	if g.UserID <= 0 || g.UserID > int64(len(m.users)) {
		return DriveEntry{}, ErrUnauthenticated
	}
	if !g.currentTime().Before(expires) {
		return DriveEntry{}, ErrUnauthenticated
	}
	if err = ctx.Err(); err != nil {
		return DriveEntry{}, err
	}
	now := time.Now()
	id := int64(len(m.d.docs) + 1)
	d := &memDoc{meta: DocMeta{ID: id, WorkspaceID: ws, ParentID: cloneDriveParent(parent), Kind: "file", Title: f.Name, CreatorID: g.UserID, CreatorName: m.users[g.UserID-1].Name, CreatedAt: now, UpdatedAt: now, DriveRevision: 1, CopyMinRole: RoleView, DownloadMinRole: RoleView, CommentMinRole: RoleView}, driveRevision: 1, personal: personal}
	f.ID = int64(len(m.sh.files) + 1)
	f.DocID = id
	f.UploaderID = g.UserID
	f.CreatedAt = now
	d.driveFileID = f.ID
	m.sh.files = append(m.sh.files, f)
	m.d.docs = append(m.d.docs, d)
	return driveMemoryEntry(m, d, g.UserID), nil
}

// GetDriveFile returns metadata only for an accessible, live file node.
func (m *Memory) GetDriveFile(ctx context.Context, uid, nodeID int64) (FileMeta, error) {
	if err := ctx.Err(); err != nil {
		return FileMeta{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(nodeID)
	if d == nil || d.deleted || d.purged || d.meta.Kind != "file" || !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) || RoleRank(m.roleLocked(uid, d)) < RoleRank(RoleView) || d.driveFileID < 1 || d.driveFileID > int64(len(m.sh.files)) {
		return FileMeta{}, ErrNotFound
	}
	f := m.sh.files[d.driveFileID-1]
	if f.ID == 0 || f.DocID != nodeID {
		return FileMeta{}, ErrNotFound
	}
	f.Personal = d.personal
	return f, nil
}

func (p *Postgres) CreateDriveFile(ctx context.Context, g RestoreGuard, ws int64, parent *int64, f FileMeta, personal bool) (out DriveEntry, err error) {
	if ws <= 0 || !ValidDriveFileName(f.Name) || f.ObjectKey == "" || f.Size < 0 {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		if e := drivePGLockWorkspace(ctx, tx, ws); e != nil {
			return e
		}
		exp, e := drivePGSession(ctx, tx, g)
		if e != nil {
			return e
		}
		var member int
		e = tx.QueryRow(ctx, `SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, ws, g.UserID).Scan(&member)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if e != nil {
			return e
		}
		parentPersonal, e := drivePGDestination(ctx, tx, g, ws, parent, RoleEdit)
		if e != nil {
			return e
		}
		personal = parent == nil && personal || parent != nil && parentPersonal
		e = tx.QueryRow(ctx, `INSERT INTO nodes(workspace_id,parent_id,kind,sort_key,title,creator_id,drive_revision,personal) VALUES($1,$2,'file','V',$3,$4,1,$5) RETURNING id,workspace_id,parent_id,kind,title,icon,creator_id,drive_revision,personal,created_at,updated_at`, ws, parent, f.Name, g.UserID, personal).Scan(&out.ID, &out.WorkspaceID, &out.ParentID, &out.Kind, &out.Title, &out.Icon, &out.CreatorID, &out.Revision, &out.Personal, &out.CreatedAt, &out.UpdatedAt)
		if e != nil {
			return e
		}
		out.Role = RoleManage
		var fid int64
		e = tx.QueryRow(ctx, `INSERT INTO attachments(doc_id,uploader_id,name,mime,size,object_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, out.ID, g.UserID, f.Name, f.Mime, f.Size, f.ObjectKey).Scan(&fid)
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO drive_files(node_id,attachment_id) VALUES($1,$2)`, out.ID, fid); e != nil {
			return e
		}
		return drivePGEnd(ctx, g, exp)
	})
	if err != nil {
		return DriveEntry{}, drivePGError(err)
	}
	return out, nil
}

func (p *Postgres) GetDriveFile(ctx context.Context, uid, nodeID int64) (f FileMeta, err error) {
	err = p.Pool.QueryRow(ctx, `SELECT a.id,a.doc_id,a.uploader_id,a.name,a.mime,a.size,a.object_key,a.created_at,n.personal FROM nodes n JOIN drive_files df ON df.node_id=n.id JOIN attachments a ON a.id=df.attachment_id AND a.doc_id=n.id`+roleJoins+` WHERE n.id=$2 AND n.kind='file' AND n.deleted_at IS NULL AND (`+roleSQL+`)<>''`, uid, nodeID).Scan(&f.ID, &f.DocID, &f.UploaderID, &f.Name, &f.Mime, &f.Size, &f.ObjectKey, &f.CreatedAt, &f.Personal)
	if errors.Is(err, pgx.ErrNoRows) {
		return FileMeta{}, ErrNotFound
	}
	return f, err
}
