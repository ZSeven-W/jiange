package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"sort"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/btquery"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type rbacSubject struct {
	UserID   int64
	DeptIDs  map[int64]bool
	GroupIDs map[int64]bool
}

type rbacSubjectCtxKey struct{}

type rbacSubjectBinding struct {
	workspaceID int64
	subject     rbacSubject
}

func withRBACSubject(ctx context.Context, workspaceID int64, subj rbacSubject) context.Context {
	return context.WithValue(ctx, rbacSubjectCtxKey{}, rbacSubjectBinding{workspaceID: workspaceID, subject: subj})
}

func rbacSubjectFromContext(ctx context.Context, workspaceID, uid int64) (rbacSubject, bool) {
	if b, ok := ctx.Value(rbacSubjectCtxKey{}).(rbacSubjectBinding); ok && b.workspaceID == workspaceID && b.subject.UserID == uid {
		return b.subject, true
	}
	return rbacSubject{UserID: uid}, false
}

// resolveBaseSubject resolves a caller's workspace department IDs (including
// ancestor departments) and user group IDs via OrgStore. External collaborators
// or stores without org access gracefully fall back to userID-only matching.
func (s *Server) resolveBaseSubject(ctx context.Context, r *http.Request, uid, wsID int64) rbacSubject {
	subj := rbacSubject{UserID: uid}
	if r == nil || uid <= 0 || wsID <= 0 || s.Store == nil {
		return subj
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		return subj
	}
	guard := store.RestoreGuard{UserID: uid, SessionHash: auth.HashToken(cookie.Value), Now: s.now}
	snap, err := s.Store.GetWorkspaceOrg(ctx, guard, wsID)
	if err != nil {
		return subj
	}
	deptByID := make(map[int64]store.OrgDepartment, len(snap.Departments))
	for _, d := range snap.Departments {
		deptByID[d.ID] = d
	}
	var depts map[int64]bool
	for _, d := range snap.Departments {
		inDept := false
		for _, m := range d.Members {
			if m.UserID == uid {
				inDept = true
				break
			}
		}
		if !inDept {
			continue
		}
		if depts == nil {
			depts = map[int64]bool{}
		}
		cur := d
		visited := map[int64]bool{}
		for {
			if visited[cur.ID] {
				break
			}
			visited[cur.ID] = true
			depts[cur.ID] = true
			if cur.ParentID == nil {
				break
			}
			parent, ok := deptByID[*cur.ParentID]
			if !ok {
				break
			}
			cur = parent
		}
	}
	var groups map[int64]bool
	for _, g := range snap.Groups {
		for _, m := range g.Members {
			if m.UserID == uid {
				if groups == nil {
					groups = map[int64]bool{}
				}
				groups[g.ID] = true
				break
			}
		}
	}
	subj.DeptIDs = depts
	subj.GroupIDs = groups
	return subj
}

type viewRowScope struct {
	allowAll   bool
	allowOwn   bool
	rowFilters []btquery.Filters // OR'd together (and OR'd with allowOwn if allowOwn is true)
}

func (vs viewRowScope) matches(specs []btquery.FieldSpec, rec store.Record, uid int64) bool {
	if vs.allowAll {
		return true
	}
	if vs.allowOwn && rec.CreatorID != nil && *rec.CreatorID == uid {
		return true
	}
	for i := range vs.rowFilters {
		f := vs.rowFilters[i]
		if btquery.Match(specs, btquery.Config{Filters: &f}, rec.Cells) {
			return true
		}
	}
	return false
}

// EffectiveBasePermissions summarizes the server-enforced RBAC outcome for the
// caller so the frontend UI matches exact server truth.
type EffectiveBasePermissions struct {
	CanAddRecord     bool     `json:"canAddRecord"`
	CanDeleteRecord  bool     `json:"canDeleteRecord"`
	OnlyOwnRecords   bool     `json:"onlyOwnRecords"`
	ReadonlyFieldIDs []int64  `json:"readonlyFieldIds"`
	HiddenFieldIDs   []int64  `json:"hiddenFieldIds"`
	MatchedRoles     []string `json:"matchedRoles"`
}

// baseReadPolicy represents the effective server-enforced data & RBAC policy
// for a non-manager across shared views. Multiple views intersect conservatively
// except hiddenViews which is per-view.
type baseReadPolicy struct {
	mandatory        []btquery.Config
	hidden           map[int64]bool
	readonly         map[int64]bool
	onlyOwnRecords   bool
	canAddRecord     bool
	canDeleteRecord  bool
	hiddenViews      map[int64]bool
	roleRowFilters   []btquery.Filters
	viewRowScopes    []viewRowScope
	matchedRoleNames []string
	specs            []btquery.FieldSpec
}

func (p baseReadPolicy) allowsRecord(rec store.Record, uid int64) bool {
	if p.onlyOwnRecords && (rec.CreatorID == nil || *rec.CreatorID != uid) {
		return false
	}
	for _, scope := range p.viewRowScopes {
		if !scope.matches(p.specs, rec, uid) {
			return false
		}
	}
	return true
}

