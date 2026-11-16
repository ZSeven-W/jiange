package store

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"sort"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
)

const (
	memoryBaseSnapshotMaxTables  = 512
	memoryBaseSnapshotMaxRecords = 100000
	memoryBaseSnapshotMaxBytes   = 64 << 20
)

type memorySnapshotPolicy struct {
	specs     []btquery.FieldSpec
	mandatory []btquery.Config
	hidden    map[int64]bool
}

// The caller holds m.mu. This is intentionally the same locked-view semantics
// as parseBasePolicy, and is needed before graph discovery so hidden columns do
// not make unrelated Bases consume the snapshot budget.
func (m *Memory) snapshotPolicyLocked(ctx context.Context, uid, baseID int64) (memorySnapshotPolicy, error) {
	p := memorySnapshotPolicy{hidden: map[int64]bool{}}
	doc := m.doc(baseID)
	if doc == nil || doc.deleted || doc.meta.Kind != "base" || RoleRank(m.roleLocked(uid, doc)) < RoleRank(RoleView) {
		return p, ErrNotFound
	}
	var fields []Field
	for _, field := range m.b.fields {
		if err := ctx.Err(); err != nil {
			return p, err
		}
		if field.BaseID == baseID {
			fields = append(fields, field)
		}
	}
	sort.SliceStable(fields, func(i, j int) bool { return fields[i].Position < fields[j].Position })
	p.specs = Specs(fields)
	if m.roleLocked(uid, doc) == RoleManage {
		return p, nil
	}
	var views []View
	for _, view := range m.b.views {
		if err := ctx.Err(); err != nil {
			return p, err
		}
		if view.BaseID == baseID {
			views = append(views, view)
		}
	}
	sort.SliceStable(views, func(i, j int) bool { return views[i].Pos < views[j].Pos })
	for _, view := range views {
		var cfg btquery.Config
		if len(view.Config) > 0 && !bytes.Equal(view.Config, []byte("null")) {
			if err := json.Unmarshal(view.Config, &cfg); err != nil {
				return p, fmt.Errorf("invalid stored view %d: %w", view.ID, err)
			}
		}
		if !cfg.Locked {
			continue
		}
		if err := btquery.ValidateLocked(p.specs, cfg); err != nil {
			return p, err
		}
		p.mandatory = append(p.mandatory, cfg)
		for _, fieldID := range cfg.Hidden {
			p.hidden[fieldID] = true
		}
	}
	return p, nil
}

// WithBaseReadSnapshot copies the source and directly related, readable Bases
// under the same lock as their writes. The callback reads only a private copy,
// so it does not hold the live store's lock while evaluating views or links.
func (m *Memory) WithBaseReadSnapshot(ctx context.Context, uid, baseID int64, fn func(BaseSnapshotReader) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.mu.Lock()
	copy, mandatory, err := m.cloneBaseSnapshotLocked(ctx, uid, baseID)
	m.mu.Unlock()
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := fn(&memoryBaseSnapshotReader{Memory: copy, sourceID: baseID, mandatory: mandatory}); err != nil {
		return err
	}
	return ctx.Err()
}

