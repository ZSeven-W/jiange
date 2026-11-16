package store

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// ClipboardAssetCopy copies immutable attachment references into an existing
// document. RequestID identifies one paste attempt, including its retries.
type ClipboardAssetCopy struct {
	SourceDocID int64
	TargetDocID int64
	RequestID   string
	FileIDs     []int64
}

type clipboardCopyKey struct {
	user, target int64
	request      string
}
type clipboardCopyResult struct {
	source  int64
	ids     []int64
	mapping map[int64]int64
}

var clipboardRequestID = regexp.MustCompile(`^[0-9a-f]{32}$`)

const maxClipboardSafeID int64 = 1<<53 - 1

func canonicalClipboardCopy(c ClipboardAssetCopy) (ClipboardAssetCopy, error) {
	if c.SourceDocID <= 0 || c.SourceDocID > maxClipboardSafeID || c.TargetDocID <= 0 || c.TargetDocID > maxClipboardSafeID || !clipboardRequestID.MatchString(c.RequestID) || len(c.FileIDs) == 0 || len(c.FileIDs) > 100 {
		return c, ErrConflict
	}
	ids := append([]int64(nil), c.FileIDs...)
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for i, id := range ids {
		if id <= 0 || id > maxClipboardSafeID || i > 0 && id == ids[i-1] {
			return c, ErrConflict
		}
	}
	c.FileIDs = ids
	return c, nil
}