func (p baseReadPolicy) effective() EffectiveBasePermissions {
	ro := make([]int64, 0, len(p.readonly))
	for fid := range p.readonly {
		if !p.hidden[fid] {
			ro = append(ro, fid)
		}
	}
	sort.Slice(ro, func(i, j int) bool { return ro[i] < ro[j] })
	hid := make([]int64, 0, len(p.hidden))
	for fid := range p.hidden {
		hid = append(hid, fid)
	}
	sort.Slice(hid, func(i, j int) bool { return hid[i] < hid[j] })
	roles := make([]string, len(p.matchedRoleNames))
	copy(roles, p.matchedRoleNames)
	return EffectiveBasePermissions{
		CanAddRecord:     p.canAddRecord,
		CanDeleteRecord:  p.canDeleteRecord,
		OnlyOwnRecords:   p.onlyOwnRecords,
		ReadonlyFieldIDs: ro,
		HiddenFieldIDs:   hid,
		MatchedRoles:     roles,
	}
}

func fieldSpecsWithPrimary(fields []store.Field) []btquery.FieldSpec {
	out := make([]btquery.FieldSpec, len(fields))
	for i, f := range fields {
		out[i] = btquery.FieldSpec{ID: f.ID, Type: f.Type, Options: f.Options, IsPrimary: f.IsPrimary}
	}
	return out
}

func roleMatchesSubject(role btquery.PermissionRole, subj rbacSubject) bool {
	if subj.UserID > 0 {
		for _, id := range role.UserIDs {
			if id == subj.UserID {
				return true
			}
		}
	}
	if len(subj.DeptIDs) > 0 {
		for _, id := range role.DeptIDs {
			if subj.DeptIDs[id] {
				return true
			}
		}
	}
	if len(subj.GroupIDs) > 0 {
		for _, id := range role.GroupIDs {
			if subj.GroupIDs[id] {
				return true
			}
		}
	}
	return false
}

func fieldModeRank(mode string) int {
	switch mode {
	case "hidden":
		return 0
	case "readonly":
		return 1
	default: // "" or "edit"
		return 2
	}
}

func parseBasePolicy(b store.DocMeta, fields []store.Field, views []store.View) (baseReadPolicy, error) {
	return parseBasePolicyForSubject(b, fields, views, rbacSubject{})
}

func parseBasePolicyForSubject(b store.DocMeta, fields []store.Field, views []store.View, subj rbacSubject) (baseReadPolicy, error) {
	p := baseReadPolicy{
		hidden:          map[int64]bool{},
		readonly:        map[int64]bool{},
		canAddRecord:    true,
		canDeleteRecord: true,
		hiddenViews:     map[int64]bool{},
		specs:           fieldSpecsWithPrimary(fields),
	}
	if b.Role == store.RoleManage {
		return p, nil
	}
	fieldExists := make(map[int64]bool, len(fields))
	for _, f := range fields {
		fieldExists[f.ID] = true
	}
	seenRoleName := map[string]bool{}
	for _, v := range views {
		if v.OwnerID != nil {
			continue
		}
		var cfg btquery.Config
		if len(v.Config) != 0 && !bytes.Equal(v.Config, []byte("null")) {
			if err := json.Unmarshal(v.Config, &cfg); err != nil {
				return p, fmt.Errorf("invalid stored view %d: %w", v.ID, err)
			}
		}
		if cfg.Permissions != nil {
			var matched []btquery.PermissionRole
			for _, role := range cfg.Permissions.Roles {
				if roleMatchesSubject(role, subj) {
					matched = append(matched, role)
					if !seenRoleName[role.Name] {
						seenRoleName[role.Name] = true
						p.matchedRoleNames = append(p.matchedRoleNames, role.Name)
					}
				}
			}
			if len(matched) > 0 {
				// Case A: union permissions across matched custom roles on this view
				// (most permissive among the caller's matched roles on that view).
				viewCanAdd := false
				viewCanDelete := false
				viewHidden := true
				scope := viewRowScope{}
				for _, role := range matched {
					if role.CanAddRecord == nil || *role.CanAddRecord {
						viewCanAdd = true
					}
					if role.CanDeleteRecord == nil || *role.CanDeleteRecord {
						viewCanDelete = true
					}
					if !role.ViewHidden {
						viewHidden = false
					}
					switch role.RowScope {
					case "", "all":
						scope.allowAll = true
					case "own":
						scope.allowOwn = true
					case "filter":
						if role.RowFilters != nil && len(role.RowFilters.Rules) > 0 {
							scope.rowFilters = append(scope.rowFilters, *role.RowFilters)
						} else {
							scope.allowAll = true
						}
					}
				}
				if !viewCanAdd {
					p.canAddRecord = false
				}
				if !viewCanDelete {
					p.canDeleteRecord = false
				}
				if viewHidden {
					p.hiddenViews[v.ID] = true
				}
				if !scope.allowAll {
					p.viewRowScopes = append(p.viewRowScopes, scope)
					if len(scope.rowFilters) > 0 {
						p.roleRowFilters = append(p.roleRowFilters, scope.rowFilters...)
					}
					if scope.allowOwn && len(scope.rowFilters) == 0 {
						p.onlyOwnRecords = true
					}
				}
				for _, f := range fields {
					fKey := strconv.FormatInt(f.ID, 10)
					bestRank := 0 // hidden
					for _, role := range matched {
						if r := fieldModeRank(role.FieldModes[fKey]); r > bestRank {
							bestRank = r
						}
					}
					switch bestRank {
					case 0:
						p.hidden[f.ID] = true
					case 1:
						p.readonly[f.ID] = true
					}
				}
			} else {
				// Case B: caller matches 0 custom roles -> apply view's default rule.
				if cfg.Permissions.OnlyOwnRecords {
					p.onlyOwnRecords = true
					p.viewRowScopes = append(p.viewRowScopes, viewRowScope{allowOwn: true})
				}
				for fidStr, mode := range cfg.Permissions.FieldModes {
					fid, err := strconv.ParseInt(fidStr, 10, 64)
					if err != nil || fid <= 0 || !fieldExists[fid] {
						continue
					}
					switch mode {
					case "hidden":
						p.hidden[fid] = true
					case "readonly":
						p.readonly[fid] = true
					}
				}
			}
		}
		if !cfg.Locked {
			continue
		}
		if err := btquery.ValidateLocked(store.Specs(fields), cfg); err != nil {
			return p, fmt.Errorf("invalid locked view %d: %w", v.ID, err)
		}
		p.mandatory = append(p.mandatory, cfg)
		for _, id := range cfg.Hidden {
			p.hidden[id] = true
		}
	}
	return p, nil
}

