package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type viewInput struct {
	Name   *string          `json:"name"`
	Type   *string          `json:"type"`
	Config *json.RawMessage `json:"config"`
	Pos    *float64         `json:"pos"`
}

var viewTypes = map[string]bool{"grid": true, "kanban": true, "gallery": true, "calendar": true, "form": true, "gantt": true}

func (in viewInput) apply(w http.ResponseWriter, v *store.View) bool {
	if in.Name != nil {
		n := []rune(*in.Name)
		if len(n) == 0 || len(n) > 100 {
			httpx.Error(w, http.StatusBadRequest, "invalid_name", "view name must be 1-100 characters")
			return false
		}
		v.Name = *in.Name
	}
	if in.Type != nil {
		if !viewTypes[*in.Type] {
			httpx.Error(w, http.StatusBadRequest, "invalid_type", "view type must be grid or kanban")
			return false
		}
		v.Type = *in.Type
	}
	if in.Config != nil {
		v.Config = *in.Config
	}
	if in.Pos != nil {
		v.Pos = *in.Pos
	}
	return true
}

func (s *Server) addView(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if !s.allowBaseWrite(w, r, b) {
		return
	}
	var in viewInput
	if !httpx.Decode(w, r, &in) {
		return
	}
	v := store.View{BaseID: b.ID, Type: "grid", Name: "表格视图"}
	if in.Type != nil && *in.Type == "kanban" {
		v.Name = "看板视图"
	}
	if !in.apply(w, &v) {
		return
	}
	if b.Role != store.RoleManage {
		var cfg btquery.Config
		if len(v.Config) > 0 && json.Unmarshal(v.Config, &cfg) != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_config", "invalid view configuration")
			return
		}
		if cfg.Locked {
			httpx.Error(w, http.StatusForbidden, "forbidden", "只有管理员可以设置权限视图")
			return
		}
	}
	if err := s.checkViewConfig(w, r, b.ID, v); !err {
		return
	}
	v, apiErr := s.Store.AddView(r.Context(), v)
	if apiErr != nil {
		s.fail(w, r, apiErr)
		return
	}
	s.btEvent(r.Context(), b.ID, map[string]any{"kind": "reload"})
	httpx.JSON(w, http.StatusCreated, v)
}

func (s *Server) patchView(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if !s.allowBaseWrite(w, r, b) {
		return
	}
	views, err := s.Store.Views(r.Context(), b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var cur *store.View
	for i := range views {
		if views[i].ID == pathID(r, "vid") {
			cur = &views[i]
			break
		}
	}
	if cur == nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "view not found")
		return
	}
	var in viewInput
	if !httpx.Decode(w, r, &in) {
		return
	}
	v := *cur
	if !in.apply(w, &v) {
		return
	}
	if b.Role != store.RoleManage {
		var cfg btquery.Config
		if len(v.Config) > 0 && json.Unmarshal(v.Config, &cfg) != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_config", "invalid view configuration")
			return
		}
		if cfg.Locked {
			httpx.Error(w, http.StatusForbidden, "forbidden", "只有管理员可以设置权限视图")
			return
		}
	}
	if err := s.checkViewConfig(w, r, b.ID, v); !err {
		return
	}
	if v, err = s.Store.UpdateView(r.Context(), v); err != nil {
		s.fail(w, r, err)
		return
	}
	s.btEvent(r.Context(), b.ID, map[string]any{"kind": "reload"})
	httpx.JSON(w, http.StatusOK, v)
}

func (s *Server) deleteView(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if !s.allowBaseWrite(w, r, b) {
		return
	}
	if err := s.Store.DeleteView(r.Context(), b.ID, pathID(r, "vid")); err != nil {
		s.fail(w, r, err)
		return
	}
	s.btEvent(r.Context(), b.ID, map[string]any{"kind": "reload"})
	w.WriteHeader(http.StatusNoContent)
}

// checkViewConfig validates an incoming view config against the base's fields.
func (s *Server) checkViewConfig(w http.ResponseWriter, r *http.Request, baseID int64, v store.View) bool {
	if len(v.Config) == 0 || string(v.Config) == "null" {
		return true
	}
	var cfg btquery.Config
	if json.Unmarshal(v.Config, &cfg) != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_config", "config must be a view config object")
		return false
	}
	fields, err := s.Store.Fields(r.Context(), baseID)
	if err != nil {
		s.fail(w, r, err)
		return false
	}
	if err := btquery.Validate(store.Specs(fields), cfg); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_config", err.Error())
		return false
	}
	if cfg.Locked {
		if err := btquery.ValidateLocked(store.Specs(fields), cfg); err != nil {
			httpx.Error(w, http.StatusBadRequest, "unsupported_locked_filter", err.Error())
			return false
		}
	}
	return true
}

