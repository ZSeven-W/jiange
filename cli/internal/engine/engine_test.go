package engine

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type failWriter struct {
	remaining int
	err       error
}

func (f *failWriter) Write(p []byte) (int, error) {
	if f.remaining <= 0 {
		return 0, f.err
	}
	if len(p) <= f.remaining {
		f.remaining -= len(p)
		return len(p), nil
	}
	n := f.remaining
	f.remaining = 0
	return n, f.err
}

type nopWriteCloser struct{ io.Writer }

func (nopWriteCloser) Close() error { return nil }

func makeZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip create %s: %v", name, err)
		}
		if _, err := io.WriteString(w, body); err != nil {
			t.Fatalf("zip write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

func makeZipWithBadMethod(t *testing.T, name, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	zw.RegisterCompressor(99, func(w io.Writer) (io.WriteCloser, error) {
		return nopWriteCloser{w}, nil
	})
	w, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: 99})
	if err != nil {
		t.Fatalf("CreateHeader: %v", err)
	}
	if _, err := io.WriteString(w, body); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return buf.Bytes()
}

func makeZipWithBadCRC(t *testing.T, name, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
	if err != nil {
		t.Fatalf("CreateHeader: %v", err)
	}
	if _, err := io.WriteString(w, body); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	raw := buf.Bytes()
	idx := bytes.Index(raw, []byte(body))
	if idx < 0 {
		t.Fatalf("payload not found in zip")
	}
	raw[idx] ^= 0xFF
	return raw
}

func withFailingBytesWriter(t *testing.T, remaining int) {
	t.Helper()
	orig := newBytesWriter
	newBytesWriter = func(*bytes.Buffer) io.Writer {
		return &failWriter{remaining: remaining, err: errors.New("injected write error")}
	}
	t.Cleanup(func() { newBytesWriter = orig })
}

func TestSheetEngineRoundTripFormulasAndVerify(t *testing.T) {
	dir := t.TempDir()
	csvPath := filepath.Join(dir, "budget.csv")
	xlsxPath := filepath.Join(dir, "budget.xlsx")

	wb, err := ParseCSVWorkbook([]byte("Item,Q1,Q2,Total\nCloud,100,150,=SUM(B2:C2)\nGPU,200,260,=B3+C3\nAvg,=AVERAGE(B2:B3),=MAX(C2:C3),\"=IF(D2>200,\"\"High\"\",\"\"Low\"\")\"\n"), "Budget")
	if err != nil {
		t.Fatalf("ParseCSVWorkbook: %v", err)
	}
	if wb.Sheets[0].Cells["D2"].Value != 250.0 {
		t.Fatalf("expected D2=250, got %#v", wb.Sheets[0].Cells["D2"].Value)
	}
	if wb.Sheets[0].Cells["D3"].Value != 460.0 {
		t.Fatalf("expected D3=460, got %#v", wb.Sheets[0].Cells["D3"].Value)
	}
	if wb.Sheets[0].Cells["D4"].Value != "High" {
		t.Fatalf("expected D4=High, got %#v", wb.Sheets[0].Cells["D4"].Value)
	}

	if err := SaveWorkbook(xlsxPath, wb); err != nil {
		t.Fatalf("SaveWorkbook xlsx: %v", err)
	}
	if err := SaveWorkbook(csvPath, wb); err != nil {
		t.Fatalf("SaveWorkbook csv: %v", err)
	}

	reloaded, err := LoadWorkbook(xlsxPath)
	if err != nil {
		t.Fatalf("LoadWorkbook xlsx: %v", err)
	}
	if reloaded.Sheets[0].Cells["D2"].Value != 250.0 {
		t.Fatalf("round-trip D2 mismatch: %#v", reloaded.Sheets[0].Cells["D2"])
	}

	// Dry run & atomic patch & verify
	applied, _, err := reloaded.Apply([]SheetOp{{Op: "setCell", Sheet: "Budget", A1: "E2", Raw: "=1/0"}}, true)
	if err != nil || applied != 1 {
		t.Fatalf("dryRun patch failed: applied=%d err=%v", applied, err)
	}
	if _, exists := reloaded.Sheets[0].Cells["E2"]; exists {
		t.Fatalf("dryRun mutated workbook")
	}

	if _, _, err := reloaded.Apply([]SheetOp{{Op: "setCell", Sheet: "Budget", A1: "E2", Raw: "=1/0"}}, false); err != nil {
		t.Fatalf("apply failed: %v", err)
	}
	diags := reloaded.Verify()
	if len(diags) != 1 || diags[0].Code != "FORMULA_ERROR" {
		t.Fatalf("expected FORMULA_ERROR diagnostic, got %#v", diags)
	}
	if len(reloaded.Query("Budget", "", false, true, 10)) != 1 {
		t.Fatalf("expected 1 error cell from Query")
	}
}