// baseRestricted is used by channels which cannot yet safely project rows or
// fields. A corrupt view or storage error never becomes an unrestricted read.
func (s *Server) baseRestricted(ctx context.Context, b store.DocMeta) (bool, error) {
	if b.Role == store.RoleManage {
		return false, nil
	}
	views, err := s.Store.Views(ctx, b.ID)
	if err != nil {
		return true, err
	}
	fields, err := s.Store.Fields(ctx, b.ID)
	if err != nil {
		return true, err
	}
	p, err := parseBasePolicy(b, fields, views)
	if err != nil {
		return true, err
	}
	return len(p.mandatory) != 0, nil
}

func (s *Server) allowBaseWrite(w http.ResponseWriter, r *http.Request, b store.DocMeta) bool {
	restricted, err := s.baseRestricted(r.Context(), b)
	if err != nil {
		s.fail(w, r, err)
		return false
	}
	if restricted {
		httpx.Error(w, http.StatusForbidden, "restricted_view", "当前权限视图暂不支持此操作")
		return false
	}
	return true
}

func visibleBaseFields(fields []store.Field, p baseReadPolicy) []store.Field {
	out := make([]store.Field, 0, len(fields))
	for _, f := range fields {
		if !p.hidden[f.ID] {
			out = append(out, f)
		}
	}
	return out
}

func stripBaseRecords(recs []store.Record, fields []store.Field, p baseReadPolicy) []store.Record {
	allowed := make(map[int64]bool, len(fields))
	var hideCreator, hideCreatedAt, hideUpdatedAt bool
	for _, f := range fields {
		if !p.hidden[f.ID] {
			allowed[f.ID] = true
		} else {
			switch f.Type {
			case "created_by":
				hideCreator = true
			case "created_at":
				hideCreatedAt = true
			case "modified_at":
				hideUpdatedAt = true
			}
		}
	}
	out := make([]store.Record, 0, len(recs))
	for _, rec := range recs {
		cells := make(map[string]json.RawMessage, len(rec.Cells))
		for k, value := range rec.Cells {
			id, err := strconv.ParseInt(k, 10, 64)
			if err == nil && allowed[id] {
				cells[k] = value
			}
		}
		rec.Cells = cells
		if hideCreator {
			rec.CreatorID = nil
		}
		if hideCreatedAt {
			rec.CreatedAt = nil
		}
		if hideUpdatedAt {
			rec.UpdatedAt = nil
		}
		out = append(out, rec)
	}
	return out
}

type baseReadable struct {
	meta               store.DocMeta
	tables             []store.BaseTable
	tableID            int64
	allFields, fields  []store.Field
	views              []store.View
	policy             baseReadPolicy
	records            []store.Record
	memberIDs          []int64
	memberNames        map[int64]string
	subject            rbacSubject
	hasResolvedSubject bool
}

func (s *Server) readBaseAllowed(ctx context.Context, uid, id int64) (baseReadable, error) {
	return readBaseTableAllowedWith(ctx, s.Store, uid, id, 0)
}

func readBaseAllowedWith(ctx context.Context, reader store.BaseSnapshotReader, uid, id int64) (baseReadable, error) {
	return readBaseTableAllowedWith(ctx, reader, uid, id, 0)
}

