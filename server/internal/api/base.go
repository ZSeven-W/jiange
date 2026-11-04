package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
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
	b, err := s.Store.CreateBase(r.Context(), in.WorkspaceID, u.ID, in.ParentID, title)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// a new base starts like Feishu's: a primary text field, a default grid
	// view and a few empty rows
	ctx := r.Context()
	s.Store.AddField(ctx, store.Field{BaseID: b.ID, Name: "标题", Type: "text"})
	s.Store.AddView(ctx, store.View{BaseID: b.ID, Type: "grid", Name: "表格视图"})
	for range 3 {
		s.Store.AddRecord(ctx, store.Record{BaseID: b.ID, CreatorID: &u.ID})
	}
	httpx.JSON(w, http.StatusCreated, b)
}

func (s *Server) getBase(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleView)
	if !ok {
		return
	}
	fields, err := s.Store.Fields(r.Context(), b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	recs, err := s.Store.Records(r.Context(), b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	head, err := s.Store.BtHead(r.Context(), b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	members, err := s.Store.WorkspaceMembers(r.Context(), b.WorkspaceID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	views, err := s.Store.Views(r.Context(), b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// 展开 link/lookup 字段值：links[fromRecord] = [{id,title}]; lookups 同理派生
	var linkIDs []int64
	for _, rec := range recs {
		linkIDs = append(linkIDs, rec.ID)
	}
	linkFields := []store.Field{}
	lookupFields := []store.Field{}
	for _, f := range fields {
		if f.Type == "link" {
			linkFields = append(linkFields, f)
		} else if f.Type == "lookup" {
			lookupFields = append(lookupFields, f)
		}
	}
	expansions := map[string]any{}
	for _, lf := range linkFields {
		links, err := s.Store.LinksForRecords(r.Context(), lf.ID, linkIDs)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		// 目标记录标题（目标 base 的第一个 text 字段）
		var targetBase int64
		if len(lf.Options) > 0 {
			targetBase, _ = strconv.ParseInt(lf.Options[0], 10, 64)
		}
		targetTitle := map[int64]string{}
		if targetBase != 0 {
			tf, err := s.Store.Fields(r.Context(), targetBase)
			if err == nil {
				titleField := int64(0)
				for _, x := range tf {
					if x.Type == "text" {
						titleField = x.ID
						break
					}
				}
				if titleField != 0 {
					trecs, err := s.Store.QueryRecords(r.Context(), targetBase, tf, store.BtQueryAll(), 0)
					if err == nil {
						for _, tr := range trecs {
							var tv any
							if raw, ok := tr.Cells[strconv.FormatInt(titleField, 10)]; ok {
								_ = json.Unmarshal(raw, &tv)
								if s2, ok := tv.(string); ok {
									targetTitle[tr.ID] = s2
								}
							}
						}
					}
				}
			}
		}
		key := strconv.FormatInt(lf.ID, 10)
		expansions[key] = links
		expansions[key+":titles"] = targetTitle
	}
	// lookup 字段：按 (link 字段, 目标字段) 派生每个记录的值数组
	for _, lf := range lookupFields {
		if len(lf.Options) < 2 {
			continue
		}
		linkFieldID, _ := strconv.ParseInt(lf.Options[0], 10, 64)
		targetFieldID, _ := strconv.ParseInt(lf.Options[1], 10, 64)
		var linkField *store.Field
		for _, x := range fields {
			if x.ID == linkFieldID && x.Type == "link" {
				linkField = &x
				break
			}
		}
		if linkField == nil {
			continue
		}
		links, err := s.Store.LinksForRecords(r.Context(), linkFieldID, linkIDs)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		var targetBase int64
		if len(linkField.Options) > 0 {
			targetBase, _ = strconv.ParseInt(linkField.Options[0], 10, 64)
		}
		values := map[int64][]any{}
		if targetBase != 0 {
			tf, err := s.Store.Fields(r.Context(), targetBase)
			if err == nil {
				if trecs, err := s.Store.QueryRecords(r.Context(), targetBase, tf, store.BtQueryAll(), 0); err == nil {
					byID := map[int64]store.Record{}
					for _, tr := range trecs {
						byID[tr.ID] = tr
					}
					for from, tos := range links {
						for _, to := range tos {
							if tr, ok := byID[to]; ok {
								if raw, ok := tr.Cells[strconv.FormatInt(targetFieldID, 10)]; ok {
									var v any
									if json.Unmarshal(raw, &v) == nil {
										values[from] = append(values[from], v)
									}
								}
							}
						}
					}
				}
			}
		}
		expansions[strconv.FormatInt(lf.ID, 10)] = values
	}
	// locked 视图 = 行级/列级权限：非 manage 角色只能看到过滤后的行与
	// 未隐藏的字段（查询时注入谓词，btquery 编译成 SQL WHERE）。
	if b.Role != store.RoleManage {
		for _, v := range views {
			if v.Type != "grid" && v.Type != "kanban" && v.Type != "gallery" && v.Type != "calendar" {
				continue
			}
			var cfg btquery.Config
			if json.Unmarshal(v.Config, &cfg) != nil || !cfg.Locked {
				continue
			}
			specs := store.Specs(fields)
			if _, _, _, err := btquery.Compile(specs, cfg); err != nil {
				break // 视图配置非法时按未锁定处理
			}
			recs, err = s.Store.QueryRecords(r.Context(), b.ID, fields, cfg, 10000)
			if err != nil {
				break
			}
			hidden := map[int64]bool{}
			for _, id := range cfg.Hidden {
				hidden[id] = true
			}
			visible := make([]store.Field, 0, len(fields))
			for _, f := range fields {
				if !hidden[f.ID] {
					visible = append(visible, f)
				}
			}
			fields = visible
			stripped := make([]store.Record, 0, len(recs))
			for _, rec := range recs {
				cells := map[string]json.RawMessage{}
				for k, v := range rec.Cells {
					if !hidden[fieldIDOf(k, fields)] && !containsID(cfg.Hidden, k) {
						cells[k] = v
					}
				}
				rec.Cells = cells
				stripped = append(stripped, rec)
			}
			recs = stripped
			break
		}
	}
	// 双向关联：被指向的本 base 记录 → 源记录（标题 chips 渲染在详情抽屉）
	reverse, err := s.Store.LinkFieldsTargeting(r.Context(), b.ID)
	if err == nil && len(reverse) > 0 {
		var selfIDs []int64
		for _, rec := range recs {
			selfIDs = append(selfIDs, rec.ID)
		}
		type revEntry struct {
			SourceBase int64             `json:"sourceBase"`
			FieldID    int64             `json:"fieldId"`
			From       map[int64][]int64 `json:"from"`
			Titles     map[int64]string  `json:"titles"`
		}
		var revs []revEntry
		for _, rf := range reverse {
			links, err := s.Store.LinksForRecords(r.Context(), rf.FieldID, selfIDs)
			if err != nil || len(links) == 0 {
				continue
			}
			// 源记录标题
			srcFields, err := s.Store.Fields(r.Context(), rf.BaseID)
			if err != nil {
				continue
			}
			titleField := int64(0)
			for _, x := range srcFields {
				if x.Type == "text" {
					titleField = x.ID
					break
				}
			}
			var srcIDs []int64
			for _, tos := range links {
				srcIDs = append(srcIDs, tos...)
			}
			if trecs, err := s.Store.QueryRecords(r.Context(), rf.BaseID, srcFields, store.BtQueryAll(), 0); err == nil {
				titles := map[int64]string{}
				for _, tr := range trecs {
					for _, sid := range srcIDs {
						if tr.ID == sid && titleField != 0 {
							if raw, ok := tr.Cells[strconv.FormatInt(titleField, 10)]; ok {
								var tv any
								if json.Unmarshal(raw, &tv) == nil {
									if s2, ok := tv.(string); ok {
										titles[sid] = s2
									}
								}
							}
						}
					}
				}
				revs = append(revs, revEntry{SourceBase: rf.BaseID, FieldID: rf.FieldID, From: links, Titles: titles})
			}
		}
		if revs == nil {
			revs = []revEntry{}
		}
		expansions["reverse"] = revs
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"base": b, "fields": fields, "records": recs, "head": head, "members": members, "views": views, "expansions": expansions})
}

type fieldInput struct {
	Name         *string   `json:"name"`
	Type         *string   `json:"type"`
	Options      *[]string `json:"options"`
	OptionColors *[]int    `json:"optionColors"`
	Description  *string   `json:"description"`
	Formula      *string   `json:"formula"`
	Position     *float64  `json:"position"`
}

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
	return true
}

func fieldIDOf(key string, _ []store.Field) int64 {
	id, _ := strconv.ParseInt(key, 10, 64)
	return id
}

func containsID(ids []int64, key string) bool {
	id, _ := strconv.ParseInt(key, 10, 64)
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

// validateFormula checks a formula expression's syntax and field references.
func (s *Server) validateFormula(w http.ResponseWriter, r *http.Request, baseID, excludeField int64, formula string) bool {
	if utf8.RuneCountInString(formula) > 2000 {
		httpx.Error(w, http.StatusBadRequest, "invalid_formula", "公式最长 2000 字")
		return false
	}
	fields, err := s.Store.Fields(r.Context(), baseID)
	if err != nil {
		s.fail(w, r, err)
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
	var in fieldInput
	if !httpx.Decode(w, r, &in) {
		return
	}
	f := store.Field{BaseID: b.ID, Name: "新字段", Type: "text"}
	if !in.apply(w, &f) {
		return
	}
	if f.Type == "formula" && f.Formula != "" && !s.validateFormula(w, r, b.ID, 0, f.Formula) {
		return
	}
	f, err := s.Store.AddField(r.Context(), f)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.btEvent(r.Context(), b.ID, map[string]any{"kind": "field", "op": "add", "field": f})
	httpx.JSON(w, http.StatusCreated, f)
}

func (s *Server) patchField(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
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
	if f.Type == "formula" && f.Formula != "" && !s.validateFormula(w, r, b.ID, f.ID, f.Formula) {
		return
	}
	if f, err = s.Store.UpdateField(r.Context(), f); err != nil {
		s.fail(w, r, err)
		return
	}
	if old.Type != f.Type || ((f.Type == "select" || f.Type == "multi_select") && !slices.Equal(old.Options, f.Options)) {
		if err := s.Store.MapFieldCells(r.Context(), b.ID, f.ID, func(v json.RawMessage) json.RawMessage {
			return convertCell(old, f, v)
		}); err != nil {
			s.fail(w, r, err)
			return
		}
		s.btEvent(r.Context(), b.ID, map[string]any{"kind": "reload"})
	}
	s.btEvent(r.Context(), b.ID, map[string]any{"kind": "field", "op": "update", "field": f})
	httpx.JSON(w, http.StatusOK, f)
}

// convertCell rewrites a cell after its field changed type (or a select's
// options shrank). Values that cannot be represented are cleared (nil).
func convertCell(from, to store.Field, v json.RawMessage) json.RawMessage {
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
	fid := pathID(r, "fid")
	if err := s.Store.DeleteField(r.Context(), b.ID, fid); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "field not found")
		return
	} else if err != nil {
		s.fail(w, r, err)
		return
	}
	s.btEvent(r.Context(), b.ID, map[string]any{"kind": "field", "op": "del", "fid": fid})
	w.WriteHeader(http.StatusNoContent)
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

func (s *Server) writeRecord(w http.ResponseWriter, r *http.Request, create bool) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	var in struct {
		Cells    map[string]json.RawMessage `json:"cells"`
		Position float64                    `json:"position"`
		// Move: when true, Position repositions the record (kanban drag).
		Move bool `json:"move"`
	}
	if r.ContentLength != 0 && !httpx.Decode(w, r, &in) {
		return
	}
	fields, err := s.Store.Fields(r.Context(), b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if msg := checkCells(fields, in.Cells); msg != "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_cell", msg)
		return
	}
	// locked 视图的隐藏字段对非 manage 角色写保护
	if b.Role != store.RoleManage {
		for _, v := range func() []store.View {
			vs, _ := s.Store.Views(r.Context(), b.ID)
			return vs
		}() {
			if v.Type != "grid" && v.Type != "kanban" {
				continue
			}
			var cfg btquery.Config
			if json.Unmarshal(v.Config, &cfg) != nil || !cfg.Locked {
				continue
			}
			for k := range in.Cells {
				if containsID(cfg.Hidden, k) {
					id, _ := strconv.ParseInt(k, 10, 64)
					name := ""
					for _, f := range fields {
						if f.ID == id {
							name = f.Name
						}
					}
					httpx.Error(w, http.StatusForbidden, "forbidden", "字段 "+name+" 受权限保护")
					return
				}
			}
			break
		}
	}
	u, _ := UserFrom(r.Context())
	var rec store.Record
	if create {
		for k, v := range in.Cells {
			if len(v) == 0 || string(v) == "null" {
				delete(in.Cells, k)
			}
		}
		rec, err = s.Store.AddRecord(r.Context(), store.Record{BaseID: b.ID, Cells: in.Cells, Position: in.Position, CreatorID: &u.ID})
	} else if in.Move {
		rec, err = s.Store.MoveRecord(r.Context(), b.ID, pathID(r, "rid"), in.Position)
	} else {
		rec, err = s.Store.SetCells(r.Context(), b.ID, pathID(r, "rid"), in.Cells)
	}
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "record not found")
		return
	} else if err != nil {
		s.fail(w, r, err)
		return
	}
	// link 字段：cells 只作展示缓存，真值写 bt_links
	linkFields := map[string]store.Field{}
	for _, x := range fields {
		if x.Type == "link" {
			linkFields[strconv.FormatInt(x.ID, 10)] = x
		}
	}
	for k, raw := range in.Cells {
		f, ok := linkFields[k]
		if !ok {
			continue
		}
		var arr []int64
		_ = json.Unmarshal(raw, &arr)
		rid := rec.ID
		if ferr := s.Store.SetLinks(r.Context(), b.ID, f.ID, rid, arr); ferr != nil {
			s.fail(w, r, ferr)
			return
		}
	}
	op := "update"
	if create {
		op = "add"
	}
	s.btEvent(r.Context(), b.ID, map[string]any{"kind": "record", "op": op, "record": rec})
	status := http.StatusOK
	if create {
		status = http.StatusCreated
	}
	httpx.JSON(w, status, rec)
}

func (s *Server) deleteRecord(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	rid := pathID(r, "rid")
	if err := s.Store.DeleteRecord(r.Context(), b.ID, rid); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "record not found")
		return
	} else if err != nil {
		s.fail(w, r, err)
		return
	}
	s.btEvent(r.Context(), b.ID, map[string]any{"kind": "record", "op": "del", "rid": rid})
	w.WriteHeader(http.StatusNoContent)
}