func TestSheetA1AndCSVAndZipErrors(t *testing.T) {
	if got := ColIndexToName(0); got != "A" {
		t.Fatalf("ColIndexToName(0) = %q", got)
	}
	if got := ColIndexToName(26); got != "AA" {
		t.Fatalf("ColIndexToName(26) = %q", got)
	}

	if r, c, ok := ParseA1("$AA$12"); !ok || r != 11 || c != 26 {
		t.Fatalf("ParseA1($AA$12) = %d,%d,%v", r, c, ok)
	}
	for _, bad := range []string{"", "123", "ABC", "A0", "A-1", "A1X"} {
		if _, _, ok := ParseA1(bad); ok {
			t.Fatalf("expected ParseA1(%q) to fail", bad)
		}
	}

	// ParseCSVWorkbook default sheet name, empty cells, and parse error
	wb, err := ParseCSVWorkbook([]byte("A,,C\n1,TRUE,FALSE\n"), "")
	if err != nil || wb.Sheets[0].Name != "Sheet1" {
		t.Fatalf("ParseCSVWorkbook default name failed: %v %#v", err, wb)
	}
	if _, err := ParseCSVWorkbook([]byte(`"unclosed`), "S"); err == nil {
		t.Fatalf("expected CSV parse error")
	}

	// LoadWorkbook error paths + CSV load
	dir := t.TempDir()
	if _, err := LoadWorkbook(filepath.Join(dir, "missing.xlsx")); err == nil {
		t.Fatalf("expected missing file error")
	}
	csvFile := filepath.Join(dir, "data.csv")
	if err := os.WriteFile(csvFile, []byte("K,V\nX,42\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	loadedCSV, err := LoadWorkbook(csvFile)
	if err != nil || loadedCSV.Sheets[0].Cells["B2"].Value != 42.0 {
		t.Fatalf("LoadWorkbook csv failed: %v %#v", err, loadedCSV)
	}
	badCSV := filepath.Join(dir, "bad.csv")
	_ = os.WriteFile(badCSV, []byte(`"broken`), 0o644)
	if _, err := LoadWorkbook(badCSV); err == nil {
		t.Fatalf("expected bad csv load error")
	}
	badXLSX := filepath.Join(dir, "bad.xlsx")
	_ = os.WriteFile(badXLSX, []byte("not-a-zip"), 0o644)
	if _, err := LoadWorkbook(badXLSX); err == nil {
		t.Fatalf("expected bad xlsx load error")
	}

	// WriteCSVWorkbook errors
	emptyWB := &WorkbookData{}
	if _, err := WriteCSVWorkbook(emptyWB, 0); err == nil {
		t.Fatalf("expected empty workbook csv error")
	}
	if _, err := WriteCSVWorkbook(wb, -1); err == nil {
		t.Fatalf("expected negative index error")
	}
	if _, err := WriteCSVWorkbook(wb, 5); err == nil {
		t.Fatalf("expected out of range index error")
	}
	if err := SaveWorkbook(filepath.Join(dir, "empty.csv"), emptyWB); err == nil {
		t.Fatalf("expected SaveWorkbook csv error on empty workbook")
	}
	if err := SaveWorkbook(filepath.Join(dir, "no-such-dir", "out.xlsx"), wb); err == nil {
		t.Fatalf("expected SaveWorkbook write error")
	}

	// fmtValue all types
	if got := fmtValue(nil, "fb"); got != "fb" {
		t.Fatalf("fmtValue(nil) = %q", got)
	}
	if got := fmtValue(3.5, ""); got != "3.5" {
		t.Fatalf("fmtValue(3.5) = %q", got)
	}
	if got := fmtValue(true, ""); got != "TRUE" {
		t.Fatalf("fmtValue(true) = %q", got)
	}
	if got := fmtValue(false, ""); got != "FALSE" {
		t.Fatalf("fmtValue(false) = %q", got)
	}
	if got := fmtValue(7, ""); got != "7" {
		t.Fatalf("fmtValue(7) = %q", got)
	}

	// WriteXLSX bools, floats, strings, formulas, multiple cols per row
	wbMulti := &WorkbookData{
		Sheets: []SheetData{{
			Name: "Types",
			Cells: map[string]SheetCell{
				"A1": {Row: 0, Col: 0, A1: "A1", Raw: "TRUE"},
				"B1": {Row: 0, Col: 1, A1: "B1", Raw: "FALSE"},
				"C1": {Row: 0, Col: 2, A1: "C1", Raw: "3.25"},
				"D1": {Row: 0, Col: 3, A1: "D1", Raw: "hello & <world>"},
				"E1": {Row: 0, Col: 4, A1: "E1", Raw: "=C1*2"},
			},
		}},
	}
	xlsxBytes, err := WriteXLSX(wbMulti)
	if err != nil {
		t.Fatalf("WriteXLSX: %v", err)
	}
	parsedMulti, err := ParseXLSX(xlsxBytes)
	if err != nil {
		t.Fatalf("ParseXLSX round-trip: %v", err)
	}
	if parsedMulti.Sheets[0].Cells["A1"].Value != true || parsedMulti.Sheets[0].Cells["B1"].Value != false {
		t.Fatalf("bool round-trip mismatch: %#v", parsedMulti.Sheets[0].Cells)
	}

	// writeZipArchive error branches: Create, WriteString, Close
	errBoom := errors.New("boom")
	// 1) Create fails when entry name > 4KB flushes immediately to failing writer
	if err := writeZipArchive(&failWriter{remaining: 0, err: errBoom}, []zipEntry{
		{name: strings.Repeat("a", 5000), body: "x"},
	}); err == nil {
		t.Fatalf("expected zw.Create write error")
	}
	// 2) io.WriteString fails when incompressible body exceeds flate's block buffer (> 64KB)
	var payload bytes.Buffer
	var seed uint32 = 1
	for i := 0; i < 150000; i++ {
		seed = seed*1664525 + 1013904223
		payload.WriteByte(byte(seed >> 24))
	}
	if err := writeZipArchive(&failWriter{remaining: 100, err: errBoom}, []zipEntry{
		{name: "big.bin", body: payload.String()},
	}); err == nil {
		t.Fatalf("expected io.WriteString write error")
	}
	// 3) zw.Close fails on small archive when writer fails on first flush
	if err := writeZipArchive(&failWriter{remaining: 0, err: errBoom}, []zipEntry{
		{name: "tiny.txt", body: "hi"},
	}); err == nil {
		t.Fatalf("expected zw.Close write error")
	}

	// WriteCSVWorkbook write error & SaveWorkbook xlsx write error via newBytesWriter
	t.Run("injectedWriterErrors", func(t *testing.T) {
		withFailingBytesWriter(t, 0)
		bigWB := &WorkbookData{
			Sheets: []SheetData{{
				Name:  "Big",
				Cells: map[string]SheetCell{"A1": {Row: 0, Col: 0, A1: "A1", Raw: strings.Repeat("Z", 5000)}},
			}},
		}
		if _, err := WriteCSVWorkbook(bigWB, 0); err == nil {
			t.Fatalf("expected WriteCSVWorkbook write error")
		}
		if err := SaveWorkbook(filepath.Join(dir, "fail.xlsx"), bigWB); err == nil {
			t.Fatalf("expected SaveWorkbook xlsx error")
		}
	})
}

func TestParseXLSXEdgeCases(t *testing.T) {
	// Invalid zip
	if _, err := ParseXLSX([]byte("bad")); err == nil {
		t.Fatalf("expected invalid zip error")
	}
	// Zip with no worksheets
	if _, err := ParseXLSX(makeZip(t, map[string]string{"readme.txt": "hi"})); err == nil {
		t.Fatalf("expected no worksheets error")
	}
	// sharedStrings (plain + rich text runs), workbook rels with/without xl/ prefix, missing rels fallback,
	// missing sheet skipped, formula with leading '=', invalid cell ref, empty cell, invalid worksheet XML
	sstXML := `<sst><si><t>Plain</t></si><si><r><t>Rich </t></r><r><t>Text</t></r></si></sst>`
	wbXML := `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
		`<sheet name="Main" r:id="rId1"/>` +
		`<sheet name="FallbackTarget" r:id="rIdMissing"/>` +
		`<sheet name="Ghost" r:id="rIdGhost"/>` +
		`</sheets></workbook>`
	relsXML := `<Relationships>` +
		`<Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/>` +
		`<Relationship Id="rIdGhost" Target="worksheets/does-not-exist.xml"/>` +
		`</Relationships>`
	sheet1XML := `<worksheet><sheetData><row r="1">` +
		`<c r="BADREF"><v>1</v></c>` +
		`<c r="A1" t="s"><v>0</v></c>` +
		`<c r="B1" t="s"><v>1</v></c>` +
		`<c r="C1"><f>=1+2</f></c>` +
		`<c r="D1"><f>3+4</f></c>` +
		`<c r="E1" t="inlineStr"><is><t>Inline</t></is></c>` +
		`<c r="F1" t="b"><v>1</v></c>` +
		`<c r="G1" t="b"><v>0</v></c>` +
		`<c r="H1"><v></v></c>` +
		`</row></sheetData></worksheet>`
	sheet2XML := `<worksheet><sheetData><row r="1"><c r="A1"><v>99</v></c></row></sheetData></worksheet>`

	rawZip := makeZip(t, map[string]string{
		"xl/sharedStrings.xml":         sstXML,
		"xl/workbook.xml":              wbXML,
		"xl/_rels/workbook.xml.rels":   relsXML,
		"xl/worksheets/sheet1.xml":     sheet1XML,
		"xl/worksheets/sheet2.xml":     sheet2XML,
	})
	wb, err := ParseXLSX(rawZip)
	if err != nil {
		t.Fatalf("ParseXLSX rich: %v", err)
	}
	if len(wb.Sheets) != 2 {
		t.Fatalf("expected 2 sheets, got %d", len(wb.Sheets))
	}
	if wb.Sheets[0].Cells["A1"].Value != "Plain" || wb.Sheets[0].Cells["B1"].Value != "Rich Text" {
		t.Fatalf("shared strings mismatch: %#v", wb.Sheets[0].Cells)
	}
	if wb.Sheets[0].Cells["C1"].Value != 3.0 || wb.Sheets[0].Cells["D1"].Value != 7.0 {
		t.Fatalf("formula mismatch: %#v", wb.Sheets[0].Cells)
	}
	if wb.Sheets[0].Cells["E1"].Value != "Inline" || wb.Sheets[0].Cells["F1"].Value != true || wb.Sheets[0].Cells["G1"].Value != false {
		t.Fatalf("inline/bool mismatch: %#v", wb.Sheets[0].Cells)
	}

	// Fallback scanning xl/worksheets/sheet*.xml when workbook.xml is absent
	fallbackZip := makeZip(t, map[string]string{
		"xl/worksheets/sheet1.xml": sheet2XML,
		"xl/worksheets/sheet2.xml": `<invalid-xml`,
	})
	wbFallback, err := ParseXLSX(fallbackZip)
	if err != nil || len(wbFallback.Sheets) != 2 {
		t.Fatalf("fallback ParseXLSX failed: %v %#v", err, wbFallback)
	}
	if len(wbFallback.Sheets[1].Cells) != 0 {
		t.Fatalf("expected invalid worksheet XML to yield 0 cells")
	}

	// readEntry error branches: bad compression method (f.Open error) and bad CRC (io.ReadAll error)
	badMethodZip := makeZipWithBadMethod(t, "xl/worksheets/sheet1.xml", sheet2XML)
	if _, err := ParseXLSX(badMethodZip); err == nil {
		t.Fatalf("expected error on unreadable sheet1 (bad method)")
	}
	badCRCZip := makeZipWithBadCRC(t, "xl/worksheets/sheet1.xml", sheet2XML)
	if _, err := ParseXLSX(badCRCZip); err == nil {
		t.Fatalf("expected error on unreadable sheet1 (bad CRC)")
	}
}

func TestSheetFormulaAllBranches(t *testing.T) {
	wb := &WorkbookData{
		Sheets: []SheetData{{
			Name: "F",
			Cells: map[string]SheetCell{
				"A1":  {Row: 0, Col: 0, A1: "A1", Raw: "10"},
				"A2":  {Row: 1, Col: 0, A1: "A2", Raw: "3"},
				"A3":  {Row: 2, Col: 0, A1: "A3", Raw: "7"},
				"B1":  {Row: 0, Col: 1, A1: "B1", Raw: "hello"},
				"B2":  {Row: 1, Col: 1, A1: "B2", Raw: "TRUE"},
				"B3":  {Row: 2, Col: 1, A1: "B3", Raw: "FALSE"},
				"C1":  {Row: 0, Col: 2, A1: "C1", Raw: "=C2"},
				"C2":  {Row: 1, Col: 2, A1: "C2", Raw: "=C1"},
				"C3":  {Row: 2, Col: 2, A1: "C3", Raw: "=A1+A1"}, // tests evaluated cache hit
				"D1":  {Row: 0, Col: 3, A1: "D1", Raw: "="},      // empty expr
				"D2":  {Row: 1, Col: 3, A1: "D2", Raw: "=Z99"},   // missing cell -> 0
				"D3":  {Row: 2, Col: 3, A1: "D3", Raw: "=COUNT(A1:A3, B1)"},
				"D4":  {Row: 3, Col: 3, A1: "D4", Raw: "=MIN(A1:A3)"},
				"D5":  {Row: 4, Col: 3, A1: "D5", Raw: "=MAX(A2, A1, A3)"},
				"D6":  {Row: 5, Col: 3, A1: "D6", Raw: "=AVERAGE()"},
				"D7":  {Row: 6, Col: 3, A1: "D7", Raw: `=SUM("txt")`},
				"D8":  {Row: 7, Col: 3, A1: "D8", Raw: "=SUM(1/0)"},
				"D9":  {Row: 8, Col: 3, A1: "D9", Raw: "=SUM(B2:A1)"}, // reversed range r1>r2 and c1>c2
				"D10": {Row: 9, Col: 3, A1: "D10", Raw: "=SUM(C1:C2)"}, // range error
				"D11": {Row: 10, Col: 3, A1: "D11", Raw: `=SUM("a:b")`}, // colon non-A1
			},
		}},
	}
	wb.Recalculate()

	sh := wb.Sheets[0].Cells
	if sh["C1"].Error != "#CYCLE!" || sh["C2"].Error != "#CYCLE!" {
		t.Fatalf("expected cycle errors, got %#v %#v", sh["C1"], sh["C2"])
	}
	if sh["C3"].Value != 20.0 || sh["D1"].Value != "" || sh["D2"].Value != 0.0 {
		t.Fatalf("basic formula mismatch: C3=%#v D1=%#v D2=%#v", sh["C3"], sh["D1"], sh["D2"])
	}
	if sh["D3"].Value != 3.0 || sh["D4"].Value != 3.0 || sh["D5"].Value != 10.0 {
		t.Fatalf("aggregate mismatch: D3=%#v D4=%#v D5=%#v", sh["D3"], sh["D4"], sh["D5"])
	}
	if sh["D6"].Error != "#DIV/0!" || sh["D7"].Value != 0.0 || sh["D8"].Error != "#DIV/0!" {
		t.Fatalf("empty/error aggregate mismatch: D6=%#v D7=%#v D8=%#v", sh["D6"], sh["D7"], sh["D8"])
	}
	if sh["D9"].Value != 14.0 || sh["D10"].Error != "#CYCLE!" || sh["D11"].Value != 0.0 {
		t.Fatalf("range mismatch: D9=%#v D10=%#v D11=%#v", sh["D9"], sh["D10"], sh["D11"])
	}

	// Exhaustive evalSheetFormula tests
	getCell := func(a1 string) (any, string) {
		if a1 == "A1" {
			return 10.0, ""
		}
		if a1 == "E1" {
			return "#ERR!", "#ERR!"
		}
		return 0.0, ""
	}
	cases := []struct {
		expr    string
		wantVal any
		wantErr string
	}{
		// Function validation & non-function parens
		{"1+(2+3)", 6.0, ""},
		{"SUM(1)+SUM(2)", 3.0, ""},
		{"FOO(1)", "#NAME?", "#NAME?"},
		// ABS
		{"ABS(-5)", 5.0, ""},
		{"ABS(1, 2)", "#VALUE!", "#VALUE!"},
		{"ABS(1/0)", "#DIV/0!", "#DIV/0!"},
		{`ABS("abc")`, "#VALUE!", "#VALUE!"},
		// ROUND
		{"ROUND(3.6)", 4.0, ""},
		{"ROUND(3.14159, 2)", 3.14, ""},
		{"ROUND()", "#VALUE!", "#VALUE!"},
		{"ROUND(1, 2, 3)", "#VALUE!", "#VALUE!"},
		{"ROUND(1/0, 2)", "#DIV/0!", "#DIV/0!"},
		{`ROUND("abc", 2)`, "#VALUE!", "#VALUE!"},
		{"ROUND(3.14, 1/0)", "#DIV/0!", "#DIV/0!"},
		// IF
		{"IF(TRUE)", "#VALUE!", "#VALUE!"},
		{"IF(1/0, 1, 2)", "#DIV/0!", "#DIV/0!"},
		{`IF(TRUE, "y", "n")`, "y", ""},
		{`IF(FALSE, "y", "n")`, "n", ""},
		{`IF(FALSE, "y")`, false, ""},
		{`IF(1, "a,b", "c")`, "a,b", ""},
		{`IF(SUM(MAX(1,2), 3)>4, "ok", "no")`, "ok", ""},
		// Numeric comparisons
		{"5=5", true, ""},
		{"5<>4", true, ""},
		{"5!=5", false, ""},
		{"5>3", true, ""},
		{"5>=5", true, ""},
		{"3<5", true, ""},
		{"5<=5", true, ""},
		{"1/0=1", "#DIV/0!", "#DIV/0!"},
		{"1=1/0", "#DIV/0!", "#DIV/0!"},
		// String comparisons
		{`"a"="a"`, true, ""},
		{`"a"<>"b"`, true, ""},
		{`"b">"a"`, true, ""},
		{`"b">="b"`, true, ""},
		{`"a"<"b"`, true, ""},
		{`"a"<="a"`, true, ""},
		// Quotes & parens inside comparisons/arithmetic
		{`("a>b")=("a>b")`, true, ""},
		{`(1+2)*(4-1)`, 9.0, ""},
		{`10/2`, 5.0, ""},
		{`10-3`, 7.0, ""},
		{`10-3-2`, 5.0, ""},
		{`1*-2`, -2.0, ""},
		{`(1/0)+1`, "#DIV/0!", "#DIV/0!"},
		{`1+(1/0)`, "#DIV/0!", "#DIV/0!"},
		{`"a"+1`, "#VALUE!", "#VALUE!"},
		{`(1/0)*2`, "#DIV/0!", "#DIV/0!"},
		{`2*(1/0)`, "#DIV/0!", "#DIV/0!"},
		{`"a"*2`, "#VALUE!", "#VALUE!"},
		{`1/0`, "#DIV/0!", "#DIV/0!"},
		// Literals & unknown identifier & strings with operators
		{"TRUE", true, ""},
		{"FALSE", false, ""},
		{`"a+b*c"`, "a+b*c", ""},
		{"UNKNOWN_NAME", "#NAME?", "#NAME?"},
		// findTopLevelOp edge cases with !=, !<, =>
		{"1!<2", "#NAME?", "#NAME?"},
		{"1=>2", false, ""},
	}
	for _, tc := range cases {
		val, ec := evalSheetFormula(tc.expr, getCell)
		if ec != tc.wantErr || val != tc.wantVal {
			t.Fatalf("evalSheetFormula(%q) = (%#v, %q), want (%#v, %q)", tc.expr, val, ec, tc.wantVal, tc.wantErr)
		}
	}

	// Direct helper branch coverage
	if !balancedParens(`("(")`) {
		t.Fatalf("expected balanced parens with quoted paren")
	}
	if balancedParens(")(") {
		t.Fatalf("expected unbalanced parens for ')('")
	}
	if idx := findTopLevelOp("a>=b", "="); idx != -1 {
		t.Fatalf("expected '=' skipped inside '>='")
	}
	if idx := findTopLevelOp("a>=b", ">"); idx != -1 {
		t.Fatalf("expected '>' skipped inside '>='")
	}
	if n, ok := toFloat(42); !ok || n != 42 {
		t.Fatalf("toFloat(int) failed")
	}
	if n, ok := toFloat(true); !ok || n != 1 {
		t.Fatalf("toFloat(true) failed")
	}
	if n, ok := toFloat(false); !ok || n != 0 {
		t.Fatalf("toFloat(false) failed")
	}
	if _, ok := toFloat(struct{}{}); ok {
		t.Fatalf("toFloat(struct) should fail")
	}
	if !toBool(1.5) || toBool(0.0) || !toBool("yes") || toBool("FALSE") || toBool("") || toBool(nil) {
		t.Fatalf("toBool edge cases failed")
	}
}

func TestSheetInspectQueryApplyVerify(t *testing.T) {
	wb := &WorkbookData{
		Sheets: []SheetData{
			{Name: "S1", Cells: make(map[string]SheetCell)},
			{Name: "Empty", Cells: make(map[string]SheetCell)},
		},
	}
	for i := 0; i < 25; i++ {
		a1 := FormatA1(i, 0)
		wb.Sheets[0].Cells[a1] = SheetCell{Row: i, Col: 0, A1: a1, Raw: fmt.Sprintf("%d", i+1)}
	}
	wb.Sheets[0].Cells["B1"] = SheetCell{Row: 0, Col: 1, A1: "B1", Raw: "=1/0"}
	wb.Recalculate()

	// Inspect summary / standard / full
	sum := wb.Inspect("summary")
	if sum["totalErrors"] != 1 || sum["totalFormulas"] != 1 {
		t.Fatalf("Inspect summary mismatch: %#v", sum)
	}
	std := wb.Inspect("standard")
	stdSheets := std["sheets"].([]map[string]any)
	if len(stdSheets[0]["cells"].([]SheetCell)) != 20 {
		t.Fatalf("expected 20 sampled cells in standard inspect")
	}
	full := wb.Inspect("full")
	fullSheets := full["sheets"].([]map[string]any)
	if len(fullSheets[0]["cells"].([]SheetCell)) != 26 {
		t.Fatalf("expected 26 cells in full inspect")
	}

	// Query filters & limit & default limit
	if len(wb.Query("", "", false, false, 0)) != 26 {
		t.Fatalf("Query default limit mismatch")
	}
	if len(wb.Query("S1", "", true, false, 10)) != 1 {
		t.Fatalf("Query onlyFormulas mismatch")
	}
	if len(wb.Query("S1", "25", false, false, 10)) != 1 {
		t.Fatalf("Query search mismatch")
	}
	if len(wb.Query("S1", "", false, false, 3)) != 3 {
		t.Fatalf("Query limit cap mismatch")
	}

	// Verify catches both EMPTY_SHEET and FORMULA_ERROR
	diags := wb.Verify()
	if len(diags) != 2 {
		t.Fatalf("expected 2 diagnostics (EMPTY_SHEET + FORMULA_ERROR), got %#v", diags)
	}

	// Apply: default sheet, clear cell, addSheet (named + default name), rollback on errors
	applied, diff, err := wb.Apply([]SheetOp{
		{Op: "setCell", Sheet: "", A1: "B1", Raw: ""},
		{Op: "addSheet", Name: ""},
		{Op: "addSheet", Name: "Custom"},
	}, false)
	if err != nil || applied != 3 || len(diff) != 3 {
		t.Fatalf("Apply failed: %d %v %v", applied, diff, err)
	}
	if _, ok := wb.Sheets[0].Cells["B1"]; ok {
		t.Fatalf("expected B1 cleared")
	}
	if _, _, err := wb.Apply([]SheetOp{{Op: "setCell", Sheet: "Nope", A1: "A1", Raw: "1"}}, false); err == nil {
		t.Fatalf("expected missing sheet error")
	}
	if _, _, err := wb.Apply([]SheetOp{{Op: "setCell", Sheet: "S1", A1: "BAD", Raw: "1"}}, false); err == nil {
		t.Fatalf("expected invalid cell error")
	}
	if _, _, err := wb.Apply([]SheetOp{{Op: "bogus"}}, false); err == nil {
		t.Fatalf("expected unsupported op error")
	}
}

func TestDocEngineFullCoverage(t *testing.T) {
	dir := t.TempDir()
	md := "# Title\n\n## Sub\n\n- bullet 1\n* bullet 2\n\n> quote line\n\n```go\nfmt.Println(1)\n```\n\n#NoSpaceHeading\n\nPlain paragraph\n"
	doc := ParseMarkdownDoc(md, "Guide")
	if len(doc.Blocks) != 8 {
		t.Fatalf("expected 8 blocks, got %d: %#v", len(doc.Blocks), doc.Blocks)
	}

	// ToMarkdown with invalid heading levels + all block types
	doc.Blocks = append(doc.Blocks, DocBlock{ID: "b9", Type: "heading", Level: 0, Text: "BadLvl"})
	exportedMD := doc.ToMarkdown()
	if !strings.Contains(exportedMD, "# Title") || !strings.Contains(exportedMD, "- bullet 1") || !strings.Contains(exportedMD, "> quote line") || !strings.Contains(exportedMD, "```") {
		t.Fatalf("unexpected ToMarkdown output:\n%s", exportedMD)
	}

	// SaveDoc & LoadDoc for .md and .docx + error paths
	mdPath := filepath.Join(dir, "guide.md")
	if err := SaveDoc(mdPath, doc); err != nil {
		t.Fatalf("SaveDoc md: %v", err)
	}
	loadedMD, err := LoadDoc(mdPath)
	if err != nil || len(loadedMD.Blocks) == 0 {
		t.Fatalf("LoadDoc md failed: %v", err)
	}
	if _, err := LoadDoc(filepath.Join(dir, "missing.md")); err == nil {
		t.Fatalf("expected LoadDoc missing error")
	}

	docxPath := filepath.Join(dir, "guide.docx")
	if err := SaveDoc(docxPath, doc); err != nil {
		t.Fatalf("SaveDoc docx: %v", err)
	}
	loadedDOCX, err := LoadDoc(docxPath)
	if err != nil || len(loadedDOCX.Blocks) == 0 {
		t.Fatalf("LoadDoc docx failed: %v", err)
	}

	// SaveDoc docx error via injected failing writer
	t.Run("saveDocWriteError", func(t *testing.T) {
		withFailingBytesWriter(t, 0)
		if err := SaveDoc(filepath.Join(dir, "fail.docx"), doc); err == nil {
			t.Fatalf("expected SaveDoc WriteDOCX error")
		}
	})

	// ParseDOCX error paths & heading styles & empty paragraphs
	if _, err := ParseDOCX([]byte("not-zip"), "x"); err == nil {
		t.Fatalf("expected invalid zip error")
	}
	if _, err := ParseDOCX(makeZip(t, map[string]string{"other.xml": "<a/>"}), "x"); err == nil {
		t.Fatalf("expected missing document.xml error")
	}
	if _, err := ParseDOCX(makeZipWithBadMethod(t, "word/document.xml", "<w:document/>"), "x"); err == nil {
		t.Fatalf("expected f.Open error")
	}
	if _, err := ParseDOCX(makeZipWithBadCRC(t, "word/document.xml", "<w:document><w:body/></w:document>"), "x"); err == nil {
		t.Fatalf("expected CRC ReadAll error")
	}
	if _, err := ParseDOCX(makeZip(t, map[string]string{"word/document.xml": "<broken"}), "x"); err == nil {
		t.Fatalf("expected xml unmarshal error")
	}
	edgeDOCX := makeZip(t, map[string]string{
		"word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
			`<w:p><w:r><w:t>   </w:t></w:r></w:p>` +
			`<w:p><w:pPr><w:pStyle w:val="Heading"/></w:pPr><w:r><w:t>H1Default</w:t></w:r></w:p>` +
			`<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>H3</w:t></w:r></w:p>` +
			`</w:body></w:document>`,
	})
	parsedEdge, err := ParseDOCX(edgeDOCX, "Edge")
	if err != nil || len(parsedEdge.Blocks) != 2 || parsedEdge.Blocks[0].Level != 1 || parsedEdge.Blocks[1].Level != 3 {
		t.Fatalf("ParseDOCX edge failed: %v %#v", err, parsedEdge)
	}

	// Inspect standard + full
	insStd := doc.Inspect("standard")
	if _, hasBlocks := insStd["blocks"]; hasBlocks {
		t.Fatalf("standard inspect should omit blocks")
	}
	insFull := doc.Inspect("full")
	if _, hasBlocks := insFull["blocks"]; !hasBlocks {
		t.Fatalf("full inspect should include blocks")
	}

	// Query with blockType & text mismatches
	if got := doc.Query("bullet", "bullet"); len(got) != 2 {
		t.Fatalf("expected 2 bullet hits, got %d", len(got))
	}
	if got := doc.Query("does-not-exist", ""); len(got) != 0 {
		t.Fatalf("expected 0 hits, got %d", len(got))
	}

	// Apply: default block type, replaceText skipping code, deleteBlock, dryRun, all errors
	if _, _, err := doc.Apply([]DocOp{
		{Op: "appendBlock", Text: "Default Para"},
		{Op: "replaceText", Search: "fmt.Println", Replacement: "NOOP"},
		{Op: "replaceText", Search: "Plain", Replacement: "Updated"},
		{Op: "deleteBlock", BlockID: "b1"},
	}, true); err != nil {
		t.Fatalf("Doc Apply dryRun failed: %v", err)
	}
	if doc.Blocks[0].ID != "b1" {
		t.Fatalf("dryRun did not restore blocks")
	}
	if _, _, err := doc.Apply([]DocOp{{Op: "replaceText", Search: ""}}, false); err == nil {
		t.Fatalf("expected empty search error")
	}
	if _, _, err := doc.Apply([]DocOp{{Op: "deleteBlock", BlockID: "missing"}}, false); err == nil {
		t.Fatalf("expected missing block error")
	}
	if _, _, err := doc.Apply([]DocOp{{Op: "unknown"}}, false); err == nil {
		t.Fatalf("expected unknown op error")
	}

	// Verify empty doc + skipped heading
	emptyDoc := &DocData{Title: "Empty"}
	if diags := emptyDoc.Verify(); len(diags) != 1 || diags[0].Code != "EMPTY_DOC" {
		t.Fatalf("expected EMPTY_DOC diag, got %#v", diags)
	}
	if diags := parsedEdge.Verify(); len(diags) != 1 || diags[0].Code != "SKIPPED_HEADING_LEVEL" {
		t.Fatalf("expected SKIPPED_HEADING_LEVEL diag, got %#v", diags)
	}
}

func TestSlidesEngineFullCoverage(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadDeck(filepath.Join(dir, "missing.pptx")); err == nil {
		t.Fatalf("expected missing pptx error")
	}
	if _, err := ParsePPTX([]byte("not-zip")); err == nil {
		t.Fatalf("expected invalid zip error")
	}
	if _, err := ParsePPTX(makeZip(t, map[string]string{"ppt/slides/slideX.xml": "<x/>"})); err == nil {
		t.Fatalf("expected no slides error")
	}

	// Out-of-order slides + empty slide + unreadable slide skipped
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	zw.RegisterCompressor(99, func(w io.Writer) (io.WriteCloser, error) { return nopWriteCloser{w}, nil })
	w1, _ := zw.Create("ppt/slides/slide2.xml")
	_, _ = io.WriteString(w1, `<p:sld><a:t>Second</a:t><a:t>Body2</a:t></p:sld>`)
	w2, _ := zw.Create("ppt/slides/slide1.xml")
	_, _ = io.WriteString(w2, `<p:sld><a:t>   </a:t></p:sld>`)
	w3, _ := zw.CreateHeader(&zip.FileHeader{Name: "ppt/slides/slide3.xml", Method: 99})
	_, _ = io.WriteString(w3, `<p:sld><a:t>Unreadable</a:t></p:sld>`)
	_ = zw.Close()
	deckParsed, err := ParsePPTX(buf.Bytes())
	if err != nil || len(deckParsed.Slides) != 2 || deckParsed.Title != "Presentation" {
		t.Fatalf("ParsePPTX edge failed: %v %#v", err, deckParsed)
	}

	// WritePPTX on empty deck creates default slide
	emptyDeck := &DeckData{Title: "Blank"}
	b, err := WritePPTX(emptyDeck)
	if err != nil || len(b) == 0 {
		t.Fatalf("WritePPTX empty failed: %v", err)
	}

	// SaveDeck error via failing writer
	t.Run("saveDeckWriteError", func(t *testing.T) {
		withFailingBytesWriter(t, 0)
		if err := SaveDeck(filepath.Join(dir, "fail.pptx"), emptyDeck); err == nil {
			t.Fatalf("expected SaveDeck error")
		}
	})

	// Inspect, Apply (addSlide, updateSlide, deleteSlide, dryRun, errors)
	deck := &DeckData{Title: "Pitch", Slides: []SlidePageData{{Index: 0, Title: "S1", Body: "B1"}}}
	if ins := deck.Inspect(); ins["slideCount"] != 1 {
		t.Fatalf("Inspect mismatch: %#v", ins)
	}
	if _, _, err := deck.Apply([]SlidePatchOp{
		{Op: "addSlide", Title: "S2", Body: "B2", Background: "#111111"},
		{Op: "updateSlide", SlideIndex: 0, Title: "S1New", Body: "B1New", Background: "#222222"},
		{Op: "deleteSlide", SlideIndex: 0},
	}, true); err != nil {
		t.Fatalf("Slides Apply dryRun failed: %v", err)
	}
	if len(deck.Slides) != 1 || deck.Slides[0].Title != "S1" {
		t.Fatalf("dryRun did not restore slides")
	}
	if _, _, err := deck.Apply([]SlidePatchOp{
		{Op: "addSlide", Title: "S2", Body: "B2"},
		{Op: "deleteSlide", SlideIndex: 0},
	}, false); err != nil || len(deck.Slides) != 1 || deck.Slides[0].Index != 0 {
		t.Fatalf("deleteSlide reindex failed: %v %#v", err, deck.Slides)
	}
	if _, _, err := deck.Apply([]SlidePatchOp{{Op: "updateSlide", SlideIndex: 9}}, false); err == nil {
		t.Fatalf("expected updateSlide range error")
	}
	if _, _, err := deck.Apply([]SlidePatchOp{{Op: "deleteSlide", SlideIndex: -1}}, false); err == nil {
		t.Fatalf("expected deleteSlide range error")
	}
	if _, _, err := deck.Apply([]SlidePatchOp{{Op: "nope"}}, false); err == nil {
		t.Fatalf("expected unsupported op error")
	}

	// Verify: EMPTY_DECK, EMPTY_SLIDE, TEXT_OVERFLOW
	if diags := (&DeckData{}).Verify(); len(diags) != 1 || diags[0].Code != "EMPTY_DECK" {
		t.Fatalf("expected EMPTY_DECK, got %#v", diags)
	}
	dense := &DeckData{Slides: []SlidePageData{
		{Index: 0, Title: "", Body: ""},
		{Index: 1, Title: "Dense", Body: strings.Repeat("字", 805)},
	}}
	diags := dense.Verify()
	if len(diags) != 2 || diags[0].Code != "EMPTY_SLIDE" || diags[1].Code != "TEXT_OVERFLOW" {
		t.Fatalf("expected EMPTY_SLIDE + TEXT_OVERFLOW, got %#v", diags)
	}

	// RenderSlideSVG: out of range, default bg, custom bg
	if _, err := dense.RenderSlideSVG(-1); err == nil {
		t.Fatalf("expected out of range SVG error")
	}
	dense.Slides[1].Background = "#000000"
	svg, err := dense.RenderSlideSVG(1)
	if err != nil || !strings.Contains(svg, "#000000") {
		t.Fatalf("expected custom background in SVG: %v %s", err, svg)
	}
}

func TestBoardEngineFullCoverage(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadBoard(filepath.Join(dir, "missing.mmd")); err == nil {
		t.Fatalf("expected missing board error")
	}

	// Mermaid with all shapes, edge labels, empty/comment lines, empty id via ';' and trailing arrow
	mmd := "flowchart LR\n%% comment\n\n  A([Start]) -->|Yes| B{Check}\n  B -.-> C((Done))\n  C --- D(Round)\n  E[Rect];\n  ;\n  E --> \n"
	mmdPath := filepath.Join(dir, "flow.mmd")
	_ = os.WriteFile(mmdPath, []byte(mmd), 0o644)
	bMmd, err := LoadBoard(mmdPath)
	if err != nil || len(bMmd.Nodes) != 5 || len(bMmd.Edges) != 3 {
		t.Fatalf("LoadBoard mmd failed: %v %#v", err, bMmd)
	}
	if ins := bMmd.Inspect(); ins["nodeCount"] != 5 {
		t.Fatalf("Board Inspect mismatch: %#v", ins)
	}

	// JSON load valid + invalid
	jsonPath := filepath.Join(dir, "graph.json")
	_ = os.WriteFile(jsonPath, []byte(`{"nodes":[{"id":"1","text":"One","x":500,"y":400}],"edges":[{"from":"1","to":"missing"}]}`), 0o644)
	bJSON, err := LoadBoard(jsonPath)
	if err != nil || len(bJSON.Nodes) != 1 {
		t.Fatalf("LoadBoard json failed: %v", err)
	}
	badJSON := filepath.Join(dir, "bad.json")
	_ = os.WriteFile(badJSON, []byte(`{bad`), 0o644)
	if _, err := LoadBoard(badJSON); err == nil {
		t.Fatalf("expected invalid json board error")
	}

	// Verify EMPTY_BOARD, DANGLING_EDGE, and RenderSVG with dangling edge & expanded bounds
	if diags := (&BoardData{}).Verify(); len(diags) != 1 || diags[0].Code != "EMPTY_BOARD" {
		t.Fatalf("expected EMPTY_BOARD, got %#v", diags)
	}
	if diags := bJSON.Verify(); len(diags) != 1 || diags[0].Code != "DANGLING_EDGE" {
		t.Fatalf("expected DANGLING_EDGE, got %#v", diags)
	}
	svg := bJSON.RenderSVG()
	if !strings.Contains(svg, `width="720"`) || !strings.Contains(svg, `height="520"`) {
		t.Fatalf("expected expanded SVG dimensions, got: %s", svg)
	}

	// XMind valid + errors (invalid zip, missing content.json, bad method, bad CRC, invalid JSON)
	xmContent := `[{"rootTopic":{"id":"","title":"Root","children":{"attached":[{"id":"c1","title":"Child"}]}}}]`
	xmPath := filepath.Join(dir, "map.xmind")
	_ = os.WriteFile(xmPath, makeZip(t, map[string]string{"meta.json": "{}", "content.json": xmContent}), 0o644)
	bXM, err := LoadBoard(xmPath)
	if err != nil || len(bXM.Nodes) != 2 || len(bXM.Edges) != 1 {
		t.Fatalf("LoadBoard xmind failed: %v %#v", err, bXM)
	}
	if _, err := ParseXMind([]byte("not-zip")); err == nil {
		t.Fatalf("expected invalid xmind zip error")
	}
	if _, err := ParseXMind(makeZip(t, map[string]string{"other.txt": "x"})); err == nil {
		t.Fatalf("expected missing content.json error")
	}
	if _, err := ParseXMind(makeZipWithBadMethod(t, "content.json", xmContent)); err == nil {
		t.Fatalf("expected xmind f.Open error")
	}
	if _, err := ParseXMind(makeZipWithBadCRC(t, "content.json", xmContent)); err == nil {
		t.Fatalf("expected xmind CRC ReadAll error")
	}
	if _, err := ParseXMind(makeZip(t, map[string]string{"content.json": "{bad"})); err == nil {
		t.Fatalf("expected xmind json unmarshal error")
	}
}

func TestBaseEngineFullCoverage(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadBase(filepath.Join(dir, "missing.json")); err == nil {
		t.Fatalf("expected missing base error")
	}

	// CSV: normal, empty, malformed
	csvPath := filepath.Join(dir, "tasks.csv")
	_ = os.WriteFile(csvPath, []byte("Name,Score,Note\nAlpha,95.5,Great\nBeta,10,Ok\n"), 0o644)
	bCSV, err := LoadBase(csvPath)
	if err != nil || len(bCSV.Fields) != 3 || len(bCSV.Records) != 2 || bCSV.Records[0].Cells["2"] != 95.5 {
		t.Fatalf("LoadBase csv failed: %v %#v", err, bCSV)
	}
	emptyCSV := filepath.Join(dir, "empty.csv")
	_ = os.WriteFile(emptyCSV, []byte(""), 0o644)
	bEmptyCSV, err := LoadBase(emptyCSV)
	if err != nil || len(bEmptyCSV.Records) != 0 {
		t.Fatalf("LoadBase empty csv failed: %v", err)
	}
	badCSV := filepath.Join(dir, "bad.csv")
	_ = os.WriteFile(badCSV, []byte(`"unclosed`), 0o644)
	if _, err := LoadBase(badCSV); err == nil {
		t.Fatalf("expected malformed csv error")
	}
	badJSON := filepath.Join(dir, "bad.json")
	_ = os.WriteFile(badJSON, []byte("{bad"), 0o644)
	if _, err := LoadBase(badJSON); err == nil {
		t.Fatalf("expected malformed json error")
	}

	// SaveBase marshal error (NaN in Cells)
	badBase := &BaseData{
		Name:    "Bad",
		Records: []BaseRecordData{{ID: 1, TableID: 1, Cells: map[string]any{"1": math.NaN()}}},
	}
	if err := SaveBase(filepath.Join(dir, "bad.json"), badBase); err == nil {
		t.Fatalf("expected SaveBase marshal error")
	}

	// Multi-table Base: Inspect, Query (default limit, table filter, unmatched search, limit break), Apply, Verify
	b := &BaseData{
		Name: "Multi",
		Tables: []BaseTableData{
			{ID: 1, Name: "T1"},
			{ID: 2, Name: "T2"},
		},
		Fields: []BaseFieldData{
			{ID: 1, TableID: 1, Name: "Name", Type: "text"},
			{ID: 2, TableID: 2, Name: "Title", Type: "text"},
		},
		Records: []BaseRecordData{
			{ID: 1, TableID: 1, Cells: map[string]any{"1": "Alpha"}},
			{ID: 2, TableID: 1, Cells: map[string]any{"1": "Beta"}},
			{ID: 3, TableID: 2, Cells: map[string]any{"2": "Gamma"}},
		},
	}
	ins := b.Inspect()
	if ins["tableCount"] != 2 {
		t.Fatalf("Base Inspect mismatch: %#v", ins)
	}
	if len(b.Query(0, "", 0)) != 3 {
		t.Fatalf("Base Query default limit mismatch")
	}
	if len(b.Query(1, "", 1)) != 1 {
		t.Fatalf("Base Query limit cap mismatch")
	}
	if len(b.Query(1, "NoMatch", 10)) != 0 {
		t.Fatalf("Base Query unmatched search mismatch")
	}

	// Apply: addRecord (default tableId), addField (default tableId & default type), deleteRecord, dryRun, errors
	if applied, _, err := b.Apply([]BasePatchOp{
		{Op: "addRecord", Cells: map[string]any{"1": "Delta"}},
		{Op: "addField", Name: "Notes"},
		{Op: "deleteRecord", RecordID: 2},
	}, true); err != nil || applied != 3 {
		t.Fatalf("Base Apply dryRun failed: %d %v", applied, err)
	}
	if len(b.Records) != 3 {
		t.Fatalf("dryRun did not restore Base records")
	}
	if _, _, err := b.Apply([]BasePatchOp{{Op: "deleteRecord", RecordID: 999}}, false); err == nil {
		t.Fatalf("expected missing record error")
	}
	if _, _, err := b.Apply([]BasePatchOp{{Op: "bogus"}}, false); err == nil {
		t.Fatalf("expected unsupported base op error")
	}

	// Verify EMPTY_BASE + multi-table clean + duplicate
	if diags := (&BaseData{}).Verify(); len(diags) != 1 || diags[0].Code != "EMPTY_BASE" {
		t.Fatalf("expected EMPTY_BASE, got %#v", diags)
	}
	if diags := b.Verify(); len(diags) != 0 {
		t.Fatalf("expected 0 diags on valid multi-table base, got %#v", diags)
	}
}

func TestDocSlidesBoardBaseEngines(t *testing.T) {
	dir := t.TempDir()

	// Doc: Markdown -> DOCX -> reload -> patch -> verify
	doc := ParseMarkdownDoc("# Spec\n\n### Skipped\n\nHello world\n", "Spec")
	docxPath := filepath.Join(dir, "spec.docx")
	if err := SaveDoc(docxPath, doc); err != nil {
		t.Fatalf("SaveDoc: %v", err)
	}
	doc2, err := LoadDoc(docxPath)
	if err != nil {
		t.Fatalf("LoadDoc: %v", err)
	}
	if len(doc2.Verify()) == 0 {
		t.Fatalf("expected SKIPPED_HEADING_LEVEL diagnostic")
	}
	if _, _, err := doc2.Apply([]DocOp{
		{Op: "replaceText", Search: "world", Replacement: "Jiange"},
		{Op: "appendBlock", Type: "paragraph", Text: "Added"},
	}, false); err != nil {
		t.Fatalf("Doc Apply: %v", err)
	}
	if len(doc2.Query("Jiange", "")) != 1 {
		t.Fatalf("expected replaced text in Query")
	}

	// Slides: Write PPTX -> reload -> patch -> SVG -> verify
	deck := &DeckData{Title: "Demo", Slides: []SlidePageData{{Index: 0, Title: "Intro", Body: "Line 1"}}}
	pptxPath := filepath.Join(dir, "demo.pptx")
	if err := SaveDeck(pptxPath, deck); err != nil {
		t.Fatalf("SaveDeck: %v", err)
	}
	deck2, err := LoadDeck(pptxPath)
	if err != nil {
		t.Fatalf("LoadDeck: %v", err)
	}
	if _, _, err := deck2.Apply([]SlidePatchOp{{Op: "addSlide", Title: "", Body: ""}}, false); err != nil {
		t.Fatalf("Slides Apply: %v", err)
	}
	if len(deck2.Verify()) == 0 {
		t.Fatalf("expected EMPTY_SLIDE diagnostic")
	}
	svg, err := deck2.RenderSlideSVG(0)
	if err != nil || !strings.Contains(svg, "<svg") || !strings.Contains(svg, "Intro") {
		t.Fatalf("unexpected slide SVG: %v %s", err, svg)
	}

	// Board: Mermaid -> verify -> SVG
	board := ParseMermaidBoard("flowchart TD\n  A([Start]) --> B[Run]\n  C[Lonely]\n")
	if len(board.Nodes) != 3 || len(board.Edges) != 1 {
		t.Fatalf("unexpected board parse: %#v", board)
	}
	if len(board.Verify()) == 0 {
		t.Fatalf("expected ISOLATED_NODE diagnostic")
	}
	if !strings.Contains(board.RenderSVG(), "Start") {
		t.Fatalf("board SVG missing node label")
	}

	// Base: CSV -> JSON -> patch -> verify
	basePath := filepath.Join(dir, "crm.json")
	b := &BaseData{
		Name:    "CRM",
		Tables:  []BaseTableData{{ID: 1, Name: "Deals"}},
		Fields:  []BaseFieldData{{ID: 1, TableID: 1, Name: "Deal", Type: "text", IsPrimary: true}},
		Records: []BaseRecordData{{ID: 1, TableID: 1, Cells: map[string]any{"1": "Enterprise Deal"}}},
	}
	if err := SaveBase(basePath, b); err != nil {
		t.Fatalf("SaveBase: %v", err)
	}
	b2, err := LoadBase(basePath)
	if err != nil {
		t.Fatalf("LoadBase: %v", err)
	}
	if len(b2.Query(1, "Enterprise", 10)) != 1 {
		t.Fatalf("expected Base Query hit")
	}
	if _, _, err := b2.Apply([]BasePatchOp{{Op: "addField", TableID: 1, Name: "Deal", Type: "text"}}, false); err != nil {
		t.Fatalf("Base Apply: %v", err)
	}
	if len(b2.Verify()) == 0 {
		t.Fatalf("expected DUPLICATE_FIELD_NAME diagnostic")
	}
}
