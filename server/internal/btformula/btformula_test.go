package btformula

import "testing"

// valid/invalid pairs mirror the TS tests (formula.test.ts) so both sides
// accept the same grammar.
func TestValidate(t *testing.T) {
	valid := []string{
		"1 + 2 * 3",
		"(1 + 2) * 3",
		"2 ^ 3 ^ 2",
		"-[价格] + 10",
		`"a" & "b" & 1`,
		"[数量] * [单价]",
		"[分] >= 60",
		`IF([分] >= 90, "优", IF([分] >= 60, "及格", "不及格"))`,
		"AND(TRUE, [开])",
		"NOT(FALSE)",
		`IFS([x] > 10, "大", [x] > 5, "中", TRUE, "小")`,
		"ABS(-3.5)",
		"ROUND(2.678, 2)",
		"MOD(10, 4)",
		"POW(2, 8)",
		"SQRT(81)",
		"MIN(3, 1, 2) + MAX(3, 1, 2)",
		"SUM(1, 2, 3.5)",
		"AVERAGE(2, 4, 6)",
		`LEN("你好世界")`,
		`UPPER("abc") & LOWER("DEF")`,
		`CONCATENATE("a", 1, TRUE)`,
		`LEFT("飞书多维表格", 2)`,
		`MID("abcdef", 2, 3)`,
		`TRIM("  x  ")`,
		`CONTAINS("hello", "ell")`,
		"ISBLANK([v])",
		`VALUE("42") + 1`,
		`YEAR("2026-03-05")`,
		"YEAR(TODAY())",
		`[状态] = "完成"`,
		`[a] <> [b]`,
	}
	for _, src := range valid {
		if err := Validate(src, nil); err != nil {
			t.Errorf("should accept %q: %v", src, err)
		}
		if _, err := Refs(src); err != nil {
			t.Errorf("refs %q: %v", src, err)
		}
	}
	invalid := []string{
		"1 +",
		"[x",
		"NOSUCHFN(1)",
		"foo + 1", // bare identifier
		`"unclosed`,
		"(1 + 2",
		"1 # 2",
	}
	for _, src := range invalid {
		if err := Validate(src, nil); err == nil {
			t.Errorf("should reject %q", src)
		}
	}
	// ref checking against known field names
	if err := Validate("[数量] * 2", []string{"数量", "单价"}); err != nil {
		t.Errorf("known ref rejected: %v", err)
	}
	if err := Validate("[不存在] * 2", []string{"数量"}); err == nil {
		t.Error("unknown ref accepted")
	}
	refs, err := Refs("[A] + [b] * [A]")
	if err != nil || len(refs) != 2 || refs[0] != "A" || refs[1] != "b" {
		t.Errorf("refs: %v %v", refs, err)
	}
}
