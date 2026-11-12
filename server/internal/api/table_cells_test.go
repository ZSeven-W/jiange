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
	if rows := tableRows(map[string]string{"tableData": `[["a"]]`}); rows[0][0] != "a" {
		t.Fatalf("legacy: %v", rows)
	}
}
