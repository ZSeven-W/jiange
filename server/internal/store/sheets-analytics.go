package store

import (
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	sheetMaxChartsPerSheet        = 30
	sheetMaxPivotTablesPerSheet   = 20
	sheetMaxPivotRowFields        = 3
	sheetMaxPivotValues           = 6
	sheetMaxSparklinesPerSheet    = 200
	sheetMaxOutlineGroupsPerSheet = 100
)

// SheetSparkline defines an inline SVG sparkline rendered inside a target worksheet cell.
type SheetSparkline struct {
	ID            string `json:"id"`
	Row           int    `json:"row"`
	Col           int    `json:"col"`
	SourceTop     int    `json:"sourceTop"`
	SourceLeft    int    `json:"sourceLeft"`
	SourceBottom  int    `json:"sourceBottom"`
	SourceRight   int    `json:"sourceRight"`
	Type          string `json:"type"` // line | bar | winloss
	Color         string `json:"color,omitempty"`
	NegativeColor string `json:"negativeColor,omitempty"`
	ShowMarkers   bool   `json:"showMarkers,omitempty"`
}

// SheetOutlineGroup defines a collapsible row or column outline group on a worksheet.
type SheetOutlineGroup struct {
	ID        string `json:"id"`
	Axis      string `json:"axis"` // row | col
	Start     int    `json:"start"`
	End       int    `json:"end"`
	Collapsed bool   `json:"collapsed,omitempty"`
}

