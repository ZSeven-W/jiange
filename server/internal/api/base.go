package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

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
	httpx.JSON(w, http.StatusOK, map[string]any{"base": b, "fields": fields, "records": recs, "head": head, "members": members, "views": views})
}

type fieldInput struct {
	Name     *string   `json:"name"`
	Type     *string   `json:"type"`
	Options  *[]string `json:"options"`
	Position *float64  `json:"position"`
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
	if in.Position != nil {
		f.Position = *in.Position
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
	u, _ := UserFrom(r.Context())
	var rec store.Record
	if create {
		for k, v := range in.Cells {
			if len(v) == 0 || string(v) == "null" {
				delete(in.Cells, k)
			}
		}
		rec, err = s.Store.AddRecord(r.Context(), store.Record{BaseID: b.ID, Cells: in.Cells, Position: in.Position, CreatorID: &u.ID})
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