func filterOwnRecords(recs []store.Record, p baseReadPolicy, uid int64) []store.Record {
	if !p.onlyOwnRecords && len(p.viewRowScopes) == 0 {
		return recs
	}
	out := make([]store.Record, 0, len(recs))
	for _, rec := range recs {
		if p.allowsRecord(rec, uid) {
			out = append(out, rec)
		}
	}
	return out
}

func cellsTouchFieldSet(cells map[string]json.RawMessage, blocked map[int64]bool) bool {
	if len(blocked) == 0 || len(cells) == 0 {
		return false
	}
	for k := range cells {
		fid, err := strconv.ParseInt(k, 10, 64)
		if err == nil && blocked[fid] {
			return true
		}
	}
	return false
}

// basePolicyForRequest evaluates the caller's RBAC policy for a given table
// (default table when tableID <= 0) using the caller's resolved org subjects.
func (s *Server) basePolicyForRequest(ctx context.Context, r *http.Request, b store.DocMeta, uid, tableID int64) (baseReadPolicy, []store.Field, error) {
	allFields, err := s.Store.Fields(ctx, b.ID)
	if err != nil {
		return baseReadPolicy{}, nil, err
	}
	allViews, err := s.Store.Views(ctx, b.ID)
	if err != nil {
		return baseReadPolicy{}, nil, err
	}
	effID := tableID
	if effID <= 0 {
		tables, err := s.Store.BaseTables(ctx, b.ID)
		if err != nil {
			return baseReadPolicy{}, nil, err
		}
		for _, tbl := range tables {
			if tbl.IsDefault {
				effID = tbl.ID
				break
			}
		}
		if effID == 0 && len(tables) > 0 {
			effID = tables[0].ID
		}
	}
	fields := filterFieldsByTable(allFields, effID)
	views := filterViewsByTable(allViews, effID)
	subj := rbacSubject{UserID: uid}
	if b.Role != store.RoleManage {
		subj = s.resolveBaseSubject(ctx, r, uid, b.WorkspaceID)
	}
	p, err := parseBasePolicyForSubject(b, fields, views, subj)
	return p, fields, err
}

// readProjectionPolicyForRequest obtains metadata + RBAC policy (including
// department/group subjects) to project a single written record.
func (s *Server) readProjectionPolicyForRequest(ctx context.Context, r *http.Request, userID, baseID int64) (baseReadable, error) {
	meta, err := s.Store.GetDoc(ctx, userID, baseID)
	if err != nil {
		return baseReadable{}, err
	}
	if meta.Kind != "base" || store.RoleRank(meta.Role) < store.RoleRank(store.RoleView) {
		return baseReadable{}, store.ErrNotFound
	}
	fields, err := s.Store.Fields(ctx, baseID)
	if err != nil {
		return baseReadable{}, err
	}
	views, err := s.Store.Views(ctx, baseID)
	if err != nil {
		return baseReadable{}, err
	}
	subj := rbacSubject{UserID: userID}
	hasSubj := false
	if meta.Role != store.RoleManage {
		subj = s.resolveBaseSubject(ctx, r, userID, meta.WorkspaceID)
		hasSubj = true
	}
	policy, err := parseBasePolicyForSubject(meta, fields, views, subj)
	if err != nil {
		return baseReadable{}, err
	}
	return baseReadable{
		meta:               meta,
		allFields:          fields,
		fields:             visibleBaseFields(fields, policy),
		views:              views,
		policy:             policy,
		subject:            subj,
		hasResolvedSubject: hasSubj,
	}, nil
}

// checkBaseRecordWritePolicy enforces fine-grained view permissions and RBAC
// for non-manage users (backward-compatible entry point for update/add callers).
func (s *Server) checkBaseRecordWritePolicy(
	w http.ResponseWriter,
	r *http.Request,
	b store.DocMeta,
	uid int64,
	defaultTableID int64,
	recordIDs []int64,
	cellMaps []map[string]json.RawMessage,
	expectedMaps []map[string]json.RawMessage,
) bool {
	op := "update"
	if len(recordIDs) == 0 {
		op = "add"
	}
	return s.checkBaseRecordOpPolicy(w, r, b, uid, op, defaultTableID, recordIDs, cellMaps, expectedMaps)
}