func sameClipboardIDs(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func cloneClipboardMapping(in map[int64]int64) map[int64]int64 {
	out := make(map[int64]int64, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// CopyClipboardAssets serializes permissions, source references and the
// idempotency result with metadata publication. Blob bytes are not copied.
func (m *Memory) CopyClipboardAssets(ctx context.Context, g RestoreGuard, input ClipboardAssetCopy) (map[int64]int64, error) {
	c, err := canonicalClipboardCopy(input)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expiry, err := m.driveSessionLocked(ctx, g)
	if err != nil {
		return nil, err
	}
	source, target := m.doc(c.SourceDocID), m.doc(c.TargetDocID)
	if source == nil || target == nil || source.deleted || source.purged || target.deleted || target.purged || source.meta.Kind != "doc" || target.meta.Kind != "doc" {
		return nil, ErrNotFound
	}
	sourceRole, targetRole := m.roleLocked(g.UserID, source), m.roleLocked(g.UserID, target)
	if RoleRank(sourceRole) < RoleRank(RoleView) || RoleRank(targetRole) < RoleRank(RoleEdit) {
		return nil, ErrForbidden
	}
	if !DocumentCopyAllowed(source.meta, sourceRole) || !DocumentDownloadAllowed(source.meta, sourceRole) {
		return nil, ErrCopyProtected
	}
	for _, id := range c.FileIDs {
		if id > int64(len(m.sh.files)) || m.sh.files[id-1].ID != id || m.sh.files[id-1].DocID != c.SourceDocID {
			return nil, ErrNotFound
		}
	}
	key := clipboardCopyKey{g.UserID, c.TargetDocID, c.RequestID}
	if old, ok := m.clipboardCopies[key]; ok {
		if old.source != c.SourceDocID || !sameClipboardIDs(old.ids, c.FileIDs) {
			return nil, ErrConflict
		}
		for _, id := range old.mapping {
			if id <= 0 || id > maxClipboardSafeID || id > int64(len(m.sh.files)) || m.sh.files[id-1].ID != id || m.sh.files[id-1].DocID != c.TargetDocID {
				return nil, ErrConflict
			}
		}
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		if !g.currentTime().Before(expiry) {
			return nil, ErrUnauthenticated
		}
		return cloneClipboardMapping(old.mapping), nil
	}
	mapping := make(map[int64]int64, len(c.FileIDs))
	files := make([]FileMeta, 0, len(c.FileIDs))
	now := time.Now()
	for _, id := range c.FileIDs {
		if c.SourceDocID == c.TargetDocID {
			mapping[id] = id
			continue
		}
		file := m.sh.files[id-1]
		file.ID = int64(len(m.sh.files) + len(files) + 1)
		if file.ID > maxClipboardSafeID {
			return nil, ErrConflict
		}
		file.DocID, file.UploaderID, file.CreatedAt = c.TargetDocID, g.UserID, now
		mapping[id] = file.ID
		files = append(files, file)
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if !g.currentTime().Before(expiry) {
		return nil, ErrUnauthenticated
	}
	if m.clipboardCopies == nil {
		m.clipboardCopies = make(map[clipboardCopyKey]clipboardCopyResult)
	}
	m.sh.files = append(m.sh.files, files...)
	m.clipboardCopies[key] = clipboardCopyResult{c.SourceDocID, append([]int64(nil), c.FileIDs...), cloneClipboardMapping(mapping)}
	return mapping, nil
}

func (p *Postgres) CopyClipboardAssets(ctx context.Context, g RestoreGuard, input ClipboardAssetCopy) (mapping map[int64]int64, err error) {
	c, err := canonicalClipboardCopy(input)
	if err != nil {
		return nil, err
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := drivePGSession(ctx, tx, g)
		if e != nil {
			return e
		}
		if !g.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		ids := []int64{c.SourceDocID}
		if c.TargetDocID != c.SourceDocID {
			ids = append(ids, c.TargetDocID)
		}
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		roles := map[int64]string{}
		protected := map[int64]bool{}
		for _, id := range ids {
			role, locked, kind, e := lockCopySource(ctx, tx, id, g.UserID)
			if e != nil {
				return e
			}
			if kind != "doc" {
				return ErrNotFound
			}
			roles[id], protected[id] = role, locked
		}
		if RoleRank(roles[c.SourceDocID]) < RoleRank(RoleView) || RoleRank(roles[c.TargetDocID]) < RoleRank(RoleEdit) {
			return ErrForbidden
		}
		var copyMin, downloadMin string
		if e = tx.QueryRow(ctx, `SELECT copy_min_role,download_min_role FROM nodes WHERE id=$1`, c.SourceDocID).Scan(&copyMin, &downloadMin); e != nil {
			return e
		}
		meta := DocMeta{Kind: "doc", CopyProtected: protected[c.SourceDocID], CopyMinRole: copyMin, DownloadMinRole: downloadMin}
		if !DocumentCopyAllowed(meta, roles[c.SourceDocID]) || !DocumentDownloadAllowed(meta, roles[c.SourceDocID]) {
			return ErrCopyProtected
		}
		rows, e := tx.Query(ctx, `SELECT id FROM attachments WHERE doc_id=$1 AND id=ANY($2) ORDER BY id FOR SHARE`, c.SourceDocID, c.FileIDs)
		if e != nil {
			return e
		}
		var found []int64
		for rows.Next() {
			var id int64
			if e = rows.Scan(&id); e != nil {
				rows.Close()
				return e
			}
			found = append(found, id)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		if !sameClipboardIDs(found, c.FileIDs) {
			return ErrNotFound
		}
		var inserted int
		e = tx.QueryRow(ctx, `INSERT INTO clipboard_asset_copies (user_id,target_doc_id,request_id,source_doc_id,source_ids,mapping) VALUES ($1,$2,$3,$4,$5,'{}'::jsonb) ON CONFLICT DO NOTHING RETURNING 1`, g.UserID, c.TargetDocID, c.RequestID, c.SourceDocID, c.FileIDs).Scan(&inserted)
		if errors.Is(e, pgx.ErrNoRows) {
			var source int64
			var oldIDs []int64
			var encoded []byte
			if e = tx.QueryRow(ctx, `SELECT source_doc_id,source_ids,mapping FROM clipboard_asset_copies WHERE user_id=$1 AND target_doc_id=$2 AND request_id=$3 FOR SHARE`, g.UserID, c.TargetDocID, c.RequestID).Scan(&source, &oldIDs, &encoded); e != nil {
				return e
			}
			if source != c.SourceDocID || !sameClipboardIDs(oldIDs, c.FileIDs) || json.Unmarshal(encoded, &mapping) != nil || len(mapping) != len(c.FileIDs) {
				return ErrConflict
			}
			var targetIDs []int64
			for _, sourceID := range c.FileIDs {
				id := mapping[sourceID]
				if id <= 0 || id > maxClipboardSafeID {
					return ErrConflict
				}
				targetIDs = append(targetIDs, id)
			}
			rows, e = tx.Query(ctx, `SELECT id FROM attachments WHERE doc_id=$1 AND id=ANY($2) ORDER BY id FOR SHARE`, c.TargetDocID, targetIDs)
			if e != nil {
				return e
			}
			count := 0
			for rows.Next() {
				count++
			}
			e = rows.Err()
			rows.Close()
			if e != nil {
				return e
			}
			if count != len(targetIDs) {
				return ErrConflict
			}
		} else if e != nil {
			return e
		} else {
			mapping = make(map[int64]int64, len(c.FileIDs))
			for _, id := range c.FileIDs {
				if c.SourceDocID == c.TargetDocID {
					mapping[id] = id
					continue
				}
				var newID int64
				e = tx.QueryRow(ctx, `INSERT INTO attachments (doc_id,uploader_id,name,mime,size,object_key) SELECT $1,$2,name,mime,size,object_key FROM attachments WHERE id=$3 AND doc_id=$4 RETURNING id`, c.TargetDocID, g.UserID, id, c.SourceDocID).Scan(&newID)
				if errors.Is(e, pgx.ErrNoRows) {
					return ErrNotFound
				}
				if e != nil {
					return e
				}
				if newID > maxClipboardSafeID {
					return ErrConflict
				}
				mapping[id] = newID
			}
			encoded, e := json.Marshal(mapping)
			if e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `UPDATE clipboard_asset_copies SET mapping=$4 WHERE user_id=$1 AND target_doc_id=$2 AND request_id=$3`, g.UserID, c.TargetDocID, c.RequestID, encoded); e != nil {
				return e
			}
		}
		expires, e = drivePGSession(ctx, tx, g)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, g, expires)
	})
	if err != nil {
		return nil, err
	}
	return mapping, nil
}
