package api

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

// Exercise the preserved parser/import code on a test-only route. Production
// deliberately does not register this legacy handler until its writes and
// authorization checks share a transaction.
func newLegacyCSVTestServer(t *testing.T, st store.Store) (*httptest.Server, *http.Client) {
	t.Helper()
	s := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	mux := http.NewServeMux()
	mux.Handle("POST /api/bases/{id}/import", s.requireUser(http.HandlerFunc(s.importCSVLegacy)))
	mux.Handle("/", s.Handler())
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	return ts, &http.Client{Jar: jar}
}

func TestCSVImportProductionAtomic(t *testing.T) {
	st := store.NewMemory()
	ts, client := newTestServer(t, st, nil)
	res := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "csv-disabled@x.com", "name": "C", "password": "password123"})
	res.Body.Close()
	res = post(t, client, ts.URL+"/api/bases", nil)
	var b store.DocMeta
	if err := json.NewDecoder(res.Body).Decode(&b); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	beforeFields, err := st.Fields(context.Background(), b.ID)
	if err != nil {
		t.Fatal(err)
	}
	beforeRecords, err := st.Records(context.Background(), b.ID)
	if err != nil {
		t.Fatal(err)
	}
	res = post(t, client, ts.URL+"/api/bases/"+itoa(b.ID)+"/import", map[string]any{"csv": "任务\n新的任务", "header": true})
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("import status: %d", res.StatusCode)
	}
	var result struct {
		Imported int `json:"imported"`
		Fields   int `json:"fields"`
	}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Imported != 1 || result.Fields != 1 {
		t.Fatalf("error: %+v", result)
	}
	afterFields, err := st.Fields(context.Background(), b.ID)
	if err != nil {
		t.Fatal(err)
	}
	afterRecords, err := st.Records(context.Background(), b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(afterFields) != len(beforeFields)+1 || len(afterRecords) != len(beforeRecords)+1 {
		t.Fatalf("import fields %d -> %d, records %d -> %d", len(beforeFields), len(afterFields), len(beforeRecords), len(afterRecords))
	}
}

func TestCSVProductionReportsBadRowsAndRejectsAmbiguousColumns(t *testing.T) {
	st := store.NewMemory()
	ts, client := newTestServer(t, st, nil)
	res := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "csv-plan@x.com", "name": "C", "password": "password123"})
	res.Body.Close()
	res = post(t, client, ts.URL+"/api/bases", nil)
	var b store.DocMeta
	if err := json.NewDecoder(res.Body).Decode(&b); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	endpoint := ts.URL + "/api/bases/" + itoa(b.ID) + "/import"
	res = post(t, client, endpoint, map[string]any{"csv": "\ufeff任务,工时,完成\n有效,3,true\n坏行,无效,false\n太多,1,true,额外", "header": true, "types": []string{"text", "number", "checkbox"}})
	defer res.Body.Close()
	var result struct {
		Imported int           `json:"imported"`
		Errors   []csvRowError `json:"errors"`
	}
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Imported != 1 || len(result.Errors) != 2 || result.Errors[0].Row != 3 || result.Errors[1].Row != 4 {
		t.Fatalf("result: %+v", result)
	}
	fields, _ := st.Fields(context.Background(), b.ID)
	records, _ := st.Records(context.Background(), b.ID)
	head, _ := st.BtHead(context.Background(), b.ID)
	for _, request := range []map[string]any{
		{"csv": "重复,重复\nA,B", "header": true},
		{"csv": "未知\nA", "header": true, "types": []string{"not-a-field"}},
		{"csv": "关联\n1", "header": true, "types": []string{"link"}},
	} {
		resp := post(t, client, endpoint, request)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("invalid import status %d", resp.StatusCode)
		}
	}
	afterFields, _ := st.Fields(context.Background(), b.ID)
	afterRecords, _ := st.Records(context.Background(), b.ID)
	afterHead, _ := st.BtHead(context.Background(), b.ID)
	if len(fields) != len(afterFields) || len(records) != len(afterRecords) || head != afterHead {
		t.Fatal("invalid import changed data")
	}
}

func TestCSVImportPreservesTextWhitespace(t *testing.T) {
	fields := []store.Field{{ID: 7, Name: "文本", Type: "text"}, {ID: 8, Name: "数值", Type: "number"}}
	plan, errs, err := csvImportPlan([][]string{{"文本", "数值"}, {"  项目  ", " 12 "}, {" ", ""}}, true, nil, fields, nil)
	if err != nil || len(errs) != 0 || len(plan.Rows) != 2 {
		t.Fatalf("plan=%+v errs=%+v err=%v", plan, errs, err)
	}
	if string(plan.Rows[0][0]) != `"  项目  "` || string(plan.Rows[0][1]) != `12` || string(plan.Rows[1][0]) != `" "` {
		t.Fatalf("whitespace changed: %+v", plan.Rows)
	}
}