// checkBaseRecordOpPolicy enforces fine-grained view permissions and multi-role
// RBAC (canAddRecord, canDeleteRecord, rowScope/rowFilters, readonly/hidden fields).
func (s *Server) checkBaseRecordOpPolicy(
	w http.ResponseWriter,
	r *http.Request,
	b store.DocMeta,
	uid int64,
	op string,
	defaultTableID int64,
	recordIDs []int64,
	cellMaps []map[string]json.RawMessage,
	expectedMaps []map[string]json.RawMessage,
) bool {
	if b.Role == store.RoleManage {
		return true
	}
	ctx := r.Context()
	allViews, err := s.Store.Views(ctx, b.ID)
	if err != nil {
		s.fail(w, r, err)
		return false
	}
	hasPermissions := false
	for _, v := range allViews {
		if v.OwnerID != nil || len(v.Config) == 0 || bytes.Equal(v.Config, []byte("null")) {
			continue
		}
		var cfg btquery.Config
		if err := json.Unmarshal(v.Config, &cfg); err != nil {
			s.fail(w, r, fmt.Errorf("invalid stored view %d: %w", v.ID, err))
			return false
		}
		if cfg.Permissions != nil && (cfg.Permissions.OnlyOwnRecords || len(cfg.Permissions.FieldModes) > 0 || len(cfg.Permissions.Roles) > 0) {
			hasPermissions = true
			break
		}
	}
	if !hasPermissions {
		return true
	}
	allFields, err := s.Store.Fields(ctx, b.ID)
	if err != nil {
		s.fail(w, r, err)
		return false
	}
	subj := s.resolveBaseSubject(ctx, r, uid, b.WorkspaceID)
	resolvedDefault := defaultTableID
	defaultResolved := resolvedDefault > 0
	resolveTable := func(tid int64) (int64, error) {
		if tid > 0 {
			return tid, nil
		}
		if !defaultResolved {
			defaultResolved = true
			tables, err := s.Store.BaseTables(ctx, b.ID)
			if err != nil {
				return 0, err
			}
			for _, tbl := range tables {
				if tbl.IsDefault {
					resolvedDefault = tbl.ID
					break
				}
			}
			if resolvedDefault == 0 && len(tables) > 0 {
				resolvedDefault = tables[0].ID
			}
		}
		return resolvedDefault, nil
	}
	policies := map[int64]baseReadPolicy{}
	policyFor := func(tid int64) (baseReadPolicy, error) {
		effID, err := resolveTable(tid)
		if err != nil {
			return baseReadPolicy{}, err
		}
		if p, ok := policies[effID]; ok {
			return p, nil
		}
		p, err := parseBasePolicyForSubject(b, filterFieldsByTable(allFields, effID), filterViewsByTable(allViews, effID), subj)
		if err != nil {
			return baseReadPolicy{}, err
		}
		policies[effID] = p
		return p, nil
	}
	checkOpCapability := func(p baseReadPolicy) bool {
		if op == "add" && !p.canAddRecord {
			httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限不允许新增记录")
			return false
		}
		if op == "delete" && !p.canDeleteRecord {
			httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限不允许删除记录")
			return false
		}
		return true
	}
	checkCellsAndExpected := func(p baseReadPolicy, cells, expected map[string]json.RawMessage) bool {
		if cellsTouchFieldSet(cells, p.hidden) || cellsTouchFieldSet(cells, p.readonly) {
			httpx.Error(w, http.StatusForbidden, "forbidden", "该字段为只读或隐藏状态，无法修改")
			return false
		}
		if cellsTouchFieldSet(expected, p.hidden) {
			httpx.Error(w, http.StatusForbidden, "forbidden", "该字段已隐藏，无法访问")
			return false
		}
		return true
	}
	if len(recordIDs) > 0 {
		recs, err := s.Store.RecordsConstrainedByIDs(ctx, b.ID, recordIDs, allFields, nil)
		if err != nil {
			s.fail(w, r, err)
			return false
		}
		byID := make(map[int64]store.Record, len(recs))
		for _, rec := range recs {
			byID[rec.ID] = rec
		}
		for i, rid := range recordIDs {
			var cells, expected map[string]json.RawMessage
			if i < len(cellMaps) {
				cells = cellMaps[i]
			}
			if i < len(expectedMaps) {
				expected = expectedMaps[i]
			}
			if rec, ok := byID[rid]; ok {
				p, err := policyFor(rec.TableID)
				if err != nil {
					s.fail(w, r, err)
					return false
				}
				if !checkOpCapability(p) {
					return false
				}
				if !p.allowsRecord(rec, uid) {
					httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限仅允许修改或删除范围内的记录")
					return false
				}
				if !checkCellsAndExpected(p, cells, expected) {
					return false
				}
			} else {
				p, err := policyFor(0)
				if err != nil {
					s.fail(w, r, err)
					return false
				}
				if !checkOpCapability(p) {
					return false
				}
				if !checkCellsAndExpected(p, cells, expected) {
					return false
				}
			}
		}
		return true
	}
	p, err := policyFor(0)
	if err != nil {
		s.fail(w, r, err)
		return false
	}
	if !checkOpCapability(p) {
		return false
	}
	for i := 0; i < len(cellMaps) || i < len(expectedMaps); i++ {
		var cells, expected map[string]json.RawMessage
		if i < len(cellMaps) {
			cells = cellMaps[i]
		}
		if i < len(expectedMaps) {
			expected = expectedMaps[i]
		}
		if !checkCellsAndExpected(p, cells, expected) {
			return false
		}
	}
	return true
}

func readBaseTableAllowedWith(ctx context.Context, reader store.BaseSnapshotReader, uid, id, tableID int64) (baseReadable, error) {
	out, err := readBaseTablePolicyWith(ctx, reader, uid, id, tableID)
	if err != nil {
		return out, err
	}
	recs, err := reader.QueryRecordsConstrained(ctx, id, out.allFields, out.policy.mandatory, btquery.Config{}, 10000)
	if err != nil {
		return out, err
	}
	recs = filterOwnRecords(recs, out.policy, uid)
	out.records = stripBaseRecords(recs, out.allFields, out.policy)
	return out, nil
}

