package api

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"regexp"
	"strconv"
)

// Document tables may store cells as individual block props (see
// apps/web/src/editor/tableCells.ts): tbl.v="2", tbl.rows/tbl.cols axis IDs,
// tbl.c.<row>.<col> cell text, a legacy tableData mirror and tbl.m = FNV-1a
// fingerprint of that mirror. tableRows returns the effective grid.

var (
	reAxisID  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)
	reBaseRow = regexp.MustCompile(`^r(\d+)$`)
	reBaseCol = regexp.MustCompile(`^c(\d+)$`)
)

// cellValue: explicit cell prop, else the migration base (tbl.base) for r<i>/c<j> axes.
func cellValue(props map[string]string, base [][]string, r, c string) string {
	if v, ok := props["tbl.c."+r+"."+c]; ok {
		return v
	}
	ri, ci := reBaseRow.FindStringSubmatch(r), reBaseCol.FindStringSubmatch(c)
	if ri == nil || ci == nil {
		return ""
	}
	i, _ := strconv.Atoi(ri[1])
	j, _ := strconv.Atoi(ci[1])
	if i < len(base) && j < len(base[i]) {
		return base[i][j]
	}
	return ""
}

func tableHash(s string) string {
	h := fnv.New32a()
	h.Write([]byte(s))
	return fmt.Sprintf("%08x", h.Sum32())
}

func axisIDs(raw string) []string {
	var ids []string
	if json.Unmarshal([]byte(raw), &ids) != nil || len(ids) == 0 {
		return nil
	}
	for _, id := range ids {
		if !reAxisID.MatchString(id) {
			return nil
		}
	}
	return ids
}

func tableRows(props map[string]string) [][]string {
	if props["tbl.v"] == "2" && props["tbl.m"] == tableHash(props["tableData"]) {
		rows, cols := axisIDs(props["tbl.rows"]), axisIDs(props["tbl.cols"])
		if rows != nil && cols != nil {
			var base [][]string
			_ = json.Unmarshal([]byte(props["tbl.base"]), &base)
			grid := make([][]string, len(rows))
			for i, r := range rows {
				grid[i] = make([]string, len(cols))
				for j, c := range cols {
					grid[i][j] = cellValue(props, base, r, c)
				}
			}
			return grid
		}
	}
	var cells [][]string
	if json.Unmarshal([]byte(props["tableData"]), &cells) != nil {
		return nil
	}
	return cells
}
