package store

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// BaseCopy describes an atomic snapshot copy of a multi-table Base node.
type BaseCopy struct {
	SourceID, UserID, WorkspaceID int64
	ParentID                      *int64
	Personal                      *bool
	Title                         string
	Guard                         *RestoreGuard
	// Non-nil binds the copy to attachment file IDs verified by the caller.
	VerifiedFileIDs []int64
}

// SurveyCopy describes an atomic snapshot copy of a standalone Survey node.
type SurveyCopy struct {
	SourceID, UserID, WorkspaceID int64
	ParentID                      *int64
	Personal                      *bool
	Title                         string
	Guard                         *RestoreGuard
}

// BaseCopyStore clones multi-table Bases with PostgreSQL/Memory parity.
type BaseCopyStore interface {
	CopyBase(ctx context.Context, copy BaseCopy) (DocMeta, error)
}

// SurveyCopyStore clones standalone Surveys with PostgreSQL/Memory parity.
type SurveyCopyStore interface {
	CopySurvey(ctx context.Context, copy SurveyCopy) (DocMeta, error)
}

// CollectBaseAttachmentIDs extracts distinct attachment file IDs referenced by
// attachment-type fields across all records of a Base.
func CollectBaseAttachmentIDs(fields []Field, records []Record) []int64 {
	attachFields := map[string]bool{}
	for _, f := range fields {
		if f.Type == "attachment" {
			attachFields[strconv.FormatInt(f.ID, 10)] = true
		}
	}
	if len(attachFields) == 0 {
		return nil
	}
	seen := map[int64]bool{}
	var ids []int64
	for _, rec := range records {
		for fk, raw := range rec.Cells {
			if !attachFields[fk] || len(raw) == 0 {
				continue
			}
			var items []struct {
				ID int64 `json:"id"`
			}
			if json.Unmarshal(raw, &items) != nil {
				continue
			}
			for _, it := range items {
				if it.ID > 0 && !seen[it.ID] {
					seen[it.ID] = true
					ids = append(ids, it.ID)
				}
			}
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

func remapAttachmentCell(raw json.RawMessage, fileMap map[int64]int64) json.RawMessage {
	if len(raw) == 0 || len(fileMap) == 0 {
		return raw
	}
	var items []map[string]any
	if json.Unmarshal(raw, &items) != nil {
		return raw
	}
	changed := false
	for _, it := range items {
		if f, ok := it["id"].(float64); ok {
			oldID := int64(f)
			if newID, mapped := fileMap[oldID]; mapped {
				it["id"] = newID
				changed = true
			}
		}
	}
	if !changed {
		return raw
	}
	b, err := json.Marshal(items)
	if err != nil {
		return raw
	}
	return b
}

func viewConfigHasLocked(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var obj struct {
		Locked bool `json:"locked"`
	}
	return json.Unmarshal(raw, &obj) == nil && obj.Locked
}

func remapInt64SliceAny(v any, m map[int64]int64) any {
	arr, ok := v.([]any)
	if !ok {
		return v
	}
	out := make([]any, 0, len(arr))
	for _, item := range arr {
		if f, ok := item.(float64); ok {
			if nid, exists := m[int64(f)]; exists {
				out = append(out, nid)
			}
		}
	}
	return out
}

func remapRuleSliceAny(v any, m map[int64]int64) any {
	arr, ok := v.([]any)
	if !ok {
		return v
	}
	out := make([]any, 0, len(arr))
	for _, item := range arr {
		rm, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if f, ok := rm["f"].(float64); ok {
			if nid, exists := m[int64(f)]; exists {
				cp := make(map[string]any, len(rm))
				for k, val := range rm {
					cp[k] = val
				}
				cp["f"] = nid
				out = append(out, cp)
			}
		}
	}
	return out
}

// RemapBaseViewConfig rewrites field IDs inside bt_views.config JSON so copied
// views preserve filters, sorts, grouping, hidden columns, fills, and cards.
func RemapBaseViewConfig(raw json.RawMessage, fieldMap map[int64]int64) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`{}`)
	}
	var cfg map[string]any
	if json.Unmarshal(raw, &cfg) != nil || cfg == nil {
		return json.RawMessage(`{}`)
	}
	for _, key := range []string{"fields", "required", "hidden"} {
		if v, ok := cfg[key]; ok {
			cfg[key] = remapInt64SliceAny(v, fieldMap)
		}
	}
	for _, key := range []string{"group", "dateField", "startField", "endField"} {
		if v, ok := cfg[key]; ok {
			if f, ok := v.(float64); ok {
				if nid, exists := fieldMap[int64(f)]; exists {
					cfg[key] = nid
				} else {
					delete(cfg, key)
				}
			}
		}
	}
	if filters, ok := cfg["filters"].(map[string]any); ok {
		if rules, has := filters["rules"]; has {
			filters["rules"] = remapRuleSliceAny(rules, fieldMap)
		}
	}
	if sorts, ok := cfg["sorts"]; ok {
		cfg["sorts"] = remapRuleSliceAny(sorts, fieldMap)
	}
	if fills, ok := cfg["fills"]; ok {
		cfg["fills"] = remapRuleSliceAny(fills, fieldMap)
	}
	if card, ok := cfg["card"].(map[string]any); ok {
		if cf, has := card["fields"]; has {
			card["fields"] = remapInt64SliceAny(cf, fieldMap)
		}
		if cov, has := card["cover"]; has {
			if f, ok := cov.(float64); ok {
				if nid, exists := fieldMap[int64(f)]; exists {
					card["cover"] = nid
				} else {
					card["cover"] = nil
				}
			}
		}
	}
	b, err := json.Marshal(cfg)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}