// readBasePolicyWith obtains the permissions/schema without loading an
// arbitrary prefix of another table. Associated records are fetched by ID.
func readBasePolicyWith(ctx context.Context, reader store.BaseSnapshotReader, uid, id int64) (baseReadable, error) {
	return readBaseTablePolicyWith(ctx, reader, uid, id, 0)
}

func readBaseTablePolicyWith(ctx context.Context, reader store.BaseSnapshotReader, uid, id, requestedTableID int64) (baseReadable, error) {
	var out baseReadable
	meta, err := reader.GetDoc(ctx, uid, id)
	if err != nil {
		return out, err
	}
	if meta.Kind != "base" || store.RoleRank(meta.Role) < store.RoleRank(store.RoleView) {
		return out, store.ErrNotFound
	}
	tables, err := reader.BaseTables(ctx, id)
	if err != nil {
		return out, err
	}
	var activeTableID int64
	if requestedTableID > 0 {
		found := false
		for _, tbl := range tables {
			if tbl.ID == requestedTableID {
				activeTableID = tbl.ID
				found = true
				break
			}
		}
		if !found {
			return out, store.ErrNotFound
		}
	} else {
		for _, tbl := range tables {
			if tbl.IsDefault {
				activeTableID = tbl.ID
				break
			}
		}
		if activeTableID == 0 && len(tables) > 0 {
			activeTableID = tables[0].ID
		}
	}
	allFields, err := reader.Fields(ctx, id)
	if err != nil {
		return out, err
	}
	allViews, err := reader.Views(ctx, id)
	if err != nil {
		return out, err
	}
	fields := filterFieldsByTable(allFields, activeTableID)
	views := filterViewsByTable(allViews, activeTableID)
	subj, hasSubj := rbacSubjectFromContext(ctx, meta.WorkspaceID, uid)
	policy, err := parseBasePolicyForSubject(meta, fields, views, subj)
	if err != nil {
		return out, err
	}
	return baseReadable{
		meta:               meta,
		tables:             tables,
		tableID:            activeTableID,
		allFields:          fields,
		fields:             visibleBaseFields(fields, policy),
		views:              views,
		policy:             policy,
		subject:            subj,
		hasResolvedSubject: hasSubj,
	}, nil
}

// Recheck the original session and the relevant permission configuration after
// reading. This narrows (but cannot eliminate) revocation-to-send races.
func (s *Server) recheckBaseRead(ctx context.Context, r *http.Request, snapshot baseReadable) error {
	u, ok := UserFrom(ctx)
	if !ok {
		return store.ErrForbidden
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		return store.ErrForbidden
	}
	current, err := s.Store.SessionUser(ctx, auth.HashToken(cookie.Value), s.now())
	if err != nil || current.ID != u.ID {
		return store.ErrForbidden
	}
	meta, err := s.Store.GetDoc(ctx, u.ID, snapshot.meta.ID)
	if err != nil {
		return err
	}
	if meta.Kind != "base" || meta.Role != snapshot.meta.Role || meta.WorkspaceID != snapshot.meta.WorkspaceID || meta.CopyProtected != snapshot.meta.CopyProtected || !reflect.DeepEqual(meta.ParentID, snapshot.meta.ParentID) {
		return store.ErrConflict
	}
	if snapshot.hasResolvedSubject && meta.Role != store.RoleManage {
		currentSubj := s.resolveBaseSubject(ctx, r, u.ID, meta.WorkspaceID)
		if !reflect.DeepEqual(currentSubj, snapshot.subject) {
			return store.ErrConflict
		}
	}
	allFields, err := s.Store.Fields(ctx, meta.ID)
	if err != nil {
		return err
	}
	allViews, err := s.Store.Views(ctx, meta.ID)
	if err != nil {
		return err
	}
	fields := filterFieldsByTable(allFields, snapshot.tableID)
	views := filterViewsByTable(allViews, snapshot.tableID)
	if !reflect.DeepEqual(fields, snapshot.allFields) || !reflect.DeepEqual(views, snapshot.views) {
		return store.ErrConflict
	}
	if len(snapshot.memberIDs) > 0 {
		names, err := s.Store.VisibleMemberNames(ctx, snapshot.meta.WorkspaceID, snapshot.memberIDs)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(names, snapshot.memberNames) {
			return store.ErrConflict
		}
	}
	return nil
}

// A record may stop satisfying a locked-view predicate without changing the
// view configuration. Recheck every row whose content could be returned.
func (s *Server) recheckBaseRows(ctx context.Context, snapshot baseReadable) error {
	if len(snapshot.records) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(snapshot.records))
	seen := make(map[int64]bool, len(snapshot.records))
	for _, record := range snapshot.records {
		if !seen[record.ID] {
			seen[record.ID] = true
			ids = append(ids, record.ID)
		}
	}
	visible, err := s.Store.VisibleRecordIDs(ctx, snapshot.meta.ID, ids, snapshot.allFields, snapshot.policy.mandatory)
	if err != nil {
		return err
	}
	if len(visible) != len(ids) {
		return store.ErrConflict
	}
	return nil
}