// cloneBaseSnapshotLocked must be called with m.mu held. Only the caller's
// effective roles and data from the source's immediate link graph are copied.
// Raw authorization tokens, passwords, document bodies and files are omitted.
func (m *Memory) cloneBaseSnapshotLocked(ctx context.Context, uid, baseID int64) (*Memory, []btquery.Config, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	source := m.doc(baseID)
	if source == nil || source.deleted || source.meta.Kind != "base" || RoleRank(m.roleLocked(uid, source)) < RoleRank(RoleView) {
		return nil, nil, ErrNotFound
	}
	if err := snapshotRecordOrder(ctx, m.b.records); err != nil {
		return nil, nil, err
	}
	used := 0
	spend := func(n int) error {
		if n < 0 || n > memoryBaseSnapshotMaxBytes-used {
			return ErrBaseSnapshotTooLarge
		}
		used += n
		return nil
	}
	if err := spend(len(m.d.docs) * 8); err != nil {
		return nil, nil, err
	}

	// Discover only visible fields and readable Bases before counting the graph
	// budget. A hidden link or an inaccessible reverse source must not make an
	// otherwise small response fail with a 413.
	sourcePolicy, err := m.snapshotPolicyLocked(ctx, uid, baseID)
	if err != nil {
		return nil, nil, err
	}
	policies := map[int64]memorySnapshotPolicy{baseID: sourcePolicy}
	allowed := map[int64]bool{baseID: true}
	policyFor := func(id int64) (memorySnapshotPolicy, bool, error) {
		if p, ok := policies[id]; ok {
			return p, true, nil
		}
		d := m.doc(id)
		if d == nil || d.deleted || d.meta.Kind != "base" || RoleRank(m.roleLocked(uid, d)) < RoleRank(RoleView) {
			return memorySnapshotPolicy{}, false, nil
		}
		p, err := m.snapshotPolicyLocked(ctx, uid, id)
		if err != nil {
			return p, false, err
		}
		policies[id] = p
		return p, true, nil
	}
	addAllowed := func(id int64) error {
		allowed[id] = true
		if len(allowed) > memoryBaseSnapshotMaxTables {
			return ErrBaseSnapshotTooLarge
		}
		return nil
	}
	targetText := strconv.FormatInt(baseID, 10)
	for _, f := range m.b.fields {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		if f.Type != "link" || len(f.Options) == 0 {
			continue
		}
		if f.BaseID == baseID && !sourcePolicy.hidden[f.ID] {
			if id, err := strconv.ParseInt(f.Options[0], 10, 64); err == nil && id > 0 {
				if _, ok, err := policyFor(id); err != nil {
					return nil, nil, err
				} else if ok {
					if err := addAllowed(id); err != nil {
						return nil, nil, err
					}
				}
			}
		}
		if f.Options[0] == targetText {
			p, ok, err := policyFor(f.BaseID)
			if err != nil {
				return nil, nil, err
			}
			if ok && !p.hidden[f.ID] {
				if err := addAllowed(f.BaseID); err != nil {
					return nil, nil, err
				}
			}
		}
	}

	if err := spend(len(m.users) * 80); err != nil {
		return nil, nil, err
	}
	snapshot := NewMemory()
	snapshot.users = make([]User, len(m.users))
	for i, u := range m.users {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		// WorkspaceMembers is only requested for the source workspace. Avoid
		// copying unrelated users' names, emails, and all password hashes.
		if u.ID != uid && !slices.Contains(m.members[u.ID], source.meta.WorkspaceID) {
			continue
		}
		if err := spend(len(u.Name) + len(u.Email)); err != nil {
			return nil, nil, err
		}
		u.PasswordHash = ""
		snapshot.users[i] = u
	}
	neededWorkspaces := map[int64]bool{source.meta.WorkspaceID: true}
	for _, id := range m.members[uid] {
		neededWorkspaces[id] = true
	}
	for id := range allowed {
		neededWorkspaces[m.doc(id).meta.WorkspaceID] = true
	}
	if err := spend(len(m.workspaces) * 48); err != nil {
		return nil, nil, err
	}
	snapshot.workspaces = make([]Workspace, len(m.workspaces))
	for i, ws := range m.workspaces {
		if !neededWorkspaces[ws.ID] {
			continue
		}
		if err := spend(len(ws.Name)); err != nil {
			return nil, nil, err
		}
		snapshot.workspaces[i] = ws
	}
	// Workspaces(uid) needs all of the caller's memberships; the only member
	// directory read by this snapshot belongs to the source workspace.
	for user, workspaces := range m.members {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		if user == uid {
			if err := spend(16 + len(workspaces)*8); err != nil {
				return nil, nil, err
			}
			snapshot.members[user] = slices.Clone(workspaces)
		} else if slices.Contains(workspaces, source.meta.WorkspaceID) {
			if err := spend(24); err != nil {
				return nil, nil, err
			}
			snapshot.members[user] = []int64{source.meta.WorkspaceID}
		}
	}
	snapshot.d.docs = make([]*memDoc, len(m.d.docs))
	snapshot.sh.shares = map[int64]map[int64]string{}
	snapshot.sh.joins = map[int64]map[int64]bool{}
	snapshot.sh.links = map[int64]Link{}
	// roleLocked follows the parent chain; copy each required ancestor and
	// only this caller's shares/link-join facts, not other users' grants.
	for id := range allowed {
		seen := map[int64]bool{}
		for d := m.doc(id); d != nil && !seen[d.meta.ID]; {
			if err := ctx.Err(); err != nil {
				return nil, nil, err
			}
			seen[d.meta.ID] = true
			if snapshot.d.docs[d.meta.ID-1] == nil {
				meta := d.meta
				if meta.ParentID != nil {
					p := *meta.ParentID
					meta.ParentID = &p
				}
				if err := spend(128 + len(meta.Title) + len(meta.Icon) + len(meta.CreatorName) + len(meta.WorkspaceName)); err != nil {
					return nil, nil, err
				}
				snapshot.d.docs[d.meta.ID-1] = &memDoc{meta: meta, deleted: d.deleted}
				if role := m.sh.shares[d.meta.ID][uid]; role != "" {
					snapshot.sh.shares[d.meta.ID] = map[int64]string{uid: role}
				}
				if m.sh.joins[d.meta.ID][uid] {
					snapshot.sh.joins[d.meta.ID] = map[int64]bool{uid: true}
					snapshot.sh.links[d.meta.ID] = Link{Role: m.sh.links[d.meta.ID].Role}
				}
			}
			if d.meta.ParentID == nil {
				break
			}
			d = m.doc(*d.meta.ParentID)
		}
	}
	fieldIDs := map[int64]bool{}
	personFields := map[int64][]int64{}
	createdByVisible := map[int64]bool{}
	neededCellFields := map[int64]map[string]bool{}
	for id, p := range policies {
		if !allowed[id] {
			continue
		}
		neededCellFields[id] = map[string]bool{}
		for _, cfg := range p.mandatory {
			if cfg.Filters == nil {
				continue
			}
			for _, rule := range cfg.Filters.Rules {
				neededCellFields[id][strconv.FormatInt(rule.F, 10)] = true
			}
		}
	}
	for _, f := range m.b.fields {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		if !allowed[f.BaseID] {
			continue
		}
		bytes := 96 + len(f.Name) + len(f.Type) + len(f.Description) + len(f.Formula) + len(f.OptionColors)*8
		for _, option := range f.Options {
			bytes += len(option) + 16
		}
		if err := spend(bytes); err != nil {
			return nil, nil, err
		}
		f.Options, f.OptionColors = slices.Clone(f.Options), slices.Clone(f.OptionColors)
		snapshot.b.fields = append(snapshot.b.fields, f)
		fieldIDs[f.ID] = true
		if !policies[f.BaseID].hidden[f.ID] {
			neededCellFields[f.BaseID][strconv.FormatInt(f.ID, 10)] = true
			if f.Type == "person" {
				personFields[f.BaseID] = append(personFields[f.BaseID], f.ID)
			}
			if f.Type == "created_by" {
				createdByVisible[f.BaseID] = true
			}
		}
	}
	for _, v := range m.b.views {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		if !allowed[v.BaseID] {
			continue
		}
		if err := spend(80 + len(v.Type) + len(v.Name) + len(v.Config)); err != nil {
			return nil, nil, err
		}
		v.Config = slices.Clone(v.Config)
		snapshot.b.views = append(snapshot.b.views, v)
	}
	// Match the same locked policy used by the API before selecting the first
	// page. Cloning all records in every related Base would make a small source
	// fail merely because an unrelated target is large.
	mandatory := policies[baseID].mandatory
	var sourceRows []int
	for i := range m.b.records {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		if m.b.records[i].BaseID == baseID {
			if err := spend(8); err != nil {
				return nil, nil, err
			}
			sourceRows = append(sourceRows, i)
		}
	}
	sort.SliceStable(sourceRows, func(i, j int) bool { return m.b.records[sourceRows[i]].Position < m.b.records[sourceRows[j]].Position })
	selected := map[int64]bool{}
	specs := policies[baseID].specs
	for _, index := range sourceRows {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		record := m.b.records[index]
		visible := true
		for _, cfg := range mandatory {
			if !btquery.Match(specs, cfg, record.Cells) {
				visible = false
				break
			}
		}
		if visible {
			selected[record.ID] = true
		}
		if len(selected) == 10000 {
			break
		}
	}
	// Capture only outgoing target IDs and reverse source IDs actually used by
	// that page. This preserves references beyond a target's first 10k rows.
	outgoing, reverse := map[int64]int64{}, map[int64]int64{}
	for _, field := range snapshot.b.fields {
		if field.Type != "link" || len(field.Options) == 0 {
			continue
		}
		target, err := strconv.ParseInt(field.Options[0], 10, 64)
		if err != nil {
			continue
		}
		if field.BaseID == baseID && !policies[baseID].hidden[field.ID] && allowed[target] {
			outgoing[field.ID] = target
		}
		if target == baseID && !policies[field.BaseID].hidden[field.ID] {
			reverse[field.ID] = field.BaseID
		}
	}
	needed := map[int64]map[int64]bool{}
	neededCount := 0
	addNeeded := func(base, id int64) error {
		if needed[base][id] {
			return nil
		}
		i := snapshotRecordIndex(m.b.records, id)
		if i < 0 || m.b.records[i].BaseID != base {
			return nil
		}
		p := policies[base]
		for _, cfg := range p.mandatory {
			if !btquery.Match(p.specs, cfg, m.b.records[i].Cells) {
				return nil
			}
		}
		neededCount++
		if neededCount > memoryBaseSnapshotMaxRecords {
			return ErrBaseSnapshotTooLarge
		}
		if err := spend(40); err != nil {
			return err
		}
		if needed[base] == nil {
			needed[base] = map[int64]bool{}
		}
		needed[base][id] = true
		return nil
	}
	for key, values := range m.links {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		if target, ok := outgoing[key[0]]; ok && selected[key[1]] {
			for index, id := range values {
				if index%1024 == 0 {
					if err := ctx.Err(); err != nil {
						return nil, nil, err
					}
				}
				if err := addNeeded(target, id); err != nil {
					return nil, nil, err
				}
			}
		}
		if other, ok := reverse[key[0]]; ok && allowed[other] {
			for index, id := range values {
				if index%1024 == 0 {
					if err := ctx.Err(); err != nil {
						return nil, nil, err
					}
				}
				if selected[id] {
					if err := addNeeded(other, key[1]); err != nil {
						return nil, nil, err
					}
					break
				}
			}
		}
	}
	recordCount := 0
	recordIDs := map[int64]bool{}
	// Target workspaces do not get a full member directory in this snapshot.
	// Only names actually referenced by authorized rows are added.
	addReferencedMember := func(userID, workspaceID int64) error {
		if userID <= 0 || userID > int64(len(m.users)) || !slices.Contains(m.members[userID], workspaceID) {
			return nil
		}
		if snapshot.users[userID-1].ID == 0 {
			user := m.users[userID-1]
			if user.ID != userID {
				return nil
			}
			if err := spend(len(user.Name)); err != nil {
				return err
			}
			snapshot.users[userID-1] = User{ID: user.ID, Name: user.Name}
		}
		if !slices.Contains(snapshot.members[userID], workspaceID) {
			if err := spend(8); err != nil {
				return err
			}
			snapshot.members[userID] = append(snapshot.members[userID], workspaceID)
		}
		return nil
	}
	for _, record := range m.b.records {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		if !allowed[record.BaseID] || !(record.BaseID == baseID && selected[record.ID] || needed[record.BaseID][record.ID]) {
			continue
		}
		recordCount++
		recordIDs[record.ID] = true
		if recordCount > memoryBaseSnapshotMaxRecords {
			return nil, nil, ErrBaseSnapshotTooLarge
		}
		workspaceID := m.doc(record.BaseID).meta.WorkspaceID
		for _, fieldID := range personFields[record.BaseID] {
			for _, personID := range btquery.PersonCellIDs(record.Cells[strconv.FormatInt(fieldID, 10)]) {
				if err := addReferencedMember(personID, workspaceID); err != nil {
					return nil, nil, err
				}
			}
		}
		if createdByVisible[record.BaseID] && record.CreatorID != nil {
			if err := addReferencedMember(*record.CreatorID, workspaceID); err != nil {
				return nil, nil, err
			}
		}
		if err := spend(128); err != nil {
			return nil, nil, err
		}
		cells := make(map[string]json.RawMessage, min(len(record.Cells), len(neededCellFields[record.BaseID])))
		for key, value := range record.Cells {
			if !neededCellFields[record.BaseID][key] {
				continue
			}
			if err := spend(24 + len(key) + len(value)); err != nil {
				return nil, nil, err
			}
			cells[key] = slices.Clone(value)
		}
		record.Cells = cells
		if record.CreatorID != nil {
			v := *record.CreatorID
			record.CreatorID = &v
		}
		if record.CreatedAt != nil {
			v := *record.CreatedAt
			record.CreatedAt = &v
		}
		if record.UpdatedAt != nil {
			v := *record.UpdatedAt
			record.UpdatedAt = &v
		}
		snapshot.b.records = append(snapshot.b.records, record)
	}
	for key, values := range m.links {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		if !fieldIDs[key[0]] || !recordIDs[key[1]] {
			continue
		}
		var visible []int64
		for index, targetID := range values {
			if index%1024 == 0 {
				if err := ctx.Err(); err != nil {
					return nil, nil, err
				}
			}
			keep := false
			if target, ok := outgoing[key[0]]; ok && selected[key[1]] && needed[target][targetID] {
				keep = true
			}
			if other, ok := reverse[key[0]]; ok && needed[other][key[1]] && selected[targetID] {
				keep = true
			}
			if keep {
				if len(visible) >= memoryBaseSnapshotMaxRecords {
					return nil, nil, ErrBaseSnapshotTooLarge
				}
				if err := spend(8); err != nil {
					return nil, nil, err
				}
				visible = append(visible, targetID)
			}
		}
		if len(visible) == 0 {
			continue
		}
		if err := spend(24); err != nil {
			return nil, nil, err
		}
		snapshot.links[key] = visible
	}
	snapshot.b.events = make(map[int64][]BtEvent, len(allowed))
	for id := range allowed {
		if events := m.b.events[id]; len(events) > 0 {
			// Only BtHead is available through the reader. Do not copy event bodies.
			snapshot.b.events[id] = []BtEvent{{Seq: events[len(events)-1].Seq}}
		}
	}
	return snapshot, mandatory, nil
}