func remapFieldOptionsForCopy(f Field, sourceBaseID, newBaseID int64, fieldMap map[int64]int64) []string {
	if f.Options == nil {
		return nil
	}
	out := append([]string(nil), f.Options...)
	switch f.Type {
	case "link":
		if len(out) > 0 && out[0] == strconv.FormatInt(sourceBaseID, 10) {
			out[0] = strconv.FormatInt(newBaseID, 10)
			if len(out) >= 2 {
				if oldCompanion, err := strconv.ParseInt(out[1], 10, 64); err == nil {
					if mapped, ok := fieldMap[oldCompanion]; ok {
						out[1] = strconv.FormatInt(mapped, 10)
					} else {
						out = out[:1]
					}
				}
			}
		} else if len(out) > 1 {
			// Drop reciprocal companion ID when linking to an external base so the
			// copy stays a clean one-way reference without mutating the external base.
			out = out[:1]
		}
	case "lookup":
		if len(out) >= 1 {
			if oldLink, err := strconv.ParseInt(out[0], 10, 64); err == nil {
				if mapped, ok := fieldMap[oldLink]; ok {
					out[0] = strconv.FormatInt(mapped, 10)
				}
			}
		}
		if len(out) >= 2 {
			if oldTargetField, err := strconv.ParseInt(out[1], 10, 64); err == nil {
				if mapped, ok := fieldMap[oldTargetField]; ok {
					out[1] = strconv.FormatInt(mapped, 10)
				}
			}
		}
	}
	return out
}

func orderFieldsPrimaryFirst(fields []Field) []Field {
	ordered := append([]Field(nil), fields...)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].TableID != ordered[j].TableID {
			return ordered[i].TableID < ordered[j].TableID
		}
		if ordered[i].IsPrimary != ordered[j].IsPrimary {
			return ordered[i].IsPrimary
		}
		if ordered[i].Position != ordered[j].Position {
			return ordered[i].Position < ordered[j].Position
		}
		return ordered[i].ID < ordered[j].ID
	})
	return ordered
}

