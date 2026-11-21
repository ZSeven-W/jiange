package sheet

import (
	"archive/zip"
	"bytes"
	"encoding/csv"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
)

// Cell stores a raw cell input (literal or formula starting with '=') and its evaluated value.
type Cell struct {
	Row   int    `json:"row"`
	Col   int    `json:"col"`
	A1    string `json:"a1"`
	Raw   string `json:"raw"`
	Value any    `json:"value"`
	Error string `json:"error,omitempty"`
}

// Worksheet represents one tab in a Workbook.
type Worksheet struct {
	Name  string          `json:"name"`
	Cells map[string]Cell `json:"cells"`
}

// Workbook is the pure-Go headless spreadsheet model.
type Workbook struct {
	Sheets []Worksheet `json:"sheets"`
}

// Op represents an atomic spreadsheet mutation (setCell, addSheet, deleteSheet).
type Op struct {
	Op    string `json:"op"`
	Sheet string `json:"sheet,omitempty"`
	A1    string `json:"a1,omitempty"`
	Raw   string `json:"raw,omitempty"`
	Name  string `json:"name,omitempty"`
}

// Diagnostic reports a formula error or structural warning discovered by Verify.
type Diagnostic struct {
	Code       string `json:"code"`
	Severity   string `json:"severity"`
	Sheet      string `json:"sheet"`
	A1         string `json:"a1,omitempty"`
	Message    string `json:"message"`
	Suggestion string `json:"suggestion"`
}

// NewWorkbook creates a Workbook initialized with the given sheet names (defaults to Sheet1).
func NewWorkbook(sheetNames ...string) *Workbook {
	if len(sheetNames) == 0 {
		sheetNames = []string{"Sheet1"}
	}
	sheets := make([]Worksheet, 0, len(sheetNames))
	for _, n := range sheetNames {
		sheets = append(sheets, Worksheet{Name: n, Cells: make(map[string]Cell)})
	}
	return &Workbook{Sheets: sheets}
}

// ColIndexToName converts a 0-based column index to Excel letters (0 -> A, 26 -> AA).
func ColIndexToName(idx int) string {
	idx++
	var buf []byte
	for idx > 0 {
		rem := (idx - 1) % 26
		buf = append([]byte{byte('A' + rem)}, buf...)
		idx = (idx - 1) / 26
	}
	return string(buf)
}

// ParseA1 parses an A1 coordinate like "B12" or "$A$1" into 0-based (row, col).
func ParseA1(ref string) (int, int, bool) {
	ref = strings.ToUpper(strings.TrimSpace(ref))
	ref = strings.ReplaceAll(ref, "$", "")
	i := 0
	for i < len(ref) && ref[i] >= 'A' && ref[i] <= 'Z' {
		i++
	}
	if i == 0 || i == len(ref) {
		return 0, 0, false
	}
	col := 0
	for j := 0; j < i; j++ {
		col = col*26 + int(ref[j]-'A'+1)
	}
	row, err := strconv.Atoi(ref[i:])
	if err != nil || row < 1 {
		return 0, 0, false
	}
	return row - 1, col - 1, true
}

// FormatA1 formats 0-based (row, col) as an A1 reference.
func FormatA1(row, col int) string {
	return fmt.Sprintf("%s%d", ColIndexToName(col), row+1)
}

var newBytesWriter = func(buf *bytes.Buffer) io.Writer { return buf }

// ParseCSV parses RFC 4180 CSV bytes into a single-sheet Workbook and evaluates formulas.
func ParseCSV(data []byte, sheetName string) (*Workbook, error) {
	if strings.TrimSpace(sheetName) == "" {
		sheetName = "Sheet1"
	}
	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil {
		return nil, err
	}
	cells := make(map[string]Cell)
	for ri, row := range rows {
		for ci, val := range row {
			if val == "" {
				continue
			}
			a1 := FormatA1(ri, ci)
			cells[a1] = Cell{Row: ri, Col: ci, A1: a1, Raw: val}
		}
	}
	wb := &Workbook{Sheets: []Worksheet{{Name: sheetName, Cells: cells}}}
	wb.Recalculate()
	return wb, nil
}

