package api

import "testing"

func TestTableRowsMatchesClientFingerprint(t *testing.T) {
	// Same FNV-1a value the web client computes for this UTF-8 string.
	if got := tableHash(`[["甲",""]]`); got != "ed7ec732" {
		t.Fatalf("hash=%q", got)
	}
	mirror := `[["旧",""]]`
	props := map[string]string{"tbl.v": "2", "tbl.rows": `["r0"]`, "tbl.cols": `["c0","c1"]`, "tbl.c.r0.c0": "新", "tableData": mirror, "tbl.m": tableHash(mirror)}
	if rows := tableRows(props); rows[0][0] != "新" {
		t.Fatalf("cells should win with a trusted mirror: %v", rows)
	}
	props["tableData"] = `[["旧客户端写入"]]` // fingerprint now stale
	if rows := tableRows(props); rows[0][0] != "旧客户端写入" {
		t.Fatalf("old-client write should win: %v", rows)
	}
	based := map[string]string{"tbl.v": "2", "tbl.rows": `["r0","r1"]`, "tbl.cols": `["c0"]`, "tbl.base": `[["底"],["x"]]`, "tbl.c.r1.c0": "改", "tableData": `[["底"],["改"]]`}
	based["tbl.m"] = tableHash(based["tableData"])
	if rows := tableRows(based); rows[0][0] != "底" || rows[1][0] != "改" {
		t.Fatalf("base fallback: %v", rows)
	}
	based["tbl.c.r0.c0"] = ""
	based["tableData"] = `[[""],["改"]]`
	based["tbl.m"] = tableHash(based["tableData"])
	if rows := tableRows(based); rows[0][0] != "" || rows[1][0] != "改" {
		t.Fatalf("explicit empty must override inherited base: %v", rows)
	}
	if rows := tableRows(map[string]string{"tableData": `[["a"]]`}); rows[0][0] != "a" {
		t.Fatalf("legacy: %v", rows)
	}
}

func TestTableRowsFollowsReorderedStableAxes(t *testing.T) {
	mirror := `[["D","C"],["B edited","A"]]`
	props := map[string]string{
		"tbl.v": "2", "tbl.rows": `["r1","r0"]`, "tbl.cols": `["c1","c0"]`,
		"tbl.base": `[["A","B"],["C","D"]]`, "tbl.c.r0.c1": "B edited",
		"tableData": mirror, "tbl.m": tableHash(mirror),
	}
	rows := tableRows(props)
	if len(rows) != 2 || len(rows[0]) != 2 || rows[0][0] != "D" || rows[0][1] != "C" || rows[1][0] != "B edited" || rows[1][1] != "A" {
		t.Fatalf("reordered axes must follow cell identities: %v", rows)
	}
}

func TestTableRowsFollowsInsertedAndRemovedStableAxes(t *testing.T) {
	mirror := `[["B"],["新增"],["D edited"]]`
	props := map[string]string{
		"tbl.v": "2", "tbl.rows": `["r0","a1_100","r1"]`, "tbl.cols": `["c1"]`,
		"tbl.base": `[["A","B"],["C","D"]]`, "tbl.c.a1_100.c1": "新增",
		"tbl.c.r1.c1": "D edited", "tbl.c.r2.c1": "deleted row edit",
		"tableData": mirror, "tbl.m": tableHash(mirror),
	}
	rows := tableRows(props)
	if len(rows) != 3 || len(rows[0]) != 1 || rows[0][0] != "B" || rows[1][0] != "新增" || rows[2][0] != "D edited" {
		t.Fatalf("inserted and removed axes must follow visible identities: %v", rows)
	}
}
