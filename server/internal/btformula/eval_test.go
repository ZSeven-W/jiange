package btformula

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Opt-in for CI after installing the repository's existing JS dependencies:
// JIANGE_FORMULA_VERIFY_FRONTEND=1 go test ./internal/btformula -run TestFrontendCorpusIsCurrent
// This invokes only the checked-in generator and does not access the network.
func TestFrontendCorpusIsCurrent(t *testing.T) {
	if os.Getenv("JIANGE_FORMULA_VERIFY_FRONTEND") != "1" {
		t.Skip("set JIANGE_FORMULA_VERIFY_FRONTEND=1 after installing JS dependencies")
	}
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(root, "packages", "collab", "node_modules", ".bin", "tsx")
	cmd := exec.Command(binary, filepath.Join(root, "server", "internal", "btformula", "testdata", "generate-parity.ts"))
	cmd.Dir = root
	actual, err := cmd.Output()
	if err != nil {
		t.Fatalf("frontend vector generation failed: %v", err)
	}
	expected, err := os.ReadFile(filepath.Join("testdata", "parity.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, expected) {
		t.Fatal("frontend corpus is stale; regenerate testdata/parity.json with generate-parity.ts")
	}
}

func TestFrontendDateCorpusIsCurrent(t *testing.T) {
	if os.Getenv("JIANGE_FORMULA_VERIFY_FRONTEND") != "1" {
		t.Skip("set JIANGE_FORMULA_VERIFY_FRONTEND=1 after installing JS dependencies")
	}
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(root, "packages", "collab", "node_modules", ".bin", "tsx")
	cmd := exec.Command(binary, filepath.Join(root, "server", "internal", "btformula", "testdata", "generate-date-parity.ts"))
	cmd.Dir = root
	actual, err := cmd.Output()
	if err != nil {
		t.Fatalf("frontend date vector generation failed: %v", err)
	}
	expected, err := os.ReadFile(filepath.Join("testdata", "date-parity.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, expected) {
		t.Fatal("frontend date corpus is stale; regenerate testdata/date-parity.json with generate-date-parity.ts")
	}
}

func TestFrontendDateParityAcrossTimeZones(t *testing.T) {
	data, err := os.ReadFile("testdata/date-parity.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Zone        string  `json:"zone"`
		Expression  string  `json:"expression"`
		Result      float64 `json:"result"`
		Unsupported bool    `json:"unsupported"`
	}
	if err = json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors {
		location, err := time.LoadLocation(vector.Zone)
		if err != nil {
			t.Fatal(err)
		}
		got, err := Evaluate(vector.Expression, nil, Options{Location: location})
		if vector.Unsupported {
			if !errors.Is(err, ErrUnsupported) {
				t.Errorf("%s %s got=%#v err=%v want unsupported", vector.Zone, vector.Expression, got, err)
			}
			continue
		}
		if err != nil || got != vector.Result {
			t.Errorf("%s %s got=%#v err=%v want=%v", vector.Zone, vector.Expression, got, err, vector.Result)
		}
	}
}

func TestSharedFrontendParityVectors(t *testing.T) {
	data, err := os.ReadFile("testdata/parity.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Expression  string           `json:"expression"`
		Values      map[string]Value `json:"values"`
		Result      Value            `json:"result"`
		Error       string           `json:"error"`
		Unsupported bool             `json:"unsupported"`
	}
	if err = json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors {
		got, err := Evaluate(vector.Expression, vector.Values, Options{})
		if vector.Unsupported {
			if !errors.Is(err, ErrUnsupported) {
				t.Errorf("%s got=%#v err=%v want unsupported", vector.Expression, got, err)
			}
			continue
		}
		if vector.Error != "" {
			if err == nil || err.Error() != vector.Error {
				t.Errorf("%s got=%#v err=%v want error %s", vector.Expression, got, err, vector.Error)
			}
			continue
		}
		if err != nil || !reflect.DeepEqual(got, vector.Result) {
			t.Errorf("%s got=%#v err=%v want=%#v", vector.Expression, got, err, vector.Result)
		}
	}
}

func TestEvaluateFrontendExamples(t *testing.T) {
	options := Options{Now: time.Date(2026, 3, 5, 10, 20, 30, 123000000, time.UTC), Location: time.FixedZone("test", 8*3600)}
	values := map[string]Value{"价格": float64(4), "数量": float64(3), "单价": float64(2.5), "分": float64(88), "开": true, "x": float64(7)}
	cases := []struct {
		src  string
		want Value
	}{
		{"1 + 2 * 3", float64(7)}, {"(1 + 2) * 3", float64(9)}, {"2 ^ 3 ^ 2", float64(512)}, {"-[价格] + 10", float64(6)},
		{"10 % 3", float64(1)}, {`"a" & "b" & 1`, "ab1"}, {"[数量]*[单价]", float64(7.5)},
		{`IF([分]>=90,"优",IF([分]>=60,"及格","不及格"))`, "及格"}, {"AND(TRUE,[开])", true}, {"NOT(FALSE)", true}, {`IFS([x]>10,"大",[x]>5,"中",TRUE,"小")`, "中"},
		{"ABS(-3.5)", float64(3.5)}, {"ROUND(2.678,2)", 2.68}, {"MOD(10,4)", float64(2)}, {"POW(2,8)", float64(256)}, {"SQRT(81)", float64(9)},
		{"MIN(3,1,2)+MAX(3,1,2)", float64(4)}, {"SUM(1,2,3.5)", 6.5}, {"AVERAGE(2,4,6)", float64(4)},
		{`LEN("你好世界")`, float64(4)}, {`UPPER("abc") & LOWER("DEF")`, "ABCdef"}, {`CONCATENATE("a",1,TRUE)`, "a1TRUE"},
		{`LEFT("飞书多维表格",2)`, "飞书"}, {`RIGHT("飞书多维表格",3)`, "维表格"}, {`MID("abcdef",2,3)`, "bcd"},
		{`TRIM("  x  ") & "|"`, "x|"}, {`CONTAINS("hello","ell")`, true}, {`VALUE("42")+1`, float64(43)},
		{`UPPER("straße")`, "STRASSE"}, {`RIGHT("abcde",2.5)`, "cde"}, {`MID("abcdef",2.5,1.5)`, "bc"},
		{`"𐀀" < ""`, true}, {`TEXT(0.0000001)`, "1e-7"}, {`VALUE("0x10")`, float64(16)}, {`IF(TRUE,1,UNKNOWN())`, float64(1)},
		{`YEAR("2026-03-05")`, float64(2026)}, {`MONTH("2026-03-05")`, float64(3)}, {`DAY("2026-03-05")`, float64(5)}, {"TODAY()", "2026-03-05"}, {"NOW()", "2026-03-05T10:20:30.123Z"},
	}
	for _, tc := range cases {
		t.Run(tc.src, func(t *testing.T) {
			got, err := Evaluate(tc.src, values, options)
			if err != nil || got != tc.want {
				t.Fatalf("got=%#v err=%v want=%#v", got, err, tc.want)
			}
		})
	}
}

func TestEvaluateFieldAuthorizationAndDependencies(t *testing.T) {
	fields := []Input{{Name: "金额", Value: float64(2)}, {Name: "翻倍", Formula: "[金额]*2"}, {Name: "合计", Formula: "[翻倍]+1"}}
	got, err := EvaluateField("合计", fields, Options{})
	if err != nil || got != float64(5) {
		t.Fatalf("got=%v err=%v", got, err)
	}
	for _, src := range []string{"[隐藏]", `IF(TRUE,1,[隐藏])`, `IFS(TRUE,1,[隐藏],2)`} {
		if _, err = Evaluate(src, map[string]Value{"公开": float64(1)}, Options{}); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("%s err=%v", src, err)
		}
	}
	if cycle, cycleErr := EvaluateField("a", []Input{{Name: "a", Formula: "[b]"}, {Name: "b", Formula: "[a]"}}, Options{}); cycleErr != nil || cycle != "#循环引用" {
		t.Fatalf("cycle=%v err=%v", cycle, cycleErr)
	}
	if _, err = Evaluate("[x]", map[string]Value{"x": map[string]string{"secret": "x"}}, Options{}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("unsafe input err=%v", err)
	}
	if got, err = EvaluateField("result", []Input{{Name: "x", Value: float64(1)}, {Name: "X", Value: float64(2)}, {Name: "result", Formula: "[x]"}}, Options{}); err != nil || got != float64(2) {
		t.Fatalf("duplicate visible field result=%v err=%v", got, err)
	}
}

func TestVisibleDependencyErrorsFollowFrontendValues(t *testing.T) {
	fields := []Input{{Name: "X", Formula: "1/0"}, {Name: "unused", Formula: `IF(TRUE,1,[X])`}, {Name: "text", Formula: `[X]&"!"`}, {Name: "sum", Formula: `[X]+1`}}
	for _, tc := range []struct {
		name string
		want Value
	}{{"unused", float64(1)}, {"text", "#DIV/0!!"}, {"sum", "#VALUE?"}, {"X", "#DIV/0!"}} {
		got, err := EvaluateField(tc.name, fields, Options{})
		if err != nil || got != tc.want {
			t.Errorf("%s got=%#v err=%v want=%#v", tc.name, got, err, tc.want)
		}
	}
	// A short-circuited branch must still be checked for hidden dependencies.
	if _, err := EvaluateField("unused", []Input{{Name: "X", Formula: "[secret]"}, {Name: "unused", Formula: `IF(TRUE,1,[X])`}}, Options{}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("hidden dependency err=%v", err)
	}
	cycles := []Input{{Name: "a", Formula: "[b]+1"}, {Name: "b", Formula: `[a]&"x"`}}
	if got, err := EvaluateField("a", cycles, Options{}); err != nil || got != "#VALUE?" {
		t.Fatalf("cycle a=%v err=%v", got, err)
	}
	if got, err := EvaluateField("b", cycles, Options{}); err != nil || got != "#循环引用x" {
		t.Fatalf("cycle b=%v err=%v", got, err)
	}
}

func TestJavaScriptCoercionAndUnicodeBoundaries(t *testing.T) {
	for _, tc := range []struct {
		src  string
		want Value
	}{
		{`NOT()`, true}, {`ISBLANK()`, false}, {`VALUE()`, float64(0)}, {`CONTAINS("undefined")`, true},
		{`TRIM("\ufeffx\ufeff")`, "x"}, {`TRIM("\u0085x\u0085")`, "\u0085x\u0085"},
		{`VALUE("0x10000000000000000")`, float64(18446744073709551616)},
	} {
		// Construct real Unicode rather than formula escape sequences.
		src := strings.ReplaceAll(strings.ReplaceAll(tc.src, `\ufeff`, "\ufeff"), `\u0085`, "\u0085")
		got, err := Evaluate(src, nil, Options{})
		if err != nil || got != tc.want {
			t.Errorf("%s got=%#v err=%v want=%#v", src, got, err, tc.want)
		}
	}
	for _, src := range []string{`VALUE("Inf")`, `VALUE("1_2")`, `VALUE("0x+1")`} {
		if _, err := Evaluate(src, nil, Options{}); err == nil || err.Error() != "#VALUE?" {
			t.Errorf("%s err=%v", src, err)
		}
	}
	for _, src := range []string{`LEN()`, `UPPER()`, `TRIM()`, `CONTAINS()`, `LEFT()`} {
		if _, err := Evaluate(src, nil, Options{}); err == nil || err.Error() != "#错误" {
			t.Errorf("%s err=%v", src, err)
		}
	}
	if _, err := Evaluate(`TEXT()`, nil, Options{}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("TEXT() err=%v", err)
	}
	if got, err := Evaluate(`[i̇]`, map[string]Value{"İ": float64(42)}, Options{}); err != nil || got != float64(42) {
		t.Fatalf("Unicode ref=%v err=%v", got, err)
	}
	if got, err := Evaluate("[\ufeff金额\ufeff]", map[string]Value{"金额": float64(2)}, Options{}); err != nil || got != float64(2) {
		t.Fatalf("trim ref=%v err=%v", got, err)
	}
	if _, err := Evaluate("[\u0085金额\u0085]", map[string]Value{"金额": float64(2)}, Options{}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("nontrim ref err=%v", err)
	}
}

func TestSharedRequestBudgetAcrossCalls(t *testing.T) {
	budget := NewBudget(35)
	completed := 0
	for i := 0; i < 50; i++ {
		_, err := Evaluate("1+2+3", nil, Options{RequestBudget: budget})
		if err != nil {
			if !strings.Contains(err.Error(), "#COMPLEXITY") {
				t.Fatalf("budget err=%v", err)
			}
			break
		}
		completed++
	}
	if completed == 0 || completed >= 50 {
		t.Fatalf("budget did not bound repeated calls: %d", completed)
	}
}

func TestBudgetChargesStringWorkAndHonorsCancellation(t *testing.T) {
	textValue := strings.Repeat("a", 128<<10)
	formula := strings.Repeat("LEN(UPPER([A]))+", 79) + "LEN(UPPER([A]))"
	_, err := Evaluate(formula, map[string]Value{"A": textValue}, Options{MaxSteps: 200000, RequestBudget: NewBudget(20000)})
	if err == nil || !strings.Contains(err.Error(), "#COMPLEXITY") {
		t.Fatalf("repeated string work err=%v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = Evaluate("1+2", nil, Options{Context: ctx}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel err=%v", err)
	}
}

func TestSharedBudgetIsSafeAcrossConcurrentCalls(t *testing.T) {
	budget := NewBudget(150)
	var successes atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := Evaluate("1+2+3", nil, Options{RequestBudget: budget}); err == nil {
				successes.Add(1)
			}
		}()
	}
	wg.Wait()
	if successes.Load() == 0 || successes.Load() >= 50 {
		t.Fatalf("concurrent budget successes=%d", successes.Load())
	}
}

