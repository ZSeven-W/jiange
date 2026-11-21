package base

import (
	"bytes"
	"context"
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

func (errReader) Read([]byte) (int, error) { return 0, errors.New("read fail") }

type limitWriter struct {
	limit int
	wrote int
	buf   bytes.Buffer
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if l.wrote+len(p) > l.limit {
		return 0, errors.New("limit reached")
	}
	l.wrote += len(p)
	return l.buf.Write(p)
}

type failingStore struct {
	storage.Store
	putErr error
	delErr error
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

func TestCSVExprInspectQueryApplyVerify(t *testing.T) {
	// ParseCSV: empty, invalid, valid
	if _, err := ParseCSV([]byte(`"unterminated`), ""); err == nil {
		t.Fatal("expected csv parse error")
	}
	emptyBase, err := ParseCSV([]byte(""), "")
	if err != nil || emptyBase.Name != "Untitled Base" || len(emptyBase.Fields) != 0 {
		t.Fatalf("empty CSV parse failed: %+v err=%v", emptyBase, err)
	}
	b, err := ParseCSV([]byte("Item,Qty,Price\nPen,2,1.5\nBook,3,10\n"), "Orders")
	if err != nil || len(b.Fields) != 3 || len(b.Records) != 2 {
		t.Fatalf("ParseCSV failed: %+v err=%v", b, err)
	}
	// Add formula fields (one valid, one with error) + second table for filter branches
	b.Tables = append(b.Tables, Table{ID: 2, Name: "Other"})
	b.Fields = append(b.Fields,
		Field{ID: 4, TableID: 1, Name: "Total", Type: "formula", Expression: "[Qty] * [Price]"},
		Field{ID: 5, TableID: 1, Name: "BadFormula", Type: "formula", Expression: "[Qty] / 0"},
		Field{ID: 6, TableID: 2, Name: "Label", Type: "text"},
	)
	b.Records = append(b.Records, Record{ID: 3, TableID: 2, Cells: map[string]any{"Label": "t2"}})

	// ToCSV success & error paths
	csvOut, err := b.ToCSV(0)
	if err != nil || !strings.Contains(string(csvOut), "Pen,2,1.5,3,#ERROR!") {
		t.Fatalf("unexpected ToCSV output: %q err=%v", string(csvOut), err)
	}
	if _, err := (&Base{}).ToCSV(0); err == nil {
		t.Fatal("expected no tables error")
	}
	if _, err := b.ToCSV(99); err == nil {
		t.Fatal("expected no fields error")
	}
	// ToCSV writer errors (flush + write header + write row)
	origWriter := newBytesWriter
	newBytesWriter = func(*bytes.Buffer) io.Writer { return &limitWriter{limit: 0} }
	if _, err := b.ToCSV(1); err == nil {
		t.Fatal("expected ToCSV flush error")
	}
	hugeHeaderBase := &Base{
		Tables: []Table{{ID: 1, Name: "T"}},
		Fields: []Field{{ID: 1, TableID: 1, Name: strings.Repeat("H", 5000), Type: "text"}},
	}
	if _, err := hugeHeaderBase.ToCSV(1); err == nil {
		t.Fatal("expected ToCSV header write error")
	}
	hugeRowBase := &Base{
		Tables:  []Table{{ID: 1, Name: "T"}},
		Fields:  []Field{{ID: 1, TableID: 1, Name: "H", Type: "text"}},
		Records: []Record{{ID: 1, TableID: 1, Cells: map[string]any{"H": strings.Repeat("v", 5000)}}},
	}
	if _, err := hugeRowBase.ToCSV(1); err == nil {
		t.Fatal("expected ToCSV row write error")
	}
	newBytesWriter = origWriter

	// EvalExpr full coverage of operators, functions, errors, and helper edge cases
	rec := Record{ID: 1, TableID: 1, Cells: map[string]any{"1": "Pen", "2": 2.0, "3": 1.5, "Direct": 9.0}}
	cases := []struct {
		expr string
		want any
	}{
		{"", ""},
		{`[Qty] * [Price]`, 3.0},
		{`([Qty] + 3) - 1`, 4.0},
		{`[Qty] / 2`, 1.0},
		{`[Direct]`, 9.0},
		{`"Item: " + [Item]`, "Item: Pen"},
		{`IF([Qty] >= 2, "many", "few")`, "many"},
		{`IF([Qty] < 2, "few", "many")`, "many"},
		{`IF(FALSE, "a")`, false},
		{`ABS(-5)`, 5.0},
		{`ROUND(3.14159, 2)`, 3.14},
		{`ROUND(3.6)`, 4.0},
		{`CONCAT([Item], "-", [Qty])`, "Pen-2"},
		{`LEN([Item])`, 3.0},
		{`UPPER([Item])`, "PEN"},
		{`LOWER([Item])`, "pen"},
		{`TRUE`, true},
		{`FALSE`, false},
		{`2 = 2`, true},
		{`2 != 3`, true},
		{`3 > 2`, true},
		{`2 < 3`, true},
		{`2 <= 2`, true},
		{`"a" = "a"`, true},
		{`"a" <> "b"`, true},
		{`"b" > "a"`, true},
		{`"b" >= "b"`, true},
		{`"a" < "b"`, true},
		{`"a" <= "a"`, true},
		{`IF(1, "t")`, "t"},
		{`IF("yes", 1)`, 1.0},
		{`([Qty]+1)+(1+1)`, 5.0},
		{`CONCAT("a,b", [Item])`, "a,bPen"},
		{`IF("[a]" = "[a]", 1)`, 1.0},
		{`1 + (2 * 3)`, 7.0},
		{`CONCAT((1+2), [Qty])`, "32"},
		{`"a+b" + "c"`, "a+bc"},
		{`[Qty] + 0`, 2.0},
		{`1 + ("a" = "a")`, 2.0},
		{`1 + ("a" = "b")`, 1.0},
	}
	for _, tc := range cases {
		got, err := b.EvalExpr(tc.expr, rec)
		if err != nil || got != tc.want {
			t.Fatalf("EvalExpr(%q) = %v (%T) err=%v, want %v (%T)", tc.expr, got, got, err, tc.want, tc.want)
		}
	}
	// Error expressions
	badExprs := []string{
		`[MissingField]`,
		`1 / 0`,
		`"x" - 1`,
		`"x" * 2`,
		`[Missing] = 1`,
		`1 = [Missing]`,
		`[Missing] + 1`,
		`1 + [Missing]`,
		`[Missing] * 2`,
		`2 * [Missing]`,
		`IF(TRUE)`,
		`IF([Missing], 1, 2)`,
		`ABS()`,
		`ABS([Missing])`,
		`ABS("x")`,
		`ROUND()`,
		`ROUND([Missing])`,
		`ROUND("x")`,
		`ROUND(1, [Missing])`,
		`CONCAT([Missing])`,
		`LEN()`,
		`LEN([Missing])`,
		`UNKNOWN(1)`,
		`FOO!BAR(1)`,
		`BAD_TOKEN`,
		`("a*b") * 2`,
	}
	for _, expr := range badExprs {
		if _, err := b.EvalExpr(expr, rec); err == nil {
			t.Fatalf("expected EvalExpr error for %q", expr)
		}
	}
	// Direct helper edge coverage
	if formatScalar(nil) != "" || formatScalar(true) != "TRUE" || formatScalar(false) != "FALSE" || formatScalar(5) != "5" {
		t.Fatal("formatScalar failed")
	}
	if n, ok := toFloat(3); !ok || n != 3 {
		t.Fatal("toFloat(int) failed")
	}
	if _, ok := toFloat(struct{}{}); ok {
		t.Fatal("toFloat(struct) should fail")
	}
	if toBool(struct{}{}) {
		t.Fatal("toBool(struct) should be false")
	}
	if balancedDelims("))") || !balancedDelims(`([Qty]+1)`) || !balancedDelims(`(")")`) {
		t.Fatal("balancedDelims edge failed")
	}
	if findExprOp(`(")")=1`, "=") < 0 || findExprOp(`([a]=1)=1`, "=") < 0 {
		t.Fatal("findExprOp edge failed")
	}
	if findExprOp("a>=b", "=") != -1 || findExprOp("a<=b", "<") != -1 || findExprOp("a<>b", ">") != -1 {
		t.Fatal("findExprOp guard failed")
	}
	if idx, _ := findLastExprAddSub(`(1+2)`); idx != -1 {
		t.Fatal("findLastExprAddSub paren failed")
	}
	if idx, _ := findLastExprAddSub(`"a+b"`); idx != -1 {
		t.Fatal("findLastExprAddSub str failed")
	}
	if idx, _ := findLastExprMulDiv(`(1*2)`); idx != -1 {
		t.Fatal("findLastExprMulDiv paren failed")
	}
	if idx, _ := findLastExprMulDiv(`[a*b]`); idx != -1 {
		t.Fatal("findLastExprMulDiv bracket failed")
	}
	if idx, _ := findLastExprAddSub(`[a+b]`); idx != -1 {
		t.Fatal("findLastExprAddSub bracket failed")
	}
	if b.cellValueForField(Record{Cells: map[string]any{}}, Field{ID: 99, Name: "None"}) != "" {
		t.Fatal("cellValueForField default failed")
	}
	if b.cellValueForField(Record{Cells: map[string]any{"Named": "ok"}}, Field{ID: 99, Name: "Named"}) != "ok" {
		t.Fatal("cellValueForField name fallback failed")
	}

	// Inspect & Query
	if info := b.Inspect(); info["tableCount"] != 2 {
		t.Fatalf("inspect failed: %+v", info)
	}
	if q := b.Query(1, "pen", 1); len(q) != 1 {
		t.Fatalf("query pen failed: %+v", q)
	}
	if q := b.Query(2, "", 10); len(q) != 1 {
		t.Fatalf("query table 2 failed: %+v", q)
	}
	if q := b.Query(0, "nonexistent", 0); len(q) != 0 {
		t.Fatalf("expected 0 results, got %d", len(q))
	}

	// Verify (empty base, duplicate field, formula error)
	if diags := (&Base{}).Verify(); len(diags) != 1 || diags[0].Code != "EMPTY_BASE" {
		t.Fatalf("expected EMPTY_BASE, got %+v", diags)
	}
	b.Fields = append(b.Fields, Field{ID: 99, TableID: 1, Name: "item", Type: "text"})
	diags := b.Verify()
	if len(diags) != 2 {
		t.Fatalf("expected 2 diagnostics (DUPLICATE_FIELD_NAME + FORMULA_ERROR), got %+v", diags)
	}

	// Apply (addTable, addField, addRecord, updateRecord, deleteRecord, dryRun, rollback on errors)
	b2 := &Base{Name: "B2"}
	n, diff, err := b2.Apply([]Op{
		{Op: "addTable", Name: ""},
		{Op: "addField", Name: "Name"},
		{Op: "addRecord", Cells: map[string]any{"1": "Alice"}},
		{Op: "updateRecord", RecordID: 1, Cells: map[string]any{"1": "Alicia"}},
		{Op: "deleteRecord", RecordID: 1},
	}, true)
	if err != nil || n != 5 || len(diff) != 5 || len(b2.Tables) != 0 {
		t.Fatalf("dryRun apply failed: n=%d tables=%d err=%v", n, len(b2.Tables), err)
	}
	b2.Tables = []Table{{ID: 1, Name: "T1"}}
	b2.Fields = []Field{{ID: 1, TableID: 1, Name: "Name", Type: "text"}}
	b2.Records = []Record{{ID: 1, TableID: 1, Cells: nil}} // exercise nil Cells init in updateRecord
	if _, _, err := b2.Apply([]Op{
		{Op: "addTable", Name: "T2"},
		{Op: "addField", Name: "Count", Type: "number"},
		{Op: "addRecord", Cells: map[string]any{"1": "Bob"}},
		{Op: "updateRecord", RecordID: 1, Cells: map[string]any{"1": "Updated"}},
		{Op: "deleteRecord", RecordID: 2},
	}, false); err != nil || len(b2.Tables) != 2 || len(b2.Records) != 1 {
		t.Fatalf("real apply failed: %+v err=%v", b2, err)
	}
	for _, badOps := range [][]Op{
		{{Op: "updateRecord", RecordID: 999}},
		{{Op: "deleteRecord", RecordID: 999}},
		{{Op: "unsupported"}},
	} {
		if _, _, err := b2.Apply(badOps, false); err == nil {
			t.Fatalf("expected error for %+v", badOps)
		}
	}
}

func TestHandlerAndTools(t *testing.T) {
	mem := storage.NewMemoryStore()
	whHits := 0
	whSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		whHits++
		w.WriteHeader(http.StatusOK)
	}))
	defer whSrv.Close()

	auth := storage.NewBearerTokenAuth(map[string]storage.Principal{
		"admin": {ID: "u1", Roles: []string{"admin"}},
	})
	h := NewHandler(mem, WithAuth(auth, storage.NewRoleAuthorizer(nil)), WithWebhook(storage.NewWebhookDispatcher(whSrv.URL, "sec", whSrv.Client())))
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

	// POST /bases JSON & CSV & errors
	if rec := doReq(http.MethodPost, "/bases", strings.NewReader(""), "application/json"); rec.Code != http.StatusCreated {
		t.Fatalf("empty POST /bases failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/bases", strings.NewReader(`{"id":"b1","title":"CRM","base":{"name":"CRM","tables":[{"id":1,"name":"Leads"}],"fields":[{"id":1,"tableId":1,"name":"Company","type":"text"}],"records":[{"id":1,"tableId":1,"cells":{"1":"Acme"}}]}}`), "application/json"); rec.Code != http.StatusCreated {
		t.Fatalf("JSON POST /bases failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doReq(http.MethodPost, "/bases", strings.NewReader(`{"id":"b1"}`), "application/json"); rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/bases", strings.NewReader(`{"id":"../bad"}`), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 invalid id, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/bases", strings.NewReader("{bad"), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad json, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/bases", errReader{}, "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 read err, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/bases?format=csv&id=csv1&title=CSVBase", strings.NewReader("Name,Score\nAlice,99\n"), "text/csv"); rec.Code != http.StatusCreated {
		t.Fatalf("CSV import failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/bases?format=csv", strings.NewReader(`"bad`), "text/csv"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad csv, got %d", rec.Code)
	}

	// GET /bases/{id}
	if rec := doReq(http.MethodGet, "/bases/b1", nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("GET /bases/b1 failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/bases/missing", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}

	// GET /bases/{id}/export.csv
	if rec := doReq(http.MethodGet, "/bases/b1/export.csv?tableId=1", nil, ""); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Acme") {
		t.Fatalf("export.csv failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doReq(http.MethodGet, "/bases/b1/export.csv?tableId=abc", nil, ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad tableId, got %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/bases/b1/export.csv?tableId=99", nil, ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 missing table fields, got %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/bases/missing/export.csv", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 export.csv, got %d", rec.Code)
	}

	// POST /bases/{id}/query
	if rec := doReq(http.MethodPost, "/bases/b1/query", strings.NewReader(`{"tableId":1,"search":"acme"}`), "application/json"); rec.Code != http.StatusOK {
		t.Fatalf("query failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/bases/b1/query", strings.NewReader("{bad"), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad query, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/bases/missing/query", strings.NewReader(`{}`), "application/json"); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 query, got %d", rec.Code)
	}

	// POST /bases/{id}/apply
	if rec := doReq(http.MethodPost, "/bases/b1/apply", strings.NewReader(`{"ops":[{"op":"addRecord","cells":{"1":"Globex"}}]}`), "application/json"); rec.Code != http.StatusOK {
		t.Fatalf("apply failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/bases/b1/apply", strings.NewReader(`{"ops":[{"op":"bad"}]}`), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad op, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/bases/b1/apply", strings.NewReader("{bad"), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 bad json, got %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/bases/missing/apply", strings.NewReader(`{"ops":[]}`), "application/json"); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 apply, got %d", rec.Code)
	}

	// POST /bases/{id}/verify
	if rec := doReq(http.MethodPost, "/bases/b1/verify", nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("verify failed: %d", rec.Code)
	}
	if rec := doReq(http.MethodPost, "/bases/missing/verify", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 verify, got %d", rec.Code)
	}

	// Failing store & corrupt JSON
	fh := NewHandler(&failingStore{Store: mem, putErr: errors.New("put err"), delErr: errors.New("del err")})
	rec := httptest.NewRecorder()
	fh.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/bases/b1/apply", strings.NewReader(`{"ops":[{"op":"addTable","name":"X"}]}`)))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on failing store put, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	fh.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/bases/b1", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on failing store delete, got %d", rec.Code)
	}
	_ = mem.Put(context.Background(), &storage.DocumentRecord{ID: "corrupt", Kind: "base", Data: []byte("{bad")})
	if rec := doReq(http.MethodGet, "/bases/corrupt", nil, ""); rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on corrupt stored base, got %d", rec.Code)
	}

	// DELETE /bases/{id}
	if rec := doReq(http.MethodDelete, "/bases/csv1", nil, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("delete failed: %d", rec.Code)
	}
	if whHits < 4 {
		t.Fatalf("expected webhook hits, got %d", whHits)
	}

	// RegisterTools
	reg := ai.NewToolRegistry()
	if err := RegisterTools(nil, mem); err == nil {
		t.Fatal("expected nil registry error")
	}
	if err := RegisterTools(reg, mem); err != nil {
		t.Fatal(err)
	}
	if err := RegisterTools(reg, mem); !errors.Is(err, ai.ErrDuplicateTool) {
		t.Fatalf("expected duplicate error, got %v", err)
	}
	ctx := context.Background()
	if _, err := reg.Call(ctx, "base_inspect", map[string]any{"id": "b1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Call(ctx, "base_inspect", map[string]any{"id": "missing"}); err == nil {
		t.Fatal("expected error")
	}
	if _, err := reg.Call(ctx, "base_query", map[string]any{"id": "b1", "tableId": 1, "search": "acme"}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Call(ctx, "base_query", map[string]any{"id": "missing"}); err == nil {
		t.Fatal("expected error")
	}
	if _, err := reg.Call(ctx, "base_verify", map[string]any{"id": "b1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Call(ctx, "base_verify", map[string]any{"id": "missing"}); err == nil {
		t.Fatal("expected error")
	}
	if _, err := reg.Call(ctx, "base_apply", map[string]any{"id": "b1", "ops": []any{map[string]any{"op": "addRecord", "cells": map[string]any{"1": "Initech"}}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Call(ctx, "base_apply", map[string]any{"id": "missing", "ops": []any{}}); err == nil {
		t.Fatal("expected missing error")
	}
	if _, err := reg.Call(ctx, "base_apply", map[string]any{"id": "b1", "ops": make(chan int)}); err == nil {
		t.Fatal("expected marshal error")
	}
	if _, err := reg.Call(ctx, "base_apply", map[string]any{"id": "b1", "ops": "bad"}); err == nil {
		t.Fatal("expected unmarshal error")
	}
	if _, err := reg.Call(ctx, "base_apply", map[string]any{"id": "b1", "ops": []any{map[string]any{"op": "bad"}}}); err == nil {
		t.Fatal("expected apply error")
	}
	regFail := ai.NewToolRegistry()
	_ = RegisterTools(regFail, &failingStore{Store: mem, putErr: errors.New("put fail")})
	if _, err := regFail.Call(ctx, "base_apply", map[string]any{"id": "b1", "ops": []any{map[string]any{"op": "addTable", "name": "X"}}}); err == nil {
		t.Fatal("expected store put error")
	}
}
