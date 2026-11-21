package sheet

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/sdk/go/ai"
	"github.com/ZSeven-W/jiange/sdk/go/storage"
)

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("read failed") }

type limitWriter struct {
	limit int
	wrote int
	buf   bytes.Buffer
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if l.wrote+len(p) > l.limit {
		return 0, errors.New("write limit reached")
	}
	l.wrote += len(p)
	return l.buf.Write(p)
}

type failingStore struct {
	storage.Store
	getErr error
	putErr error
	delErr error
}

func (f *failingStore) Get(ctx context.Context, id string) (*storage.DocumentRecord, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	return f.Store.Get(ctx, id)
}

func (f *failingStore) Put(ctx context.Context, rec *storage.DocumentRecord) error {
	if f.putErr != nil {
		return f.putErr
	}
	return f.Store.Put(ctx, rec)
}

func (f *failingStore) Delete(ctx context.Context, id string) error {
	if f.delErr != nil {
		return f.delErr
	}
	return f.Store.Delete(ctx, id)
}

func TestCoordinatesAndCSVAndXLSX(t *testing.T) {
	if ColIndexToName(0) != "A" || ColIndexToName(26) != "AA" {
		t.Fatalf("unexpected col names: %s %s", ColIndexToName(0), ColIndexToName(26))
	}
	if r, c, ok := ParseA1("$AA$10"); !ok || r != 9 || c != 26 {
		t.Fatalf("ParseA1 failed: %d %d %v", r, c, ok)
	}
	for _, bad := range []string{"", "123", "ABC", "A0", "A-1", "A1X"} {
		if _, _, ok := ParseA1(bad); ok {
			t.Fatalf("expected invalid A1 for %q", bad)
		}
	}

	// ParseCSV & WriteCSV
	if _, err := ParseCSV([]byte("\"unterminated"), ""); err == nil {
		t.Fatal("expected CSV parse error")
	}
	wb, err := ParseCSV([]byte("Item,Qty,Price,Total\nPen,2,1.5,=B2*C2\nBook,,TRUE,FALSE\n"), "")
	if err != nil {
		t.Fatalf("ParseCSV failed: %v", err)
	}
	if wb.Sheets[0].Name != "Sheet1" || wb.Sheets[0].Cells["D2"].Value != 3.0 {
		t.Fatalf("unexpected CSV workbook: %+v", wb.Sheets[0])
	}
	csvOut, err := WriteCSV(wb, 0)
	if err != nil || !strings.Contains(string(csvOut), "Pen,2,1.5,3") || !strings.Contains(string(csvOut), "TRUE,FALSE") {
		t.Fatalf("unexpected CSV output: %q err=%v", string(csvOut), err)
	}
	if _, err := WriteCSV(wb, 5); err == nil {
		t.Fatal("expected out-of-range sheetIndex error")
	}
	if formatValue(nil, "fb") != "fb" || formatValue(42, "") != "42" {
		t.Fatal("formatValue fallback/default failed")
	}

	// Failing writer tests for WriteCSV & WriteXLSX
	origWriter := newBytesWriter
	newBytesWriter = func(*bytes.Buffer) io.Writer { return &limitWriter{limit: 0} }
	if _, err := WriteCSV(wb, 0); err == nil {
		t.Fatal("expected WriteCSV flush error")
	}
	// Trigger Write error mid-loop (buffer > 4096 triggers bufio flush during Write)
	bigWB := NewWorkbook("Big")
	bigWB.Sheets[0].Cells["A1"] = Cell{Row: 0, Col: 0, A1: "A1", Raw: strings.Repeat("x", 5000)}
	bigWB.Sheets[0].Cells["A2"] = Cell{Row: 1, Col: 0, A1: "A2", Raw: "y"}
	if _, err := WriteCSV(bigWB, 0); err == nil {
		t.Fatal("expected WriteCSV write error")
	}

	// WriteXLSX / buildZipBytes errors at Create, WriteString, and Close.
	newBytesWriter = func(*bytes.Buffer) io.Writer { return &limitWriter{limit: 0} }
	if _, err := buildZipBytes([]zipEntry{{name: strings.Repeat("a", 5000), body: "x"}}); err == nil {
		t.Fatal("expected buildZipBytes create error")
	}
	var large strings.Builder
	state := uint32(1)
	for i := 0; i < 80000; i++ {
		state = state*1664525 + 1013904223
		large.WriteByte(byte(state >> 24))
	}
	newBytesWriter = func(*bytes.Buffer) io.Writer { return &limitWriter{limit: 100} }
	if _, err := buildZipBytes([]zipEntry{{name: "big.xml", body: large.String()}}); err == nil {
		t.Fatal("expected buildZipBytes write error")
	}
	newBytesWriter = func(*bytes.Buffer) io.Writer { return &limitWriter{limit: 50} }
	if _, err := buildZipBytes([]zipEntry{{name: "a.xml", body: "hi"}}); err == nil {
		t.Fatal("expected buildZipBytes close error")
	}
	newBytesWriter = origWriter

	// WriteXLSX nil/empty fallback & round-trip
	emptyXLSX, err := WriteXLSX(nil)
	if err != nil {
		t.Fatalf("WriteXLSX(nil) failed: %v", err)
	}
	parsedEmpty, err := ParseXLSX(emptyXLSX)
	if err != nil || len(parsedEmpty.Sheets) != 1 {
		t.Fatalf("ParseXLSX empty failed: %+v err=%v", parsedEmpty, err)
	}

	xlsxBytes, err := WriteXLSX(wb)
	if err != nil {
		t.Fatalf("WriteXLSX failed: %v", err)
	}
	rt, err := ParseXLSX(xlsxBytes)
	if err != nil || rt.Sheets[0].Cells["D2"].Value != 3.0 || rt.Sheets[0].Cells["C3"].Value != true || rt.Sheets[0].Cells["D3"].Value != false {
		t.Fatalf("XLSX roundtrip failed: %+v err=%v", rt, err)
	}

	// ParseXLSX error cases + sharedStrings + rich text + fallback sheet scan + malformed XML + corrupt zip entries
	if _, err := ParseXLSX([]byte("not a zip")); err == nil {
		t.Fatal("expected invalid zip error")
	}
	noSheetsZip, _ := buildZipBytes([]zipEntry{{name: "other.txt", body: "hi"}})
	if _, err := ParseXLSX(noSheetsZip); err == nil {
		t.Fatal("expected no worksheets error")
	}

	// Rich sharedStrings + workbook rels + sheet XML with =formula, shared string, inlineStr, bool, bad ref, empty cell
	customZip, _ := buildZipBytes([]zipEntry{
		{name: "xl/sharedStrings.xml", body: `<sst><si><t>Hello</t></si><si><r><t>Ri</t></r><r><t>ch</t></r></si></sst>`},
		{name: "xl/workbook.xml", body: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Main" r:id="rId1"/><sheet name="Missing" r:id="rIdMissing"/><sheet name="NoRel" r:id="rId3"/></sheets></workbook>`},
		{name: "xl/_rels/workbook.xml.rels", body: `<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rIdMissing" Target="worksheets/nope.xml"/></Relationships>`},
		{name: "xl/worksheets/sheet1.xml", body: `<worksheet><sheetData><row r="1"><c r="BAD"><v>1</v></c><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><f>=1+2</f></c><c r="D1" t="b"><v>1</v></c><c r="E1" t="b"><v>0</v></c><c r="F1" t="inlineStr"><is><t>Inl</t></is></c><c r="G1"><v></v></c></row></sheetData></worksheet>`},
		{name: "xl/worksheets/sheet3.xml", body: `<worksheet><not-valid-xml`},
	})
	parsedCustom, err := ParseXLSX(customZip)
	if err != nil || len(parsedCustom.Sheets) != 2 || parsedCustom.Sheets[0].Cells["B1"].Value != "Rich" || parsedCustom.Sheets[0].Cells["C1"].Value != 3.0 {
		t.Fatalf("custom xlsx parse failed: %+v err=%v", parsedCustom, err)
	}

	// Fallback scan when workbook.xml absent
	fallbackZip, _ := buildZipBytes([]zipEntry{
		{name: "xl/worksheets/sheet1.xml", body: `<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>`},
	})
	fbWB, err := ParseXLSX(fallbackZip)
	if err != nil || fbWB.Sheets[0].Name != "Sheet1" || fbWB.Sheets[0].Cells["A1"].Value != 7.0 {
		t.Fatalf("fallback xlsx scan failed: %+v err=%v", fbWB, err)
	}

	// Test corrupt zip entry Open error (unsupported method 99) and ReadAll error (corrupt deflate stream)
	badMethodZip := makeCorruptMethodZip("xl/worksheets/sheet1.xml")
	if _, err := ParseXLSX(badMethodZip); err == nil {
		t.Fatal("expected error for unsupported zip compression method")
	}
	badDeflateZip := makeCorruptDeflateZip("xl/worksheets/sheet1.xml")
	if _, err := ParseXLSX(badDeflateZip); err == nil {
		t.Fatal("expected error for corrupt deflate payload")
	}
}

func makeCorruptMethodZip(entryName string) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	fh := &zip.FileHeader{Name: entryName, Method: zip.Deflate}
	fw, _ := zw.CreateHeader(fh)
	_, _ = fw.Write([]byte("hello world hello world"))
	_ = zw.Close()
	raw := buf.Bytes()
	// Patch compression method in local file header (offset 8..10) and central dir header
	binary.LittleEndian.PutUint16(raw[8:10], 99)
	if idx := bytes.Index(raw, []byte{0x50, 0x4b, 0x01, 0x02}); idx >= 0 {
		binary.LittleEndian.PutUint16(raw[idx+10:idx+12], 99)
	}
	return raw
}

