package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/btformula"
	"github.com/ZSeven-W/jiange/server/internal/btquery"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// needBase is need() restricted to base nodes.
func (s *Server) needBase(w http.ResponseWriter, r *http.Request, role string) (store.DocMeta, bool) {
	d, ok := s.need(w, r, role)
	if ok && d.Kind != "base" {
		httpx.Error(w, http.StatusNotFound, "not_found", "base not found")
		return d, false
	}
	return d, ok
}

func (s *Server) createBase(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	var in docInput
	if r.ContentLength != 0 && !httpx.Decode(w, r, &in) {
		return
	}
	ws, err := s.Store.Workspaces(r.Context(), u.ID)
	if err != nil || len(ws) == 0 {
		s.fail(w, r, errors.New("user has no workspace"))
		return
	}
	if in.WorkspaceID == 0 {
		in.WorkspaceID = ws[0].ID
	}
	if ok, err := s.Store.CanCreateIn(r.Context(), u.ID, in.WorkspaceID); err != nil || !ok {
		httpx.Error(w, http.StatusForbidden, "forbidden", "not a member of this workspace")
		return
	}
	title := "未命名多维表格"
	if in.Title != nil {
		var ok bool
		if title, ok = cleanTitle(w, *in.Title); !ok {
			return
		}
	}
	b, err := s.Store.CreateInitializedBase(r.Context(), in.WorkspaceID, u.ID, in.ParentID, title)
	if err != nil {
		if errors.Is(err, store.ErrForbidden) {
			httpx.Error(w, http.StatusForbidden, "forbidden", "not a member of this workspace")
			return
		}
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusBadRequest, "invalid_parent", "parent not found")
			return
		}
		if errors.Is(err, store.ErrConflict) {
			httpx.Error(w, http.StatusConflict, "conflict", "目录正在变化，请重试")
			return
		}
		s.fail(w, r, err)
		return
	}
	b = s.sanitizeWrittenDocMeta(r.Context(), u.ID, b)
	httpx.JSON(w, http.StatusCreated, b)
}