// SheetChart defines a floating embedded chart anchored to a cell range on a worksheet.
type SheetChart struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Type       string `json:"type"` // column | bar | line | area | pie
	Top        int    `json:"top"`
	Left       int    `json:"left"`
	Bottom     int    `json:"bottom"`
	Right      int    `json:"right"`
	HeaderRow  bool   `json:"headerRow"`
	X          int    `json:"x"`
	Y          int    `json:"y"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	ShowLegend bool   `json:"showLegend"`
	ShowValues bool   `json:"showValues,omitempty"`
}

// SheetPivotValue defines one value aggregation column inside a pivot table.
type SheetPivotValue struct {
	Col int    `json:"col"` // offset relative to source range Left (0..Right-Left)
	Agg string `json:"agg"` // sum | count | avg | min | max
}

// SheetPivotTable defines a persisted pivot table over a worksheet cell range.
type SheetPivotTable struct {
	ID            string            `json:"id"`
	Title         string            `json:"title"`
	SourceSheetID int64             `json:"sourceSheetId,omitempty"` // 0 = same worksheet
	Top           int               `json:"top"`
	Left          int               `json:"left"`
	Bottom        int               `json:"bottom"`
	Right         int               `json:"right"`
	RowFields     []int             `json:"rowFields"`
	ColField      *int              `json:"colField,omitempty"`
	Values        []SheetPivotValue `json:"values"`
	ShowRowTotals bool              `json:"showRowTotals"`
	ShowColTotals bool              `json:"showColTotals"`
	SortBy        string            `json:"sortBy,omitempty"` // label_asc | label_desc | value_desc | value_asc
	DestRow       int               `json:"destRow,omitempty"`
	DestCol       int               `json:"destCol,omitempty"`
}

func validateAndNormalizeSheetCharts(charts []SheetChart, rowCount, colCount int) ([]SheetChart, bool) {
	if len(charts) > sheetMaxChartsPerSheet {
		return nil, false
	}
	out := make([]SheetChart, 0, len(charts))
	seen := make(map[string]bool, len(charts))
	for _, c := range charts {
		id, ok := validRuleID(c.ID)
		if !ok || seen[id] {
			return nil, false
		}
		seen[id] = true
		title := strings.TrimSpace(c.Title)
		if utf8.RuneCountInString(title) > 100 || !utf8.ValidString(title) || strings.ContainsRune(title, '\x00') {
			return nil, false
		}
		switch c.Type {
		case "column", "bar", "line", "area", "pie":
		default:
			return nil, false
		}
		t, l, b, r, ok := normalizeRect(c.Top, c.Left, c.Bottom, c.Right, rowCount, colCount)
		if !ok {
			return nil, false
		}
		x := max(0, min(20000, c.X))
		y := max(0, min(20000, c.Y))
		w := c.Width
		if w == 0 {
			w = 460
		}
		w = max(260, min(1200, w))
		h := c.Height
		if h == 0 {
			h = 300
		}
		h = max(200, min(800, h))
		out = append(out, SheetChart{
			ID:         id,
			Title:      title,
			Type:       c.Type,
			Top:        t,
			Left:       l,
			Bottom:     b,
			Right:      r,
			HeaderRow:  c.HeaderRow,
			X:          x,
			Y:          y,
			Width:      w,
			Height:     h,
			ShowLegend: c.ShowLegend,
			ShowValues: c.ShowValues,
		})
	}
	return out, true
}

func validateAndNormalizeSheetPivotTables(pivots []SheetPivotTable, currentSheetID int64, sheetDims map[int64][2]int) ([]SheetPivotTable, bool) {
	if len(pivots) > sheetMaxPivotTablesPerSheet {
		return nil, false
	}
	out := make([]SheetPivotTable, 0, len(pivots))
	seen := make(map[string]bool, len(pivots))
	for _, p := range pivots {
		id, ok := validRuleID(p.ID)
		if !ok || seen[id] {
			return nil, false
		}
		seen[id] = true
		title := strings.TrimSpace(p.Title)
		if title == "" {
			title = "数据透视表"
		}
		if utf8.RuneCountInString(title) > 100 || !utf8.ValidString(title) || strings.ContainsRune(title, '\x00') {
			return nil, false
		}
		srcSheetID := p.SourceSheetID
		lookupID := srcSheetID
		if lookupID == 0 {
			lookupID = currentSheetID
		}
		dims, exists := sheetDims[lookupID]
		if !exists {
			return nil, false
		}
		rowCount, colCount := dims[0], dims[1]
		t, l, b, r, ok := normalizeRect(p.Top, p.Left, p.Bottom, p.Right, rowCount, colCount)
		if !ok || b <= t {
			// Pivot table needs at least a header row + 1 data row.
			return nil, false
		}
		width := r - l + 1
		if len(p.RowFields) == 0 || len(p.RowFields) > sheetMaxPivotRowFields {
			return nil, false
		}
		rowFields := make([]int, 0, len(p.RowFields))
		rfSeen := map[int]bool{}
		for _, rf := range p.RowFields {
			if rf < 0 || rf >= width || rfSeen[rf] {
				return nil, false
			}
			rfSeen[rf] = true
			rowFields = append(rowFields, rf)
		}
		var colField *int
		if p.ColField != nil {
			cf := *p.ColField
			if cf < 0 || cf >= width || rfSeen[cf] {
				return nil, false
			}
			colField = &cf
		}
		if len(p.Values) == 0 || len(p.Values) > sheetMaxPivotValues {
			return nil, false
		}
		vals := make([]SheetPivotValue, 0, len(p.Values))
		for _, v := range p.Values {
			if v.Col < 0 || v.Col >= width {
				return nil, false
			}
			switch v.Agg {
			case "sum", "count", "avg", "min", "max":
			default:
				return nil, false
			}
			vals = append(vals, SheetPivotValue{Col: v.Col, Agg: v.Agg})
		}
		sortBy := p.SortBy
		switch sortBy {
		case "", "label_asc", "label_desc", "value_desc", "value_asc":
		default:
			return nil, false
		}
		destRow := max(0, p.DestRow)
		destCol := max(0, p.DestCol)
		out = append(out, SheetPivotTable{
			ID:            id,
			Title:         title,
			SourceSheetID: srcSheetID,
			Top:           t,
			Left:          l,
			Bottom:        b,
			Right:         r,
			RowFields:     rowFields,
			ColField:      colField,
			Values:        vals,
			ShowRowTotals: p.ShowRowTotals,
			ShowColTotals: p.ShowColTotals,
			SortBy:        sortBy,
			DestRow:       destRow,
			DestCol:       destCol,
		})
	}
	return out, true
}

func cloneSheetCharts(charts []SheetChart) []SheetChart {
	if len(charts) == 0 {
		return []SheetChart{}
	}
	return slices.Clone(charts)
}

func cloneSheetPivotTables(pivots []SheetPivotTable) []SheetPivotTable {
	if len(pivots) == 0 {
		return []SheetPivotTable{}
	}
	out := make([]SheetPivotTable, len(pivots))
	for i, p := range pivots {
		p.RowFields = slices.Clone(p.RowFields)
		if p.ColField != nil {
			v := *p.ColField
			p.ColField = &v
		}
		p.Values = slices.Clone(p.Values)
		out[i] = p
	}
	return out
}

func remapSheetPivotSourceIDs(pivots []SheetPivotTable, idMap map[int64]int64) []SheetPivotTable {
	out := cloneSheetPivotTables(pivots)
	for i := range out {
		if out[i].SourceSheetID > 0 {
			if mapped, ok := idMap[out[i].SourceSheetID]; ok {
				out[i].SourceSheetID = mapped
			}
		}
	}
	return out
}

func adjustIntervalInsert(start, end, index, count int) (int, int) {
	if start >= index {
		return start + count, end + count
	}
	if end >= index {
		return start, end + count
	}
	return start, end
}

func adjustSheetChartsInsert(charts []SheetChart, axis string, index, count int) []SheetChart {
	out := cloneSheetCharts(charts)
	for i := range out {
		if axis == "row" {
			out[i].Top, out[i].Bottom = adjustIntervalInsert(out[i].Top, out[i].Bottom, index, count)
		} else {
			out[i].Left, out[i].Right = adjustIntervalInsert(out[i].Left, out[i].Right, index, count)
		}
	}
	return out
}

func adjustSheetChartsDelete(charts []SheetChart, axis string, index, count int) []SheetChart {
	out := make([]SheetChart, 0, len(charts))
	for _, c := range charts {
		var keep bool
		if axis == "row" {
			c.Top, c.Bottom, keep = adjustIntervalDelete(c.Top, c.Bottom, index, count)
		} else {
			c.Left, c.Right, keep = adjustIntervalDelete(c.Left, c.Right, index, count)
		}
		if keep {
			out = append(out, c)
		}
	}
	return out
}

func adjustSheetPivotsInsert(pivots []SheetPivotTable, currentSheetID int64, axis string, index, count int) []SheetPivotTable {
	out := cloneSheetPivotTables(pivots)
	for i := range out {
		if out[i].SourceSheetID != 0 && out[i].SourceSheetID != currentSheetID {
			continue
		}
		if axis == "row" {
			out[i].Top, out[i].Bottom = adjustIntervalInsert(out[i].Top, out[i].Bottom, index, count)
		} else {
			oldLeft := out[i].Left
			out[i].Left, out[i].Right = adjustIntervalInsert(out[i].Left, out[i].Right, index, count)
			// If columns were inserted strictly inside [oldLeft+1..Right], shift relative field offsets >= (index - oldLeft).
			if index > oldLeft && index <= out[i].Right-count {
				rel := index - oldLeft
				for j := range out[i].RowFields {
					if out[i].RowFields[j] >= rel {
						out[i].RowFields[j] += count
					}
				}
				if out[i].ColField != nil && *out[i].ColField >= rel {
					v := *out[i].ColField + count
					out[i].ColField = &v
				}
				for j := range out[i].Values {
					if out[i].Values[j].Col >= rel {
						out[i].Values[j].Col += count
					}
				}
			}
		}
	}
	return out
}

func adjustSheetPivotsDelete(pivots []SheetPivotTable, currentSheetID int64, axis string, index, count int) []SheetPivotTable {
	out := make([]SheetPivotTable, 0, len(pivots))
	for _, p := range cloneSheetPivotTables(pivots) {
		if p.SourceSheetID != 0 && p.SourceSheetID != currentSheetID {
			out = append(out, p)
			continue
		}
		var keep bool
		if axis == "row" {
			p.Top, p.Bottom, keep = adjustIntervalDelete(p.Top, p.Bottom, index, count)
			if !keep || p.Bottom <= p.Top {
				continue
			}
		} else {
			oldLeft := p.Left
			p.Left, p.Right, keep = adjustIntervalDelete(p.Left, p.Right, index, count)
			if !keep {
				continue
			}
			newWidth := p.Right - p.Left + 1
			remapCol := func(rel int) (int, bool) {
				abs := oldLeft + rel
				if abs >= index && abs < index+count {
					return 0, false
				}
				if abs >= index+count {
					abs -= count
				}
				nextRel := abs - p.Left
				return nextRel, nextRel >= 0 && nextRel < newWidth
			}
			nextRF := make([]int, 0, len(p.RowFields))
			for _, rf := range p.RowFields {
				if nr, ok := remapCol(rf); ok {
					nextRF = append(nextRF, nr)
				}
			}
			if len(nextRF) == 0 {
				continue
			}
			p.RowFields = nextRF
			if p.ColField != nil {
				if nc, ok := remapCol(*p.ColField); ok {
					p.ColField = &nc
				} else {
					p.ColField = nil
				}
			}
			nextVals := make([]SheetPivotValue, 0, len(p.Values))
			for _, v := range p.Values {
				if nv, ok := remapCol(v.Col); ok {
					nextVals = append(nextVals, SheetPivotValue{Col: nv, Agg: v.Agg})
				}
			}
			if len(nextVals) == 0 {
				continue
			}
			p.Values = nextVals
		}
		out = append(out, p)
	}
	return out
}

func validateAndNormalizeSheetSparklines(sparklines []SheetSparkline, rowCount, colCount int) ([]SheetSparkline, bool) {
	if len(sparklines) > sheetMaxSparklinesPerSheet {
		return nil, false
	}
	out := make([]SheetSparkline, 0, len(sparklines))
	seenID := make(map[string]bool, len(sparklines))
	seenCell := make(map[[2]int]bool, len(sparklines))
	for _, sp := range sparklines {
		id, ok := validRuleID(sp.ID)
		if !ok || seenID[id] {
			return nil, false
		}
		seenID[id] = true
		if sp.Row < 0 || sp.Row >= rowCount || sp.Col < 0 || sp.Col >= colCount {
			return nil, false
		}
		cellKey := [2]int{sp.Row, sp.Col}
		if seenCell[cellKey] {
			return nil, false
		}
		seenCell[cellKey] = true
		t, l, b, r, ok := normalizeRect(sp.SourceTop, sp.SourceLeft, sp.SourceBottom, sp.SourceRight, rowCount, colCount)
		if !ok {
			return nil, false
		}
		switch sp.Type {
		case "line", "bar", "winloss":
		default:
			return nil, false
		}
		color := strings.TrimSpace(sp.Color)
		if color != "" && !sheetHexColorPattern.MatchString(color) {
			return nil, false
		}
		negColor := strings.TrimSpace(sp.NegativeColor)
		if negColor != "" && !sheetHexColorPattern.MatchString(negColor) {
			return nil, false
		}
		out = append(out, SheetSparkline{
			ID:            id,
			Row:           sp.Row,
			Col:           sp.Col,
			SourceTop:     t,
			SourceLeft:    l,
			SourceBottom:  b,
			SourceRight:   r,
			Type:          sp.Type,
			Color:         color,
			NegativeColor: negColor,
			ShowMarkers:   sp.ShowMarkers,
		})
	}
	return out, true
}

func validateAndNormalizeSheetOutlineGroups(groups []SheetOutlineGroup, rowCount, colCount int) ([]SheetOutlineGroup, bool) {
	if len(groups) > sheetMaxOutlineGroupsPerSheet {
		return nil, false
	}
	out := make([]SheetOutlineGroup, 0, len(groups))
	seenID := make(map[string]bool, len(groups))
	for _, g := range groups {
		id, ok := validRuleID(g.ID)
		if !ok || seenID[id] {
			return nil, false
		}
		seenID[id] = true
		var limit int
		switch g.Axis {
		case "row":
			limit = rowCount
		case "col":
			limit = colCount
		default:
			return nil, false
		}
		start, end := g.Start, g.End
		if start > end {
			start, end = end, start
		}
		if start < 0 || end >= limit {
			return nil, false
		}
		out = append(out, SheetOutlineGroup{
			ID:        id,
			Axis:      g.Axis,
			Start:     start,
			End:       end,
			Collapsed: g.Collapsed,
		})
	}
	return out, true
}

func cloneSheetSparklines(sparklines []SheetSparkline) []SheetSparkline {
	if len(sparklines) == 0 {
		return []SheetSparkline{}
	}
	return slices.Clone(sparklines)
}

func cloneSheetOutlineGroups(groups []SheetOutlineGroup) []SheetOutlineGroup {
	if len(groups) == 0 {
		return []SheetOutlineGroup{}
	}
	return slices.Clone(groups)
}

func adjustSheetSparklinesInsert(sparklines []SheetSparkline, axis string, index, count int) []SheetSparkline {
	out := cloneSheetSparklines(sparklines)
	for i := range out {
		if axis == "row" {
			if out[i].Row >= index {
				out[i].Row += count
			}
			out[i].SourceTop, out[i].SourceBottom = adjustIntervalInsert(out[i].SourceTop, out[i].SourceBottom, index, count)
		} else {
			if out[i].Col >= index {
				out[i].Col += count
			}
			out[i].SourceLeft, out[i].SourceRight = adjustIntervalInsert(out[i].SourceLeft, out[i].SourceRight, index, count)
		}
	}
	return out
}

func adjustSheetSparklinesDelete(sparklines []SheetSparkline, axis string, index, count int) []SheetSparkline {
	out := make([]SheetSparkline, 0, len(sparklines))
	delEnd := index + count - 1
	for _, sp := range sparklines {
		var keep bool
		if axis == "row" {
			if sp.Row >= index && sp.Row <= delEnd {
				continue
			}
			if sp.Row > delEnd {
				sp.Row -= count
			}
			sp.SourceTop, sp.SourceBottom, keep = adjustIntervalDelete(sp.SourceTop, sp.SourceBottom, index, count)
		} else {
			if sp.Col >= index && sp.Col <= delEnd {
				continue
			}
			if sp.Col > delEnd {
				sp.Col -= count
			}
			sp.SourceLeft, sp.SourceRight, keep = adjustIntervalDelete(sp.SourceLeft, sp.SourceRight, index, count)
		}
		if keep {
			out = append(out, sp)
		}
	}
	return out
}

func adjustSheetOutlineGroupsInsert(groups []SheetOutlineGroup, axis string, index, count int) []SheetOutlineGroup {
	out := cloneSheetOutlineGroups(groups)
	for i := range out {
		if out[i].Axis != axis {
			continue
		}
		out[i].Start, out[i].End = adjustIntervalInsert(out[i].Start, out[i].End, index, count)
	}
	return out
}

func adjustSheetOutlineGroupsDelete(groups []SheetOutlineGroup, axis string, index, count int) []SheetOutlineGroup {
	out := make([]SheetOutlineGroup, 0, len(groups))
	for _, g := range groups {
		if g.Axis != axis {
			out = append(out, g)
			continue
		}
		ns, ne, keep := adjustIntervalDelete(g.Start, g.End, index, count)
		if keep {
			g.Start, g.End = ns, ne
			out = append(out, g)
		}
	}
	return out
}