// Only the source's empty-config first page is materialized; related Bases are
// deliberately sparse and must be read through the exact-ID methods.
type memoryBaseSnapshotReader struct {
	*Memory
	sourceID  int64
	mandatory []btquery.Config
}

func (r *memoryBaseSnapshotReader) QueryRecordsConstrained(ctx context.Context, base int64, fields []Field, mandatory []btquery.Config, cfg btquery.Config, limit int) ([]Record, error) {
	if base != r.sourceID || !reflect.DeepEqual(mandatory, r.mandatory) || !reflect.DeepEqual(cfg, btquery.Config{}) || limit <= 0 || limit > 10000 {
		return nil, fmt.Errorf("unsupported sparse Base snapshot query")
	}
	return r.Memory.QueryRecordsConstrained(ctx, base, fields, mandatory, cfg, limit)
}

// RecordsConstrainedByIDs returns only the requested IDs satisfying the locked
// policy, preserving their input order and never exposing live mutable bytes.
func (m *Memory) RecordsConstrainedByIDs(ctx context.Context, base int64, ids []int64, fields []Field, mandatory []btquery.Config) ([]Record, error) {
	if len(ids) > memoryBaseSnapshotMaxRecords {
		return nil, ErrBaseSnapshotTooLarge
	}
	specs := Specs(fields)
	for _, cfg := range mandatory {
		if err := btquery.ValidateLocked(specs, cfg); err != nil {
			return nil, err
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := snapshotRecordOrder(ctx, m.b.records); err != nil {
		return nil, err
	}
	seen := make(map[int64]bool, len(ids))
	out := make([]Record, 0, len(ids))
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if id <= 0 || seen[id] {
			continue
		}
		seen[id] = true
		i := snapshotRecordIndex(m.b.records, id)
		if i < 0 || m.b.records[i].BaseID != base {
			continue
		}
		record := m.b.records[i]
		visible := true
		for _, cfg := range mandatory {
			if !btquery.Match(specs, cfg, record.Cells) {
				visible = false
				break
			}
		}
		if !visible {
			continue
		}
		cells := make(map[string]json.RawMessage, len(record.Cells))
		for key, value := range record.Cells {
			cells[key] = slices.Clone(value)
		}
		record.Cells = cells
		if record.CreatorID != nil {
			v := *record.CreatorID
			record.CreatorID = &v
		}
		if record.CreatedAt != nil {
			v := *record.CreatedAt
			record.CreatedAt = &v
		}
		if record.UpdatedAt != nil {
			v := *record.UpdatedAt
			record.UpdatedAt = &v
		}
		out = append(out, record)
	}
	return out, nil
}

// LinksToRecords returns reverse links to the exact targets, ordered by source
// ID for deterministic Memory results. The caller must authorize the source.
func (m *Memory) LinksToRecords(ctx context.Context, fieldID int64, targetIDs []int64) (map[int64][]int64, error) {
	if len(targetIDs) > memoryBaseSnapshotMaxRecords {
		return nil, ErrBaseSnapshotTooLarge
	}
	targets := make(map[int64]bool, len(targetIDs))
	for _, id := range targetIDs {
		if id > 0 {
			targets[id] = true
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[int64][]int64{}
	count := 0
	for key, values := range m.links {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if key[0] != fieldID {
			continue
		}
		seen := map[int64]bool{}
		for index, target := range values {
			if index%1024 == 0 {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
			}
			if !targets[target] || seen[target] {
				continue
			}
			seen[target] = true
			count++
			if count > memoryBaseSnapshotMaxRecords {
				return nil, ErrBaseSnapshotTooLarge
			}
			out[target] = append(out[target], key[1])
		}
	}
	for target := range out {
		slices.Sort(out[target])
	}
	return out, nil
}

// LinksForRecordsConstrained projects only edges whose target row is visible
// under the target Base's mandatory locked policies. Inaccessible edges do not
// consume the output budget or appear as raw IDs.
func (m *Memory) LinksForRecordsConstrained(ctx context.Context, fieldID int64, fromIDs []int64, targetBase int64, fields []Field, mandatory []btquery.Config) (map[int64][]int64, error) {
	if len(fromIDs) > memoryBaseSnapshotMaxRecords {
		return nil, ErrBaseSnapshotTooLarge
	}
	specs := Specs(fields)
	for _, cfg := range mandatory {
		if err := btquery.ValidateLocked(specs, cfg); err != nil {
			return nil, err
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := snapshotRecordOrder(ctx, m.b.records); err != nil {
		return nil, err
	}
	out := map[int64][]int64{}
	count := 0
	seenFrom := map[int64]bool{}
	for _, from := range fromIDs {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if from <= 0 || seenFrom[from] {
			continue
		}
		seenFrom[from] = true
		seenTo := map[int64]bool{}
		for index, to := range m.links[[2]int64{fieldID, from}] {
			if index%1024 == 0 {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
			}
			if seenTo[to] {
				continue
			}
			seenTo[to] = true
			i := snapshotRecordIndex(m.b.records, to)
			if i < 0 || m.b.records[i].BaseID != targetBase {
				continue
			}
			visible := true
			for _, cfg := range mandatory {
				if !btquery.Match(specs, cfg, m.b.records[i].Cells) {
					visible = false
					break
				}
			}
			if !visible {
				continue
			}
			count++
			if count > memoryBaseSnapshotMaxRecords {
				return nil, ErrBaseSnapshotTooLarge
			}
			out[from] = append(out[from], to)
		}
	}
	return out, nil
}

// LinksToRecordsConstrained is the inverse projection: only source rows
// satisfying their own Base policy are returned for the requested target IDs.
func (m *Memory) LinksToRecordsConstrained(ctx context.Context, fieldID int64, targetIDs []int64, sourceBase int64, fields []Field, mandatory []btquery.Config) (map[int64][]int64, error) {
	if len(targetIDs) > memoryBaseSnapshotMaxRecords {
		return nil, ErrBaseSnapshotTooLarge
	}
	specs := Specs(fields)
	for _, cfg := range mandatory {
		if err := btquery.ValidateLocked(specs, cfg); err != nil {
			return nil, err
		}
	}
	targets := make(map[int64]bool, len(targetIDs))
	for _, id := range targetIDs {
		if id > 0 {
			targets[id] = true
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := snapshotRecordOrder(ctx, m.b.records); err != nil {
		return nil, err
	}
	out := map[int64][]int64{}
	count := 0
	for key, values := range m.links {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if key[0] != fieldID {
			continue
		}
		i := snapshotRecordIndex(m.b.records, key[1])
		if i < 0 || m.b.records[i].BaseID != sourceBase {
			continue
		}
		visible := true
		for _, cfg := range mandatory {
			if !btquery.Match(specs, cfg, m.b.records[i].Cells) {
				visible = false
				break
			}
		}
		if !visible {
			continue
		}
		seen := map[int64]bool{}
		for index, target := range values {
			if index%1024 == 0 {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
			}
			if !targets[target] || seen[target] {
				continue
			}
			seen[target] = true
			count++
			if count > memoryBaseSnapshotMaxRecords {
				return nil, ErrBaseSnapshotTooLarge
			}
			out[target] = append(out[target], key[1])
		}
	}
	for target := range out {
		slices.Sort(out[target])
	}
	return out, nil
}

// VisibleMemberNames returns only the requested names within one workspace.
// Callers must derive IDs from already-authorized records.
func (m *Memory) VisibleMemberNames(ctx context.Context, workspaceID int64, ids []int64) (map[int64]string, error) {
	if len(ids) > memoryBaseSnapshotMaxRecords {
		return nil, ErrBaseSnapshotTooLarge
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[int64]string)
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if id <= 0 || id > int64(len(m.users)) || !slices.Contains(m.members[id], workspaceID) {
			continue
		}
		user := m.users[id-1]
		if user.ID == id {
			out[id] = user.Name
		}
	}
	return out, nil
}

// Memory allocates record IDs monotonically and only appends or deletes rows;
// position changes do not reorder the backing slice. Check that invariant so
// a corrupt/nonconforming store fails closed instead of silently omitting IDs.
func snapshotRecordOrder(ctx context.Context, records []Record) error {
	for i := 1; i < len(records); i++ {
		if i%1024 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		if records[i-1].ID >= records[i].ID {
			return fmt.Errorf("invalid Memory record ID order")
		}
	}
	return ctx.Err()
}

func snapshotRecordIndex(records []Record, id int64) int {
	i := sort.Search(len(records), func(i int) bool { return records[i].ID >= id })
	if i == len(records) || records[i].ID != id {
		return -1
	}
	return i
}
