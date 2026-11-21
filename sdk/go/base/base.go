package base

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
)

// Table represents a table inside a multidimensional Base.
type Table struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

// Field defines a typed column in a Base Table.
type Field struct {
	ID         int      `json:"id"`
	TableID    int      `json:"tableId"`
	Name       string   `json:"name"`
	Type       string   `json:"type"`
	IsPrimary  bool     `json:"isPrimary,omitempty"`
	Options    []string `json:"options,omitempty"`
	Expression string   `json:"expression,omitempty"`
}

// Record holds a row of cell values keyed by field ID string (or field name).
type Record struct {
	ID      int            `json:"id"`
	TableID int            `json:"tableId"`
	Cells   map[string]any `json:"cells"`
}

// Base is the pure-Go headless multidimensional database model.
type Base struct {
	Name    string   `json:"name"`
	Tables  []Table  `json:"tables"`
	Fields  []Field  `json:"fields"`
	Records []Record `json:"records"`
}

// Op represents an atomic Base mutation (addTable, addField, addRecord, updateRecord, deleteRecord).
type Op struct {
	Op         string         `json:"op"`
	TableID    int            `json:"tableId,omitempty"`
	RecordID   int            `json:"recordId,omitempty"`
	Cells      map[string]any `json:"cells,omitempty"`
	Name       string         `json:"name,omitempty"`
	Type       string         `json:"type,omitempty"`
	Expression string         `json:"expression,omitempty"`
}

// Diagnostic reports schema or formula integrity issues.
type Diagnostic struct {
	Code       string `json:"code"`
	Severity   string `json:"severity"`
	TableID    int    `json:"tableId,omitempty"`
	Message    string `json:"message"`
	Suggestion string `json:"suggestion"`
}

var newBytesWriter = func(buf *bytes.Buffer) io.Writer { return buf }

// ParseCSV infers a single-table Base from RFC 4180 CSV bytes.
func ParseCSV(data []byte, name string) (*Base, error) {
	if strings.TrimSpace(name) == "" {
		name = "Untitled Base"
	}
	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil {
		return nil, err
	}
	b := &Base{
		Name:    name,
		Tables:  []Table{{ID: 1, Name: "Table 1"}},
		Fields:  make([]Field, 0),
		Records: make([]Record, 0),
	}
	if len(rows) == 0 {
		return b, nil
	}
	for i, h := range rows[0] {
		b.Fields = append(b.Fields, Field{
			ID:        i + 1,
			TableID:   1,
			Name:      strings.TrimSpace(h),
			Type:      "text",
			IsPrimary: i == 0,
		})
	}
	for ri, row := range rows[1:] {
		cells := make(map[string]any, len(row))
		for ci, v := range row {
			if n, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil && ci > 0 {
				cells[strconv.Itoa(ci+1)] = n
			} else {
				cells[strconv.Itoa(ci+1)] = v
			}
		}
		b.Records = append(b.Records, Record{ID: ri + 1, TableID: 1, Cells: cells})
	}
	return b, nil
}