func (s *Server) getBase(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	b, ok := s.needBase(w, r, store.RoleView)
	if !ok {
		return
	}
	u, _ := UserFrom(r.Context())
	var read baseReadable
	var targets []baseReadable
	var expansions map[string]any
	var members []store.User
	var workspaces []store.Workspace
	var head int64
	snapshotCtx, cancelSnapshot := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancelSnapshot()
	err := s.Store.WithBaseReadSnapshot(snapshotCtx, u.ID, b.ID, func(reader store.BaseSnapshotReader) error {
		var err error
		read, err = readBaseAllowedWith(snapshotCtx, reader, u.ID, b.ID)
		if err != nil {
			return err
		}
		head, err = reader.BtHead(snapshotCtx, b.ID)
		if err != nil {
			return err
		}
		members, err = reader.WorkspaceMembers(snapshotCtx, read.meta.WorkspaceID)
		if err != nil {
			return err
		}
		workspaces, err = reader.Workspaces(snapshotCtx, u.ID)
		if err != nil {
			return err
		}
		expansions, targets, err = expandBaseWith(snapshotCtx, reader, u.ID, &read, true)
		return err
	})
	if err != nil {
		switch {
		case errors.Is(err, context.Canceled):
			return
		case errors.Is(err, context.DeadlineExceeded):
			httpx.Error(w, http.StatusServiceUnavailable, "base_snapshot_timeout", "读取表格超时，请重试")
		case errors.Is(err, store.ErrNotFound), errors.Is(err, store.ErrForbidden):
			httpx.Error(w, http.StatusForbidden, "forbidden", "访问权限已变化")
		case errors.Is(err, store.ErrBaseSnapshotTooLarge):
			httpx.Error(w, http.StatusRequestEntityTooLarge, "base_snapshot_too_large", "表格关联数据过多，请缩小范围后重试")
		default:
			s.fail(w, r, err)
		}
		return
	}
	snapshotMembers := slices.Clone(members)
	// People the base is shared with can be picked in person cells and
	// defaults too (names only; emails stay with the workspace directory).
	shares, err := s.Store.ListShares(r.Context(), b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	for _, sh := range shares {
		if !slices.ContainsFunc(members, func(m store.User) bool { return m.ID == sh.UserID }) {
			members = append(members, store.User{ID: sh.UserID, Name: sh.Name})
		}
	}
	isMember := false
	for _, ws := range workspaces {
		if ws.ID == read.meta.WorkspaceID {
			isMember = true
			break
		}
	}
	if !isMember {
		// External collaborators need names only for visible person/creator
		// values, not the workspace's full member directory or email addresses.
		used := map[int64]bool{}
		for _, f := range read.fields {
			for _, rec := range read.records {
				if f.Type == "person" {
					for _, id := range btquery.PersonCellIDs(rec.Cells[strconv.FormatInt(f.ID, 10)]) {
						if id > 0 {
							used[id] = true
						}
					}
				}
				if f.Type == "created_by" && rec.CreatorID != nil {
					used[*rec.CreatorID] = true
				}
			}
		}
		visible := make([]store.User, 0)
		for _, member := range members {
			if used[member.ID] {
				member.Email = ""
				visible = append(visible, member)
			}
		}
		members = visible
	}
	reads := append([]baseReadable{read}, targets...)
	if !s.finishBaseRead(w, r, reads) {
		return
	}
	// A direct share can preserve the same role after workspace membership is
	// revoked; independently recheck membership before returning the directory.
	currentWorkspaces, err := s.Store.Workspaces(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	currentMember := false
	for _, ws := range currentWorkspaces {
		if ws.ID == read.meta.WorkspaceID {
			currentMember = true
			break
		}
	}
	if currentMember != isMember {
		httpx.Error(w, http.StatusConflict, "access_changed", "工作空间权限已变化，请重试")
		return
	}
	currentMembers, err := s.Store.WorkspaceMembers(r.Context(), read.meta.WorkspaceID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !reflect.DeepEqual(currentMembers, snapshotMembers) {
		httpx.Error(w, http.StatusConflict, "access_changed", "工作空间成员已变化，请重试")
		return
	}
	meta, err := s.sanitizeDocMeta(r.Context(), u.ID, read.meta, nil)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"base": meta, "fields": read.fields, "records": read.records, "head": head,
		"members": members, "views": visibleBaseViews(read.views, read.policy), "expansions": expansions,
		"writeRestricted": len(read.policy.mandatory) > 0,
	})
}

type fieldInput struct {
	Name         *string   `json:"name"`
	Type         *string   `json:"type"`
	Options      *[]string `json:"options"`
	OptionColors *[]int    `json:"optionColors"`
	Description  *string   `json:"description"`
	Formula      *string   `json:"formula"`
	Position     *float64  `json:"position"`
	// OptionRenames maps old→new select option names so a rename keeps the
	// records that held the old value (otherwise removed options are cleared).
	OptionRenames map[string]string `json:"optionRenames"`
	// DefaultValue sets (or with null clears) the field's 默认值.
	DefaultValue json.RawMessage `json:"defaultValue"` // absent = keep; null = clear
	// Multiple turns a person field into a member array (允许多选).
	Multiple *bool `json:"multiple"`
}

// defaultableTypes may carry a 默认值; derived, link and attachment fields cannot.
var defaultableTypes = map[string]bool{"text": true, "number": true, "select": true, "multi_select": true, "checkbox": true, "date": true, "url": true, "phone": true, "email": true, "rating": true, "person": true}

func (in fieldInput) apply(w http.ResponseWriter, f *store.Field) bool {
	if in.Name != nil {
		n := strings.TrimSpace(*in.Name)
		if n == "" || utf8.RuneCountInString(n) > 100 {
			httpx.Error(w, http.StatusBadRequest, "invalid_name", "field name must be 1-100 characters")
			return false
		}
		f.Name = n
	}
	if in.Type != nil {
		if !store.FieldTypes[*in.Type] {
			httpx.Error(w, http.StatusBadRequest, "invalid_type", "unknown field type "+*in.Type)
			return false
		}
		f.Type = *in.Type
	}
	if in.Options != nil {
		f.Options = *in.Options
	}
	if in.OptionColors != nil {
		for _, c := range *in.OptionColors {
			if c < -1 || c > 9 {
				httpx.Error(w, http.StatusBadRequest, "invalid_color", "color index must be -1..9")
				return false
			}
		}
		f.OptionColors = *in.OptionColors
	}
	if in.Description != nil {
		if utf8.RuneCountInString(*in.Description) > 200 {
			httpx.Error(w, http.StatusBadRequest, "invalid_description", "描述最多 200 字")
			return false
		}
		f.Description = strings.TrimSpace(*in.Description)
	}
	if in.Formula != nil {
		f.Formula = strings.TrimSpace(*in.Formula)
	}
	if in.Position != nil {
		f.Position = *in.Position
	}
	// 允许多选 is a person-only attribute; every other type stays single.
	if in.Multiple != nil {
		if f.Type != "person" && *in.Multiple {
			httpx.Error(w, http.StatusBadRequest, "invalid_multiple", "只有人员字段允许多选")
			return false
		}
		f.Multiple = f.Type == "person" && *in.Multiple
	} else if f.Type != "person" {
		f.Multiple = false
	}
	if len(in.DefaultValue) > 0 {
		v := in.DefaultValue
		if len(v) == 0 || string(v) == "null" || string(v) == `""` || string(v) == "[]" {
			f.DefaultValue = nil
		} else if !defaultableTypes[f.Type] || !validCell(*f, v) || len(v) > 2000 {
			httpx.Error(w, http.StatusBadRequest, "invalid_default", "默认值与字段类型不匹配")
			return false
		} else {
			f.DefaultValue = v
		}
	} else if f.DefaultValue != nil && (!defaultableTypes[f.Type] || !validCell(*f, f.DefaultValue)) {
		// A type or option change invalidated the old default; drop it.
		f.DefaultValue = nil
	}
	return true
}

// validateFormula checks a formula expression's syntax and field references.
func validateFormula(w http.ResponseWriter, fields []store.Field, excludeField int64, formula string) bool {
	if utf8.RuneCountInString(formula) > 2000 {
		httpx.Error(w, http.StatusBadRequest, "invalid_formula", "公式最长 2000 字")
		return false
	}
	names := make([]string, 0, len(fields))
	for _, x := range fields {
		if x.ID != excludeField {
			names = append(names, x.Name)
		}
	}
	if err := btformula.Validate(formula, names); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_formula", err.Error())
		return false
	}
	return true
}

