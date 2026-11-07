package store

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// DriveEntry is a directory entry, not a document or a collaborative state.
// Folder access uses the existing workspace and inherited node grants. It does
// not imply that a workspace member's folder is private to its creator.
type DriveEntry struct {
	ID          int64     `json:"id"`
	WorkspaceID int64     `json:"workspaceId"`
	ParentID    *int64    `json:"parentId"`
	Kind        string    `json:"kind"`
	Title       string    `json:"title"`
	Icon        string    `json:"icon,omitempty"`
	CreatorID   int64     `json:"creatorId"`
	Role        string    `json:"role"`
	Revision    int64     `json:"revision"`
	Personal    bool      `json:"personal"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// DriveFolderStore implements the versioned directory API. These operations
// must not be replaced with the legacy unguarded document tree operations.
// The trailing bool on create/list is the personal scope (我的空间): children
// inherit the scope of their parent folder; top-level nodes take it from the
// request.
type DriveFolderStore interface {
	CreateDriveFolder(context.Context, RestoreGuard, int64, *int64, string, bool) (DriveEntry, error)
	CreateDriveNode(context.Context, RestoreGuard, int64, *int64, string, string, bool) (DriveEntry, error)
	ListDriveChildren(context.Context, RestoreGuard, int64, *int64, bool) ([]DriveEntry, error)
	MoveDriveNode(context.Context, RestoreGuard, int64, *int64, int64) error
	TrashDriveNode(context.Context, RestoreGuard, int64, int64) error
	RestoreDriveNode(context.Context, RestoreGuard, int64, int64) error
}

func validDriveTitle(title string) bool { return title != "" }
func sameDriveParent(a, b *int64) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

func (m *Memory) driveSessionLocked(ctx context.Context, g RestoreGuard) (time.Time, error) {
	if err := ctx.Err(); err != nil {
		return time.Time{}, err
	}
	s, ok := m.sessions[string(g.SessionHash)]
	if !ok || s.userID != g.UserID || !g.currentTime().Before(s.expires) {
		return time.Time{}, ErrUnauthenticated
	}
	return s.expires, nil
}
func (m *Memory) driveValidChainLocked(d *memDoc, workspace int64, allowDeleted bool) bool {
	seen := map[int64]bool{}
	for d != nil {
		if seen[d.meta.ID] || d.meta.WorkspaceID != workspace || (!allowDeleted && d.deleted) {
			return false
		}
		seen[d.meta.ID] = true
		if d.meta.ParentID == nil {
			return true
		}
		d = m.doc(*d.meta.ParentID)
	}
	return false
}

// Legacy tree mutations cannot safely modify a folder tree because they do
// not carry a directory revision or a session/authorization guard.
func (m *Memory) driveFolderAncestorLocked(d *memDoc) bool {
	seen := make(map[int64]bool)
	for d != nil {
		if seen[d.meta.ID] { return true }
		seen[d.meta.ID] = true
		if d.meta.Kind == "folder" { return true }
		if d.meta.ParentID == nil { return false }
		d = m.doc(*d.meta.ParentID)
	}
	return true
}

func (m *Memory) driveFolderSubtreeLocked(d *memDoc) bool {
	if m.driveFolderAncestorLocked(d) { return true }
	children, err := m.safeDriveSubtreeLocked(d)
	if err != nil { return true }
	for _, child := range children { if child.meta.Kind == "folder" { return true } }
	return false
}
func (m *Memory) driveDestinationLocked(user, workspace int64, parent *int64, minimum string) error {
	if parent == nil {
		if !m.member(user, workspace) {
			return ErrForbidden
		}
		return nil
	}
	d := m.doc(*parent)
	if d == nil || d.meta.Kind != "folder" || !m.driveValidChainLocked(d, workspace, false) || RoleRank(m.roleLocked(user, d)) < RoleRank(minimum) {
		return ErrForbidden
	}
	return nil
}
func driveMemoryEntry(m *Memory, d *memDoc, user int64) DriveEntry {
	return DriveEntry{ID: d.meta.ID, WorkspaceID: d.meta.WorkspaceID, ParentID: cloneDriveParent(d.meta.ParentID), Kind: d.meta.Kind, Title: d.meta.Title, Icon: d.meta.Icon, CreatorID: d.meta.CreatorID, Role: m.roleLocked(user, d), Revision: d.driveRevision, Personal: d.personal, UpdatedAt: d.meta.UpdatedAt}
}

func cloneDriveParent(parent *int64) *int64 {
	if parent == nil { return nil }
	value := *parent
	return &value
}

const maxDriveRevision = int64(9007199254740991)
func (m *Memory) CreateDriveFolder(ctx context.Context, g RestoreGuard, ws int64, parent *int64, title string, personal bool) (DriveEntry, error) {
	if ws <= 0 || !validDriveTitle(title) {
		return DriveEntry{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, g)
	if err != nil {
		return DriveEntry{}, err
	}
	// The current workspace model grants workspace members access to all
	// shared-scope nodes. Personal-scope nodes are the creator's 我的空间:
	// membership grants nothing there, so the creator always keeps manage.
	if !m.member(g.UserID, ws) {
		return DriveEntry{}, ErrForbidden
	}
	if err = m.driveDestinationLocked(g.UserID, ws, parent, RoleEdit); err != nil {
		return DriveEntry{}, err
	}
	if parent != nil {
		personal = m.doc(*parent).personal // 子节点继承父目录空间
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
	var pp *int64
	if parent != nil {
		v := *parent
		pp = &v
	}
	d := &memDoc{meta: DocMeta{ID: int64(len(m.d.docs) + 1), WorkspaceID: ws, ParentID: pp, Kind: "folder", Title: title, CreatorID: g.UserID, CreatorName: m.users[g.UserID-1].Name, CreatedAt: now, UpdatedAt: now, DriveRevision: 1}, driveRevision: 1, personal: personal}
	m.d.docs = append(m.d.docs, d)
	return driveMemoryEntry(m, d, g.UserID), nil
}

// CreateDriveNode creates a doc or base under a folder (folder kind delegates
// to CreateDriveFolder). The node is born into the versioned drive world:
// drive_revision 1 and, for bases, the same default content as the legacy
// initialized creation.
func (m *Memory) CreateDriveNode(ctx context.Context, g RestoreGuard, ws int64, parent *int64, kind, title string, personal bool) (DriveEntry, error) {
	if kind == "folder" {
		return m.CreateDriveFolder(ctx, g, ws, parent, title, personal)
	}
	if (kind != "doc" && kind != "base") || ws <= 0 || !validDriveTitle(title) {
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
		personal = m.doc(*parent).personal // 子节点继承父目录空间
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
	var pp *int64
	if parent != nil {
		v := *parent
		pp = &v
	}
	id := int64(len(m.d.docs) + 1)
	meta := DocMeta{ID: id, WorkspaceID: ws, ParentID: pp, Kind: kind, Title: title, CreatorID: g.UserID, CreatorName: m.users[g.UserID-1].Name, CreatedAt: now, UpdatedAt: now, DriveRevision: 1}
	if kind == "doc" {
		meta.CopyMinRole, meta.DownloadMinRole, meta.CommentMinRole = RoleView, RoleView, RoleView
	}
	d := &memDoc{meta: meta, driveRevision: 1, personal: personal, ids: map[[2]int64]bool{}, snaps: map[int64][]byte{}, versions: map[int64]memVersion{}}
	if kind == "base" {
		field := Field{BaseID: id, Name: "文本", Type: "text", Position: 1, IsPrimary: true}
		view := View{BaseID: id, Name: "表格", Type: "grid", Config: json.RawMessage(`{}`), Pos: 1}
		records := make([]Record, 5)
		for i := range records {
			uid := g.UserID
			records[i] = Record{BaseID: id, Cells: map[string]json.RawMessage{}, Position: float64(i + 1), CreatorID: &uid, CreatedAt: &now, UpdatedAt: &now}
		}
		field.ID = m.id()
		view.ID = m.id()
		for i := range records {
			records[i].ID = m.id()
			records[i].Position = float64(records[i].ID)
		}
		m.b.fields = append(m.b.fields, field)
		m.b.views = append(m.b.views, view)
		m.b.records = append(m.b.records, records...)
	}
	m.d.docs = append(m.d.docs, d)
	return driveMemoryEntry(m, d, g.UserID), nil
}
func (m *Memory) ListDriveChildren(ctx context.Context, g RestoreGuard, ws int64, parent *int64, personal bool) ([]DriveEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, g)
	if err != nil {
		return nil, err
	}
	if err = m.driveDestinationLocked(g.UserID, ws, parent, RoleView); err != nil {
		return nil, err
	}
	if parent != nil {
		personal = m.doc(*parent).personal // 目录内空间由父目录决定
	}
	out := make([]DriveEntry, 0)
	for _, d := range m.d.docs {
		if d.meta.WorkspaceID == ws && !d.deleted && d.personal == personal && sameDriveParent(d.meta.ParentID, parent) && RoleRank(m.roleLocked(g.UserID, d)) >= RoleRank(RoleView) {
			out = append(out, driveMemoryEntry(m, d, g.UserID))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind == "folder"
		}
		return out[i].ID < out[j].ID
	})
	if !g.currentTime().Before(expires) {
		return nil, ErrUnauthenticated
	}
	return out, ctx.Err()
}
func (m *Memory) MoveDriveNode(ctx context.Context, g RestoreGuard, id int64, parent *int64, expected int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, g)
	if err != nil {
		return err
	}
	d := m.doc(id)
	if d == nil || d.deleted || !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) || RoleRank(m.roleLocked(g.UserID, d)) < RoleRank(RoleManage) {
		return ErrForbidden
	}
	if d.driveRevision != expected || d.driveRevision >= maxDriveRevision {
		return ErrConflict
	}
	if err = m.driveDestinationLocked(g.UserID, d.meta.WorkspaceID, parent, RoleEdit); err != nil {
		return err
	}
	if parent != nil {
		if m.doc(*parent).personal != d.personal {
			// 跨空间移动会静默改变整棵子树的可见性，先拒绝（顶层移动保持原空间）
			return ErrForbidden
		}
		for x := m.doc(*parent); x != nil; {
			if x.meta.ID == id {
				return ErrConflict
			}
			if x.meta.ParentID == nil {
				break
			}
			x = m.doc(*x.meta.ParentID)
		}
	}
	if !g.currentTime().Before(expires) {
		return ErrUnauthenticated
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	d.meta.ParentID = cloneDriveParent(parent)
	d.driveRevision++
	d.meta.DriveRevision = d.driveRevision
	d.meta.UpdatedAt = time.Now()
	return nil
}
func (m *Memory) TrashDriveNode(ctx context.Context, g RestoreGuard, id, expected int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, g)
	if err != nil {
		return err
	}
	d := m.doc(id)
	if d == nil || d.deleted || !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) || RoleRank(m.roleLocked(g.UserID, d)) < RoleRank(RoleManage) {
		return ErrForbidden
	}
	if d.driveRevision != expected {
		return ErrConflict
	}
	items, err := m.safeDriveSubtreeLocked(d)
	if err != nil {
		return err
	}
	for _, item := range items { if !item.deleted && item.driveRevision >= maxDriveRevision { return ErrConflict } }
	if m.d.driveTrashSequence >= maxDriveRevision { return ErrConflict }
	if !g.currentTime().Before(expires) {
		return ErrUnauthenticated
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	m.d.driveTrashSequence++
	batch := m.d.driveTrashSequence
	for _, item := range items {
		if !item.deleted {
			item.deleted = true
			item.driveTrashBatch = batch
			item.driveRevision++
			item.meta.DriveRevision = item.driveRevision
			item.meta.TrashBatchID = batch
		}
	}
	return nil
}
func (m *Memory) RestoreDriveNode(ctx context.Context, g RestoreGuard, id, expected int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.driveSessionLocked(ctx, g)
	if err != nil {
		return err
	}
	d := m.doc(id)
	// driveTrashBatch == 0 marks a legacy (pre-drive) deletion; the loops
	// below then restore the subtree's still-deleted legacy rows.
	if d == nil || !d.deleted || d.driveRevision != expected {
		return ErrConflict
	}
	// 个人空间节点只有创建者能还原（空间 owner 也不行）
	if !m.member(g.UserID, d.meta.WorkspaceID) || (d.meta.CreatorID != g.UserID && (d.personal || int(d.meta.WorkspaceID) > len(m.workspaces) || m.workspaces[d.meta.WorkspaceID-1].OwnerID != g.UserID)) {
		return ErrForbidden
	}
	if d.meta.ParentID != nil {
		p := m.doc(*d.meta.ParentID)
		if p == nil || !m.driveValidChainLocked(p, d.meta.WorkspaceID, false) {
			return ErrConflict
		}
	}
	items, err := m.safeDriveSubtreeLocked(d)
	if err != nil {
		return err
	}
	for _, item := range items { if item.deleted && item.driveTrashBatch == d.driveTrashBatch && item.driveRevision >= maxDriveRevision { return ErrConflict } }
	if !g.currentTime().Before(expires) {
		return ErrUnauthenticated
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	batch := d.driveTrashBatch
	for _, item := range items {
		if item.deleted && item.driveTrashBatch == batch {
			item.deleted = false
			item.driveTrashBatch = 0
			item.driveRevision++
			item.meta.DriveRevision = item.driveRevision
			item.meta.TrashBatchID = 0
		}
	}
	return nil
}
func (m *Memory) safeDriveSubtreeLocked(root *memDoc) ([]*memDoc, error) {
	seen := map[int64]bool{}
	children := make(map[int64][]*memDoc)
	for _, child := range m.d.docs { if child.meta.ParentID != nil { children[*child.meta.ParentID] = append(children[*child.meta.ParentID], child) } }
	queue := []*memDoc{root}
	out := []*memDoc{}
	for len(queue) > 0 {
		d := queue[0]
		queue = queue[1:]
		if seen[d.meta.ID] || d.meta.WorkspaceID != root.meta.WorkspaceID {
			return nil, ErrConflict
		}
		seen[d.meta.ID] = true
		out = append(out, d)
		queue = append(queue, children[d.meta.ID]...)
	}
	return out, nil
}

func drivePGSession(ctx context.Context, tx pgx.Tx, g RestoreGuard) (time.Time, error) {
	var uid int64
	var expires time.Time
	err := tx.QueryRow(ctx, `SELECT user_id,expires_at FROM sessions WHERE token_hash=$1 FOR SHARE`, g.SessionHash).Scan(&uid, &expires)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (uid != g.UserID || !g.currentTime().Before(expires)) {
		return time.Time{}, ErrUnauthenticated
	}
	return expires, err
}
func drivePGLockWorkspace(ctx context.Context, tx pgx.Tx, ws int64) error {
	if ws <= 0 {
		return ErrConflict
	}
	_, err := tx.Exec(ctx, `SELECT drive_lock_workspace($1)`, ws)
	return err
}
func drivePGLockWorkspaceRead(ctx context.Context, tx pgx.Tx, ws int64) error {
	if ws <= 0 { return ErrConflict }
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended('jiange:drive:' || $1::bigint::text, 0))`, ws)
	return err
}
func drivePGNodeWorkspace(ctx context.Context, tx pgx.Tx, id int64) (int64, error) {
	var ws int64
	err := tx.QueryRow(ctx, `SELECT workspace_id FROM nodes WHERE id=$1`, id).Scan(&ws)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return ws, err
}
func drivePGValidChain(ctx context.Context, tx pgx.Tx, id, ws int64) error {
	var bad bool
	err := tx.QueryRow(ctx, `WITH RECURSIVE a AS (SELECT id,parent_id,workspace_id,deleted_at,ARRAY[id] AS seen FROM nodes WHERE id=$1 UNION ALL SELECT n.id,n.parent_id,n.workspace_id,n.deleted_at,a.seen||n.id FROM nodes n JOIN a ON n.id=a.parent_id WHERE NOT n.id=ANY(a.seen)) SELECT NOT EXISTS(SELECT 1 FROM a) OR EXISTS(SELECT 1 FROM a WHERE deleted_at IS NOT NULL OR workspace_id<>$2 OR (parent_id IS NOT NULL AND (parent_id=ANY(seen) OR NOT EXISTS(SELECT 1 FROM nodes p WHERE p.id=a.parent_id))))`, id, ws).Scan(&bad)
	if err != nil {
		return err
	}
	if bad {
		return ErrConflict
	}
	return nil
}
// drivePGDestination validates the destination and returns the parent
// folder's personal scope (false at the workspace root).
func drivePGDestination(ctx context.Context, tx pgx.Tx, g RestoreGuard, ws int64, parent *int64, min string) (bool, error) {
	if parent == nil {
		var member int
		err := tx.QueryRow(ctx, `SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, ws, g.UserID).Scan(&member)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, ErrForbidden
		}
		return false, err
	}
	var kind string
	var pws int64
	var personal bool
	err := tx.QueryRow(ctx, `SELECT kind,workspace_id,personal FROM nodes WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, *parent).Scan(&kind, &pws, &personal)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (kind != "folder" || pws != ws) {
		return false, ErrForbidden
	}
	if err != nil {
		return false, err
	}
	if err = drivePGValidChain(ctx, tx, *parent, ws); err != nil {
		return false, err
	}
	role, _, _, err := lockCopySource(ctx, tx, *parent, g.UserID)
	if err != nil {
		return false, err
	}
	if RoleRank(role) < RoleRank(min) {
		return false, ErrForbidden
	}
	return personal, nil
}
func drivePGEnd(ctx context.Context, g RestoreGuard, expires time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !g.currentTime().Before(expires) {
		return ErrUnauthenticated
	}
	return nil
}
func drivePGError(err error) error {
	if retryableRestoreConflict(err) {
		return ErrConflict
	}
	return err
}
func (p *Postgres) CreateDriveFolder(ctx context.Context, g RestoreGuard, ws int64, parent *int64, title string, personal bool) (out DriveEntry, err error) {
	if ws <= 0 || !validDriveTitle(title) {
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
		e = tx.QueryRow(ctx, `INSERT INTO nodes(workspace_id,parent_id,kind,sort_key,title,creator_id,drive_revision,personal) VALUES($1,$2,'folder','V',$3,$4,1,$5) RETURNING id,workspace_id,parent_id,kind,title,icon,creator_id,drive_revision,personal,updated_at`, ws, parent, title, g.UserID, personal).Scan(&out.ID, &out.WorkspaceID, &out.ParentID, &out.Kind, &out.Title, &out.Icon, &out.CreatorID, &out.Revision, &out.Personal, &out.UpdatedAt)
		if e != nil {
			return e
		}
		out.Role = RoleManage
		return drivePGEnd(ctx, g, exp)
	})
	return out, drivePGError(err)
}