// ToCSV exports records from tableID (or the first table when tableID <= 0) as CSV.
func (b *Base) ToCSV(tableID int) ([]byte, error) {
	if len(b.Tables) == 0 {
		return nil, errors.New("base: no tables available")
	}
	if tableID <= 0 {
		tableID = b.Tables[0].ID
	}
	var fields []Field
	for _, f := range b.Fields {
		if f.TableID == tableID {
			fields = append(fields, f)
		}
	}
	if len(fields) == 0 {
		return nil, fmt.Errorf("base: table %d has no fields", tableID)
	}
	var buf bytes.Buffer
	w := csv.NewWriter(newBytesWriter(&buf))
	header := make([]string, len(fields))
	for i, f := range fields {
		header[i] = f.Name
	}
	if err := w.Write(header); err != nil {
		return nil, err
	}
	for _, rec := range b.Records {
		if rec.TableID != tableID {
			continue
		}
		row := make([]string, len(fields))
		for i, f := range fields {
			if f.Type == "formula" && strings.TrimSpace(f.Expression) != "" {
				if val, err := b.EvalExpr(f.Expression, rec); err == nil {
					row[i] = formatScalar(val)
				} else {
					row[i] = "#ERROR!"
				}
				continue
			}
			val := b.cellValueForField(rec, f)
			row[i] = formatScalar(val)
		}
		if err := w.Write(row); err != nil {
			return nil, err
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func (b *Base) cellValueForField(rec Record, f Field) any {
	if v, ok := rec.Cells[strconv.Itoa(f.ID)]; ok {
		return v
	}
	if v, ok := rec.Cells[f.Name]; ok {
		return v
	}
	return ""
}

// EvalExpr evaluates a Base formula expression with [Field] references against rec.
func (b *Base) EvalExpr(expr string, rec Record) (any, error) {
	fieldByName := make(map[string]Field)
	for _, f := range b.Fields {
		if f.TableID == rec.TableID {
			fieldByName[strings.ToLower(strings.TrimSpace(f.Name))] = f
		}
	}
	lookup := func(name string) (any, error) {
		key := strings.ToLower(strings.TrimSpace(name))
		if f, ok := fieldByName[key]; ok {
			return b.cellValueForField(rec, f), nil
		}
		if v, ok := rec.Cells[name]; ok {
			return v, nil
		}
		return nil, fmt.Errorf("base: unknown field [%s]", name)
	}
	return evalExprNode(strings.TrimSpace(expr), lookup)
}

func evalExprNode(expr string, lookup func(string) (any, error)) (any, error) {
	expr = strings.TrimSpace(expr)
	if expr == "" {
		return "", nil
	}
	// Function call: IF, ROUND, ABS, CONCAT, LEN, UPPER, LOWER
	if lp := strings.IndexByte(expr, '('); lp > 0 && strings.HasSuffix(expr, ")") {
		fn := strings.ToUpper(strings.TrimSpace(expr[:lp]))
		validIdent := true
		for i := 0; i < len(fn); i++ {
			if !((fn[i] >= 'A' && fn[i] <= 'Z') || fn[i] == '_') {
				validIdent = false
				break
			}
		}
		if validIdent && balancedDelims(expr[lp:]) {
			return evalBaseFunc(fn, splitExprArgs(expr[lp+1:len(expr)-1]), lookup)
		}
	}

	// Comparisons
	for _, op := range []string{">=", "<=", "<>", "!=", "=", ">", "<"} {
		if idx := findExprOp(expr, op); idx >= 0 {
			lv, err := evalExprNode(expr[:idx], lookup)
			if err != nil {
				return nil, err
			}
			rv, err := evalExprNode(expr[idx+len(op):], lookup)
			if err != nil {
				return nil, err
			}
			return compareScalars(lv, rv, op), nil
		}
	}

	// Binary + and -
	if idx, op := findLastExprAddSub(expr); idx > 0 {
		lv, err := evalExprNode(expr[:idx], lookup)
		if err != nil {
			return nil, err
		}
		rv, err := evalExprNode(expr[idx+1:], lookup)
		if err != nil {
			return nil, err
		}
		ln, ok1 := toFloat(lv)
		rn, ok2 := toFloat(rv)
		if op == '+' && (!ok1 || !ok2) {
			return formatScalar(lv) + formatScalar(rv), nil
		}
		if !ok1 || !ok2 {
			return nil, errors.New("base: numeric operands required")
		}
		if op == '+' {
			return ln + rn, nil
		}
		return ln - rn, nil
	}

	// Binary * and /
	if idx, op := findLastExprMulDiv(expr); idx > 0 {
		lv, err := evalExprNode(expr[:idx], lookup)
		if err != nil {
			return nil, err
		}
		rv, err := evalExprNode(expr[idx+1:], lookup)
		if err != nil {
			return nil, err
		}
		ln, ok1 := toFloat(lv)
		rn, ok2 := toFloat(rv)
		if !ok1 || !ok2 {
			return nil, errors.New("base: numeric operands required")
		}
		if op == '*' {
			return ln * rn, nil
		}
		if rn == 0 {
			return nil, errors.New("base: division by zero")
		}
		return ln / rn, nil
	}

	// Parentheses
	if strings.HasPrefix(expr, "(") && strings.HasSuffix(expr, ")") && balancedDelims(expr) {
		return evalExprNode(expr[1:len(expr)-1], lookup)
	}
	// [Field] reference
	if strings.HasPrefix(expr, "[") && strings.HasSuffix(expr, "]") {
		return lookup(expr[1 : len(expr)-1])
	}
	// String literal
	if len(expr) >= 2 && expr[0] == '"' && expr[len(expr)-1] == '"' {
		return expr[1 : len(expr)-1], nil
	}
	// Number literal
	if n, err := strconv.ParseFloat(expr, 64); err == nil {
		return n, nil
	}
	if strings.EqualFold(expr, "TRUE") {
		return true, nil
	}
	if strings.EqualFold(expr, "FALSE") {
		return false, nil
	}
	return nil, fmt.Errorf("base: invalid expression token %q", expr)
}

func evalBaseFunc(fn string, args []string, lookup func(string) (any, error)) (any, error) {
	switch fn {
	case "IF":
		if len(args) < 2 {
			return nil, errors.New("base: IF requires at least 2 arguments")
		}
		cond, err := evalExprNode(args[0], lookup)
		if err != nil {
			return nil, err
		}
		if toBool(cond) {
			return evalExprNode(args[1], lookup)
		}
		if len(args) >= 3 {
			return evalExprNode(args[2], lookup)
		}
		return false, nil
	case "ABS":
		if len(args) != 1 {
			return nil, errors.New("base: ABS requires 1 argument")
		}
		v, err := evalExprNode(args[0], lookup)
		if err != nil {
			return nil, err
		}
		n, ok := toFloat(v)
		if !ok {
			return nil, errors.New("base: ABS requires a number")
		}
		return math.Abs(n), nil
	case "ROUND":
		if len(args) < 1 || len(args) > 2 {
			return nil, errors.New("base: ROUND requires 1 or 2 arguments")
		}
		v, err := evalExprNode(args[0], lookup)
		if err != nil {
			return nil, err
		}
		n, ok := toFloat(v)
		if !ok {
			return nil, errors.New("base: ROUND requires a number")
		}
		digits := 0.0
		if len(args) == 2 {
			dv, err := evalExprNode(args[1], lookup)
			if err != nil {
				return nil, err
			}
			digits, _ = toFloat(dv)
		}
		pow := math.Pow(10, digits)
		return math.Round(n*pow) / pow, nil
	case "CONCAT":
		var sb strings.Builder
		for _, a := range args {
			v, err := evalExprNode(a, lookup)
			if err != nil {
				return nil, err
			}
			sb.WriteString(formatScalar(v))
		}
		return sb.String(), nil
	case "LEN", "UPPER", "LOWER":
		if len(args) != 1 {
			return nil, fmt.Errorf("base: %s requires 1 argument", fn)
		}
		v, err := evalExprNode(args[0], lookup)
		if err != nil {
			return nil, err
		}
		s := formatScalar(v)
		if fn == "LEN" {
			return float64(len([]rune(s))), nil
		}
		if fn == "UPPER" {
			return strings.ToUpper(s), nil
		}
		return strings.ToLower(s), nil
	default:
		return nil, fmt.Errorf("base: unknown function %s", fn)
	}
}

func balancedDelims(s string) bool {
	depth := 0
	inStr := false
	inBrack := false
	for i := 0; i < len(s); i++ {
		if s[i] == '"' && !inBrack {
			inStr = !inStr
			continue
		}
		if inStr {
			continue
		}
		if s[i] == '[' {
			inBrack = true
		} else if s[i] == ']' {
			inBrack = false
		} else if !inBrack {
			if s[i] == '(' {
				depth++
			} else if s[i] == ')' {
				depth--
				if depth < 0 || (depth == 0 && i < len(s)-1) {
					return false
				}
			}
		}
	}
	return depth == 0
}

func splitExprArgs(s string) []string {
	var out []string
	depth := 0
	inStr := false
	inBrack := false
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '"' && !inBrack {
			inStr = !inStr
		} else if !inStr {
			if s[i] == '[' {
				inBrack = true
			} else if s[i] == ']' {
				inBrack = false
			} else if !inBrack {
				if s[i] == '(' {
					depth++
				} else if s[i] == ')' {
					depth--
				} else if s[i] == ',' && depth == 0 {
					out = append(out, strings.TrimSpace(s[start:i]))
					start = i + 1
				}
			}
		}
	}
	if rest := strings.TrimSpace(s[start:]); rest != "" {
		out = append(out, rest)
	}
	return out
}

func findExprOp(s, op string) int {
	depth := 0
	inStr := false
	inBrack := false
	for i := 0; i <= len(s)-len(op); i++ {
		if s[i] == '"' && !inBrack {
			inStr = !inStr
			continue
		}
		if inStr {
			continue
		}
		if s[i] == '[' {
			inBrack = true
		} else if s[i] == ']' {
			inBrack = false
		} else if !inBrack {
			if s[i] == '(' {
				depth++
			} else if s[i] == ')' {
				depth--
			} else if depth == 0 && s[i:i+len(op)] == op {
				if len(op) == 1 && (op == "=" || op == "<" || op == ">") {
					if i > 0 && (s[i-1] == '<' || s[i-1] == '>' || s[i-1] == '!') {
						continue
					}
					if i+1 < len(s) && (s[i+1] == '=' || s[i+1] == '>') {
						continue
					}
				}
				return i
			}
		}
	}
	return -1
}

func findLastExprAddSub(s string) (int, byte) {
	depth := 0
	inStr := false
	inBrack := false
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '"' && !inBrack {
			inStr = !inStr
		} else if !inStr {
			if s[i] == ']' {
				inBrack = true
			} else if s[i] == '[' {
				inBrack = false
			} else if !inBrack {
				if s[i] == ')' {
					depth++
				} else if s[i] == '(' {
					depth--
				} else if depth == 0 && (s[i] == '+' || s[i] == '-') && i > 0 {
					prev := strings.TrimSpace(s[:i])
					if prev != "" && !strings.HasSuffix(prev, "(") && !strings.HasSuffix(prev, ",") && !strings.HasSuffix(prev, "+") && !strings.HasSuffix(prev, "-") && !strings.HasSuffix(prev, "*") && !strings.HasSuffix(prev, "/") {
						return i, s[i]
					}
				}
			}
		}
	}
	return -1, 0
}

func findLastExprMulDiv(s string) (int, byte) {
	depth := 0
	inStr := false
	inBrack := false
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '"' && !inBrack {
			inStr = !inStr
		} else if !inStr {
			if s[i] == ']' {
				inBrack = true
			} else if s[i] == '[' {
				inBrack = false
			} else if !inBrack {
				if s[i] == ')' {
					depth++
				} else if s[i] == '(' {
					depth--
				} else if depth == 0 && (s[i] == '*' || s[i] == '/') {
					return i, s[i]
				}
			}
		}
	}
	return -1, 0
}