func pathID(r *http.Request, k string) int64 {
	id, _ := strconv.ParseInt(r.PathValue(k), 10, 64)
	return id
}

// btEvent appends a realtime event and pokes the base's sync room. Failures
// don't fail the mutation: clients converge on the next refetch.
func (s *Server) btEvent(ctx context.Context, baseID int64, body map[string]any) {
	b, err := json.Marshal(body)
	if err != nil {
		return
	}
	if _, err := s.Store.AppendBtEvent(ctx, baseID, b); err != nil {
		s.Log.Error("bt event append", "base", baseID, "err", err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(baseID)
	}
}

func (s *Server) addField(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if !s.allowBaseWrite(w, r, b) {
		return
	}
	var in fieldInput
	if !httpx.Decode(w, r, &in) {
		return
	}
	f := store.Field{BaseID: b.ID, Name: "新字段", Type: "text"}
	if !in.apply(w, &f) {
		return
	}
	if !s.validPersonDefault(w, r, b, in, f) {
		return
	}
	fields, err := s.Store.Fields(r.Context(), b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if f.Type == "formula" && f.Formula != "" && !validateFormula(w, fields, 0, f.Formula) {
		return
	}
	if f.Type == "link" && !s.allowLinkTarget(w, r, b.ID, f, nil) {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	result, err := s.Store.MutateFieldGuarded(r.Context(), guard, store.FieldMutation{BaseID: b.ID, After: &f, Fields: fields})
	if err != nil {
		s.fieldMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		for _, id := range result.Notify {
			s.BtHub.Notify(id)
		}
	}
	httpx.JSON(w, http.StatusCreated, result.Field)
}

func (s *Server) patchField(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if !s.allowBaseWrite(w, r, b) {
		return
	}
	fields, err := s.Store.Fields(r.Context(), b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	i := slices.IndexFunc(fields, func(f store.Field) bool { return f.ID == pathID(r, "fid") })
	if i < 0 {
		httpx.Error(w, http.StatusNotFound, "not_found", "field not found")
		return
	}
	var in fieldInput
	if !httpx.Decode(w, r, &in) {
		return
	}
	old := fields[i]
	f := old
	if !in.apply(w, &f) {
		return
	}
	if !s.validPersonDefault(w, r, b, in, f) {
		return
	}
	if f.Type == "formula" && f.Formula != "" && !validateFormula(w, fields, f.ID, f.Formula) {
		return
	}
	if f.Type == "link" && !s.allowLinkTarget(w, r, b.ID, f, nil) {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	convert := convertCell
	if len(in.OptionRenames) > 0 && old.Type == f.Type && (f.Type == "select" || f.Type == "multi_select") {
		renames := in.OptionRenames
		convert = func(from, to store.Field, v json.RawMessage) json.RawMessage {
			return convertCell(from, to, renameOptionCell(v, renames))
		}
	}
	// 允许多选 flip: single number → [n] when turning on, [a, b…] → a (first
	// member) when turning off; anything unrepresentable is cleared.
	if old.Type == f.Type && f.Type == "person" && old.Multiple != f.Multiple {
		toMultiple := f.Multiple
		convert = func(from, to store.Field, v json.RawMessage) json.RawMessage {
			return convertCell(from, to, convertPersonMultiple(toMultiple, v))
		}
	}
	result, err := s.Store.MutateFieldGuarded(r.Context(), guard, store.FieldMutation{BaseID: b.ID, Before: &old, After: &f, Fields: fields, Convert: convert})
	if err != nil {
		s.fieldMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		for _, id := range result.Notify {
			s.BtHub.Notify(id)
		}
	}
	httpx.JSON(w, http.StatusOK, result.Field)
}

// convertCell rewrites a cell after its field changed type (or a select's
// options shrank). Values that cannot be represented are cleared (nil).
// renameOptionCell applies old→new option renames to a select or
// multi_select cell value before the regular conversion runs.
// convertPersonMultiple rewrites a person cell between the single-number and
// array shapes (允许多选 flip); values that cannot be represented are cleared.
func convertPersonMultiple(toMultiple bool, v json.RawMessage) json.RawMessage {
	var one int64
	if json.Unmarshal(v, &one) == nil {
		if one <= 0 {
			return nil
		}
		if !toMultiple {
			return v
		}
		b, _ := json.Marshal([]int64{one})
		return b
	}
	var many []int64
	if json.Unmarshal(v, &many) != nil {
		return v
	}
	kept := make([]int64, 0, len(many))
	for _, id := range many {
		if id > 0 {
			kept = append(kept, id)
		}
	}
	if len(kept) == 0 {
		return nil
	}
	if !toMultiple {
		// Single mode stores a bare number, not a one-element array.
		b, _ := json.Marshal(kept[0])
		return b
	}
	b, _ := json.Marshal(kept)
	return b
}

func renameOptionCell(v json.RawMessage, renames map[string]string) json.RawMessage {
	var one string
	if json.Unmarshal(v, &one) == nil {
		if n, ok := renames[one]; ok {
			b, _ := json.Marshal(n)
			return b
		}
		return v
	}
	var many []string
	if json.Unmarshal(v, &many) == nil {
		for i, s := range many {
			if n, ok := renames[s]; ok {
				many[i] = n
			}
		}
		b, _ := json.Marshal(many)
		return b
	}
	return v
}

func convertCell(from, to store.Field, v json.RawMessage) json.RawMessage {
	// A value already valid for the destination type needs no conversion.
	// This preserves compatible values such as text→email/url/phone and
	// integer number→rating instead of silently clearing them.
	if validCell(to, v) {
		return v
	}
	if from.Type == to.Type {
		if to.Type == "select" {
			var s string
			if json.Unmarshal(v, &s) == nil && slices.Contains(to.Options, s) {
				return v
			}
			return nil
		}
		if to.Type == "multi_select" {
			var arr []string
			if json.Unmarshal(v, &arr) != nil {
				return nil
			}
			kept := arr[:0]
			for _, s := range arr {
				if slices.Contains(to.Options, s) {
					kept = append(kept, s)
				}
			}
			b, _ := json.Marshal(kept)
			return b
		}
		return v
	}
	var x any
	if json.Unmarshal(v, &x) != nil {
		return nil
	}
	mustJSON := func(a any) json.RawMessage { b, _ := json.Marshal(a); return b }
	switch val := x.(type) {
	case string:
		switch to.Type {
		case "text", "date", "select":
			if to.Type == "select" && !slices.Contains(to.Options, val) {
				return nil
			}
			if to.Type == "date" {
				if _, err := time.Parse("2006-01-02", val); err != nil {
					return nil
				}
			}
			return mustJSON(val)
		case "number":
			if n, err := strconv.ParseFloat(strings.TrimSpace(val), 64); err == nil {
				return mustJSON(n)
			}
		case "checkbox":
			if b, err := strconv.ParseBool(val); err == nil {
				return mustJSON(b)
			}
		case "multi_select":
			if slices.Contains(to.Options, val) {
				return mustJSON([]string{val})
			}
		}
	case float64:
		switch to.Type {
		case "number":
			return mustJSON(val)
		case "text":
			return mustJSON(strconv.FormatFloat(val, 'f', -1, 64))
		case "checkbox":
			return mustJSON(val != 0)
		case "person":
			return mustJSON(int64(val))
		}
	case bool:
		switch to.Type {
		case "checkbox":
			return mustJSON(val)
		case "number":
			if val {
				return mustJSON(1)
			}
			return mustJSON(0)
		case "text":
			return mustJSON(strconv.FormatBool(val))
		}
	case []any:
		switch to.Type {
		case "text":
			parts := make([]string, 0, len(val))
			for _, item := range val {
				if s, ok := item.(string); ok {
					parts = append(parts, s)
				}
			}
			return mustJSON(strings.Join(parts, ","))
		}
	}
	return nil
}

func (s *Server) deleteField(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if !s.allowBaseWrite(w, r, b) {
		return
	}
	fields, err := s.Store.Fields(r.Context(), b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	idx := slices.IndexFunc(fields, func(f store.Field) bool { return f.ID == pathID(r, "fid") })
	if idx < 0 {
		httpx.Error(w, http.StatusNotFound, "not_found", "field not found")
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	old := fields[idx]
	result, err := s.Store.MutateFieldGuarded(r.Context(), guard, store.FieldMutation{BaseID: b.ID, Before: &old, Fields: fields})
	if err != nil {
		s.fieldMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		for _, id := range result.Notify {
			s.BtHub.Notify(id)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) fieldMutationError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效，未修改字段")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限不允许修改字段")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "字段不存在")
	case errors.Is(err, store.ErrPrimaryField):
		httpx.Error(w, http.StatusConflict, "primary_field", "主字段不能删除、移动或隐藏")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "field_conflict", "字段、关联表或权限视图已变化或存在依赖，请检查后重试")
	default:
		s.fail(w, r, err)
	}
}

// checkCells validates values against field types (null clears a cell).
func checkCells(fields []store.Field, cells map[string]json.RawMessage) string {
	for k, v := range cells {
		i := slices.IndexFunc(fields, func(f store.Field) bool { return strconv.FormatInt(f.ID, 10) == k })
		if i < 0 {
			return "unknown field " + k
		}
		if len(v) == 0 || string(v) == "null" {
			continue
		}
		f := fields[i]
		if store.FieldReadOnly(f.Type) {
			return f.Name + " 是自动填充字段，不能编辑"
		}
		if f.Type == "link" {
			var arr []int64
			if json.Unmarshal(v, &arr) != nil {
				return f.Name + " 需要关联记录 id 数组"
			}
			continue
		}
		if f.Type == "lookup" {
			return f.Name + " 是查找引用字段，由关联字段派生，不能直接编辑"
		}
		if !validCell(f, v) {
			return "invalid value for " + f.Name
		}
	}
	return ""
}

// validCell is the per-type cell validator (server side of the type registry).
func validCell(f store.Field, v json.RawMessage) bool {
	switch f.Type {
	case "text":
		var s string
		return json.Unmarshal(v, &s) == nil && utf8.RuneCountInString(s) <= 10000
	case "number":
		var n float64
		return json.Unmarshal(v, &n) == nil
	case "checkbox":
		var b bool
		return json.Unmarshal(v, &b) == nil
	case "select":
		var s string
		return json.Unmarshal(v, &s) == nil && slices.Contains(f.Options, s)
	case "multi_select":
		var arr []string
		if json.Unmarshal(v, &arr) != nil {
			return false
		}
		for _, s := range arr {
			if !slices.Contains(f.Options, s) {
				return false
			}
		}
		return true
	case "person":
		if f.Multiple {
			var ids []int64
			if json.Unmarshal(v, &ids) != nil {
				return false
			}
			for _, id := range ids {
				if id <= 0 {
					return false
				}
			}
			return true
		}
		var id int64
		return json.Unmarshal(v, &id) == nil
	case "attachment":
		var arr []struct {
			ID   int64  `json:"id"`
			Name string `json:"name"`
			Mime string `json:"mime"`
			Size int64  `json:"size"`
		}
		return json.Unmarshal(v, &arr) == nil
	case "date":
		var s string
		if json.Unmarshal(v, &s) == nil {
			_, err := time.Parse("2006-01-02", s)
			return err == nil
		}
	case "url":
		var s string
		return json.Unmarshal(v, &s) == nil && utf8.RuneCountInString(s) <= 1000 &&
			(strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://"))
	case "phone":
		var s string
		if json.Unmarshal(v, &s) == nil && utf8.RuneCountInString(s) <= 24 {
			ok := true
			for _, r := range s {
				if (r < '0' || r > '9') && r != '+' && r != '-' && r != ' ' {
					ok = false
					break
				}
			}
			return ok && strings.TrimSpace(s) != ""
		}
	case "email":
		var s string
		if json.Unmarshal(v, &s) == nil {
			a, err := mail.ParseAddress(s)
			return err == nil && a.Address == s
		}
	case "rating":
		var n float64
		return json.Unmarshal(v, &n) == nil && n >= 1 && n <= 5 && n == float64(int(n))
	}
	return false
}

// validPersonDefault requires a person 默认值 to be one of the base's
// collaborators: a workspace member or someone the base is shared with.
func (s *Server) validPersonDefault(w http.ResponseWriter, r *http.Request, b store.DocMeta, in fieldInput, f store.Field) bool {
	if len(in.DefaultValue) == 0 || f.Type != "person" || f.DefaultValue == nil {
		return true
	}
	// 允许多选的默认值是 id 数组；单选仍是单个 id。
	var ids []int64
	if f.Multiple {
		if json.Unmarshal(f.DefaultValue, &ids) != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_default", "默认值与字段类型不匹配")
			return false
		}
	} else {
		var id int64
		if json.Unmarshal(f.DefaultValue, &id) != nil || id <= 0 {
			httpx.Error(w, http.StatusBadRequest, "invalid_default", "默认值与字段类型不匹配")
			return false
		}
		ids = []int64{id}
	}
	names, err := s.collaboratorNames(r.Context(), b)
	if err != nil {
		s.fail(w, r, err)
		return false
	}
	for _, id := range ids {
		if id <= 0 {
			httpx.Error(w, http.StatusBadRequest, "invalid_default", "默认值与字段类型不匹配")
			return false
		}
		if _, ok := names[id]; !ok {
			httpx.Error(w, http.StatusBadRequest, "invalid_default", "默认人员必须是此表格的协作者")
			return false
		}
	}
	return true
}
