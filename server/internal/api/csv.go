package api

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type csvRowError struct {
	Row int    `json:"row"`
	Err string `json:"err"`
}

// importCSV validates and publishes schema, records and reload event in one
// guarded transaction; no field or row is published on an operational error.
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
	if !utf8.ValidString(in.CSV) {
		httpx.Error(w, http.StatusBadRequest, "invalid_csv", "CSV 必须使用 UTF-8 编码")
		return
	}
	reader := csv.NewReader(strings.NewReader(preserveCSVBlankLines(strings.TrimPrefix(in.CSV, "\ufeff"))))
	reader.FieldsPerRecord = -1
	var rows [][]string
	for {
		row, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_csv", err.Error())
			return
		}
		if len(rows) >= 10001 || len(row) > 500 {
			httpx.Error(w, http.StatusBadRequest, "csv_too_large", "最多导入 10000 行、500 列")
			return
		}
		rows = append(rows, row)
	}
	if len(rows) == 0 || len(rows[0]) == 0 {
		httpx.Error(w, http.StatusBadRequest, "empty_csv", "CSV 没有数据")
		return
	}
	if len(rows) > 10001 || len(rows[0]) > 500 {
		httpx.Error(w, http.StatusBadRequest, "csv_too_large", "最多导入 10000 行、500 列")
		return
	}
	u, _ := UserFrom(r.Context())
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
		return
	}
	guard := store.BaseWriteGuard{UserID: u.ID, SessionHash: auth.HashToken(cookie.Value), Now: s.now}
	var rowErrors []csvRowError
	var fieldCount int
	count, err := s.Store.ImportBaseCSV(r.Context(), guard, b.ID, func(fields []store.Field) (store.BaseImportPlan, error) {
		plan, errs, e := csvImportPlan(rows, in.Header, in.Types, fields)
		rowErrors, fieldCount = errs, len(plan.Columns)
		return plan, e
	})
	if errors.Is(err, store.ErrUnauthenticated) {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效，未导入数据")
		return
	}
	if errors.Is(err, store.ErrForbidden) || errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限暂不支持导入，未修改数据")
		return
	}
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "import_conflict", "表格已变化，请重试；未修改数据")
		return
	}
	var invalid *csvPlanError
	if errors.As(err, &invalid) {
		httpx.Error(w, http.StatusBadRequest, "invalid_csv", invalid.Error())
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	if rowErrors == nil {
		rowErrors = []csvRowError{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"imported": count, "fields": fieldCount, "errors": rowErrors})
}

type csvPlanError struct{ message string }

func (e *csvPlanError) Error() string { return e.message }

// encoding/csv intentionally discards empty physical lines. A single-column
// CSV exported by this app represents empty records as such lines, so quote
// them only outside a quoted field before parsing. Quoted multiline content
// and malformed input remain for encoding/csv to validate normally.
func preserveCSVBlankLines(input string) string {
	var out strings.Builder
	out.Grow(len(input))
	quoted, fieldStart, lineStart := false, true, true
	for i := 0; i < len(input); i++ {
		c := input[i]
		if lineStart && !quoted && (c == '\n' || c == '\r' && i+1 < len(input) && input[i+1] == '\n') {
			out.WriteString(`""`)
		}
		if c == '"' {
			if quoted && i+1 < len(input) && input[i+1] == '"' {
				out.WriteString(`""`)
				i++
				lineStart = false
				continue
			}
			if quoted || fieldStart {
				quoted = !quoted
			}
		}
		out.WriteByte(c)
		if c == '\n' {
			lineStart = true
			if !quoted {
				fieldStart = true
			}
		} else {
			lineStart = false
			if !quoted {
				fieldStart = c == ','
			}
		}
	}
	return out.String()
}