func compareScalars(lv, rv any, op string) bool {
	if ln, ok1 := toFloat(lv); ok1 {
		if rn, ok2 := toFloat(rv); ok2 {
			switch op {
			case "=":
				return ln == rn
			case "<>", "!=":
				return ln != rn
			case ">":
				return ln > rn
			case ">=":
				return ln >= rn
			case "<":
				return ln < rn
			default:
				return ln <= rn
			}
		}
	}
	ls, rs := formatScalar(lv), formatScalar(rv)
	switch op {
	case "=":
		return ls == rs
	case "<>", "!=":
		return ls != rs
	case ">":
		return ls > rs
	case ">=":
		return ls >= rs
	case "<":
		return ls < rs
	default:
		return ls <= rs
	}
}

func formatScalar(v any) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case float64:
		if math.Trunc(x) == x {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		if x {
			return "TRUE"
		}
		return "FALSE"
	case string:
		return x
	default:
		return fmt.Sprint(x)
	}
}

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	case string:
		n, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return n, err == nil
	default:
		return 0, false
	}
}

func toBool(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x != "" && !strings.EqualFold(x, "FALSE")
	default:
		return false
	}
}

// Inspect returns a compact schema and count summary across all tables.
func (b *Base) Inspect() map[string]any {
	tables := make([]map[string]any, 0, len(b.Tables))
	for _, t := range b.Tables {
		flds := make([]Field, 0)
		for _, f := range b.Fields {
			if f.TableID == t.ID {
				flds = append(flds, f)
			}
		}
		recCount := 0
		for _, r := range b.Records {
			if r.TableID == t.ID {
				recCount++
			}
		}
		tables = append(tables, map[string]any{
			"id":          t.ID,
			"name":        t.Name,
			"fieldCount":  len(flds),
			"recordCount": recCount,
			"fields":      flds,
		})
	}
	return map[string]any{
		"name":       b.Name,
		"tableCount": len(b.Tables),
		"tables":     tables,
	}
}