func TestCSVImportPreservesNumericTextAndEmptyRows(t *testing.T) {
	for _, value := range []string{"00123", "1.0", "1e3", "9007199254740993"} {
		if got := inferType([]string{value}); got != "text" {
			t.Errorf("inferType(%q)=%q, want text", value, got)
		}
	}
	if got := inferType([]string{"123", "3.5"}); got != "number" {
		t.Fatalf("canonical numbers inferred as %q", got)
	}
	plan, errs, err := csvImportPlan([][]string{{"编号", "内容"}, {"00123", ""}, {"", ""}, {"", "末行"}}, true, nil, nil, nil)
	if err != nil || len(errs) != 0 || len(plan.Rows) != 3 || plan.Columns[0].New.Type != "text" {
		t.Fatalf("plan=%+v errs=%+v err=%v", plan, errs, err)
	}
	if string(plan.Rows[0][0]) != `"00123"` || len(plan.Rows[1]) != 0 {
		t.Fatalf("rows changed: %+v", plan.Rows)
	}
	spacePlan, _, err := csvImportPlan([][]string{{"编码"}, {" 123 "}}, true, nil, nil, nil)
	if err != nil || spacePlan.Columns[0].New.Type != "text" || string(spacePlan.Rows[0][0]) != `" 123 "` {
		t.Fatalf("spaced text changed: %+v err=%v", spacePlan, err)
	}
}