func csvImportPlan(rows [][]string, header bool, types []string, fields []store.Field) (store.BaseImportPlan, []csvRowError, error) {
	var plan store.BaseImportPlan
	headers, data := rows[0], rows[1:]
	if !header {
		headers, data = make([]string, len(rows[0])), rows
		for i := range headers {
			headers[i] = "列" + strconv.Itoa(i+1)
		}
	}
	if len(data) > 10000 || len(headers) == 0 || len(headers) > 500 {
		return plan, nil, &csvPlanError{"最多导入 10000 行、500 列"}
	}
	byName := map[string]store.Field{}
	ambiguous := map[string]bool{}
	for _, f := range fields {
		if _, ok := byName[f.Name]; ok {
			ambiguous[f.Name] = true
		}
		byName[f.Name] = f
	}
	seen := map[string]bool{}
	columnFields := make([]store.Field, 0, len(headers))
	for i, name := range headers {
		name = strings.TrimSpace(name)
		if name == "" {
			name = "列" + strconv.Itoa(i+1)
		}
		if !utf8.ValidString(name) || utf8.RuneCountInString(name) > 100 || seen[name] || ambiguous[name] {
			return plan, nil, &csvPlanError{fmt.Sprintf("第 %d 列的字段名称无效或重复", i+1)}
		}
		seen[name] = true
		f, exists := byName[name]
		if !exists {
			// Infer only when the exact source spelling is representable; leading
			// or trailing whitespace may be meaningful in text identifiers.
			typ := inferType(columnExact(data, i))
			if i < len(types) && types[i] != "" {
				typ = types[i]
			}
			f = store.Field{Name: name, Type: typ}
			if typ == "select" || typ == "multi_select" {
				optionSeen := map[string]bool{}
				for _, value := range column(data, i) {
					parts := []string{value}
					if typ == "multi_select" {
						parts = strings.Split(value, ";")
					}
					for _, part := range parts {
						part = strings.TrimSpace(part)
						if part != "" && !optionSeen[part] {
							optionSeen[part] = true
							f.Options = append(f.Options, part)
						}
					}
				}
			}
		}
		switch f.Type {
		case "text", "number", "checkbox", "date", "select", "multi_select", "url", "phone", "email", "rating":
		default:
			return plan, nil, &csvPlanError{fmt.Sprintf("字段「%s」的类型暂不支持 CSV 导入", name)}
		}
		c := store.ImportColumn{}
		if exists {
			c.ExistingID = f.ID
		} else {
			c.New = f
		}
		plan.Columns = append(plan.Columns, c)
		columnFields = append(columnFields, f)
	}
	var errs []csvRowError
	for ri, row := range data {
		cells := map[int]json.RawMessage{}
		bad := ""
		if len(row) > len(headers) {
			bad = "列数超过表头"
		}
		for ci := range headers {
			if bad != "" || ci >= len(row) {
				break
			}
			raw := row[ci]
			if raw == "" {
				continue
			}
			f := columnFields[ci]
			value := raw
			if f.Type != "text" {
				value = strings.TrimSpace(raw)
			}
			if value == "" {
				continue
			}
			cell, err := csvValue(f, value)
			if err != nil || !validCell(f, cell) {
				bad = fmt.Sprintf("第 %d 列「%s」的值无效", ci+1, f.Name)
				break
			}
			cells[ci] = cell
		}
		if bad != "" {
			number := ri + 1
			if header {
				number++
			}
			errs = append(errs, csvRowError{Row: number, Err: bad})
			continue
		}
		// A CSV row with explicitly empty cells is still a record. Dropping it
		// silently breaks export/import round trips and changes row positions.
		plan.Rows = append(plan.Rows, cells)
	}
	return plan, errs, nil
}

// importCSVLegacy is kept only as a reference for a future transactional
// implementation. It must not be registered as an HTTP handler.
func (s *Server) importCSVLegacy(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if s.baseChannelAccess(r.Context(), r, b.ID, store.RoleEdit) != nil {
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限暂不支持导入")
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
	if s.baseChannelAccess(ctx, r, b.ID, store.RoleEdit) != nil {
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限暂不支持导入")
		return
	}

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
	case "rating":
		n, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return nil, fmt.Errorf("不是评分")
		}
		return mustJSON(n)
	case "multi_select":
		var values []string
		for _, part := range strings.Split(v, ";") {
			part = strings.TrimSpace(part)
			if part != "" {
				values = append(values, part)
			}
		}
		return mustJSON(values)
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

func containsInt(arr []int64, v int64) bool {
	for _, x := range arr {
		if x == v {
			return true
		}
	}
	return false
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

func columnExact(rows [][]string, i int) []string {
	var out []string
	for _, r := range rows {
		if i < len(r) && r[i] != "" {
			out = append(out, r[i])
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
		if n, err := strconv.ParseFloat(v, 64); err != nil || strconv.FormatFloat(n, 'f', -1, 64) != v {
			allNum = false
		}
		switch v {
		case "true", "false":
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
	w.Header().Set("Cache-Control", "private, no-store")
	b, ok := s.needBase(w, r, store.RoleView)
	if !ok {
		return
	}
	if s.baseExportAccess(r.Context(), r, b.ID) != nil {
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限暂不支持导出")
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
	// The export may have taken long enough for access or view restrictions to
	// change. Do not write headers or buffered data until the final check.
	if s.baseExportAccess(r.Context(), r, b.ID) != nil {
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限暂不支持导出")
		return
	}
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