// CreateDriveNode creates a doc or base under a folder (folder kind delegates
// to CreateDriveFolder) with guard, destination checks and fence-compatible
// insert (drive_revision 1). Bases get the same default content as the legacy
// initialized creation, published in the same transaction.
func (p *Postgres) CreateDriveNode(ctx context.Context, g RestoreGuard, ws int64, parent *int64, kind, title string, personal bool) (out DriveEntry, err error) {
	if kind == "folder" {
		return p.CreateDriveFolder(ctx, g, ws, parent, title, personal)
	}
	if (kind != "doc" && kind != "base") || ws <= 0 || !validDriveTitle(title) {
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
		if e = tx.QueryRow(ctx, `INSERT INTO nodes(workspace_id,parent_id,kind,sort_key,title,creator_id,drive_revision,personal) VALUES($1,$2,$3,'V',$4,$5,1,$6) RETURNING id,workspace_id,parent_id,kind,title,icon,creator_id,drive_revision,personal,updated_at`, ws, parent, kind, title, g.UserID, personal).
			Scan(&out.ID, &out.WorkspaceID, &out.ParentID, &out.Kind, &out.Title, &out.Icon, &out.CreatorID, &out.Revision, &out.Personal, &out.UpdatedAt); e != nil {
			return e
		}
		out.Role = RoleManage
		if kind == "doc" {
			if _, e = tx.Exec(ctx, `INSERT INTO doc_heads (doc_id, seq) VALUES ($1, 0)`, out.ID); e != nil {
				return e
			}
		} else {
			if _, e = tx.Exec(ctx, `INSERT INTO base_fields (base_id,name,type,position,is_primary) VALUES ($1,'文本','text',1,true)`, out.ID); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `INSERT INTO bt_views (base_id,type,name,config,pos) VALUES ($1,'grid','表格','{}'::jsonb,1)`, out.ID); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `INSERT INTO base_records (base_id,cells,position,creator_id)
				SELECT $1,'{}'::jsonb, n, $2 FROM generate_series(1,5) AS n`, out.ID, g.UserID); e != nil {
				return e
			}
		}
		return drivePGEnd(ctx, g, exp)
	})
	return out, drivePGError(err)
}
func (p *Postgres) ListDriveChildren(ctx context.Context, g RestoreGuard, ws int64, parent *int64, personal bool) (out []DriveEntry, err error) {
	out = make([]DriveEntry, 0)
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		if e := drivePGLockWorkspaceRead(ctx, tx, ws); e != nil {
			return e
		}
		exp, e := drivePGSession(ctx, tx, g)
		if e != nil {
			return e
		}
		parentPersonal, e := drivePGDestination(ctx, tx, g, ws, parent, RoleView)
		if e != nil {
			return e
		}
		if parent != nil {
			personal = parentPersonal // 目录内空间由父目录决定
		}
		rows, e := tx.Query(ctx, `SELECT n.id,n.workspace_id,n.parent_id,n.kind,n.title,n.icon,n.creator_id,`+roleSQL+`,n.drive_revision,n.personal,n.updated_at FROM nodes n`+roleJoins+` WHERE n.workspace_id=$2 AND n.parent_id IS NOT DISTINCT FROM $3 AND n.personal = $4 AND n.deleted_at IS NULL AND (`+roleSQL+`)<>'' ORDER BY (n.kind='folder') DESC,n.sort_key,n.id`, g.UserID, ws, parent, personal)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var d DriveEntry
			if e = rows.Scan(&d.ID, &d.WorkspaceID, &d.ParentID, &d.Kind, &d.Title, &d.Icon, &d.CreatorID, &d.Role, &d.Revision, &d.Personal, &d.UpdatedAt); e != nil {
				return e
			}
			out = append(out, d)
		}
		if e = rows.Err(); e != nil {
			return e
		}
		return drivePGEnd(ctx, g, exp)
	})
	return out, drivePGError(err)
}
func (p *Postgres) MoveDriveNode(ctx context.Context, g RestoreGuard, id int64, parent *int64, expected int64) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		ws, e := drivePGNodeWorkspace(ctx, tx, id)
		if e != nil {
			return e
		}
		if e = drivePGLockWorkspace(ctx, tx, ws); e != nil {
			return e
		}
		exp, e := drivePGSession(ctx, tx, g)
		if e != nil {
			return e
		}
		var currentWS, rev int64
		var deleted, nodePersonal bool
		e = tx.QueryRow(ctx, `SELECT workspace_id,drive_revision,deleted_at IS NOT NULL,personal FROM nodes WHERE id=$1 FOR UPDATE`, id).Scan(&currentWS, &rev, &deleted, &nodePersonal)
		if e != nil {
			return e
		}
		if currentWS != ws || deleted || rev != expected {
			return ErrConflict
		}
		if e = drivePGValidChain(ctx, tx, id, ws); e != nil {
			return e
		}
		role, _, _, e := lockCopySource(ctx, tx, id, g.UserID)
		if e != nil {
			return e
		}
		if RoleRank(role) < RoleRank(RoleManage) {
			return ErrForbidden
		}
		parentPersonal, e := drivePGDestination(ctx, tx, g, ws, parent, RoleEdit)
		if e != nil {
			return e
		}
		if parent != nil && parentPersonal != nodePersonal {
			// 跨空间移动会静默改变整棵子树的可见性，先拒绝（顶层移动保持原空间）
			return ErrForbidden
		}
		if parent != nil {
			var cyc bool
			e = tx.QueryRow(ctx, `WITH RECURSIVE a AS (SELECT id,parent_id,ARRAY[id] seen FROM nodes WHERE id=$1 UNION ALL SELECT n.id,n.parent_id,a.seen||n.id FROM nodes n JOIN a ON n.id=a.parent_id WHERE NOT n.id=ANY(a.seen)) SELECT EXISTS(SELECT 1 FROM a WHERE id=$2)`, *parent, id).Scan(&cyc)
			if e != nil {
				return e
			}
			if cyc {
				return ErrConflict
			}
		}
		if e = drivePGEnd(ctx, g, exp); e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `UPDATE nodes SET parent_id=$2,drive_revision=drive_revision+1,updated_at=now() WHERE id=$1`, id, parent)
		if e != nil { return e }
		return drivePGEnd(ctx, g, exp)
	})
	return drivePGError(err)
}
func (p *Postgres) TrashDriveNode(ctx context.Context, g RestoreGuard, id, expected int64) error {
	return p.changeDriveTrash(ctx, g, id, expected, false)
}
func (p *Postgres) RestoreDriveNode(ctx context.Context, g RestoreGuard, id, expected int64) error {
	return p.changeDriveTrash(ctx, g, id, expected, true)
}
func (p *Postgres) changeDriveTrash(ctx context.Context, g RestoreGuard, id, expected int64, restore bool) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		ws, e := drivePGNodeWorkspace(ctx, tx, id)
		if e != nil {
			return e
		}
		if e = drivePGLockWorkspace(ctx, tx, ws); e != nil {
			return e
		}
		exp, e := drivePGSession(ctx, tx, g)
		if e != nil {
			return e
		}
		var actualWS, rev, creator int64
		var deleted, personal bool
		var batch *int64
		var parent *int64
		e = tx.QueryRow(ctx, `SELECT workspace_id,drive_revision,creator_id,deleted_at IS NOT NULL,trash_batch_id,parent_id,personal FROM nodes WHERE id=$1 FOR UPDATE`, id).Scan(&actualWS, &rev, &creator, &deleted, &batch, &parent, &personal)
		if e != nil {
			return e
		}
		if actualWS != ws || rev != expected || deleted != restore {
			return ErrConflict
		}
		// 个人空间节点只有创建者能还原（空间 owner/admin 也不行）
		if personal && creator != g.UserID {
			return ErrForbidden
		}
		if !restore {
			if e = drivePGValidChain(ctx, tx, id, ws); e != nil {
				return e
			}
			role, _, _, e := lockCopySource(ctx, tx, id, g.UserID)
			if e != nil {
				return e
			}
			if RoleRank(role) < RoleRank(RoleManage) {
				return ErrForbidden
			}
		} else {
			// batch == nil marks a legacy (pre-drive) deletion: those subtrees
			// carry no batch, so restore still-deleted legacy rows below.
			var memberRole string
			e = tx.QueryRow(ctx, `SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, ws, g.UserID).Scan(&memberRole)
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrForbidden
			}
			if e != nil {
				return e
			}
			if memberRole != "owner" && memberRole != "admin" && creator != g.UserID {
				return ErrForbidden
			}
			if parent != nil {
				if e = drivePGValidChain(ctx, tx, *parent, ws); e != nil {
					return e
				}
			}
		}
		var bad bool
		e = tx.QueryRow(ctx, `WITH RECURSIVE t AS (SELECT id,workspace_id,ARRAY[id] seen FROM nodes WHERE id=$1 UNION ALL SELECT n.id,n.workspace_id,t.seen||n.id FROM nodes n JOIN t ON n.parent_id=t.id WHERE NOT n.id=ANY(t.seen)) SELECT EXISTS(SELECT 1 FROM t WHERE workspace_id<>$2) OR EXISTS(SELECT 1 FROM t JOIN nodes n ON n.parent_id=t.id WHERE n.id=ANY(t.seen))`, id, ws).Scan(&bad)
		if e != nil {
			return e
		}
		if bad {
			return ErrConflict
		}
		if e = drivePGEnd(ctx, g, exp); e != nil {
			return e
		}
		if !restore {
			var b int64
			if e = tx.QueryRow(ctx, `SELECT nextval('drive_trash_batch_seq')`).Scan(&b); e != nil {
				return e
			}
			_, e = tx.Exec(ctx, `WITH RECURSIVE t(id) AS (SELECT $1::bigint UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id=t.id) UPDATE nodes SET deleted_at=now(),trash_batch_id=$2,drive_revision=drive_revision+1 WHERE id IN (SELECT id FROM t) AND deleted_at IS NULL`, id, b)
			if e != nil { return e }
			return drivePGEnd(ctx, g, exp)
		}
		if batch != nil {
			_, e = tx.Exec(ctx, `WITH RECURSIVE t(id) AS (SELECT $1::bigint UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id=t.id) UPDATE nodes SET deleted_at=NULL,trash_batch_id=NULL,drive_revision=drive_revision+1 WHERE id IN (SELECT id FROM t) AND trash_batch_id=$2`, id, *batch)
		} else {
			_, e = tx.Exec(ctx, `WITH RECURSIVE t(id) AS (SELECT $1::bigint UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id=t.id) UPDATE nodes SET deleted_at=NULL,drive_revision=drive_revision+1 WHERE id IN (SELECT id FROM t) AND deleted_at IS NOT NULL AND trash_batch_id IS NULL`, id)
		}
		if e != nil { return e }
		return drivePGEnd(ctx, g, exp)
	})
	return drivePGError(err)
}