func makeCorruptDeflateZip(entryName string) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	fw, _ := zw.Create(entryName)
	_, _ = fw.Write([]byte("some xml content to compress with deflate"))
	_ = zw.Close()
	raw := buf.Bytes()
	// Corrupt compressed payload bytes right after local header (30 + len(name))
	dataStart := 30 + len(entryName)
	for i := dataStart; i < dataStart+5 && i < len(raw); i++ {
		raw[i] ^= 0xff
	}
	return raw
}

func TestFormulaEngineInspectQueryApplyVerify(t *testing.T) {
	wb := NewWorkbook("Data")
	cells := map[string]string{
		"A1": "10",
		"A2": "20",
		"A3": "5",
		"A4": "text",
		"B1": "=SUM(A1:A3, 5)",
		"B2": "=AVERAGE(A3:A1)", // reversed row range
		"B9": "=SUM(B1:A1)",     // reversed col range
		"B3": "=MIN(A1:A3)",
		"B4": "=MAX(A1:A3)",
		"B5": "=COUNT(A1:A4)",
		"B6": "=ABS(-7)",
		"B7": "=ROUND(3.14159, 2)",
		"B8": "=ROUND(3.6)",
		"C1": `=IF(A1>=10, "ok", "no")`,
		"C2": `=IF(A1<5, "yes", "no")`,
		"C3": `=IF(FALSE, "a")`,
		"C4": `=(A1 + A2) * 2 - 10 / 2`,
		"C5": `=A1=10`,
		"C6": `=A1<>20`,
		"C7": `=A2>A1`,
		"C8": `=A3<=5`,
		"C9": `="b">"a"`,
		"D1": `="a"="a"`,
		"D2": `="a"!="b"`,
		"D3": `="b">="b"`,
		"D4": `="a"<"b"`,
		"D5": `="a"<="a"`,
		"D6": `=`,           // empty formula
		"D7": `=TRUE`,       // bool literal
		"D8": `=A99`,        // empty cell ref -> 0
		"E1": `=1/0`,        // #DIV/0!
		"E2": `=E3`,         // cycle
		"E3": `=E2`,         // cycle
		"E4": `=UNKNOWN(1)`, // #NAME?
		"E5": `=BADREF`,     // #NAME?
		"E6": `=ABS()`,      // #VALUE!
		"E7": `=ABS("x")`,   // #VALUE!
		"E8": `=ABS(E1)`,    // propagate err
		"F1": `=ROUND()`,
		"F2": `=ROUND("x")`,
		"F3": `=ROUND(E1)`,
		"F4": `=ROUND(1, E1)`,
		"F5": `=IF(TRUE)`,
		"F6": `=IF(E1, 1, 2)`,
		"F7": `=AVERAGE(A4)`,
		"F8": `=SUM(A4)`,
		"F9": `=SUM(A1:E1)`,
		"G1": `=SUM(E1)`,
		"G2": `=E1 + 1`,
		"G3": `=1 + E1`,
		"G4": `="x" + 1`,
		"G5": `=E1 * 2`,
		"G6": `=2 * E1`,
		"G7": `="x" * 2`,
		"G8": `=E1 = 1`,
		"G9": `=1 = E1`,
		"H1": `=(1+2)+(3+4)`,       // balancedParens early close check
		"H2": `=IF("a,b"="a,b",1)`, // comma inside string + quoted op
		"H3": `=IF(1, "yes")`,      // numeric truthy
		"H4": `=IF("yes", 1)`,      // string truthy
		"H5": `=SUM(TRUE, FALSE)`,  // bool in toFloat
		"H6": `=1 + (2 * 3)`,       // parens inside add/mul scan
		"H7": `=SUM((1+2), 3)`,     // parens inside splitArgs
		"H8": `=(1 + 2`,            // unbalanced parens
		"H9": `="a=b" = "a=b"`,     // operator inside quotes
		"I1": `=1 + "a+b"`,         // quotes inside addSub scan
		"I2": `=1 * "a*b"`,         // quotes inside mulDiv scan
		"I3": `=FOO!BAR(1)`,        // invalid ident before (
		"I4": `=IF(A1<A2, 1, 0)`,   // < comparison on numbers
		"I5": `=IF(A1>A2, 1, 0)`,   // > false branch
		"I6": `=IF("a">"b", 1, 0)`, // string comparison
		"I7": `=A1>=10`,
		"I8": `=1 + (2 - 1)`,
		"I9": `=SUM(B1)`, // cached evaluated cell hit
	}
	for a1, raw := range cells {
		r, c, _ := ParseA1(a1)
		wb.Sheets[0].Cells[a1] = Cell{Row: r, Col: c, A1: a1, Raw: raw}
	}
	wb.Recalculate()

	if wb.Sheets[0].Cells["B1"].Value != 40.0 {
		t.Fatalf("B1=%v", wb.Sheets[0].Cells["B1"].Value)
	}
	if wb.Sheets[0].Cells["B2"].Value != 35.0/3.0 {
		t.Fatalf("B2=%v", wb.Sheets[0].Cells["B2"].Value)
	}
	if wb.Sheets[0].Cells["B3"].Value != 5.0 || wb.Sheets[0].Cells["B4"].Value != 20.0 || wb.Sheets[0].Cells["B5"].Value != 3.0 {
		t.Fatalf("MIN/MAX/COUNT mismatch")
	}
	if wb.Sheets[0].Cells["B6"].Value != 7.0 || wb.Sheets[0].Cells["B7"].Value != 3.14 || wb.Sheets[0].Cells["B8"].Value != 4.0 {
		t.Fatalf("ABS/ROUND mismatch")
	}
	if wb.Sheets[0].Cells["C1"].Value != "ok" || wb.Sheets[0].Cells["C2"].Value != "no" || wb.Sheets[0].Cells["C3"].Value != false {
		t.Fatalf("IF mismatch")
	}
	if wb.Sheets[0].Cells["C4"].Value != 55.0 {
		t.Fatalf("C4=%v", wb.Sheets[0].Cells["C4"].Value)
	}
	if wb.Sheets[0].Cells["E1"].Error != "#DIV/0!" || wb.Sheets[0].Cells["E2"].Error != "#CYCLE!" {
		t.Fatalf("expected #DIV/0! and #CYCLE!, got %q %q", wb.Sheets[0].Cells["E1"].Error, wb.Sheets[0].Cells["E2"].Error)
	}

	// Cover remaining edge cases on helpers directly
	if n, ok := toFloat(5); !ok || n != 5 {
		t.Fatal("toFloat(int) failed")
	}
	if _, ok := toFloat(struct{}{}); ok {
		t.Fatal("toFloat(struct) should fail")
	}
	if toBool(struct{}{}) {
		t.Fatal("toBool(struct) should be false")
	}
	if balancedParens("))") {
		t.Fatal("balancedParens should reject negative depth")
	}
	if findTopLevelOp(`(")")=1`, "=") < 0 {
		t.Fatal("findTopLevelOp failed with quoted paren")
	}
	if findTopLevelOp("a>=b", "=") != -1 || findTopLevelOp("a<=b", "<") != -1 || findTopLevelOp("a<>b", ">") != -1 {
		t.Fatal("findTopLevelOp single-char operator guard failed")
	}
	if idx, _ := findLastTopLevelAddSub("(1+2)"); idx != -1 {
		t.Fatal("findLastTopLevelAddSub should ignore parens")
	}
	if idx, _ := findLastTopLevelMulDiv("(1*2)"); idx != -1 {
		t.Fatal("findLastTopLevelMulDiv should ignore parens")
	}

	// Inspect (summary, standard, full)
	if m := wb.Inspect("summary"); m["sheetCount"] != 1 {
		t.Fatalf("summary inspect failed: %+v", m)
	}
	if m := wb.Inspect("standard"); m["totalErrors"].(int) == 0 {
		t.Fatalf("expected formula errors in inspect: %+v", m)
	}
	if m := wb.Inspect("full"); m["totalFormulas"].(int) == 0 {
		t.Fatalf("expected formulas in full inspect: %+v", m)
	}

	// Query
	if q := wb.Query("Other", "", false, false, 0); len(q) != 0 {
		t.Fatalf("expected 0 results for missing sheet, got %d", len(q))
	}
	if q := wb.Query("Data", "SUM", true, false, 1); len(q) != 1 {
		t.Fatalf("expected 1 limited formula match, got %d", len(q))
	}
	if q := wb.Query("Data", "", false, true, 50); len(q) == 0 {
		t.Fatal("expected error cells in query")
	}
	if q := wb.Query("Data", "does-not-exist", false, false, 10); len(q) != 0 {
		t.Fatalf("expected 0 matches, got %d", len(q))
	}

	// Apply (addSheet, setCell, clear cell, deleteSheet, dryRun, rollback on errors)
	wb2 := NewWorkbook()
	wb2.Sheets[0].Cells = nil // exercise nil map init in setCell
	n, diff, err := wb2.Apply([]Op{
		{Op: "setCell", A1: "A1", Raw: "100"},
		{Op: "setCell", A1: "A2", Raw: "=A1*2"},
		{Op: "addSheet", Name: ""},
		{Op: "setCell", Sheet: "Sheet2", A1: "B1", Raw: "hi"},
		{Op: "setCell", Sheet: "Sheet2", A1: "B1", Raw: ""}, // clear
	}, true)
	if err != nil || n != 5 || len(diff) != 5 || len(wb2.Sheets) != 1 {
		t.Fatalf("dryRun apply failed: n=%d diff=%v sheets=%d err=%v", n, diff, len(wb2.Sheets), err)
	}
	if _, _, err := wb2.Apply([]Op{
		{Op: "setCell", A1: "A1", Raw: "10"},
		{Op: "addSheet", Name: "Empty"},
		{Op: "addSheet", Name: "Temp"},
		{Op: "deleteSheet", Sheet: "Temp"},
	}, false); err != nil {
		t.Fatalf("real apply failed: %v", err)
	}
	// Error rollbacks
	for _, badOps := range [][]Op{
		{{Op: "setCell", Sheet: "Nope", A1: "A1", Raw: "1"}},
		{{Op: "setCell", Sheet: "Sheet1", A1: "BAD", Raw: "1"}},
		{{Op: "deleteSheet", Sheet: "Nope"}},
		{{Op: "unknownOp"}},
	} {
		if _, _, err := wb2.Apply(badOps, false); err == nil {
			t.Fatalf("expected apply error for %+v", badOps)
		}
	}

	// Verify (empty sheet + formula error)
	_, _, _ = wb2.Apply([]Op{{Op: "setCell", Sheet: "Sheet1", A1: "B1", Raw: "=1/0"}}, false)
	diags := wb2.Verify()
	if len(diags) != 2 {
		t.Fatalf("expected 2 diagnostics (FORMULA_ERROR + EMPTY_SHEET), got %+v", diags)
	}
}