func TestFieldIDAndHiddenDuplicateNames(t *testing.T) {
	visible := []Input{{ID: 1, Name: "A", Formula: "1+1"}, {ID: 2, Name: "A", Value: float64(99)}, {ID: 3, Name: "Result", Formula: "[a]+1"}}
	schema := []SchemaField{{ID: 1, Name: "A"}, {ID: 2, Name: "A"}, {ID: 3, Name: "Result"}}
	if got, err := EvaluateFieldID(1, visible, Options{FullSchema: schema}); err != nil || got != float64(2) {
		t.Fatalf("specific first field=%v err=%v", got, err)
	}
	if got, err := EvaluateFieldID(3, visible, Options{FullSchema: schema}); err != nil || got != float64(100) {
		t.Fatalf("visible duplicate ref=%v err=%v", got, err)
	}
	// A hidden duplicate is never treated as an absent or alternate visible
	// field. The complete schema carries only names and IDs, never its value.
	partial := []Input{visible[0], visible[2]}
	if _, err := EvaluateFieldID(3, partial, Options{FullSchema: schema}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("hidden duplicate err=%v", err)
	}
	if got, err := EvaluateFieldID(1, partial, Options{FullSchema: schema}); err != nil || got != float64(2) {
		t.Fatalf("unreferenced duplicate=%v err=%v", got, err)
	}
	if _, err := EvaluateFieldID(1, partial, Options{}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("missing full schema err=%v", err)
	}
	if _, err := EvaluateFieldID(1, partial, Options{FullSchema: []SchemaField{{ID: 1, Name: "changed"}, {ID: 3, Name: "Result"}}}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("stale schema err=%v", err)
	}
	if _, err := EvaluateFieldID(1, partial, Options{FullSchema: []SchemaField{{ID: 1, Name: "A"}, {ID: 1, Name: "A"}, {ID: 3, Name: "Result"}}}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("duplicate ID err=%v", err)
	}
	unicodeFields := []Input{{ID: 4, Name: "İ", Value: float64(1)}, {ID: 5, Name: "output", Formula: "[i̇]"}}
	unicodeSchema := []SchemaField{{ID: 4, Name: "İ"}, {ID: 5, Name: "output"}, {ID: 6, Name: "i̇"}}
	if _, err := EvaluateFieldID(5, unicodeFields, Options{FullSchema: unicodeSchema}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("hidden Unicode duplicate err=%v", err)
	}
}

