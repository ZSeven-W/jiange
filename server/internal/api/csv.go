package api

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type csvRowError struct {
	Row int    `json:"row"`
	Err string `json:"err"`
}

// importCSV creates/updates fields from the header row (types inferred or
// given) and inserts every valid row; invalid rows are skipped and reported.
// POST /api/bases/{id}/import {csv, header, types?}
func (s *Server) importCSV(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	var in struct {
		CSV    string   `json:"csv"`
		Header bool     `json:"header"`
		Types  []string `json:"types"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	reader := csv.NewReader(strings.NewReader(in.CSV))
	reader.FieldsPerRecord = -1
	rows, err := reader.ReadAll()
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_csv", err.Error())
		return
	}
	if len(rows) == 0 {
		httpx.Error(w, http.StatusBadRequest, "empty_csv", "CSV 没有数据")
		return
	}
	u, _ := UserFrom(r.Context())
	ctx := r.Context()

	// resolve columns → fields (reuse an existing field with the same name)
	headers := rows[0]
	data := rows[1:]
	if !in.Header {
		headers = make([]string, len(rows[0]))
		for i := range headers {
			headers[i] = "列" + strconv.Itoa(i+1)
		}
		data = rows
	}
	fields, err := s.Store.Fields(ctx, b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	byName := map[string]store.Field{}
	for _, f := range fields {
		byName[f.Name] = f
	}
	colFields := make([]store.Field, len(headers))
	for i, h := range headers {
		h = strings.TrimSpace(h)
		if h == "" {
			h = "列" + strconv.Itoa(i+1)
		}
		if f, ok := byName[h]; ok {
			colFields[i] = f
			continue
		}
		typ := "text"
		if i < len(in.Types) && in.Types[i] != "" {
			typ = in.Types[i]
		} else {
			typ = inferType(column(data, i))
		}
		f, err := s.Store.AddField(ctx, store.Field{BaseID: b.ID, Name: h, Type: typ})
		if err != nil {
			s.fail(w, r, err)
			return
		}
		colFields[i] = f
	}

	// build records; invalid values skip the row with a report entry
	var recs []store.Record
	var errs []csvRowError
	for ri, row := range data {
		cells := map[string]json.RawMessage{}
		bad := ""
		for ci := range colFields {
			if ci >= len(row) {
				break
			}
			v := strings.TrimSpace(row[ci])
			if v == "" {
				continue
			}
			cell, err := csvValue(colFields[ci], v)
			if err != nil {
				bad = fmt.Sprintf("第 %d 列「%s」：%v", ci+1, colFields[ci].Name, err)
				break
			}
			cells[strconv.FormatInt(colFields[ci].ID, 10)] = cell
		}
		if bad != "" {
			errs = append(errs, csvRowError{Row: ri + 2, Err: bad}) // +2: header + 1-based
			continue
		}
		if len(cells) == 0 {
			continue
		}
		recs = append(recs, store.Record{BaseID: b.ID, Cells: cells, CreatorID: &u.ID})
	}
	if err := s.Store.AddRecordsBulk(ctx, b.ID, recs); err != nil {
		s.fail(w, r, err)
		return
	}
	s.btEvent(ctx, b.ID, map[string]any{"kind": "reload"})
	if errs == nil {
		errs = []csvRowError{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"imported": len(recs), "fields": len(colFields), "errors": errs})
}

// csvValue coerces one CSV cell into the field's JSON representation.
func csvValue(f store.Field, v string) (json.RawMessage, error) {
	mustJSON := func(a any) (json.RawMessage, error) { b, err := json.Marshal(a); return b, err }
	switch f.Type {
	case "number":
		n, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return nil, fmt.Errorf("不是数字")
		}
		return mustJSON(n)
	case "checkbox":
		switch strings.ToLower(v) {
		case "true", "1", "yes", "是", "x":
			return mustJSON(true)
		case "false", "0", "no", "否":
			return mustJSON(false)
		}
		return nil, fmt.Errorf("不是布尔值")
	case "date":
		if _, err := time.Parse("2006-01-02", v); err != nil {
			return nil, fmt.Errorf("日期需要 YYYY-MM-DD")
		}
		return mustJSON(v)
	case "select":
		if !containsStr(f.Options, v) {
			return nil, fmt.Errorf("不是选项之一")
		}
		return mustJSON(v)
	default:
		return mustJSON(v)
	}
}

func containsStr(arr []string, s string) bool {
	for _, x := range arr {
		if x == s {
			return true
		}
	}
	return false
}

func column(rows [][]string, i int) []string {
	var out []string
	for _, r := range rows {
		if i < len(r) && strings.TrimSpace(r[i]) != "" {
			out = append(out, strings.TrimSpace(r[i]))
		}
	}
	return out
}

// inferType looks at the values: all numbers → number, all bool-ish →
// checkbox, all ISO dates → date, otherwise text.
func inferType(values []string) string {
	if len(values) == 0 {
		return "text"
	}
	allNum, allBool, allDate := true, true, true
	for _, v := range values {
		if _, err := strconv.ParseFloat(v, 64); err != nil {
			allNum = false
		}
		switch strings.ToLower(v) {
		case "true", "false", "是", "否":
		default:
			allBool = false
		}
		if _, err := time.Parse("2006-01-02", v); err != nil {
			allDate = false
		}
	}
	switch {
	case allNum:
		return "number"
	case allBool:
		return "checkbox"
	case allDate:
		return "date"
	}
	return "text"
}

// exportCSV streams every record as CSV. GET /api/bases/{id}/export
func (s *Server) exportCSV(w http.ResponseWriter, r *http.Request) {
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
	var buf bytes.Buffer
	wr := csv.NewWriter(&buf)
	header := make([]string, len(fields))
	for i, f := range fields {
		header[i] = f.Name
	}
	_ = wr.Write(header)
	for _, rec := range recs {
		row := make([]string, len(fields))
		for i := range fields {
			row[i] = cellCSV(fields[i], rec)
		}
		_ = wr.Write(row)
	}
	wr.Flush()
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=base-%d.csv", b.ID))
	_, _ = w.Write(buf.Bytes())
}

func cellCSV(f store.Field, rec store.Record) string {
	switch f.Type {
	case "created_by":
		if rec.CreatorID != nil {
			return strconv.FormatInt(*rec.CreatorID, 10)
		}
		return ""
	case "created_at":
		if rec.CreatedAt != nil {
			return rec.CreatedAt.Format("2006-01-02 15:04")
		}
		return ""
	case "modified_at":
		if rec.UpdatedAt != nil {
			return rec.UpdatedAt.Format("2006-01-02 15:04")
		}
		return ""
	}
	raw, ok := rec.Cells[strconv.FormatInt(f.ID, 10)]
	if !ok {
		return ""
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	case []any:
		parts := make([]string, 0, len(x))
		for _, item := range x {
			if s, ok := item.(string); ok {
				parts = append(parts, s)
			} else if m, ok := item.(map[string]any); ok {
				if n, ok := m["name"].(string); ok {
					parts = append(parts, n)
				}
			}
		}
		return strings.Join(parts, "; ")
	}
	return ""
}