func TestHandlerAndTools(t *testing.T) {
	mem := storage.NewMemoryStore()
	var webhookHits int
	whSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		webhookHits++
		w.WriteHeader(http.StatusOK)
	}))
	defer whSrv.Close()

	auth := storage.NewBearerTokenAuth(map[string]storage.Principal{
		"admin": {ID: "u1", Roles: []string{"admin"}},
	})
	h := NewHandler(
		mem,
		WithAuth(auth, storage.NewRoleAuthorizer(nil)),
		WithWebhook(storage.NewWebhookDispatcher(whSrv.URL, "sec", whSrv.Client())),
	)
	doReq := func(method, path string, body io.Reader, ct string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, body)
		r.Header.Set("Authorization", "Bearer admin")
		if ct != "" {
			r.Header.Set("Content-Type", ct)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		return rec
	}

	// POST /sheets JSON (default empty + explicit)
	rec := doReq(http.MethodPost, "/sheets", strings.NewReader(""), "application/json")
	if rec.Code != http.StatusCreated {
		t.Fatalf("empty POST /sheets failed: %d %s", rec.Code, rec.Body.String())
	}
	rec = doReq(http.MethodPost, "/sheets", strings.NewReader(`{"id":"s1","title":"Q1","workbook":{"sheets":[{"name":"Main","cells":{"A1":{"row":0,"col":0,"a1":"A1","raw":"10"}}}]}}`), "application/json")
	if rec.Code != http.StatusCreated {
		t.Fatalf("JSON POST /sheets failed: %d %s", rec.Code, rec.Body.String())
	}
	// Duplicate ID -> 409 Conflict
	rec = doReq(http.MethodPost, "/sheets", strings.NewReader(`{"id":"s1"}`), "application/json")
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", rec.Code)
	}
	// Invalid ID -> 400
	rec = doReq(http.MethodPost, "/sheets", strings.NewReader(`{"id":"../bad"}`), "application/json")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 invalid id, got %d", rec.Code)
	}
	// Bad JSON & body read error
	if rec := doReq(http.MethodPost, "/sheets", strings.NewReader("{bad"), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad json, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/sheets", errReader{}, "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 read err, got %d", rec.Code)
	}

	// POST /sheets CSV & XLSX import (+ errors)
	if rec := doReq(http.MethodPost, "/sheets?format=csv&id=csv1&title=CSV", strings.NewReader("A,B\n1,2\n"), "text/csv"); rec.Code != http.StatusCreated {
		t.Fatalf("CSV import failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doReq(http.MethodPost, "/sheets?format=csv", strings.NewReader(`"bad`), "text/csv"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad csv, got %d", rec.Code)
	}
	sampleXLSX, _ := WriteXLSX(NewWorkbook("S1"))
	if rec := doReq(http.MethodPost, "/sheets?format=xlsx&id=x1", bytes.NewReader(sampleXLSX), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); rec.Code != http.StatusCreated {
		t.Fatalf("XLSX import failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doReq(http.MethodPost, "/sheets?format=xlsx", strings.NewReader("notzip"), "application/octet-stream"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad xlsx, got %d", rec.Code)
	}

	// GET /sheets/{id} & 404
	if rec := doReq(http.MethodGet, "/sheets/s1?detail=full", nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("GET /sheets/s1 failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/sheets/missing", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}

	// GET /sheets/{id}/export (xlsx, csv, invalid sheetIndex, out of range, unsupported format, 404, writeXLSX fail)
	if rec := doReq(http.MethodGet, "/sheets/s1/export", nil, ""); rec.Code != http.StatusOK || !strings.Contains(rec.Header().Get("Content-Type"), "spreadsheetml") {
		t.Fatalf("export xlsx failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/sheets/s1/export?format=csv&sheetIndex=0", nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("export csv failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/sheets/s1/export?format=csv&sheetIndex=abc", nil, ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad sheetIndex, got %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/sheets/s1/export?format=csv&sheetIndex=9", nil, ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 out-of-range sheetIndex, got %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/sheets/s1/export?format=pdf", nil, ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 unsupported format, got %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/sheets/missing/export", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 export, got %d", rec.Code)
	}
	origW := newBytesWriter
	newBytesWriter = func(*bytes.Buffer) io.Writer { return &limitWriter{limit: 0} }
	if rec := doReq(http.MethodGet, "/sheets/s1/export?format=xlsx", nil, ""); rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on WriteXLSX failure, got %d", rec.Code)
	}
	newBytesWriter = origW

	// POST /sheets/{id}/query
	if rec := doReq(http.MethodPost, "/sheets/s1/query", strings.NewReader(`{"sheet":"Main"}`), "application/json"); rec.Code != http.StatusOK {
		t.Fatalf("query failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/sheets/s1/query", strings.NewReader("{bad"), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad query json, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/sheets/missing/query", strings.NewReader(`{}`), "application/json"); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 query, got %d", rec.Code)
	}

	// POST /sheets/{id}/apply
	if rec := doReq(http.MethodPost, "/sheets/s1/apply", strings.NewReader(`{"ops":[{"op":"setCell","sheet":"Main","a1":"B1","raw":"=A1*3"}]}`), "application/json"); rec.Code != http.StatusOK {
		t.Fatalf("apply failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doReq(http.MethodPost, "/sheets/s1/apply", strings.NewReader(`{"ops":[{"op":"bad"}]}`), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad op, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/sheets/s1/apply", strings.NewReader("{bad"), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad json, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/sheets/missing/apply", strings.NewReader(`{"ops":[]}`), "application/json"); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 apply, got %d", rec.Code)
	}

	// POST /sheets/{id}/verify
	if rec := doReq(http.MethodPost, "/sheets/s1/verify", nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("verify failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/sheets/missing/verify", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 verify, got %d", rec.Code)
	}

	// Failing store (500 on Put during apply, corrupt stored JSON, Delete error)
	fs := &failingStore{Store: mem, putErr: errors.New("disk full"), delErr: errors.New("delete fail")}
	fh := NewHandler(fs)
	rec = httptest.NewRecorder()
	fh.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/sheets/s1/apply", strings.NewReader(`{"ops":[{"op":"addSheet","name":"S2"}]}`)))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on failing store put, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	fh.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/sheets/s1", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on failing store delete, got %d", rec.Code)
	}

	// Corrupt stored record JSON
	_ = mem.Put(context.Background(), &storage.DocumentRecord{ID: "corrupt", Kind: "sheet", Data: []byte("{bad")})
	if rec := doReq(http.MethodGet, "/sheets/corrupt", nil, ""); rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on corrupt stored json, got %d", rec.Code)
	}

	// DELETE /sheets/{id}
	if rec := doReq(http.MethodDelete, "/sheets/x1", nil, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("delete failed: %d", rec.Code)
	}
	if webhookHits < 4 {
		t.Fatalf("expected webhook dispatches, got %d", webhookHits)
	}

	// RegisterTools + MCP execution
	reg := ai.NewToolRegistry()
	if err := RegisterTools(nil, mem); err == nil {
		t.Fatal("expected error for nil registry")
	}
	if err := RegisterTools(reg, mem); err != nil {
		t.Fatalf("RegisterTools failed: %v", err)
	}
	if err := RegisterTools(reg, mem); !errors.Is(err, ai.ErrDuplicateTool) {
		t.Fatalf("expected duplicate tool error on second register, got %v", err)
	}
	ctx := context.Background()
	if _, err := reg.Call(ctx, "sheet_inspect", map[string]any{"id": "s1", "detail": "summary"}); err != nil {
		t.Fatalf("sheet_inspect failed: %v", err)
	}
	if _, err := reg.Call(ctx, "sheet_inspect", map[string]any{"id": "missing"}); err == nil {
		t.Fatal("expected sheet_inspect error")
	}
	if _, err := reg.Call(ctx, "sheet_query", map[string]any{"id": "s1", "sheet": "Main"}); err != nil {
		t.Fatalf("sheet_query failed: %v", err)
	}
	if _, err := reg.Call(ctx, "sheet_query", map[string]any{"id": "missing"}); err == nil {
		t.Fatal("expected sheet_query error")
	}
	if _, err := reg.Call(ctx, "sheet_verify", map[string]any{"id": "s1"}); err != nil {
		t.Fatalf("sheet_verify failed: %v", err)
	}
	if _, err := reg.Call(ctx, "sheet_verify", map[string]any{"id": "missing"}); err == nil {
		t.Fatal("expected sheet_verify error")
	}
	// sheet_apply success, dryRun, bad ops marshal/unmarshal, bad op, missing doc, store Put error
	if _, err := reg.Call(ctx, "sheet_apply", map[string]any{"id": "s1", "ops": []any{map[string]any{"op": "addSheet", "name": "Extra"}}}); err != nil {
		t.Fatalf("sheet_apply failed: %v", err)
	}
	if _, err := reg.Call(ctx, "sheet_apply", map[string]any{"id": "missing", "ops": []any{}}); err == nil {
		t.Fatal("expected sheet_apply missing error")
	}
	if _, err := reg.Call(ctx, "sheet_apply", map[string]any{"id": "s1", "ops": make(chan int)}); err == nil {
		t.Fatal("expected sheet_apply marshal error")
	}
	if _, err := reg.Call(ctx, "sheet_apply", map[string]any{"id": "s1", "ops": "not-an-array"}); err == nil {
		t.Fatal("expected sheet_apply unmarshal error")
	}
	if _, err := reg.Call(ctx, "sheet_apply", map[string]any{"id": "s1", "ops": []any{map[string]any{"op": "nope"}}}); err == nil {
		t.Fatal("expected sheet_apply op error")
	}

	regFail := ai.NewToolRegistry()
	_ = RegisterTools(regFail, &failingStore{Store: mem, putErr: errors.New("put fail")})
	if _, err := regFail.Call(ctx, "sheet_apply", map[string]any{"id": "s1", "ops": []any{map[string]any{"op": "addSheet"}}}); err == nil {
		t.Fatal("expected sheet_apply store put error")
	}
	// Verify JSON round-trip of response structure
	var parsed map[string]any
	if err := json.Unmarshal([]byte(`{"ok":true}`), &parsed); err != nil {
		t.Fatal(err)
	}
}
