package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/auth"
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
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	v, apiErr := s.Store.AddViewGuarded(r.Context(), guard, v)
	if apiErr != nil {
		s.viewMutationError(w, r, apiErr)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
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
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	if v, err = s.Store.UpdateViewGuarded(r.Context(), guard, *cur, v); err != nil {
		s.viewMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
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
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	if err := s.Store.DeleteViewGuarded(r.Context(), guard, b.ID, pathID(r, "vid")); err != nil {
		s.viewMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	w.WriteHeader(http.StatusNoContent)
}

// viewGuard captures the current session identity; the Store rechecks it and
// the caller's role under the same lock as the actual list mutation.
func (s *Server) viewGuard(w http.ResponseWriter, r *http.Request) (store.BaseWriteGuard, bool) {
	u, _ := UserFrom(r.Context())
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
		return store.BaseWriteGuard{}, false
	}
	return store.BaseWriteGuard{UserID: u.ID, SessionHash: auth.HashToken(cookie.Value), Now: s.now}, true
}

func (s *Server) viewMutationError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限无法修改视图")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "视图不存在")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "view_conflict", "视图列表已变化，或不能删除最后一个视图；请刷新后重试")
	default:
		s.fail(w, r, err)
	}
}

func (s *Server) duplicateView(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if !s.allowBaseWrite(w, r, b) {
		return
	}
	var in struct {
		Name *string `json:"name"`
	}
	if r.ContentLength != 0 && !httpx.Decode(w, r, &in) {
		return
	}
	name := ""
	if in.Name != nil {
		if *in.Name == "" || !utf8.ValidString(*in.Name) || utf8.RuneCountInString(*in.Name) > 100 {
			httpx.Error(w, http.StatusBadRequest, "invalid_name", "view name must be 1-100 characters")
			return
		}
		name = *in.Name
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	v, err := s.Store.DuplicateView(r.Context(), guard, b.ID, pathID(r, "vid"), name)
	if err != nil {
		s.viewMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	httpx.JSON(w, http.StatusCreated, v)
}

func (s *Server) renameView(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if !s.allowBaseWrite(w, r, b) {
		return
	}
	var in struct {
		ExpectedName *string `json:"expectedName"`
		Name         *string `json:"name"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.ExpectedName == nil || in.Name == nil || *in.Name == "" || !utf8.ValidString(*in.Name) || utf8.RuneCountInString(*in.Name) > 100 {
		httpx.Error(w, http.StatusBadRequest, "invalid_name", "view name must be 1-100 characters")
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	v, err := s.Store.RenameViewGuarded(r.Context(), guard, b.ID, pathID(r, "vid"), *in.ExpectedName, *in.Name)
	if err != nil {
		s.viewMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	httpx.JSON(w, http.StatusOK, v)
}

func (s *Server) reorderViews(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if !s.allowBaseWrite(w, r, b) {
		return
	}
	var in struct {
		ExpectedViewIDs []int64 `json:"expectedViewIds"`
		ViewIDs         []int64 `json:"viewIds"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if len(in.ViewIDs) == 0 || len(in.ViewIDs) > 1000 || len(in.ExpectedViewIDs) != len(in.ViewIDs) {
		httpx.Error(w, http.StatusBadRequest, "invalid_views", "请提供完整视图顺序")
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	views, err := s.Store.ReorderViews(r.Context(), guard, b.ID, in.ExpectedViewIDs, in.ViewIDs)
	if err != nil {
		s.viewMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"views": views})
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
	Required     bool     `json:"required,omitempty"`
}

// formConfig is the saved form definition (bt_views.config for type=form).
type formConfig struct {
	Title    string  `json:"title,omitempty"`
	Desc     string  `json:"desc,omitempty"`
	Fields   []int64 `json:"fields"`
	Required []int64 `json:"required,omitempty"`
}

type formValidationError struct{ code, message string }

var publicFormSubmitSlots = make(chan struct{}, 8)

func (e *formValidationError) Error() string { return e.message }

// Missing fields means an unconfigured form: compute a default only during
// publication/configuration and persist it before exposing the link. An
// explicit [] or null stays empty and never expands with future schema changes.
func preparePublicForm(view store.View, fields []store.Field, allowDefault, requireFields bool) (formConfig, json.RawMessage, error) {
	var cfg formConfig
	raw := view.Config
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	var object map[string]json.RawMessage
	if !validPublicFormJSON(raw) || json.Unmarshal(raw, &object) != nil || object == nil || json.Unmarshal(raw, &cfg) != nil {
		return cfg, nil, &formValidationError{"invalid_form", "表单配置无效"}
	}
	if utf8.RuneCountInString(cfg.Title) > 200 || utf8.RuneCountInString(cfg.Desc) > 10000 || strings.ContainsRune(cfg.Title, 0) || strings.ContainsRune(cfg.Desc, 0) {
		return cfg, nil, &formValidationError{"invalid_form", "表单标题或说明无效"}
	}
	if _, exists := object["fields"]; !exists {
		if !allowDefault {
			return cfg, nil, &formValidationError{"invalid_form", "表单字段未配置，请联系管理者"}
		}
		cfg.Fields = []int64{}
		for _, field := range fields {
			if store.PublicFormSupportsField(field.Type) {
				cfg.Fields = append(cfg.Fields, field.ID)
			}
		}
		encoded, _ := json.Marshal(cfg.Fields)
		object["fields"] = encoded
	}
	if len(cfg.Fields) > 1000 || len(cfg.Required) > 1000 || (requireFields && len(cfg.Fields) == 0) {
		return cfg, nil, &formValidationError{"invalid_form", "请选择至少一个可填写字段"}
	}
	available := make(map[int64]store.Field, len(fields))
	for _, field := range fields {
		available[field.ID] = field
	}
	selected := make(map[int64]bool, len(cfg.Fields))
	for _, id := range cfg.Fields {
		field, ok := available[id]
		if id <= 0 || !ok || selected[id] || !store.PublicFormSupportsField(field.Type) {
			return cfg, nil, &formValidationError{"invalid_form", "表单字段不存在、重复或暂不支持"}
		}
		selected[id] = true
	}
	required := make(map[int64]bool, len(cfg.Required))
	for _, id := range cfg.Required {
		if !selected[id] || required[id] {
			return cfg, nil, &formValidationError{"invalid_form", "必填字段必须属于可填写字段且不能重复"}
		}
		required[id] = true
	}
	encoded, err := json.Marshal(object)
	if err != nil {
		return cfg, nil, &formValidationError{"invalid_form", "表单配置无效"}
	}
	return cfg, encoded, nil
}

// A public link is a bearer capability. Decode and canonicalize it before
// hashing so one secret has exactly one accepted URL representation.
func publicFormHash(token string) ([]byte, bool) {
	if len(token) != 43 {
		return nil, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != 32 || base64.RawURLEncoding.EncodeToString(raw) != token {
		return nil, false
	}
	hash := sha256.Sum256(raw)
	return hash[:], true
}

func (s *Server) legacyPublicForm(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.Error(w, http.StatusNotFound, "not_found", "form not found")
}

// Publication changes a bearer capability. Require a JSON body even when
// empty and reject a browser's cross-origin request independently of SameSite.
func publicFormJSONRequest(w http.ResponseWriter, r *http.Request) bool {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" || r.ContentLength == 0 {
		httpx.Error(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "expected nonempty application/json")
		return false
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		httpx.Error(w, http.StatusForbidden, "forbidden", "cross-origin publication is not allowed")
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") || !strings.EqualFold(u.Host, r.Host) || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			httpx.Error(w, http.StatusForbidden, "forbidden", "cross-origin publication is not allowed")
			return false
		}
	}
	return true
}

type formPublicationRequest struct {
	ExpectedRevision *int64          `json:"expectedRevision"`
	ExpectedConfig   json.RawMessage `json:"expectedConfig"`
	ExpectedFields   []store.Field   `json:"expectedFields"`
}

func publicFormMutationRequest(w http.ResponseWriter, r *http.Request) (formPublicationRequest, bool) {
	var in formPublicationRequest
	if !publicFormJSONRequest(w, r) {
		return in, false
	}
	if !httpx.Decode(w, r, &in) {
		return in, false
	}
	if in.ExpectedRevision == nil || *in.ExpectedRevision < 0 || *in.ExpectedRevision > 9007199254740991 {
		httpx.Error(w, http.StatusBadRequest, "invalid_revision", "请重新检查表单发布状态")
		return in, false
	}
	return in, true
}

func (s *Server) publicFormMutationError(w http.ResponseWriter, r *http.Request, err error) {
	var invalid *formValidationError
	if errors.As(err, &invalid) {
		httpx.Error(w, http.StatusBadRequest, invalid.code, invalid.message)
		return
	}
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "form_conflict", "表单发布状态已变化，请重新检查")
		return
	}
	s.viewMutationError(w, r, err)
}