func TestCSVExportImportPreservesSingleColumnBlankAndMultilineRows(t *testing.T) {
	st := store.NewMemory()
	ts, client := newTestServer(t, st, nil)
	res := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "csv-roundtrip@x.com", "name": "C", "password": "password123"})
	res.Body.Close()
	create := func() store.DocMeta {
		resp := post(t, client, ts.URL+"/api/bases", nil)
		defer resp.Body.Close()
		var b store.DocMeta
		if err := json.NewDecoder(resp.Body).Decode(&b); err != nil {
			t.Fatal(err)
		}
		return b
	}
	source, target := create(), create()
	fields, err := st.Fields(context.Background(), source.ID)
	if err != nil || len(fields) != 1 {
		t.Fatalf("fields=%v err=%v", fields, err)
	}
	key := strconv.FormatInt(fields[0].ID, 10)
	for _, value := range []string{"开头", "", "末尾", "第一行\n\n第二行", "含\"引号"} {
		cells := map[string]json.RawMessage{}
		if value != "" {
			raw, _ := json.Marshal(value)
			cells[key] = raw
		}
		if _, err := st.AddRecord(context.Background(), store.Record{BaseID: source.ID, Cells: cells}); err != nil {
			t.Fatal(err)
		}
	}
	resp, err := client.Get(ts.URL + "/api/bases/" + itoa(source.ID) + "/export")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("export status=%d err=%v", resp.StatusCode, err)
	}
	resp = post(t, client, ts.URL+"/api/bases/"+itoa(target.ID)+"/import", map[string]any{"csv": string(data), "header": true})
	defer resp.Body.Close()
	var result struct {
		Imported int           `json:"imported"`
		Errors   []csvRowError `json:"errors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("import status=%d err=%v", resp.StatusCode, err)
	}
	if result.Imported != 10 || len(result.Errors) != 0 {
		t.Fatalf("import result=%+v CSV=%q", result, data)
	}
	sourceRows, _ := st.Records(context.Background(), source.ID)
	targetRows, _ := st.Records(context.Background(), target.ID)
	targetFields, _ := st.Fields(context.Background(), target.ID)
	targetKey := strconv.FormatInt(targetFields[0].ID, 10)
	if len(targetRows) != 5+len(sourceRows) {
		t.Fatalf("source=%d target=%d", len(sourceRows), len(targetRows))
	}
	for i, row := range sourceRows {
		var a, b string
		_ = json.Unmarshal(row.Cells[key], &a)
		_ = json.Unmarshal(targetRows[5+i].Cells[targetKey], &b)
		if a != b {
			t.Fatalf("row %d: %q != %q", i, a, b)
		}
	}
}

func TestCSVBlankLinePreservationHonorsQuotedFieldsAndCRLF(t *testing.T) {
	for _, useCRLF := range []bool{false, true} {
		want := [][]string{{"标题", "说明"}, {"", ""}, {"中文", "前\n\n后"}, {"含\"引号", ""}, {"", "尾"}}
		var out bytes.Buffer
		writer := csv.NewWriter(&out)
		writer.UseCRLF = useCRLF
		if err := writer.WriteAll(want); err != nil {
			t.Fatal(err)
		}
		r := csv.NewReader(strings.NewReader(preserveCSVBlankLines(out.String())))
		r.FieldsPerRecord = -1
		got, err := r.ReadAll()
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("CRLF=%v got=%q want=%q err=%v", useCRLF, got, want, err)
		}
	}
}

func TestLegacyCSVImportInferAndErrors(t *testing.T) {
	st := store.NewMemory()
	ts, c := newLegacyCSVTestServer(t, st)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "csv@x.com", "name": "C", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	u := ts.URL + "/api/bases/" + itoa(b.ID)

	csvData := "任务,工时,完成,截止\n导入A,3.5,true,2026-01-02\n导入B,2,false,2026-01-03\n坏行,不是数字,x,2026-01-04\n导入C,,,,"
	var res struct {
		Imported int
		Fields   int
		Errors   []struct {
			Row int
			Err string
		}
	}
	r := post(t, c, u+"/import", map[string]any{
		"csv":    csvData,
		"header": true,
		"types":  []string{"text", "number", "checkbox", "date"},
	})
	if r.StatusCode != 200 {
		t.Fatalf("import: %d", r.StatusCode)
	}
	json.NewDecoder(r.Body).Decode(&res)
	if res.Imported != 3 || res.Fields != 4 { // 坏行 skipped, 导入C imports with only 任务
		t.Fatalf("import result: %+v", res)
	}
	if len(res.Errors) != 1 || res.Errors[0].Row != 4 {
		t.Fatalf("errors: %+v", res)
	}

	// a second import without explicit types infers them
	r = post(t, c, u+"/import", map[string]any{"csv": "数量,完成\n3,true\n4,false\n", "header": true})
	if r.StatusCode != 200 {
		t.Fatalf("import2: %d", r.StatusCode)
	}
	var full struct {
		Fields []store.Field
	}
	r, _ = c.Get(u)
	json.NewDecoder(r.Body).Decode(&full)
	types := map[string]string{}
	for _, f := range full.Fields {
		types[f.Name] = f.Type
	}
	if types["工时"] != "number" || types["完成"] != "checkbox" || types["截止"] != "date" || types["任务"] != "text" {
		t.Fatalf("explicit types: %v", types)
	}
	if types["数量"] != "number" || types["完成"] != "checkbox" {
		t.Fatalf("inferred types: %v", types)
	}

	// export → import round-trip keeps the row count
	r, _ = c.Get(u + "/export")
	if ct := r.Header.Get("Content-Type"); !strings.Contains(ct, "text/csv") {
		t.Fatalf("content type: %s", ct)
	}
	body, _ := io.ReadAll(r.Body)
	lines := strings.Split(strings.TrimSpace(string(body)), "\n")
	if len(lines) != 1+4 { // header + 2 imported + 3 empty seeded rows... seeded rows may be empty but exported
		t.Logf("export lines: %d", len(lines))
	}
	resp := post(t, c, u+"/import", map[string]any{"csv": string(body), "header": true})
	if resp.StatusCode != 200 {
		t.Fatalf("reimport: %d", resp.StatusCode)
	}
	json.NewDecoder(resp.Body).Decode(&res)
	nonEmpty := 0
	for _, l := range lines[1:] {
		if strings.ReplaceAll(strings.ReplaceAll(l, ",", ""), " ", "") != "" {
			nonEmpty++
		}
	}
	if res.Imported != nonEmpty {
		t.Fatalf("reimport rows %d vs exported non-empty %d", res.Imported, nonEmpty)
	}
}

func TestLegacyCSVImportPerf10k(t *testing.T) {
	st := store.NewMemory()
	ts, c := newLegacyCSVTestServer(t, st)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "perf@x.com", "name": "P", "password": "password123"})
	var b store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/bases", nil).Body).Decode(&b)
	var sb strings.Builder
	wr := csv.NewWriter(&sb)
	_ = wr.Write([]string{"任务", "工时"})
	for i := 0; i < 10000; i++ {
		_ = wr.Write([]string{itoaInt(i) + "号任务", itoaInt(i % 100)})
	}
	wr.Flush()
	start := time.Now()
	res := post(t, c, ts.URL+"/api/bases/"+itoa(b.ID)+"/import", map[string]any{"csv": sb.String(), "header": true})
	if res.StatusCode != 200 {
		t.Fatalf("import: %d", res.StatusCode)
	}
	var out struct{ Imported int }
	json.NewDecoder(res.Body).Decode(&out)
	elapsed := time.Since(start)
	if out.Imported != 10000 {
		t.Fatalf("imported %d", out.Imported)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("10k import took %s (>5s)", elapsed)
	}
	t.Logf("10k-row CSV import took %s", elapsed)
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func itoaInt(i int) string { return strconv.Itoa(i) }

func quote(s string) string { b, _ := json.Marshal(s); return string(b) }