// Query filters records by tableID and keyword search.
func (b *Base) Query(tableID int, search string, limit int) []Record {
	if limit <= 0 {
		limit = 200
	}
	needle := strings.ToLower(strings.TrimSpace(search))
	out := make([]Record, 0)
	for _, r := range b.Records {
		if tableID > 0 && r.TableID != tableID {
			continue
		}
		if needle != "" {
			matched := false
			for _, v := range r.Cells {
				if strings.Contains(strings.ToLower(fmt.Sprint(v)), needle) {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}
		out = append(out, r)
		if len(out) >= limit {
			break
		}
	}
	return out
}

// Apply atomically executes Base ops with rollback on error or dryRun.
func (b *Base) Apply(ops []Op, dryRun bool) (int, []string, error) {
	snap, _ := json.Marshal(b)
	restore := func() { _ = json.Unmarshal(snap, b) }

	nextTableID, nextFieldID, nextRecID := 1, 1, 1
	for _, t := range b.Tables {
		if t.ID >= nextTableID {
			nextTableID = t.ID + 1
		}
	}
	for _, f := range b.Fields {
		if f.ID >= nextFieldID {
			nextFieldID = f.ID + 1
		}
	}
	for _, r := range b.Records {
		if r.ID >= nextRecID {
			nextRecID = r.ID + 1
		}
	}

	var diff []string
	for i, op := range ops {
		switch op.Op {
		case "addTable":
			name := strings.TrimSpace(op.Name)
			if name == "" {
				name = fmt.Sprintf("Table %d", nextTableID)
			}
			id := nextTableID
			nextTableID++
			b.Tables = append(b.Tables, Table{ID: id, Name: name})
			diff = append(diff, fmt.Sprintf("added table %q (#%d)", name, id))
		case "addField":
			tid := op.TableID
			if tid == 0 && len(b.Tables) > 0 {
				tid = b.Tables[0].ID
			}
			ft := op.Type
			if ft == "" {
				ft = "text"
			}
			id := nextFieldID
			nextFieldID++
			b.Fields = append(b.Fields, Field{ID: id, TableID: tid, Name: op.Name, Type: ft, Expression: op.Expression})
			diff = append(diff, fmt.Sprintf("added field %q (#%d)", op.Name, id))
		case "addRecord":
			tid := op.TableID
			if tid == 0 && len(b.Tables) > 0 {
				tid = b.Tables[0].ID
			}
			cells := make(map[string]any, len(op.Cells))
			for k, v := range op.Cells {
				cells[k] = v
			}
			id := nextRecID
			nextRecID++
			b.Records = append(b.Records, Record{ID: id, TableID: tid, Cells: cells})
			diff = append(diff, fmt.Sprintf("added record #%d in table #%d", id, tid))
		case "updateRecord":
			idx := -1
			for ri, r := range b.Records {
				if r.ID == op.RecordID {
					idx = ri
					break
				}
			}
			if idx < 0 {
				restore()
				return 0, nil, fmt.Errorf("op[%d]: record %d not found", i, op.RecordID)
			}
			if b.Records[idx].Cells == nil {
				b.Records[idx].Cells = make(map[string]any)
			}
			for k, v := range op.Cells {
				b.Records[idx].Cells[k] = v
			}
			diff = append(diff, fmt.Sprintf("updated record #%d", op.RecordID))
		case "deleteRecord":
			idx := -1
			for ri, r := range b.Records {
				if r.ID == op.RecordID {
					idx = ri
					break
				}
			}
			if idx < 0 {
				restore()
				return 0, nil, fmt.Errorf("op[%d]: record %d not found", i, op.RecordID)
			}
			b.Records = append(b.Records[:idx], b.Records[idx+1:]...)
			diff = append(diff, fmt.Sprintf("deleted record #%d", op.RecordID))
		default:
			restore()
			return 0, nil, fmt.Errorf("op[%d]: unsupported op %q", i, op.Op)
		}
	}
	if dryRun {
		restore()
	}
	return len(diff), diff, nil
}

// Verify checks Base schema consistency, duplicate field names, and formula expressions.
func (b *Base) Verify() []Diagnostic {
	diags := make([]Diagnostic, 0)
	if len(b.Tables) == 0 {
		return []Diagnostic{{
			Code:       "EMPTY_BASE",
			Severity:   "error",
			Message:    "Base has 0 tables.",
			Suggestion: "Add at least one table.",
		}}
	}
	for _, t := range b.Tables {
		names := make(map[string]bool)
		var formulaFields []Field
		for _, f := range b.Fields {
			if f.TableID != t.ID {
				continue
			}
			k := strings.ToLower(strings.TrimSpace(f.Name))
			if names[k] {
				diags = append(diags, Diagnostic{
					Code:       "DUPLICATE_FIELD_NAME",
					Severity:   "error",
					TableID:    t.ID,
					Message:    fmt.Sprintf("Duplicate field name %q in table %q.", f.Name, t.Name),
					Suggestion: "Rename duplicate field so references stay unique.",
				})
			}
			names[k] = true
			if f.Type == "formula" && strings.TrimSpace(f.Expression) != "" {
				formulaFields = append(formulaFields, f)
			}
		}
		for _, ff := range formulaFields {
			for _, rec := range b.Records {
				if rec.TableID != t.ID {
					continue
				}
				if _, err := b.EvalExpr(ff.Expression, rec); err != nil {
					diags = append(diags, Diagnostic{
						Code:       "FORMULA_ERROR",
						Severity:   "error",
						TableID:    t.ID,
						Message:    fmt.Sprintf("Formula field %q failed on record #%d: %v", ff.Name, rec.ID, err),
						Suggestion: "Verify [Field] references and operands in the formula expression.",
					})
					break
				}
			}
		}
	}
	return diags
}