func (s *Server) finishBaseRead(w http.ResponseWriter, r *http.Request, reads []baseReadable) bool {
	// A Base can be reached by multiple link/lookup fields. Merge its visible
	// IDs so current-access checks do not grow with the number of link fields.
	merged := make([]baseReadable, 0, len(reads))
	indexes := make(map[[2]int64]int, len(reads))
	seen := make(map[[2]int64]map[int64]bool, len(reads))
	seenMembers := make(map[[2]int64]map[int64]bool, len(reads))
	for _, read := range reads {
		key := [2]int64{read.meta.ID, read.tableID}
		idx, ok := indexes[key]
		if !ok {
			idx = len(merged)
			indexes[key] = idx
			seen[key] = map[int64]bool{}
			seenMembers[key] = map[int64]bool{}
			copy := read
			copy.records = nil
			copy.memberIDs = nil
			copy.memberNames = map[int64]string{}
			merged = append(merged, copy)
		} else {
			previous := merged[idx]
			if previous.meta.Role != read.meta.Role || previous.meta.WorkspaceID != read.meta.WorkspaceID || previous.meta.CopyProtected != read.meta.CopyProtected || !reflect.DeepEqual(previous.meta.ParentID, read.meta.ParentID) || !reflect.DeepEqual(previous.allFields, read.allFields) || !reflect.DeepEqual(previous.views, read.views) {
				httpx.Error(w, http.StatusConflict, "access_changed", "表格权限或字段已变化，请重试")
				return false
			}
		}
		for _, record := range read.records {
			if !seen[key][record.ID] {
				seen[key][record.ID] = true
				merged[idx].records = append(merged[idx].records, record)
			}
		}
		for _, id := range read.memberIDs {
			name, present := read.memberNames[id]
			if seenMembers[key][id] {
				oldName, oldPresent := merged[idx].memberNames[id]
				if oldPresent != present || (present && oldName != name) {
					httpx.Error(w, http.StatusConflict, "access_changed", "表格成员已变化，请重试")
					return false
				}
				continue
			}
			seenMembers[key][id] = true
			merged[idx].memberIDs = append(merged[idx].memberIDs, id)
			if present {
				merged[idx].memberNames[id] = name
			}
		}
	}
	for _, read := range merged {
		if err := s.recheckBaseRead(r.Context(), r, read); err != nil {
			if errors.Is(err, store.ErrForbidden) || errors.Is(err, store.ErrNotFound) {
				httpx.Error(w, http.StatusForbidden, "forbidden", "访问权限已变化")
				return false
			}
			if errors.Is(err, store.ErrConflict) {
				httpx.Error(w, http.StatusConflict, "access_changed", "表格权限或字段已变化，请重试")
				return false
			}
			s.fail(w, r, err)
			return false
		}
		if err := s.recheckBaseRows(r.Context(), read); err != nil {
			if errors.Is(err, store.ErrConflict) || errors.Is(err, store.ErrNotFound) {
				httpx.Error(w, http.StatusConflict, "access_changed", "表格记录权限已变化，请重试")
			} else {
				s.fail(w, r, err)
			}
			return false
		}
	}
	return true
}

// Editing a link also mutates the target's companion data. Check the target
// before making any source changes so a caller cannot write through a guessed
// base or record ID.
func (s *Server) allowLinkTarget(w http.ResponseWriter, r *http.Request, sourceID int64, field store.Field, raw json.RawMessage) bool {
	if field.Type != "link" {
		return true
	}
	if len(field.Options) == 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_link", "关联字段缺少目标表格")
		return false
	}
	targetID, err := strconv.ParseInt(field.Options[0], 10, 64)
	if err != nil || targetID <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_link", "关联目标无效")
		return false
	}
	u, _ := UserFrom(r.Context())
	target, err := s.Store.GetDoc(r.Context(), u.ID, targetID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, r, err)
		return false
	}
	if err != nil || target.Kind != "base" || store.RoleRank(target.Role) < store.RoleRank(store.RoleEdit) {
		httpx.Error(w, http.StatusForbidden, "forbidden", "没有目标表格的编辑权限")
		return false
	}
	if !s.allowBaseWrite(w, r, target) {
		return false
	}
	if field.TargetTableID != nil && *field.TargetTableID > 0 {
		tables, err := s.Store.BaseTables(r.Context(), targetID)
		if err != nil {
			s.fail(w, r, err)
			return false
		}
		validTable := false
		for _, tbl := range tables {
			if tbl.ID == *field.TargetTableID {
				validTable = true
				break
			}
		}
		if !validTable {
			httpx.Error(w, http.StatusBadRequest, "invalid_link", "关联的目标数据表不存在")
			return false
		}
	}
	if len(field.Options) > 1 {
		companionID, err := strconv.ParseInt(field.Options[1], 10, 64)
		if err != nil || companionID <= 0 {
			httpx.Error(w, http.StatusBadRequest, "invalid_link", "关联字段无效")
			return false
		}
		fields, err := s.Store.Fields(r.Context(), targetID)
		if err != nil {
			s.fail(w, r, err)
			return false
		}
		found := false
		for _, f := range fields {
			if f.ID == companionID && f.Type == "link" && len(f.Options) > 0 && f.Options[0] == strconv.FormatInt(sourceID, 10) {
				found = true
				break
			}
		}
		if !found {
			httpx.Error(w, http.StatusBadRequest, "invalid_link", "关联字段无效")
			return false
		}
	}
	if len(raw) > 0 && string(raw) != "null" {
		var ids []int64
		if json.Unmarshal(raw, &ids) != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_link", "关联记录无效")
			return false
		}
		rows, err := s.Store.Records(r.Context(), targetID)
		if err != nil {
			s.fail(w, r, err)
			return false
		}
		allowed := map[int64]bool{}
		for _, row := range rows {
			allowed[row.ID] = true
		}
		for _, id := range ids {
			if !allowed[id] {
				httpx.Error(w, http.StatusBadRequest, "invalid_link", "关联记录不属于目标表格")
				return false
			}
		}
	}
	return true
}

