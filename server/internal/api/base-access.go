package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/btquery"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// A locked view currently acts as a coarse data restriction for non-managers,
// not as a complete implementation of Feishu's advanced permissions. Multiple
// locked views intersect, so adding another cannot relax an existing rule.
type baseReadPolicy struct {
	mandatory []btquery.Config
	hidden    map[int64]bool
}

func parseBasePolicy(b store.DocMeta, fields []store.Field, views []store.View) (baseReadPolicy, error) {
	p := baseReadPolicy{hidden: map[int64]bool{}}
	if b.Role == store.RoleManage {
		return p, nil
	}
	for _, v := range views {
		var cfg btquery.Config
		if len(v.Config) != 0 && !bytes.Equal(v.Config, []byte("null")) {
			if err := json.Unmarshal(v.Config, &cfg); err != nil {
				return p, fmt.Errorf("invalid stored view %d: %w", v.ID, err)
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
	meta              store.DocMeta
	allFields, fields []store.Field
	views             []store.View
	policy            baseReadPolicy
	records           []store.Record
	memberIDs         []int64
	memberNames       map[int64]string
}

func (s *Server) readBaseAllowed(ctx context.Context, uid, id int64) (baseReadable, error) {
	return readBaseAllowedWith(ctx, s.Store, uid, id)
}

func readBaseAllowedWith(ctx context.Context, reader store.BaseSnapshotReader, uid, id int64) (baseReadable, error) {
	out, err := readBasePolicyWith(ctx, reader, uid, id)
	if err != nil {
		return out, err
	}
	recs, err := reader.QueryRecordsConstrained(ctx, id, out.allFields, out.policy.mandatory, btquery.Config{}, 10000)
	if err != nil {
		return out, err
	}
	out.records = stripBaseRecords(recs, out.allFields, out.policy)
	return out, nil
}

// readBasePolicyWith obtains the permissions/schema without loading an
// arbitrary prefix of another table. Associated records are fetched by ID.
func readBasePolicyWith(ctx context.Context, reader store.BaseSnapshotReader, uid, id int64) (baseReadable, error) {
	var out baseReadable
	meta, err := reader.GetDoc(ctx, uid, id)
	if err != nil {
		return out, err
	}
	if meta.Kind != "base" || store.RoleRank(meta.Role) < store.RoleRank(store.RoleView) {
		return out, store.ErrNotFound
	}
	fields, err := reader.Fields(ctx, id)
	if err != nil {
		return out, err
	}
	views, err := reader.Views(ctx, id)
	if err != nil {
		return out, err
	}
	policy, err := parseBasePolicy(meta, fields, views)
	if err != nil {
		return out, err
	}
	return baseReadable{meta: meta, allFields: fields, fields: visibleBaseFields(fields, policy), views: views, policy: policy}, nil
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
	fields, err := s.Store.Fields(ctx, meta.ID)
	if err != nil {
		return err
	}
	views, err := s.Store.Views(ctx, meta.ID)
	if err != nil {
		return err
	}
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
	indexes := make(map[int64]int, len(reads))
	seen := make(map[int64]map[int64]bool, len(reads))
	seenMembers := make(map[int64]map[int64]bool, len(reads))
	for _, read := range reads {
		idx, ok := indexes[read.meta.ID]
		if !ok {
			idx = len(merged)
			indexes[read.meta.ID] = idx
			seen[read.meta.ID] = map[int64]bool{}
			seenMembers[read.meta.ID] = map[int64]bool{}
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
			if !seen[read.meta.ID][record.ID] {
				seen[read.meta.ID][record.ID] = true
				merged[idx].records = append(merged[idx].records, record)
			}
		}
		for _, id := range read.memberIDs {
			name, present := read.memberNames[id]
			if seenMembers[read.meta.ID][id] {
				oldName, oldPresent := merged[idx].memberNames[id]
				if oldPresent != present || (present && oldName != name) {
					httpx.Error(w, http.StatusConflict, "access_changed", "表格成员已变化，请重试")
					return false
				}
				continue
			}
			seenMembers[read.meta.ID][id] = true
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
func visibleBaseViews(views []store.View, p baseReadPolicy) []store.View {
	if len(p.hidden) == 0 {
		return views
	}
	out := make([]store.View, 0, len(views))
	for _, view := range views {
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
		delete(obj, "hidden")
		raw, err := json.Marshal(obj)
		if err == nil {
			view.Config = raw
		}
		out = append(out, view)
	}
	return out
}