func (m *Memory) CopyBase(ctx context.Context, c BaseCopy) (DocMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var expiry time.Time
	if c.Guard != nil {
		guard := c.Guard
		session, ok := m.sessions[string(guard.SessionHash)]
		if !ok || guard.UserID != c.UserID || session.userID != c.UserID || !guard.currentTime().Before(session.expires) {
			return DocMeta{}, ErrUnauthenticated
		}
		expiry = session.expires
	}
	source := m.doc(c.SourceID)
	if source == nil || source.deleted || source.purged {
		return DocMeta{}, ErrNotFound
	}
	if source.meta.Kind != "base" {
		return DocMeta{}, ErrConflict
	}
	sourceRole := m.roleLocked(c.UserID, source)
	if RoleRank(sourceRole) < RoleRank(RoleView) {
		return DocMeta{}, ErrNotFound
	}
	if !DocumentDownloadAllowed(source.meta, sourceRole) {
		return DocMeta{}, ErrCopyProtected
	}
	if sourceRole != RoleManage {
		for _, v := range m.b.views {
			if v.BaseID == c.SourceID && v.OwnerID == nil && viewConfigHasLocked(v.Config) {
				return DocMeta{}, ErrCopyProtected
			}
		}
	}
	if c.UserID < 1 || c.UserID > int64(len(m.users)) || !m.member(c.UserID, c.WorkspaceID) {
		return DocMeta{}, ErrForbidden
	}
	personal := source.personal
	if c.WorkspaceID != source.meta.WorkspaceID {
		personal = true
	}
	if c.Personal != nil {
		personal = *c.Personal
	}
	var parentID *int64
	if c.ParentID != nil {
		parent := m.doc(*c.ParentID)
		if parent == nil || parent.deleted || parent.meta.Kind == "file" || parent.meta.WikiSpaceID != nil || parent.meta.WorkspaceID != c.WorkspaceID {
			return DocMeta{}, ErrNotFound
		}
		if parent.meta.Kind == "folder" {
			if err := m.driveDestinationLocked(c.UserID, c.WorkspaceID, c.ParentID, RoleEdit); err != nil {
				return DocMeta{}, err
			}
		} else if RoleRank(m.roleLocked(c.UserID, parent)) < RoleRank(RoleView) {
			return DocMeta{}, ErrNotFound
		}
		personal = parent.personal
		id := *c.ParentID
		parentID = &id
	}
	if err := ctx.Err(); err != nil {
		return DocMeta{}, err
	}

	srcTables := m.baseTablesLocked(c.SourceID)
	srcFields := []Field{}
	for _, f := range m.b.fields {
		if f.BaseID == c.SourceID {
			srcFields = append(srcFields, f)
		}
	}
	srcRecords := []Record{}
	for _, r := range m.b.records {
		if r.BaseID == c.SourceID {
			srcRecords = append(srcRecords, r)
		}
	}
	actualAttachIDs := CollectBaseAttachmentIDs(srcFields, srcRecords)
	if c.VerifiedFileIDs != nil && !sameSlideImageIDs(c.VerifiedFileIDs, actualAttachIDs) {
		return DocMeta{}, ErrConflict
	}

	now := time.Now()
	newID := int64(len(m.d.docs) + 1)
	fileMap := make(map[int64]int64, len(actualAttachIDs))
	clonedFiles := make([]FileMeta, 0, len(actualAttachIDs))
	for _, oldFID := range actualAttachIDs {
		if oldFID < 1 || oldFID > int64(len(m.sh.files)) {
			return DocMeta{}, ErrNotFound
		}
		orig := m.sh.files[oldFID-1]
		if orig.DocID != c.SourceID {
			return DocMeta{}, ErrNotFound
		}
		orig.ID = int64(len(m.sh.files) + len(clonedFiles) + 1)
		orig.DocID, orig.UploaderID, orig.CreatedAt = newID, c.UserID, now
		fileMap[oldFID] = orig.ID
		clonedFiles = append(clonedFiles, orig)
	}
	if c.Guard != nil && !c.Guard.currentTime().Before(expiry) {
		return DocMeta{}, ErrUnauthenticated
	}

	d := &memDoc{
		meta: DocMeta{
			ID: newID, Kind: "base", WorkspaceID: c.WorkspaceID, ParentID: parentID,
			Title: c.Title, CreatorID: c.UserID, CreatorName: m.users[c.UserID-1].Name,
			CreatedAt: now, UpdatedAt: now,
			CopyMinRole: RoleView, DownloadMinRole: RoleView, CommentMinRole: RoleView,
			InheritParentACL: true,
		},
		driveRevision: 1,
		personal:      personal,
		ids:           map[[2]int64]bool{}, snaps: map[int64][]byte{}, versions: map[int64]memVersion{},
	}
	m.sh.files = append(m.sh.files, clonedFiles...)
	m.d.docs = append(m.d.docs, d)

	tableMap := make(map[int64]int64, len(srcTables))
	for _, tbl := range srcTables {
		nt := BaseTable{ID: m.id(), BaseID: newID, Name: tbl.Name, Position: tbl.Position, IsDefault: tbl.IsDefault}
		tableMap[tbl.ID] = nt.ID
		m.b.tables = append(m.b.tables, nt)
	}
	orderedFields := orderFieldsPrimaryFirst(srcFields)
	fieldMap := make(map[int64]int64, len(orderedFields))
	attachFieldKeys := map[string]bool{}
	newFieldIndices := make([]int, 0, len(orderedFields))
	for _, f := range orderedFields {
		nf := f
		nf.ID = m.id()
		nf.BaseID = newID
		if tid, ok := tableMap[f.TableID]; ok {
			nf.TableID = tid
		} else {
			nf.TableID = m.defaultTableIDLocked(newID)
		}
		if f.TargetTableID != nil {
			if mapped, ok := tableMap[*f.TargetTableID]; ok {
				v := mapped
				nf.TargetTableID = &v
			} else {
				v := *f.TargetTableID
				nf.TargetTableID = &v
			}
		}
		if f.Options != nil {
			nf.Options = append([]string(nil), f.Options...)
		}
		if f.OptionColors != nil {
			nf.OptionColors = append([]int(nil), f.OptionColors...)
		}
		if f.DefaultValue != nil {
			nf.DefaultValue = append(json.RawMessage(nil), f.DefaultValue...)
		}
		fieldMap[f.ID] = nf.ID
		if f.Type == "attachment" {
			attachFieldKeys[strconv.FormatInt(f.ID, 10)] = true
		}
		newFieldIndices = append(newFieldIndices, len(m.b.fields))
		m.b.fields = append(m.b.fields, nf)
	}
	// Second pass: remap link/lookup field options now that fieldMap is complete.
	for _, idx := range newFieldIndices {
		f := m.b.fields[idx]
		if f.Type == "link" || f.Type == "lookup" {
			m.b.fields[idx].Options = remapFieldOptionsForCopy(f, c.SourceID, newID, fieldMap)
		}
	}

	recordMap := make(map[int64]int64, len(srcRecords))
	for _, rec := range srcRecords {
		newCells := make(map[string]json.RawMessage, len(rec.Cells))
		for k, raw := range rec.Cells {
			oldFID, parseErr := strconv.ParseInt(k, 10, 64)
			if parseErr != nil {
				continue
			}
			newFID, ok := fieldMap[oldFID]
			if !ok {
				continue
			}
			val := append(json.RawMessage(nil), raw...)
			if attachFieldKeys[k] {
				val = remapAttachmentCell(val, fileMap)
			}
			newCells[strconv.FormatInt(newFID, 10)] = val
		}
		uid := c.UserID
		nr := Record{
			ID:        m.id(),
			BaseID:    newID,
			TableID:   tableMap[rec.TableID],
			Cells:     newCells,
			Position:  rec.Position,
			CreatorID: &uid,
			CreatedAt: &now,
			UpdatedAt: &now,
		}
		if nr.TableID == 0 {
			nr.TableID = m.defaultTableIDLocked(newID)
		}
		recordMap[rec.ID] = nr.ID
		m.b.records = append(m.b.records, nr)
	}

	// Copy bt_links for all link fields in this base.
	for _, f := range orderedFields {
		if f.Type != "link" {
			continue
		}
		newFID := fieldMap[f.ID]
		for _, rec := range srcRecords {
			targets, ok := m.links[[2]int64{f.ID, rec.ID}]
			if !ok || len(targets) == 0 {
				continue
			}
			newFrom := recordMap[rec.ID]
			mappedTargets := make([]int64, 0, len(targets))
			for _, to := range targets {
				if nt, inside := recordMap[to]; inside {
					mappedTargets = append(mappedTargets, nt)
				} else {
					mappedTargets = append(mappedTargets, to)
				}
			}
			m.links[[2]int64{newFID, newFrom}] = mappedTargets
		}
	}

	// Copy shared views (excluding personal views) with remapped field IDs.
	for _, v := range m.b.views {
		if v.BaseID != c.SourceID || v.OwnerID != nil {
			continue
		}
		nv := View{
			ID:      m.id(),
			BaseID:  newID,
			TableID: tableMap[v.TableID],
			Type:    v.Type,
			Name:    v.Name,
			Config:  RemapBaseViewConfig(v.Config, fieldMap),
			Pos:     v.Pos,
		}
		if nv.TableID == 0 {
			nv.TableID = m.defaultTableIDLocked(newID)
		}
		m.b.views = append(m.b.views, nv)
	}
	return d.meta, nil
}

