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
}

func (s *Server) readBaseAllowed(ctx context.Context, uid, id int64) (baseReadable, error) {
	var out baseReadable
	meta, err := s.Store.GetDoc(ctx, uid, id)
	if err != nil {
		return out, err
	}
	if meta.Kind != "base" || store.RoleRank(meta.Role) < store.RoleRank(store.RoleView) {
		return out, store.ErrNotFound
	}
	fields, err := s.Store.Fields(ctx, id)
	if err != nil {
		return out, err
	}
	views, err := s.Store.Views(ctx, id)
	if err != nil {
		return out, err
	}
	policy, err := parseBasePolicy(meta, fields, views)
	if err != nil {
		return out, err
	}
	recs, err := s.Store.QueryRecordsConstrained(ctx, id, fields, policy.mandatory, btquery.Config{}, 10000)
	if err != nil {
		return out, err
	}
	return baseReadable{meta: meta, allFields: fields, fields: visibleBaseFields(fields, policy), views: views, policy: policy, records: stripBaseRecords(recs, fields, policy)}, nil
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
	if meta.Kind != "base" || meta.Role != snapshot.meta.Role {
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
	return nil
}

func (s *Server) finishBaseRead(w http.ResponseWriter, r *http.Request, reads []baseReadable) bool {
	for _, read := range reads {
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
