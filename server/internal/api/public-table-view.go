package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/ZSeven-W/jiange/server/collab"
)

var errPublicTableUnavailable = errors.New("table cannot be safely projected")
var publicTableFill = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// Public readers receive the visible table, not migration bases or deleted
// cell registers. Keep only the formatting needed by the read-only renderer.
func publicTableView(view collab.DocView) (collab.DocView, error) {
	out := collab.DocView{Blocks: make([]collab.BlockView, len(view.Blocks))}
	copy(out.Blocks, view.Blocks)
	children := make(map[string]map[string]bool)
	types := make(map[string]string, len(view.Blocks))
	for _, block := range view.Blocks {
		types[block.ID] = block.Type
		if children[block.Parent] == nil {
			children[block.Parent] = make(map[string]bool)
		}
		children[block.Parent][block.ID] = true
	}
	for i := range out.Blocks {
		block := &out.Blocks[i]
		columnChild := types[block.Parent] == "columns"
		if block.Type != "table" || columnChild {
			*block = publicCommonBlock(*block, children[block.ID], columnChild)
			continue
		}
		projected, err := publicTableProps(block.Props)
		if err != nil {
			return collab.DocView{}, err
		}
		block.Props = projected
		// The table renderer ignores block-level text. It can contain old
		// content after a block conversion, so it is not part of this view.
		block.Spans = []collab.Span{}
	}
	return out, nil
}

func publicTableProps(props map[string]string) (map[string]string, error) {
	if len(props["tableData"]) > 8<<20 || len(props["tbl.base"]) > 8<<20 || len(props["tbl.rows"]) > 32000 || len(props["tbl.cols"]) > 32000 {
		return nil, errPublicTableUnavailable
	}
	var rowIDs, colIDs []string
	for key, value := range props {
		if value == "" || !strings.HasPrefix(key, "tbl.") {
			continue
		}
		switch key {
		case "tbl.v", "tbl.rows", "tbl.cols", "tbl.base", "tbl.m":
			continue
		}
		if !strings.HasPrefix(key, "tbl.c.") && !strings.HasPrefix(key, "tbl.fill.") && !strings.HasPrefix(key, "tbl.halign.") && !strings.HasPrefix(key, "tbl.valign.") {
			return nil, errPublicTableUnavailable
		}
	}
	switch props["tbl.v"] {
	case "2":
		rowIDs, colIDs = axisIDs(props["tbl.rows"]), axisIDs(props["tbl.cols"])
		if rowIDs == nil || colIDs == nil || len(rowIDs) > 200 || len(colIDs) > 50 || len(rowIDs)*len(colIDs) > 5000 || props["tbl.m"] != tableHash(props["tableData"]) || duplicateIDs(rowIDs) || duplicateIDs(colIDs) {
			return nil, errPublicTableUnavailable
		}
	case "":
		// A partially migrated table is ambiguous. Recognized legacy visual
		// cell styles are safe to project by position.
		for key, value := range props {
			if strings.HasPrefix(key, "tbl.") && value != "" && !strings.HasPrefix(key, "tbl.fill.") && !strings.HasPrefix(key, "tbl.halign.") && !strings.HasPrefix(key, "tbl.valign.") {
				return nil, errPublicTableUnavailable
			}
		}
	default:
		return nil, errPublicTableUnavailable
	}
	rows := tableRows(props)
	if len(rows) == 0 || len(rows[0]) == 0 {
		rows = [][]string{{"", "", ""}, {"", "", ""}}
	}
	cols := len(rows[0])
	if len(rows) > 200 || cols > 50 || len(rows)*cols > 5000 {
		return nil, errPublicTableUnavailable
	}
	for _, row := range rows {
		if len(row) != cols {
			return nil, errPublicTableUnavailable
		}
	}
	if props["tbl.v"] == "2" && (len(rowIDs) != len(rows) || len(colIDs) != cols) {
		return nil, errPublicTableUnavailable
	}
	if len(props["tableMerges"]) > 256*1024 {
		return nil, errPublicTableUnavailable
	}
	merges, hidden, err := publicTableMerges(props["tableMerges"], len(rows), cols)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string)
	// A table may have been converted from another block type. Unknown block
	// properties are not rendered by the table and may contain old content.
	if props["align"] == "center" || props["align"] == "right" {
		out["align"] = props["align"]
	}
	if indent, err := strconv.ParseFloat(strings.TrimSpace(props["indent"]), 64); err == nil && !math.IsNaN(indent) && !math.IsInf(indent, 0) {
		out["indent"] = strconv.FormatFloat(math.Max(0, math.Min(20, indent)), 'f', -1, 64)
	}
	for r := range rows {
		for c := range rows[r] {
			if hidden[r*cols+c] {
				rows[r][c] = ""
				continue
			}
			sourceR, sourceC := fmt.Sprintf("r%d", r), fmt.Sprintf("c%d", c)
			if rowIDs != nil && colIDs != nil {
				sourceR, sourceC = rowIDs[r], colIDs[c]
			}
			for _, kind := range []string{"fill", "halign", "valign"} {
				value := props["tbl."+kind+"."+sourceR+"."+sourceC]
				valid := kind == "fill" && publicTableFill.MatchString(value) || kind == "halign" && (value == "center" || value == "right") || kind == "valign" && (value == "middle" || value == "bottom")
				if valid {
					out[fmt.Sprintf("tbl.%s.r%d.c%d", kind, r, c)] = value
				}
			}
		}
	}
	data, _ := json.Marshal(rows)
	out["tableData"] = string(data)
	if len(merges) > 0 {
		data, _ = json.Marshal(merges)
		out["tableMerges"] = string(data)
	}
	if widths := publicTableWidths(props["tableWidths"], cols); widths != "" {
		out["tableWidths"] = widths
	}
	if props["tableHeader"] == "none" {
		out["tableHeader"] = "none"
	} else {
		out["tableHeader"] = "row"
	}
	if props["tableHeaderColumn"] == "column" {
		out["tableHeaderColumn"] = "column"
	}
	return out, nil
}