func (p *Postgres) CopyBase(ctx context.Context, c BaseCopy) (meta DocMeta, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		srcWS, e := drivePGNodeWorkspace(ctx, tx, c.SourceID)
		if e != nil {
			return e
		}
		if srcWS <= c.WorkspaceID {
			if e = drivePGLockWorkspace(ctx, tx, srcWS); e != nil {
				return e
			}
			if c.WorkspaceID != srcWS {
				if e = drivePGLockWorkspace(ctx, tx, c.WorkspaceID); e != nil {
					return e
				}
			}
		} else {
			if e = drivePGLockWorkspace(ctx, tx, c.WorkspaceID); e != nil {
				return e
			}
			if e = drivePGLockWorkspace(ctx, tx, srcWS); e != nil {
				return e
			}
		}
		var expiry time.Time
		if c.Guard != nil {
			guard := c.Guard
			var sessionUser int64
			e = tx.QueryRow(ctx, `SELECT user_id, expires_at FROM sessions WHERE token_hash=$1 FOR SHARE`, guard.SessionHash).Scan(&sessionUser, &expiry)
			if errors.Is(e, pgx.ErrNoRows) || e == nil && (guard.UserID != c.UserID || sessionUser != c.UserID || !guard.currentTime().Before(expiry)) {
				return ErrUnauthenticated
			}
			if e != nil {
				return e
			}
		}
		sourceRole, protected, kind, e := lockCopySource(ctx, tx, c.SourceID, c.UserID)
		if e != nil {
			return e
		}
		if RoleRank(sourceRole) < RoleRank(RoleView) {
			return ErrNotFound
		}
		if kind != "base" {
			return ErrConflict
		}
		var downloadMinRole string
		var sourcePersonal bool
		var sourceWorkspace int64
		if e = tx.QueryRow(ctx, `SELECT download_min_role, personal, workspace_id FROM nodes WHERE id=$1`, c.SourceID).Scan(&downloadMinRole, &sourcePersonal, &sourceWorkspace); e != nil {
			return e
		}
		if !DocumentDownloadAllowed(DocMeta{Kind: kind, CopyProtected: protected, DownloadMinRole: downloadMinRole}, sourceRole) {
			return ErrCopyProtected
		}
		var member int64
		if e = tx.QueryRow(ctx, `SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, c.WorkspaceID, c.UserID).Scan(&member); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrForbidden
			}
			return e
		}
		personal := sourcePersonal
		if c.WorkspaceID != sourceWorkspace {
			personal = true
		}
		if c.Personal != nil {
			personal = *c.Personal
		}
		if c.ParentID != nil {
			var pws int64
			var pkind string
			var pwiki *int64
			var ppersonal bool
			if e = tx.QueryRow(ctx, `SELECT workspace_id, kind, wiki_space_id, personal FROM nodes WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, *c.ParentID).Scan(&pws, &pkind, &pwiki, &ppersonal); e != nil {
				if errors.Is(e, pgx.ErrNoRows) {
					return ErrNotFound
				}
				return e
			}
			if pws != c.WorkspaceID || pkind == "file" || pwiki != nil {
				return ErrNotFound
			}
			if pkind == "folder" {
				personal, e = drivePGDestination(ctx, tx, RestoreGuard{UserID: c.UserID}, c.WorkspaceID, c.ParentID, RoleEdit)
				if e != nil {
					return e
				}
			} else {
				personal = ppersonal
			}
		}

		// Load source shared views first so non-managers are blocked if any locked view exists.
		vRows, e := tx.Query(ctx, `SELECT id, base_id, table_id, type, name, config, pos FROM bt_views WHERE base_id=$1 AND owner_id IS NULL ORDER BY pos, id FOR SHARE`, c.SourceID)
		if e != nil {
			return e
		}
		var srcViews []View
		for vRows.Next() {
			var v View
			if e = vRows.Scan(&v.ID, &v.BaseID, &v.TableID, &v.Type, &v.Name, &v.Config, &v.Pos); e != nil {
				vRows.Close()
				return e
			}
			srcViews = append(srcViews, v)
		}
		if e = vRows.Err(); e != nil {
			vRows.Close()
			return e
		}
		vRows.Close()
		if sourceRole != RoleManage {
			for _, v := range srcViews {
				if viewConfigHasLocked(v.Config) {
					return ErrCopyProtected
				}
			}
		}

		// Load tables, fields, records, links under FOR SHARE.
		tRows, e := tx.Query(ctx, `SELECT id, base_id, name, position, is_default FROM bt_tables WHERE base_id=$1 ORDER BY position, id FOR SHARE`, c.SourceID)
		if e != nil {
			return e
		}
		var srcTables []BaseTable
		for tRows.Next() {
			var t BaseTable
			if e = tRows.Scan(&t.ID, &t.BaseID, &t.Name, &t.Position, &t.IsDefault); e != nil {
				tRows.Close()
				return e
			}
			srcTables = append(srcTables, t)
		}
		if e = tRows.Err(); e != nil {
			tRows.Close()
			return e
		}
		tRows.Close()

		fRows, e := tx.Query(ctx, `SELECT `+fieldCols+` FROM base_fields WHERE base_id=$1 ORDER BY position, id FOR SHARE`, c.SourceID)
		if e != nil {
			return e
		}
		var srcFields []Field
		for fRows.Next() {
			f, se := scanField(fRows)
			if se != nil {
				fRows.Close()
				return se
			}
			srcFields = append(srcFields, f)
		}
		if e = fRows.Err(); e != nil {
			fRows.Close()
			return e
		}
		fRows.Close()

		rRows, e := tx.Query(ctx, `SELECT `+recordCols+` FROM base_records WHERE base_id=$1 ORDER BY position, id FOR SHARE`, c.SourceID)
		if e != nil {
			return e
		}
		var srcRecords []Record
		for rRows.Next() {
			rec, se := scanRecord(rRows)
			if se != nil {
				rRows.Close()
				return se
			}
			srcRecords = append(srcRecords, rec)
		}
		if e = rRows.Err(); e != nil {
			rRows.Close()
			return e
		}
		rRows.Close()

		type rawLink struct {
			fieldID, fromRec, toRec int64
		}
		lRows, e := tx.Query(ctx, `SELECT field_id, from_record, to_record FROM bt_links WHERE base_id=$1 ORDER BY id FOR SHARE`, c.SourceID)
		if e != nil {
			return e
		}
		var srcLinks []rawLink
		for lRows.Next() {
			var l rawLink
			if e = lRows.Scan(&l.fieldID, &l.fromRec, &l.toRec); e != nil {
				lRows.Close()
				return e
			}
			srcLinks = append(srcLinks, l)
		}
		if e = lRows.Err(); e != nil {
			lRows.Close()
			return e
		}
		lRows.Close()

		actualAttachIDs := CollectBaseAttachmentIDs(srcFields, srcRecords)
		if c.VerifiedFileIDs != nil && !sameSlideImageIDs(c.VerifiedFileIDs, actualAttachIDs) {
			return ErrConflict
		}

		// Create destination Base node (trigger auto-creates its default bt_tables row).
		meta, e = scanDocWithPermissions(tx.QueryRow(ctx, `INSERT INTO nodes (workspace_id, parent_id, kind, sort_key, title, creator_id, drive_revision, personal)
			VALUES ($1,$2,'base','V',$3,$4,1,$5) RETURNING `+docCols+creatorName+`, copy_protected, copy_min_role, download_min_role, comment_min_role, permissions_revision`,
			c.WorkspaceID, c.ParentID, c.Title, c.UserID, personal))
		if e != nil {
			return e
		}

		// Clone referenced attachment rows (sharing immutable object keys).
		fileMap := make(map[int64]int64, len(actualAttachIDs))
		if len(actualAttachIDs) > 0 {
			aRows, ae := tx.Query(ctx, `SELECT id FROM attachments WHERE doc_id=$1 AND id=ANY($2) ORDER BY id FOR SHARE`, c.SourceID, actualAttachIDs)
			if ae != nil {
				return ae
			}
			locked := 0
			for aRows.Next() {
				var aid int64
				if ae = aRows.Scan(&aid); ae != nil {
					aRows.Close()
					return ae
				}
				locked++
			}
			ae = aRows.Err()
			aRows.Close()
			if ae != nil {
				return ae
			}
			if locked != len(actualAttachIDs) {
				return ErrNotFound
			}
			for _, oldFID := range actualAttachIDs {
				var newFID int64
				if e = tx.QueryRow(ctx, `INSERT INTO attachments (doc_id, uploader_id, name, mime, size, object_key)
					SELECT $1, $2, name, mime, size, object_key FROM attachments WHERE id=$3 AND doc_id=$4 RETURNING id`,
					meta.ID, c.UserID, oldFID, c.SourceID).Scan(&newFID); e != nil {
					return notFound(e)
				}
				fileMap[oldFID] = newFID
			}
		}

		// Clone bt_tables (reusing trigger-created default table row for source's default table).
		tableMap := make(map[int64]int64, len(srcTables))
		var defaultNewTableID int64
		for _, tbl := range srcTables {
			if tbl.IsDefault {
				if e = tx.QueryRow(ctx, `UPDATE bt_tables SET name=$2, position=$3 WHERE base_id=$1 AND is_default RETURNING id`,
					meta.ID, tbl.Name, tbl.Position).Scan(&defaultNewTableID); e != nil {
					return e
				}
				tableMap[tbl.ID] = defaultNewTableID
			} else {
				var ntid int64
				if e = tx.QueryRow(ctx, `INSERT INTO bt_tables (base_id, name, position, is_default) VALUES ($1,$2,$3,false) RETURNING id`,
					meta.ID, tbl.Name, tbl.Position).Scan(&ntid); e != nil {
					return e
				}
				tableMap[tbl.ID] = ntid
			}
		}
		if defaultNewTableID == 0 {
			if e = tx.QueryRow(ctx, `SELECT id FROM bt_tables WHERE base_id=$1 AND is_default LIMIT 1`, meta.ID).Scan(&defaultNewTableID); e != nil {
				return e
			}
		}

		// Clone base_fields with primary field inserted first per table.
		orderedFields := orderFieldsPrimaryFirst(srcFields)
		fieldMap := make(map[int64]int64, len(orderedFields))
		attachFieldKeys := map[string]bool{}
		for _, f := range orderedFields {
			tid := tableMap[f.TableID]
			if tid == 0 {
				tid = defaultNewTableID
			}
			var targetTID *int64
			if f.TargetTableID != nil {
				if mapped, ok := tableMap[*f.TargetTableID]; ok {
					v := mapped
					targetTID = &v
				} else {
					v := *f.TargetTableID
					targetTID = &v
				}
			}
			var nfid int64
			if e = tx.QueryRow(ctx, `INSERT INTO base_fields (base_id, table_id, name, type, options, option_colors, description, formula, position, is_primary, default_value, multiple, target_table_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
				meta.ID, tid, f.Name, f.Type, opts(f), colors(f), f.Description, f.Formula, f.Position, f.IsPrimary, defaultJSON(f), multipleFlag(f), targetTID,
			).Scan(&nfid); e != nil {
				return e
			}
			fieldMap[f.ID] = nfid
			if f.Type == "attachment" {
				attachFieldKeys[strconv.FormatInt(f.ID, 10)] = true
			}
		}
		// Second pass: update remapped link/lookup options.
		for _, f := range orderedFields {
			if f.Type != "link" && f.Type != "lookup" {
				continue
			}
			remapped := f
			remapped.Options = remapFieldOptionsForCopy(f, c.SourceID, meta.ID, fieldMap)
			if _, e = tx.Exec(ctx, `UPDATE base_fields SET options=$2 WHERE id=$1`, fieldMap[f.ID], opts(remapped)); e != nil {
				return e
			}
		}

		// Clone base_records with remapped field keys and attachment IDs.
		recordMap := make(map[int64]int64, len(srcRecords))
		for _, rec := range srcRecords {
			tid := tableMap[rec.TableID]
			if tid == 0 {
				tid = defaultNewTableID
			}
			newCells := make(map[string]json.RawMessage, len(rec.Cells))
			for k, raw := range rec.Cells {
				oldFID, parseErr := strconv.ParseInt(k, 10, 64)
				if parseErr != nil {
					continue
				}
				newFID, ok := fieldMap[oldFID]
				if !ok {
					continue
				}
				val := append(json.RawMessage(nil), raw...)
				if attachFieldKeys[k] {
					val = remapAttachmentCell(val, fileMap)
				}
				newCells[strconv.FormatInt(newFID, 10)] = val
			}
			var nrid int64
			if e = tx.QueryRow(ctx, `INSERT INTO base_records (base_id, table_id, cells, position, creator_id)
				VALUES ($1,$2,$3,$4,$5) RETURNING id`,
				meta.ID, tid, newCells, rec.Position, c.UserID,
			).Scan(&nrid); e != nil {
				return e
			}
			recordMap[rec.ID] = nrid
		}

		// Clone bt_links.
		for _, l := range srcLinks {
			nfid, okF := fieldMap[l.fieldID]
			nfrom, okFrom := recordMap[l.fromRec]
			if !okF || !okFrom {
				continue
			}
			nto := l.toRec
			if mapped, ok := recordMap[l.toRec]; ok {
				nto = mapped
			}
			if _, e = tx.Exec(ctx, `INSERT INTO bt_links (base_id, field_id, from_record, to_record) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
				meta.ID, nfid, nfrom, nto); e != nil {
				return e
			}
		}

		// Clone shared views.
		for _, v := range srcViews {
			tid := tableMap[v.TableID]
			if tid == 0 {
				tid = defaultNewTableID
			}
			cfg := RemapBaseViewConfig(v.Config, fieldMap)
			if _, e = tx.Exec(ctx, `INSERT INTO bt_views (base_id, table_id, type, name, config, pos) VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
				meta.ID, tid, v.Type, v.Name, string(cfg), v.Pos); e != nil {
				return e
			}
		}

		if c.Guard != nil && !c.Guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		return DocMeta{}, drivePGError(err)
	}
	return meta, nil
}

func (m *Memory) CopySurvey(ctx context.Context, c SurveyCopy) (DocMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var expiry time.Time
	if c.Guard != nil {
		guard := c.Guard
		session, ok := m.sessions[string(guard.SessionHash)]
		if !ok || guard.UserID != c.UserID || session.userID != c.UserID || !guard.currentTime().Before(session.expires) {
			return DocMeta{}, ErrUnauthenticated
		}
		expiry = session.expires
	}
	source := m.doc(c.SourceID)
	if source == nil || source.deleted || source.purged {
		return DocMeta{}, ErrNotFound
	}
	if source.meta.Kind != "survey" {
		return DocMeta{}, ErrConflict
	}
	sourceRole := m.roleLocked(c.UserID, source)
	if RoleRank(sourceRole) < RoleRank(RoleView) {
		return DocMeta{}, ErrNotFound
	}
	if !DocumentDownloadAllowed(source.meta, sourceRole) {
		return DocMeta{}, ErrCopyProtected
	}
	if c.UserID < 1 || c.UserID > int64(len(m.users)) || !m.member(c.UserID, c.WorkspaceID) {
		return DocMeta{}, ErrForbidden
	}
	personal := source.personal
	if c.WorkspaceID != source.meta.WorkspaceID {
		personal = true
	}
	if c.Personal != nil {
		personal = *c.Personal
	}
	var parentID *int64
	if c.ParentID != nil {
		parent := m.doc(*c.ParentID)
		if parent == nil || parent.deleted || parent.meta.Kind == "file" || parent.meta.WikiSpaceID != nil || parent.meta.WorkspaceID != c.WorkspaceID {
			return DocMeta{}, ErrNotFound
		}
		if parent.meta.Kind == "folder" {
			if err := m.driveDestinationLocked(c.UserID, c.WorkspaceID, c.ParentID, RoleEdit); err != nil {
				return DocMeta{}, err
			}
		} else if RoleRank(m.roleLocked(c.UserID, parent)) < RoleRank(RoleView) {
			return DocMeta{}, ErrNotFound
		}
		personal = parent.personal
		id := *c.ParentID
		parentID = &id
	}
	if err := ctx.Err(); err != nil {
		return DocMeta{}, err
	}
	m.initSurveyLocked(c.SourceID)
	srcSurvey := cloneSurvey(m.surveys[c.SourceID])
	if c.Guard != nil && !c.Guard.currentTime().Before(expiry) {
		return DocMeta{}, ErrUnauthenticated
	}
	now := time.Now()
	newID := int64(len(m.d.docs) + 1)
	d := &memDoc{
		meta: DocMeta{
			ID: newID, Kind: "survey", WorkspaceID: c.WorkspaceID, ParentID: parentID,
			Title: c.Title, CreatorID: c.UserID, CreatorName: m.users[c.UserID-1].Name,
			CreatedAt: now, UpdatedAt: now,
			CopyMinRole: RoleView, DownloadMinRole: RoleView, CommentMinRole: RoleView,
			InheritParentACL: true,
		},
		driveRevision: 1,
		personal:      personal,
		ids:           map[[2]int64]bool{}, snaps: map[int64][]byte{}, versions: map[int64]memVersion{},
	}
	m.d.docs = append(m.d.docs, d)
	m.surveys[newID] = Survey{
		NodeID:         newID,
		Description:    srcSurvey.Description,
		Status:         "draft",
		PublicToken:    newSurveyToken(),
		AllowAnonymous: srcSurvey.AllowAnonymous,
		MaxResponses:   srcSurvey.MaxResponses,
		Questions:      srcSurvey.Questions,
		Revision:       1,
		UpdatedAt:      now,
	}
	return d.meta, nil
}

func (p *Postgres) CopySurvey(ctx context.Context, c SurveyCopy) (meta DocMeta, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		srcWS, e := drivePGNodeWorkspace(ctx, tx, c.SourceID)
		if e != nil {
			return e
		}
		if srcWS <= c.WorkspaceID {
			if e = drivePGLockWorkspace(ctx, tx, srcWS); e != nil {
				return e
			}
			if c.WorkspaceID != srcWS {
				if e = drivePGLockWorkspace(ctx, tx, c.WorkspaceID); e != nil {
					return e
				}
			}
		} else {
			if e = drivePGLockWorkspace(ctx, tx, c.WorkspaceID); e != nil {
				return e
			}
			if e = drivePGLockWorkspace(ctx, tx, srcWS); e != nil {
				return e
			}
		}
		var expiry time.Time
		if c.Guard != nil {
			guard := c.Guard
			var sessionUser int64
			e = tx.QueryRow(ctx, `SELECT user_id, expires_at FROM sessions WHERE token_hash=$1 FOR SHARE`, guard.SessionHash).Scan(&sessionUser, &expiry)
			if errors.Is(e, pgx.ErrNoRows) || e == nil && (guard.UserID != c.UserID || sessionUser != c.UserID || !guard.currentTime().Before(expiry)) {
				return ErrUnauthenticated
			}
			if e != nil {
				return e
			}
		}
		sourceRole, protected, kind, e := lockCopySource(ctx, tx, c.SourceID, c.UserID)
		if e != nil {
			return e
		}
		if RoleRank(sourceRole) < RoleRank(RoleView) {
			return ErrNotFound
		}
		if kind != "survey" {
			return ErrConflict
		}
		var downloadMinRole string
		var sourcePersonal bool
		var sourceWorkspace int64
		if e = tx.QueryRow(ctx, `SELECT download_min_role, personal, workspace_id FROM nodes WHERE id=$1`, c.SourceID).Scan(&downloadMinRole, &sourcePersonal, &sourceWorkspace); e != nil {
			return e
		}
		if !DocumentDownloadAllowed(DocMeta{Kind: kind, CopyProtected: protected, DownloadMinRole: downloadMinRole}, sourceRole) {
			return ErrCopyProtected
		}
		var member int64
		if e = tx.QueryRow(ctx, `SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, c.WorkspaceID, c.UserID).Scan(&member); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrForbidden
			}
			return e
		}
		personal := sourcePersonal
		if c.WorkspaceID != sourceWorkspace {
			personal = true
		}
		if c.Personal != nil {
			personal = *c.Personal
		}
		if c.ParentID != nil {
			var pws int64
			var pkind string
			var pwiki *int64
			var ppersonal bool
			if e = tx.QueryRow(ctx, `SELECT workspace_id, kind, wiki_space_id, personal FROM nodes WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, *c.ParentID).Scan(&pws, &pkind, &pwiki, &ppersonal); e != nil {
				if errors.Is(e, pgx.ErrNoRows) {
					return ErrNotFound
				}
				return e
			}
			if pws != c.WorkspaceID || pkind == "file" || pwiki != nil {
				return ErrNotFound
			}
			if pkind == "folder" {
				personal, e = drivePGDestination(ctx, tx, RestoreGuard{UserID: c.UserID}, c.WorkspaceID, c.ParentID, RoleEdit)
				if e != nil {
					return e
				}
			} else {
				personal = ppersonal
			}
		}

		var desc string
		var allowAnon bool
		var maxResp int
		var questionsRaw []byte
		e = tx.QueryRow(ctx, `SELECT description, allow_anonymous, max_responses, questions FROM surveys WHERE node_id=$1 FOR SHARE`, c.SourceID).Scan(&desc, &allowAnon, &maxResp, &questionsRaw)
		if errors.Is(e, pgx.ErrNoRows) {
			desc = "感谢参与本次问卷调研，您的反馈对我们非常重要。"
			allowAnon = true
			maxResp = 0
			questionsRaw, _ = json.Marshal(defaultSurveyQuestions())
		} else if e != nil {
			return e
		}
		meta, e = scanDocWithPermissions(tx.QueryRow(ctx, `INSERT INTO nodes (workspace_id, parent_id, kind, sort_key, title, creator_id, drive_revision, personal)
			VALUES ($1,$2,'survey','V',$3,$4,1,$5) RETURNING `+docCols+creatorName+`, copy_protected, copy_min_role, download_min_role, comment_min_role, permissions_revision`,
			c.WorkspaceID, c.ParentID, c.Title, c.UserID, personal))
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO surveys (node_id, description, status, public_token, allow_anonymous, max_responses, questions, revision)
			VALUES ($1, $2, 'draft', $3, $4, $5, $6::jsonb, 1)`,
			meta.ID, desc, newSurveyToken(), allowAnon, maxResp, string(questionsRaw)); e != nil {
			return e
		}
		if c.Guard != nil && !c.Guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		return DocMeta{}, drivePGError(err)
	}
	return meta, nil
}