func TestExhaustedBudgetRejectsBeforeLargeMapAllocation(t *testing.T) {
	fields := make([]Input, 10000)
	for i := range fields {
		fields[i] = Input{ID: int64(i + 1), Name: fmt.Sprintf("字段%d", i), Value: float64(i)}
	}
	allocs := testing.AllocsPerRun(5, func() {
		_, err := EvaluateField("字段1", fields, Options{RequestBudget: NewBudget(1)})
		if err == nil || !strings.Contains(err.Error(), "#COMPLEXITY") {
			t.Fatalf("budget err=%v", err)
		}
	})
	if allocs > 20 {
		t.Fatalf("exhausted request allocated %.0f objects before rejecting", allocs)
	}
}

func TestEvaluateErrorsBoundariesAndBudget(t *testing.T) {
	for _, tc := range []struct{ src, code string }{{"1/0", "#DIV/0!"}, {"SQRT(-1)", "#NUM?"}, {"1+", "#SYNTAX"}, {"FOO(1)", "#NAME?"}, {"2+TRUE+\"text\"", "#VALUE?"}} {
		if _, err := Evaluate(tc.src, nil, Options{}); err == nil || !strings.Contains(err.Error(), tc.code) {
			t.Fatalf("%s err=%v want %s", tc.src, err, tc.code)
		}
	}
	if _, err := Evaluate("TODAY()", nil, Options{}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("clock err=%v", err)
	}
	if _, err := Evaluate(`YEAR("2026-01-01")`, nil, Options{}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("zone err=%v", err)
	}
	if _, err := Evaluate(`LEFT("😀",1)`, nil, Options{}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("surrogate err=%v", err)
	}
	if _, err := Evaluate("1+2+3+4", nil, Options{MaxSteps: 2}); err == nil || !strings.Contains(err.Error(), "#COMPLEXITY") {
		t.Fatalf("budget err=%v", err)
	}
	if got, err := Evaluate("MIN()", nil, Options{}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("min=%v err=%v", got, err)
	}
}

func BenchmarkEvaluateVisibleFormula(b *testing.B) {
	fields := []Input{{Name: "数量", Value: float64(3)}, {Name: "单价", Value: float64(2.5)}, {Name: "合计", Formula: "[数量]*[单价]"}}
	for i := 0; i < b.N; i++ {
		if _, err := EvaluateField("合计", fields, Options{}); err != nil {
			b.Fatal(err)
		}
	}
}