func (s *Server) publicFormStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	b, ok := s.needBase(w, r, store.RoleManage)
	if !ok {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	published, revision, err := s.Store.PublicFormPublished(r.Context(), guard, b.ID, pathID(r, "vid"))
	if err != nil {
		s.publicFormMutationError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"published": published, "revision": revision})
}

func (s *Server) publishPublicForm(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	b, ok := s.needBase(w, r, store.RoleManage)
	if !ok {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	in, ok := publicFormMutationRequest(w, r)
	if !ok {
		return
	}
	if len(in.ExpectedConfig) == 0 || in.ExpectedFields == nil {
		httpx.Error(w, http.StatusBadRequest, "missing_snapshot", "请先检查表单字段再发布")
		return
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		s.fail(w, r, err)
		return
	}
	hash := sha256.Sum256(raw[:])
	snapshot := &store.PublicFormPublishSnapshot{Config: in.ExpectedConfig, Fields: in.ExpectedFields, Prepare: func(view store.View, fields []store.Field) (json.RawMessage, error) {
		_, config, err := preparePublicForm(view, fields, true, true)
		return config, err
	}}
	revision, err := s.Store.SetPublicFormToken(r.Context(), guard, b.ID, pathID(r, "vid"), *in.ExpectedRevision, hash[:], snapshot)
	if err != nil {
		s.publicFormMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	// The token can be retrieved only in this response. A subsequent publish
	// rotates it; ambiguous responses must never be retried automatically.
	httpx.JSON(w, http.StatusOK, map[string]any{"token": base64.RawURLEncoding.EncodeToString(raw[:]), "revision": revision})
}

func (s *Server) closePublicForm(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	b, ok := s.needBase(w, r, store.RoleManage)
	if !ok {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	in, ok := publicFormMutationRequest(w, r)
	if !ok {
		return
	}
	revision, err := s.Store.SetPublicFormToken(r.Context(), guard, b.ID, pathID(r, "vid"), *in.ExpectedRevision, nil, nil)
	if err != nil {
		s.publicFormMutationError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"published": false, "revision": revision})
}

// savePublicFormConfig updates only form-facing settings against the exact
// configuration and schema shown in the manager's preview.
func (s *Server) savePublicFormConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	b, ok := s.needBase(w, r, store.RoleManage)
	if !ok {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok || !publicFormJSONRequest(w, r) {
		return
	}
	var in struct {
		ExpectedConfig json.RawMessage `json:"expectedConfig"`
		ExpectedFields []store.Field   `json:"expectedFields"`
		Config         json.RawMessage `json:"config"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if len(in.ExpectedConfig) == 0 || in.ExpectedFields == nil || len(in.Config) == 0 {
		httpx.Error(w, http.StatusBadRequest, "missing_snapshot", "请先检查表单字段再保存")
		return
	}
	view, err := s.Store.SetPublicFormConfig(r.Context(), guard, b.ID, pathID(r, "vid"), in.ExpectedConfig, in.ExpectedFields, func(current store.View, fields []store.Field) (json.RawMessage, error) {
		if !store.PublicFormConfigExtrasEqual(current.Config, in.Config) {
			return nil, &formValidationError{"invalid_form", "不能通过表单设置修改其他视图配置"}
		}
		candidate := current
		candidate.Config = in.Config
		_, config, err := preparePublicForm(candidate, fields, false, false)
		return config, err
	})
	if err != nil {
		s.publicFormMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"config": view.Config})
}

func (s *Server) resolvePublicForm(w http.ResponseWriter, r *http.Request) (int64, int64, []byte, bool) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	hash, ok := publicFormHash(r.PathValue("token"))
	if !ok {
		httpx.Error(w, http.StatusNotFound, "not_found", "form not found")
		return 0, 0, nil, false
	}
	baseID, viewID, err := s.Store.LookupPublicForm(r.Context(), hash)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "form not found")
		return 0, 0, nil, false
	}
	if err != nil {
		s.fail(w, r, err)
		return 0, 0, nil, false
	}
	return baseID, viewID, hash, true
}

// getForm serves the public form definition: only the fields included in the
// form config, no record data. No auth — forms are shareable links.
func (s *Server) getForm(w http.ResponseWriter, r *http.Request) {
	baseID, vid, hash, ok := s.resolvePublicForm(w, r)
	if !ok {
		return
	}
	view, fields, err := s.Store.ReadPublicForm(r.Context(), baseID, vid, hash)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "form not found")
		} else {
			s.fail(w, r, err)
		}
		return
	}
	cfg, _, err := preparePublicForm(view, fields, false, false)
	if err != nil {
		s.publicFormMutationError(w, r, err)
		return
	}
	byID := map[int64]store.Field{}
	for _, f := range fields {
		byID[f.ID] = f
	}
	out := []formField{}
	required := make(map[int64]bool, len(cfg.Required))
	for _, id := range cfg.Required {
		required[id] = true
	}
	for _, fid := range cfg.Fields {
		if f, ok := byID[fid]; ok {
			out = append(out, formField{ID: f.ID, Name: f.Name, Type: f.Type, Description: f.Description, Options: f.Options, OptionColors: f.OptionColors, Required: required[fid]})
		}
	}
	// Narrow the revoke race between snapshot materialization and response.
	currentBase, currentView, err := s.Store.LookupPublicForm(r.Context(), hash)
	if errors.Is(err, store.ErrNotFound) || err == nil && (currentBase != baseID || currentView != vid) {
		httpx.Error(w, http.StatusNotFound, "not_found", "form not found")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"title": cfg.Title, "desc": cfg.Desc, "fields": out})
}

// PostgreSQL jsonb rejects NUL and invalid UTF-8; reject them consistently in
// memory too, before attempting the record transaction.
func validPublicFormJSON(raw json.RawMessage) bool {
	if !utf8.Valid(raw) || !validJSONSurrogates(raw) {
		return false
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return false
	}
	var valid func(any) bool
	valid = func(v any) bool {
		switch x := v.(type) {
		case string:
			return !strings.ContainsRune(x, 0)
		case []any:
			for _, item := range x {
				if !valid(item) {
					return false
				}
			}
		case map[string]any:
			for key, item := range x {
				if strings.ContainsRune(key, 0) || !valid(item) {
					return false
				}
			}
		}
		return true
	}
	return valid(value)
}

func publicFormValuePresent(raw json.RawMessage) bool {
	var value any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return false
	}
	switch x := value.(type) {
	case string:
		return strings.TrimSpace(x) != ""
	case []any:
		return len(x) != 0
	default:
		return true
	}
}

// encoding/json replaces unpaired UTF-16 escapes with U+FFFD while PostgreSQL
// jsonb rejects them; reject them consistently instead of altering input.
func validJSONSurrogates(raw []byte) bool {
	inString := false
	for i := 0; i < len(raw); i++ {
		if !inString {
			if raw[i] == '"' {
				inString = true
			}
			continue
		}
		if raw[i] == '"' {
			inString = false
			continue
		}
		if raw[i] != '\\' {
			continue
		}
		i++
		if i >= len(raw) {
			return false
		}
		if raw[i] != 'u' {
			continue
		}
		if i+4 >= len(raw) {
			return false
		}
		code, err := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if code >= 0xdc00 && code <= 0xdfff {
			return false
		}
		if code >= 0xd800 && code <= 0xdbff {
			if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return !inString
}

// submitForm accepts one response from an anonymous visitor.
func (s *Server) submitForm(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	select {
	case publicFormSubmitSlots <- struct{}{}:
		defer func() { <-publicFormSubmitSlots }()
	default:
		w.Header().Set("Retry-After", "1")
		httpx.Error(w, http.StatusServiceUnavailable, "form_busy", "表单繁忙，请稍后重试")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	baseID, vid, hash, ok := s.resolvePublicForm(w, r)
	if !ok {
		return
	}
	var in struct {
		Cells map[string]json.RawMessage `json:"cells"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	// Validate against the current form definition and schema inside the same
	// critical section as the record and event. A concurrent form or field
	// change cannot turn a previously valid request into a stale write.
	rec, err := s.Store.SubmitPublicForm(r.Context(), baseID, vid, hash, func(view store.View, fields []store.Field) (map[string]json.RawMessage, error) {
		cfg, _, err := preparePublicForm(view, fields, false, false)
		if err != nil {
			return nil, err
		}
		allowed := make(map[string]bool, len(cfg.Fields))
		for _, fid := range cfg.Fields {
			allowed[strconv.FormatInt(fid, 10)] = true
		}
		byID := make(map[string]store.Field, len(fields))
		for _, f := range fields {
			byID[strconv.FormatInt(f.ID, 10)] = f
		}
		clean := make(map[string]json.RawMessage, len(in.Cells))
		for k, v := range in.Cells {
			if !allowed[k] {
				return nil, &formValidationError{"invalid_field", "字段不在表单中"}
			}
			f, exists := byID[k]
			if !exists {
				return nil, &formValidationError{"invalid_field", "表单字段已发生变化，请刷新后重试"}
			}
			if len(v) == 0 || string(v) == "null" {
				continue
			}
			if !validPublicFormJSON(v) {
				return nil, &formValidationError{"invalid_cell", "字段包含不支持的字符"}
			}
			// Anonymous forms have no scoped upload token or authorization to
			// enumerate target records. Do not accept forged file or link IDs.
			if f.Type == "link" || f.Type == "attachment" || f.Type == "person" {
				return nil, &formValidationError{"unsupported_form_field", "公开表单暂不支持提交关联、附件或人员字段"}
			}
			clean[k] = v
		}
		if msg := checkCells(fields, clean); msg != "" {
			return nil, &formValidationError{"invalid_cell", msg}
		}
		for _, id := range cfg.Required {
			raw, ok := clean[strconv.FormatInt(id, 10)]
			if !ok || !publicFormValuePresent(raw) {
				return nil, &formValidationError{"required_field", "请填写所有必填字段"}
			}
		}
		if len(clean) == 0 {
			return nil, &formValidationError{"empty", "内容不能为空"}
		}
		return clean, nil
	})
	if err != nil {
		if errors.Is(err, store.ErrPublicFormRateLimited) {
			w.Header().Set("Retry-After", "60")
			httpx.Error(w, http.StatusTooManyRequests, "form_rate_limited", "提交过于频繁，请稍后重试")
			return
		}
		var invalid *formValidationError
		if errors.As(err, &invalid) {
			httpx.Error(w, http.StatusBadRequest, invalid.code, invalid.message)
			return
		}
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "form not found")
			return
		}
		s.fail(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(baseID)
	}
	s.runAutomations(context.Background(), baseID, "form_submit", rec)
	httpx.JSON(w, http.StatusCreated, map[string]any{"ok": true})
}