// A view config can itself contain filter values for a hidden field. Remove
// those rules from metadata returned to non-managers; the actual mandatory
// policy remains on the server and is never taken from this representation.
func visibleBaseViews(views []store.View, p baseReadPolicy, callerUserID int64) []store.View {
	filtered := make([]store.View, 0, len(views))
	for _, v := range views {
		if v.OwnerID != nil && *v.OwnerID != callerUserID {
			continue
		}
		if v.OwnerID == nil && p.hiddenViews[v.ID] {
			continue
		}
		filtered = append(filtered, v)
	}
	if len(p.hidden) == 0 {
		return filtered
	}
	out := make([]store.View, 0, len(filtered))
	for _, view := range filtered {
		var obj map[string]json.RawMessage
		if len(view.Config) == 0 || json.Unmarshal(view.Config, &obj) != nil || obj == nil {
			out = append(out, view)
			continue
		}
		if raw, ok := obj["filters"]; ok {
			var f btquery.Filters
			if json.Unmarshal(raw, &f) == nil {
				rules := make([]btquery.Rule, 0, len(f.Rules))
				for _, rule := range f.Rules {
					if !p.hidden[rule.F] {
						rules = append(rules, rule)
					}
				}
				f.Rules = rules
				obj["filters"], _ = json.Marshal(f)
			}
		}
		if raw, ok := obj["sorts"]; ok {
			var sorts []btquery.Sort
			if json.Unmarshal(raw, &sorts) == nil {
				visible := make([]btquery.Sort, 0, len(sorts))
				for _, sort := range sorts {
					if !p.hidden[sort.F] {
						visible = append(visible, sort)
					}
				}
				obj["sorts"], _ = json.Marshal(visible)
			}
		}
		if raw, ok := obj["group"]; ok {
			var id int64
			if json.Unmarshal(raw, &id) == nil && p.hidden[id] {
				delete(obj, "group")
			}
		}
		if raw, ok := obj["permissions"]; ok {
			var perms btquery.ViewPermissions
			if json.Unmarshal(raw, &perms) == nil {
				if len(perms.FieldModes) > 0 {
					cleanModes := make(map[string]string, len(perms.FieldModes))
					for fidStr, mode := range perms.FieldModes {
						fid, err := strconv.ParseInt(fidStr, 10, 64)
						if err == nil && !p.hidden[fid] {
							cleanModes[fidStr] = mode
						}
					}
					perms.FieldModes = cleanModes
				}
				if len(perms.Roles) > 0 {
					cleanRoles := make([]btquery.PermissionRole, len(perms.Roles))
					for i, role := range perms.Roles {
						if len(role.FieldModes) > 0 {
							rm := make(map[string]string, len(role.FieldModes))
							for fidStr, mode := range role.FieldModes {
								fid, err := strconv.ParseInt(fidStr, 10, 64)
								if err == nil && !p.hidden[fid] {
									rm[fidStr] = mode
								}
							}
							role.FieldModes = rm
						}
						if role.RowFilters != nil && len(role.RowFilters.Rules) > 0 {
							rules := make([]btquery.Rule, 0, len(role.RowFilters.Rules))
							for _, rule := range role.RowFilters.Rules {
								if !p.hidden[rule.F] {
									rules = append(rules, rule)
								}
							}
							rf := *role.RowFilters
							rf.Rules = rules
							role.RowFilters = &rf
						}
						cleanRoles[i] = role
					}
					perms.Roles = cleanRoles
				}
				if !perms.OnlyOwnRecords && len(perms.FieldModes) == 0 && len(perms.Roles) == 0 {
					delete(obj, "permissions")
				} else {
					obj["permissions"], _ = json.Marshal(perms)
				}
			}
		}
		delete(obj, "hidden")
		raw, err := json.Marshal(obj)
		if err == nil {
			view.Config = raw
		}
		out = append(out, view)
	}
	return out
}