// WriteCSV exports the chosen worksheet as RFC 4180 CSV.
func WriteCSV(wb *Workbook, sheetIndex int) ([]byte, error) {
	if wb == nil || len(wb.Sheets) == 0 || sheetIndex < 0 || sheetIndex >= len(wb.Sheets) {
		return nil, errors.New("sheet: worksheet index out of range")
	}
	wb.Recalculate()
	sh := wb.Sheets[sheetIndex]
	maxR, maxC := -1, -1
	for _, c := range sh.Cells {
		if c.Row > maxR {
			maxR = c.Row
		}
		if c.Col > maxC {
			maxC = c.Col
		}
	}
	var buf bytes.Buffer
	w := csv.NewWriter(newBytesWriter(&buf))
	for r := 0; r <= maxR; r++ {
		rec := make([]string, maxC+1)
		for c := 0; c <= maxC; c++ {
			if cell, ok := sh.Cells[FormatA1(r, c)]; ok {
				rec[c] = formatValue(cell.Value, cell.Raw)
			}
		}
		if err := w.Write(rec); err != nil {
			return nil, err
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func formatValue(v any, fallback string) string {
	if v == nil {
		return fallback
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

// ParseXLSX parses a standard OOXML .xlsx archive (sharedStrings, workbook, worksheets).
func ParseXLSX(data []byte) (*Workbook, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("sheet: invalid xlsx zip: %w", err)
	}
	files := make(map[string]*zip.File, len(zr.File))
	for _, f := range zr.File {
		files[strings.ReplaceAll(f.Name, "\\", "/")] = f
	}
	readEntry := func(name string) ([]byte, bool) {
		f, ok := files[name]
		if !ok {
			return nil, false
		}
		rc, err := f.Open()
		if err != nil {
			return nil, false
		}
		defer rc.Close()
		b, err := io.ReadAll(io.LimitReader(rc, 32*1024*1024))
		if err != nil {
			return nil, false
		}
		return b, true
	}

	var sharedStrings []string
	if raw, ok := readEntry("xl/sharedStrings.xml"); ok {
		type sstSI struct {
			T string `xml:"t"`
			R []struct {
				T string `xml:"t"`
			} `xml:"r"`
		}
		var sst struct {
			SI []sstSI `xml:"si"`
		}
		if xml.Unmarshal(raw, &sst) == nil {
			for _, si := range sst.SI {
				if len(si.R) > 0 {
					var sb strings.Builder
					for _, run := range si.R {
						sb.WriteString(run.T)
					}
					sharedStrings = append(sharedStrings, sb.String())
				} else {
					sharedStrings = append(sharedStrings, si.T)
				}
			}
		}
	}

	type wbSheet struct {
		Name string `xml:"name,attr"`
		RID  string `xml:"http://schemas.openxmlformats.org/officeDocument/2006/relationships id,attr"`
	}
	var wbXML struct {
		Sheets []wbSheet `xml:"sheets>sheet"`
	}
	if raw, ok := readEntry("xl/workbook.xml"); ok {
		_ = xml.Unmarshal(raw, &wbXML)
	}
	rels := make(map[string]string)
	if raw, ok := readEntry("xl/_rels/workbook.xml.rels"); ok {
		var relXML struct {
			Items []struct {
				ID     string `xml:"Id,attr"`
				Target string `xml:"Target,attr"`
			} `xml:"Relationship"`
		}
		if xml.Unmarshal(raw, &relXML) == nil {
			for _, r := range relXML.Items {
				t := strings.TrimPrefix(strings.ReplaceAll(r.Target, "\\", "/"), "/")
				if !strings.HasPrefix(t, "xl/") {
					t = "xl/" + t
				}
				rels[r.ID] = t
			}
		}
	}

	wb := &Workbook{}
	for idx, s := range wbXML.Sheets {
		target := rels[s.RID]
		if target == "" {
			target = fmt.Sprintf("xl/worksheets/sheet%d.xml", idx+1)
		}
		raw, ok := readEntry(target)
		if !ok {
			continue
		}
		wb.Sheets = append(wb.Sheets, Worksheet{Name: s.Name, Cells: parseWorksheetXML(raw, sharedStrings)})
	}
	if len(wb.Sheets) == 0 {
		var sheetFiles []string
		for name := range files {
			if strings.HasPrefix(name, "xl/worksheets/sheet") && strings.HasSuffix(name, ".xml") {
				sheetFiles = append(sheetFiles, name)
			}
		}
		sort.Strings(sheetFiles)
		for i, sf := range sheetFiles {
			if raw, ok := readEntry(sf); ok {
				wb.Sheets = append(wb.Sheets, Worksheet{
					Name:  fmt.Sprintf("Sheet%d", i+1),
					Cells: parseWorksheetXML(raw, sharedStrings),
				})
			}
		}
	}
	if len(wb.Sheets) == 0 {
		return nil, errors.New("sheet: no worksheets found in xlsx")
	}
	wb.Recalculate()
	return wb, nil
}

func parseWorksheetXML(raw []byte, sharedStrings []string) map[string]Cell {
	type xmlCell struct {
		Ref string `xml:"r,attr"`
		T   string `xml:"t,attr"`
		F   string `xml:"f"`
		V   string `xml:"v"`
		IS  struct {
			T string `xml:"t"`
		} `xml:"is"`
	}
	type xmlRow struct {
		Cells []xmlCell `xml:"c"`
	}
	var ws struct {
		Rows []xmlRow `xml:"sheetData>row"`
	}
	cells := make(map[string]Cell)
	if xml.Unmarshal(raw, &ws) != nil {
		return cells
	}
	for _, row := range ws.Rows {
		for _, c := range row.Cells {
			rIdx, cIdx, ok := ParseA1(c.Ref)
			if !ok {
				continue
			}
			rawStr := ""
			if c.F != "" {
				if strings.HasPrefix(c.F, "=") {
					rawStr = c.F
				} else {
					rawStr = "=" + c.F
				}
			} else if c.T == "s" {
				if si, err := strconv.Atoi(c.V); err == nil && si >= 0 && si < len(sharedStrings) {
					rawStr = sharedStrings[si]
				}
			} else if c.T == "inlineStr" {
				rawStr = c.IS.T
			} else if c.T == "b" {
				if c.V == "1" {
					rawStr = "TRUE"
				} else {
					rawStr = "FALSE"
				}
			} else {
				rawStr = c.V
			}
			if rawStr == "" {
				continue
			}
			a1 := FormatA1(rIdx, cIdx)
			cells[a1] = Cell{Row: rIdx, Col: cIdx, A1: a1, Raw: rawStr}
		}
	}
	return cells
}

type zipEntry struct {
	name string
	body string
}

// WriteXLSX serializes wb into a valid DEFLATE-compressed OOXML .xlsx archive.
func WriteXLSX(wb *Workbook) ([]byte, error) {
	if wb == nil || len(wb.Sheets) == 0 {
		wb = NewWorkbook("Sheet1")
	}
	wb.Recalculate()
	var entries []zipEntry
	var overrides, wbSheets, wbRels strings.Builder

	for i, sh := range wb.Sheets {
		idx := i + 1
		overrides.WriteString(fmt.Sprintf(`<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`, idx))
		wbSheets.WriteString(fmt.Sprintf(`<sheet name="%s" sheetId="%d" r:id="rId%d"/>`, xmlEscape(sh.Name), idx, idx))
		wbRels.WriteString(fmt.Sprintf(`<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>`, idx, idx))

		byRow := make(map[int][]Cell)
		var rowNums []int
		for _, c := range sh.Cells {
			if _, exists := byRow[c.Row]; !exists {
				rowNums = append(rowNums, c.Row)
			}
			byRow[c.Row] = append(byRow[c.Row], c)
		}
		sort.Ints(rowNums)

		var sheetData strings.Builder
		for _, rn := range rowNums {
			rowCells := byRow[rn]
			sort.Slice(rowCells, func(a, b int) bool { return rowCells[a].Col < rowCells[b].Col })
			sheetData.WriteString(fmt.Sprintf(`<row r="%d">`, rn+1))
			for _, c := range rowCells {
				if strings.HasPrefix(c.Raw, "=") {
					valStr := formatValue(c.Value, "")
					sheetData.WriteString(fmt.Sprintf(`<c r="%s"><f>%s</f><v>%s</v></c>`, c.A1, xmlEscape(c.Raw[1:]), xmlEscape(valStr)))
				} else if num, err := strconv.ParseFloat(c.Raw, 64); err == nil && strings.TrimSpace(c.Raw) != "" {
					sheetData.WriteString(fmt.Sprintf(`<c r="%s"><v>%s</v></c>`, c.A1, strconv.FormatFloat(num, 'f', -1, 64)))
				} else if strings.EqualFold(c.Raw, "TRUE") || strings.EqualFold(c.Raw, "FALSE") {
					bVal := "0"
					if strings.EqualFold(c.Raw, "TRUE") {
						bVal = "1"
					}
					sheetData.WriteString(fmt.Sprintf(`<c r="%s" t="b"><v>%s</v></c>`, c.A1, bVal))
				} else {
					sheetData.WriteString(fmt.Sprintf(`<c r="%s" t="inlineStr"><is><t>%s</t></is></c>`, c.A1, xmlEscape(c.Raw)))
				}
			}
			sheetData.WriteString(`</row>`)
		}

		wsXML := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
			sheetData.String() + `</sheetData></worksheet>`
		entries = append(entries, zipEntry{name: fmt.Sprintf("xl/worksheets/sheet%d.xml", idx), body: wsXML})
	}

	ctXML := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
		`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
		`<Default Extension="xml" ContentType="application/xml"/>` +
		`<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
		overrides.String() + `</Types>`
	relsXML := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
		`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
		`</Relationships>`
	wbXML := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
		wbSheets.String() + `</sheets></workbook>`
	wbRelsXML := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
		wbRels.String() + `</Relationships>`

	entries = append(entries,
		zipEntry{name: "[Content_Types].xml", body: ctXML},
		zipEntry{name: "_rels/.rels", body: relsXML},
		zipEntry{name: "xl/workbook.xml", body: wbXML},
		zipEntry{name: "xl/_rels/workbook.xml.rels", body: wbRelsXML},
	)
	return buildZipBytes(entries)
}

func buildZipBytes(entries []zipEntry) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(newBytesWriter(&buf))
	for _, e := range entries {
		fw, err := zw.Create(e.name)
		if err != nil {
			return nil, err
		}
		if _, err := io.WriteString(fw, e.body); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func xmlEscape(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// Recalculate evaluates all formulas across all worksheets with cycle detection.
func (wb *Workbook) Recalculate() {
	for si := range wb.Sheets {
		sh := &wb.Sheets[si]
		evaluated := make(map[string]bool)
		visiting := make(map[string]bool)
		var evalCell func(a1 string) (any, string)
		evalCell = func(a1 string) (any, string) {
			c, ok := sh.Cells[a1]
			if !ok {
				return 0.0, ""
			}
			if evaluated[a1] {
				return c.Value, c.Error
			}
			if visiting[a1] {
				c.Value = "#CYCLE!"
				c.Error = "#CYCLE!"
				sh.Cells[a1] = c
				return c.Value, c.Error
			}
			if !strings.HasPrefix(c.Raw, "=") {
				if n, err := strconv.ParseFloat(strings.TrimSpace(c.Raw), 64); err == nil {
					c.Value = n
				} else if strings.EqualFold(c.Raw, "TRUE") {
					c.Value = true
				} else if strings.EqualFold(c.Raw, "FALSE") {
					c.Value = false
				} else {
					c.Value = c.Raw
				}
				c.Error = ""
				sh.Cells[a1] = c
				evaluated[a1] = true
				return c.Value, ""
			}
			visiting[a1] = true
			val, errCode := evalFormula(strings.TrimSpace(c.Raw[1:]), evalCell)
			delete(visiting, a1)
			c.Value = val
			c.Error = errCode
			sh.Cells[a1] = c
			evaluated[a1] = true
			return val, errCode
		}
		for a1 := range sh.Cells {
			evalCell(a1)
		}
	}
}

func evalFormula(expr string, getCell func(string) (any, string)) (any, string) {
	expr = strings.TrimSpace(expr)
	if expr == "" {
		return "", ""
	}
	upper := strings.ToUpper(expr)
	if lp := strings.IndexByte(upper, '('); lp > 0 && strings.HasSuffix(expr, ")") {
		fn := strings.TrimSpace(upper[:lp])
		validIdent := true
		for i := 0; i < len(fn); i++ {
			ch := fn[i]
			if !((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '.') {
				validIdent = false
				break
			}
		}
		if validIdent && balancedParens(expr[lp:]) {
			return evalFunction(fn, splitArgs(expr[lp+1:len(expr)-1]), getCell)
		}
	}

	// Comparison operators
	for _, op := range []string{">=", "<=", "<>", "!=", "=", ">", "<"} {
		if idx := findTopLevelOp(expr, op); idx >= 0 {
			lv, ec1 := evalFormula(expr[:idx], getCell)
			if ec1 != "" {
				return ec1, ec1
			}
			rv, ec2 := evalFormula(expr[idx+len(op):], getCell)
			if ec2 != "" {
				return ec2, ec2
			}
			return compareValues(lv, rv, op), ""
		}
	}

	// Binary + and -
	if idx, op := findLastTopLevelAddSub(expr); idx > 0 {
		lv, ec1 := evalFormula(expr[:idx], getCell)
		if ec1 != "" {
			return ec1, ec1
		}
		rv, ec2 := evalFormula(expr[idx+1:], getCell)
		if ec2 != "" {
			return ec2, ec2
		}
		ln, ok1 := toFloat(lv)
		rn, ok2 := toFloat(rv)
		if !ok1 || !ok2 {
			return "#VALUE!", "#VALUE!"
		}
		if op == '+' {
			return ln + rn, ""
		}
		return ln - rn, ""
	}

	// Binary * and /
	if idx, op := findLastTopLevelMulDiv(expr); idx > 0 {
		lv, ec1 := evalFormula(expr[:idx], getCell)
		if ec1 != "" {
			return ec1, ec1
		}
		rv, ec2 := evalFormula(expr[idx+1:], getCell)
		if ec2 != "" {
			return ec2, ec2
		}
		ln, ok1 := toFloat(lv)
		rn, ok2 := toFloat(rv)
		if !ok1 || !ok2 {
			return "#VALUE!", "#VALUE!"
		}
		if op == '*' {
			return ln * rn, ""
		}
		if rn == 0 {
			return "#DIV/0!", "#DIV/0!"
		}
		return ln / rn, ""
	}

	// Parenthesized expression
	if strings.HasPrefix(expr, "(") && strings.HasSuffix(expr, ")") && balancedParens(expr) {
		return evalFormula(expr[1:len(expr)-1], getCell)
	}
	// String literal
	if len(expr) >= 2 && expr[0] == '"' && expr[len(expr)-1] == '"' {
		return expr[1 : len(expr)-1], ""
	}
	// Number literal
	if n, err := strconv.ParseFloat(expr, 64); err == nil {
		return n, ""
	}
	if strings.EqualFold(expr, "TRUE") {
		return true, ""
	}
	if strings.EqualFold(expr, "FALSE") {
		return false, ""
	}
	if r, c, ok := ParseA1(expr); ok {
		return getCell(FormatA1(r, c))
	}
	return "#NAME?", "#NAME?"
}

func evalFunction(fn string, args []string, getCell func(string) (any, string)) (any, string) {
	switch fn {
	case "SUM", "AVERAGE", "MIN", "MAX", "COUNT":
		var nums []float64
		for _, arg := range args {
			vals, ec := expandArgNumbers(arg, getCell)
			if ec != "" {
				return ec, ec
			}
			nums = append(nums, vals...)
		}
		if fn == "COUNT" {
			return float64(len(nums)), ""
		}
		if len(nums) == 0 {
			if fn == "AVERAGE" {
				return "#DIV/0!", "#DIV/0!"
			}
			return 0.0, ""
		}
		if fn == "SUM" || fn == "AVERAGE" {
			sum := 0.0
			for _, n := range nums {
				sum += n
			}
			if fn == "AVERAGE" {
				return sum / float64(len(nums)), ""
			}
			return sum, ""
		}
		best := nums[0]
		for _, n := range nums[1:] {
			if (fn == "MIN" && n < best) || (fn == "MAX" && n > best) {
				best = n
			}
		}
		return best, ""
	case "ABS":
		if len(args) != 1 {
			return "#VALUE!", "#VALUE!"
		}
		v, ec := evalFormula(args[0], getCell)
		if ec != "" {
			return ec, ec
		}
		n, ok := toFloat(v)
		if !ok {
			return "#VALUE!", "#VALUE!"
		}
		return math.Abs(n), ""
	case "ROUND":
		if len(args) < 1 || len(args) > 2 {
			return "#VALUE!", "#VALUE!"
		}
		v, ec := evalFormula(args[0], getCell)
		if ec != "" {
			return ec, ec
		}
		n, ok := toFloat(v)
		if !ok {
			return "#VALUE!", "#VALUE!"
		}
		digits := 0.0
		if len(args) == 2 {
			dv, ec2 := evalFormula(args[1], getCell)
			if ec2 != "" {
				return ec2, ec2
			}
			digits, _ = toFloat(dv)
		}
		pow := math.Pow(10, digits)
		return math.Round(n*pow) / pow, ""
	case "IF":
		if len(args) < 2 {
			return "#VALUE!", "#VALUE!"
		}
		cond, ec := evalFormula(args[0], getCell)
		if ec != "" {
			return ec, ec
		}
		if toBool(cond) {
			return evalFormula(args[1], getCell)
		}
		if len(args) >= 3 {
			return evalFormula(args[2], getCell)
		}
		return false, ""
	default:
		return "#NAME?", "#NAME?"
	}
}

func compareValues(lv, rv any, op string) bool {
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
	ls, rs := formatValue(lv, ""), formatValue(rv, "")
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

func balancedParens(s string) bool {
	depth := 0
	inStr := false
	for i := 0; i < len(s); i++ {
		if s[i] == '"' {
			inStr = !inStr
			continue
		}
		if inStr {
			continue
		}
		if s[i] == '(' {
			depth++
		} else if s[i] == ')' {
			depth--
			if depth < 0 || (depth == 0 && i < len(s)-1) {
				return false
			}
		}
	}
	return depth == 0
}

func splitArgs(s string) []string {
	var out []string
	depth := 0
	inStr := false
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '"' {
			inStr = !inStr
		} else if !inStr {
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
	if rest := strings.TrimSpace(s[start:]); rest != "" {
		out = append(out, rest)
	}
	return out
}

func findTopLevelOp(s, op string) int {
	depth := 0
	inStr := false
	for i := 0; i <= len(s)-len(op); i++ {
		if s[i] == '"' {
			inStr = !inStr
			continue
		}
		if inStr {
			continue
		}
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
	return -1
}

func findLastTopLevelAddSub(s string) (int, byte) {
	depth := 0
	inStr := false
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '"' {
			inStr = !inStr
		} else if !inStr {
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
	return -1, 0
}

func findLastTopLevelMulDiv(s string) (int, byte) {
	depth := 0
	inStr := false
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '"' {
			inStr = !inStr
		} else if !inStr {
			if s[i] == ')' {
				depth++
			} else if s[i] == '(' {
				depth--
			} else if depth == 0 && (s[i] == '*' || s[i] == '/') {
				return i, s[i]
			}
		}
	}
	return -1, 0
}

func expandArgNumbers(arg string, getCell func(string) (any, string)) ([]float64, string) {
	arg = strings.TrimSpace(arg)
	if colon := strings.IndexByte(arg, ':'); colon > 0 {
		r1, c1, ok1 := ParseA1(arg[:colon])
		r2, c2, ok2 := ParseA1(arg[colon+1:])
		if ok1 && ok2 {
			if r1 > r2 {
				r1, r2 = r2, r1
			}
			if c1 > c2 {
				c1, c2 = c2, c1
			}
			var vals []float64
			for r := r1; r <= r2; r++ {
				for c := c1; c <= c2; c++ {
					v, ec := getCell(FormatA1(r, c))
					if ec != "" {
						return nil, ec
					}
					if n, ok := toFloat(v); ok {
						vals = append(vals, n)
					}
				}
			}
			return vals, ""
		}
	}
	v, ec := evalFormula(arg, getCell)
	if ec != "" {
		return nil, ec
	}
	if n, ok := toFloat(v); ok {
		return []float64{n}, ""
	}
	return nil, ""
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

// Inspect returns a compact summary of worksheets, cell/formula/error counts, and optional cells.
func (wb *Workbook) Inspect(detail string) map[string]any {
	wb.Recalculate()
	sheetsOut := make([]map[string]any, 0, len(wb.Sheets))
	totalCells, totalFormulas, totalErrors := 0, 0, 0
	for _, sh := range wb.Sheets {
		formulas, errs := 0, 0
		var sample []Cell
		keys := make([]string, 0, len(sh.Cells))
		for k := range sh.Cells {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			c := sh.Cells[k]
			if strings.HasPrefix(c.Raw, "=") {
				formulas++
			}
			if c.Error != "" {
				errs++
			}
			if detail == "full" || (detail != "summary" && len(sample) < 20) {
				sample = append(sample, c)
			}
		}
		totalCells += len(sh.Cells)
		totalFormulas += formulas
		totalErrors += errs
		entry := map[string]any{
			"name":          sh.Name,
			"nonEmptyCells": len(sh.Cells),
			"formulaCells":  formulas,
			"errorCells":    errs,
		}
		if detail != "summary" {
			entry["cells"] = sample
		}
		sheetsOut = append(sheetsOut, entry)
	}
	return map[string]any{
		"sheetCount":    len(wb.Sheets),
		"totalCells":    totalCells,
		"totalFormulas": totalFormulas,
		"totalErrors":   totalErrors,
		"sheets":        sheetsOut,
	}
}

// Query filters workbook cells by sheet name, keyword, formulas-only, or errors-only.
func (wb *Workbook) Query(sheetName, search string, onlyFormulas, onlyErrors bool, limit int) []map[string]any {
	wb.Recalculate()
	if limit <= 0 {
		limit = 200
	}
	needle := strings.ToLower(strings.TrimSpace(search))
	out := make([]map[string]any, 0)
	for _, sh := range wb.Sheets {
		if sheetName != "" && !strings.EqualFold(sh.Name, sheetName) {
			continue
		}
		keys := make([]string, 0, len(sh.Cells))
		for k := range sh.Cells {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			c := sh.Cells[k]
			if onlyFormulas && !strings.HasPrefix(c.Raw, "=") {
				continue
			}
			if onlyErrors && c.Error == "" {
				continue
			}
			if needle != "" && !strings.Contains(strings.ToLower(c.Raw), needle) && !strings.Contains(strings.ToLower(formatValue(c.Value, "")), needle) {
				continue
			}
			out = append(out, map[string]any{
				"sheet": sh.Name,
				"a1":    c.A1,
				"raw":   c.Raw,
				"value": c.Value,
				"error": c.Error,
			})
			if len(out) >= limit {
				return out
			}
		}
	}
	return out
}

// Apply atomically executes ops with rollback on any error or when dryRun is true.
func (wb *Workbook) Apply(ops []Op, dryRun bool) (int, []string, error) {
	backup := make([]Worksheet, len(wb.Sheets))
	for i, sh := range wb.Sheets {
		copied := make(map[string]Cell, len(sh.Cells))
		for k, v := range sh.Cells {
			copied[k] = v
		}
		backup[i] = Worksheet{Name: sh.Name, Cells: copied}
	}

	var diff []string
	findSheet := func(name string) int {
		if name == "" && len(wb.Sheets) > 0 {
			return 0
		}
		for i := range wb.Sheets {
			if strings.EqualFold(wb.Sheets[i].Name, name) {
				return i
			}
		}
		return -1
	}

	for i, op := range ops {
		switch op.Op {
		case "setCell":
			idx := findSheet(op.Sheet)
			if idx < 0 {
				wb.Sheets = backup
				return 0, nil, fmt.Errorf("op[%d]: worksheet %q not found", i, op.Sheet)
			}
			r, c, ok := ParseA1(op.A1)
			if !ok {
				wb.Sheets = backup
				return 0, nil, fmt.Errorf("op[%d]: invalid cell %q", i, op.A1)
			}
			sh := &wb.Sheets[idx]
			if sh.Cells == nil {
				sh.Cells = make(map[string]Cell)
			}
			a1 := FormatA1(r, c)
			if op.Raw == "" {
				delete(sh.Cells, a1)
				diff = append(diff, fmt.Sprintf("cleared %s!%s", sh.Name, a1))
			} else {
				sh.Cells[a1] = Cell{Row: r, Col: c, A1: a1, Raw: op.Raw}
				diff = append(diff, fmt.Sprintf("set %s!%s = %s", sh.Name, a1, op.Raw))
			}
		case "addSheet":
			name := strings.TrimSpace(op.Name)
			if name == "" {
				name = fmt.Sprintf("Sheet%d", len(wb.Sheets)+1)
			}
			wb.Sheets = append(wb.Sheets, Worksheet{Name: name, Cells: make(map[string]Cell)})
			diff = append(diff, fmt.Sprintf("added sheet %s", name))
		case "deleteSheet":
			idx := findSheet(op.Sheet)
			if idx < 0 {
				wb.Sheets = backup
				return 0, nil, fmt.Errorf("op[%d]: worksheet %q not found", i, op.Sheet)
			}
			name := wb.Sheets[idx].Name
			wb.Sheets = append(wb.Sheets[:idx], wb.Sheets[idx+1:]...)
			diff = append(diff, fmt.Sprintf("deleted sheet %s", name))
		default:
			wb.Sheets = backup
			return 0, nil, fmt.Errorf("op[%d]: unsupported op %q", i, op.Op)
		}
	}

	wb.Recalculate()
	if dryRun {
		wb.Sheets = backup
	}
	return len(diff), diff, nil
}

// Verify evaluates all formulas and reports errors and empty worksheets.
func (wb *Workbook) Verify() []Diagnostic {
	wb.Recalculate()
	diags := make([]Diagnostic, 0)
	for _, sh := range wb.Sheets {
		if len(sh.Cells) == 0 {
			diags = append(diags, Diagnostic{
				Code:       "EMPTY_SHEET",
				Severity:   "info",
				Sheet:      sh.Name,
				Message:    fmt.Sprintf("Worksheet %q has no populated cells.", sh.Name),
				Suggestion: "Populate data or delete unused worksheet.",
			})
			continue
		}
		keys := make([]string, 0, len(sh.Cells))
		for k := range sh.Cells {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			c := sh.Cells[k]
			if c.Error != "" {
				diags = append(diags, Diagnostic{
					Code:       "FORMULA_ERROR",
					Severity:   "error",
					Sheet:      sh.Name,
					A1:         c.A1,
					Message:    fmt.Sprintf("Cell %s!%s evaluated to %s (%s).", sh.Name, c.A1, c.Error, c.Raw),
					Suggestion: "Inspect referenced cells and fix formula arguments.",
				})
			}
		}
	}
	return diags
}