func duplicateIDs(ids []string) bool {
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			return true
		}
		seen[id] = true
	}
	return false
}

func publicTableWidths(raw string, cols int) string {
	var values []json.RawMessage
	if raw == "" || len(raw) > 32000 || json.Unmarshal([]byte(raw), &values) != nil || values == nil {
		return ""
	}
	if len(values) > cols {
		values = values[:cols]
	}
	clean := make([]any, len(values))
	for i, raw := range values {
		var value float64
		if json.Unmarshal(raw, &value) == nil && !math.IsNaN(value) && !math.IsInf(value, 0) && value > 0 && value <= 100000 {
			clean[i] = value
		}
	}
	result, _ := json.Marshal(clean)
	return string(result)
}

// Matches the renderer's valid, non-overlapping rectangular merges.
func publicTableMerges(raw string, rows, cols int) ([][4]int, []bool, error) {
	hidden := make([]bool, rows*cols)
	var result [][4]int
	var entries []json.RawMessage
	if raw == "" {
		return result, hidden, nil
	}
	if len(raw) > 256*1024 || json.Unmarshal([]byte(raw), &entries) != nil {
		return nil, nil, errPublicTableUnavailable
	}
	for _, entry := range entries {
		var v []float64
		if json.Unmarshal(entry, &v) != nil || len(v) != 4 {
			return nil, nil, errPublicTableUnavailable
		}
		valid := true
		for _, n := range v {
			if math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || n < 0 || n > 5000 {
				valid = false
			}
		}
		if !valid {
			return nil, nil, errPublicTableUnavailable
		}
		r, c, rs, cs := int(v[0]), int(v[1]), int(v[2]), int(v[3])
		if rs < 1 || cs < 1 || rs+cs < 3 || r+rs > rows || c+cs > cols {
			return nil, nil, errPublicTableUnavailable
		}
		for _, m := range result {
			if r < m[0]+m[2] && m[0] < r+rs && c < m[1]+m[3] && m[1] < c+cs {
				valid = false
				break
			}
		}
		if !valid {
			return nil, nil, errPublicTableUnavailable
		}
		result = append(result, [4]int{r, c, rs, cs})
		for y := r; y < r+rs; y++ {
			for x := c; x < c+cs; x++ {
				if y != r || x != c {
					hidden[y*cols+x] = true
				}
			}
		}
	}
	return result, hidden, nil
}
