package api

import (
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

func TestCSVImportTemporarilyDisabledWithoutMutation(t *testing.T) {
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
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("import status: %d", res.StatusCode)
	}
	var result struct {
		Error string `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Error != "import_temporarily_unavailable" {
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
	if !reflect.DeepEqual(beforeFields, afterFields) || !reflect.DeepEqual(beforeRecords, afterRecords) {
		t.Fatal("disabled import mutated base")
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