// queryBase runs a view config server-side and returns the ordered records.
func (s *Server) queryBase(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	b, ok := s.needBase(w, r, store.RoleView)
	if !ok {
		return
	}
	var in struct {
		Filters *btquery.Filters `json:"filters"`
		Sorts   []btquery.Sort   `json:"sorts"`
		Limit   int              `json:"limit"`
		ViewID  *int64           `json:"viewId"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	u, _ := UserFrom(r.Context())
	read, err := s.readBaseAllowed(r.Context(), u.ID, b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if in.ViewID != nil {
		found := false
		for _, view := range read.views {
			if view.ID == *in.ViewID {
				found = true
				break
			}
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "not_found", "view not found")
			return
		}
	}
	cfg := btquery.Config{Filters: in.Filters, Sorts: in.Sorts}
	// A hidden field cannot be used as a filter or sort oracle.
	if err := btquery.Validate(store.Specs(read.fields), cfg); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_query", err.Error())
		return
	}
	// Link IDs and derived values must not be queried against raw cells:
	// that would reveal inaccessible associations through result membership.
	// Until the query engine supports authorized projection, fail explicitly.
	unsafe := map[int64]bool{}
	for _, field := range read.fields {
		switch field.Type {
		case "link", "lookup", "formula", "created_by", "created_at", "modified_at":
			unsafe[field.ID] = true
		}
	}
	if cfg.Filters != nil {
		for _, rule := range cfg.Filters.Rules {
			if unsafe[rule.F] {
				httpx.Error(w, http.StatusBadRequest, "unsupported_query", "关联及派生字段暂不支持筛选")
				return
			}
		}
	}
	for _, sort := range cfg.Sorts {
		if unsafe[sort.F] {
			httpx.Error(w, http.StatusBadRequest, "unsupported_query", "关联及派生字段暂不支持排序")
			return
		}
	}
	recs, err := s.Store.QueryRecordsConstrained(r.Context(), b.ID, read.allFields, read.policy.mandatory, cfg, in.Limit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	read.records = stripBaseRecords(recs, read.allFields, read.policy)
	_, targets, err := s.expandBase(r.Context(), u.ID, &read, false)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !s.finishBaseRead(w, r, append([]baseReadable{read}, targets...)) {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"records": read.records})
}

// ---- public forms (collect responses without login) ----

type formField struct {
	ID           int64    `json:"id"`
	Name         string   `json:"name"`
	Type         string   `json:"type"`
	Description  string   `json:"description,omitempty"`
	Options      []string `json:"options,omitempty"`
	OptionColors []int    `json:"optionColors,omitempty"`
}

// formConfig is the saved form definition (bt_views.config for type=form).
type formConfig struct {
	Title  string  `json:"title,omitempty"`
	Desc   string  `json:"desc,omitempty"`
	Fields []int64 `json:"fields"`
}

// getForm serves the public form definition: only the fields included in the
// form config, no record data. No auth — forms are shareable links.
func (s *Server) getForm(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Forms int64 `json:"-"`
	}
	_ = in
	baseID := pathID(r, "id")
	vid := pathID(r, "vid")
	views, err := s.Store.Views(r.Context(), baseID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "base not found")
		return
	}
	var view *store.View
	for i := range views {
		if views[i].ID == vid && views[i].Type == "form" {
			view = &views[i]
			break
		}
	}
	if view == nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "form not found")
		return
	}
	var cfg formConfig
	_ = json.Unmarshal(view.Config, &cfg)
	fields, err := s.Store.Fields(r.Context(), baseID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	byID := map[int64]store.Field{}
	for _, f := range fields {
		byID[f.ID] = f
	}
	out := []formField{}
	for _, fid := range cfg.Fields {
		if f, ok := byID[fid]; ok {
			out = append(out, formField{ID: f.ID, Name: f.Name, Type: f.Type, Description: f.Description, Options: f.Options, OptionColors: f.OptionColors})
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"title": cfg.Title, "desc": cfg.Desc, "fields": out})
}

// submitForm accepts one response from an anonymous visitor.
func (s *Server) submitForm(w http.ResponseWriter, r *http.Request) {
	baseID := pathID(r, "id")
	vid := pathID(r, "vid")
	var in struct {
		Cells map[string]json.RawMessage `json:"cells"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	views, err := s.Store.Views(r.Context(), baseID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "base not found")
		return
	}
	var view *store.View
	for i := range views {
		if views[i].ID == vid && views[i].Type == "form" {
			view = &views[i]
			break
		}
	}
	if view == nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "form not found")
		return
	}
	var cfg formConfig
	_ = json.Unmarshal(view.Config, &cfg)
	allowed := map[string]bool{}
	for _, fid := range cfg.Fields {
		allowed[strconv.FormatInt(fid, 10)] = true
	}
	fields, err := s.Store.Fields(r.Context(), baseID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	for k := range in.Cells {
		if !allowed[k] {
			httpx.Error(w, http.StatusBadRequest, "invalid_field", "字段不在表单中")
			return
		}
	}
	if msg := checkCells(fields, in.Cells); msg != "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_cell", msg)
		return
	}
	for k, v := range in.Cells {
		if len(v) == 0 || string(v) == "null" {
			delete(in.Cells, k)
		}
	}
	if len(in.Cells) == 0 {
		httpx.Error(w, http.StatusBadRequest, "empty", "内容不能为空")
		return
	}
	rec, err := s.Store.AddRecord(r.Context(), store.Record{BaseID: baseID, Cells: in.Cells})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.btEvent(r.Context(), baseID, map[string]any{"kind": "record", "op": "add", "record": rec})
	s.runAutomations(context.Background(), baseID, "form_submit", rec)
	httpx.JSON(w, http.StatusCreated, map[string]any{"ok": true})
}
