package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	sheetInitialRows     = 100
	sheetInitialCols     = 26
	sheetMaxWorksheets   = 50
	sheetMaxRows         = 10000
	sheetMaxCols         = 256
	sheetMaxBatchCells   = 2000
	sheetMaxCellBytes    = 32 * 1024
	sheetMaxFormulaBytes = 8192
	sheetMaxBatchBytes   = 4 << 20
	sheetMaxImportCells  = 50000
	sheetMaxImportBytes  = 16 << 20
	sheetMaxRevision     = int64(9007199254740991)
	sheetMaxFrozenRows   = 50
	sheetMaxFrozenCols   = 20
	// Idempotency receipts only need to outlive client retries.
	sheetReceiptRetention = 24 * time.Hour
)

var (
	sheetMutationPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
	sheetHexColorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	sheetInvalidTitleSet = regexp.MustCompile(`[\[\]:*?/\\]`)
)

type SheetBorders struct {
	Top    bool   `json:"top,omitempty"`
	Right  bool   `json:"right,omitempty"`
	Bottom bool   `json:"bottom,omitempty"`
	Left   bool   `json:"left,omitempty"`
	Color  string `json:"color,omitempty"`
}

type SheetCellStyle struct {
	Bold       bool          `json:"bold,omitempty"`
	Italic     bool          `json:"italic,omitempty"`
	Underline  bool          `json:"underline,omitempty"`
	Strike     bool          `json:"strike,omitempty"`
	FontFamily string        `json:"fontFamily,omitempty"`
	FontSize   int           `json:"fontSize,omitempty"`
	Color      string        `json:"color,omitempty"`
	Bg         string        `json:"bg,omitempty"`
	Align      string        `json:"align,omitempty"`
	VAlign     string        `json:"valign,omitempty"`
	Wrap       bool          `json:"wrap,omitempty"`
	Borders    *SheetBorders `json:"borders,omitempty"`
	NumFmt     string        `json:"numFmt,omitempty"`
}

type SheetMerge struct {
	Top    int `json:"top"`
	Left   int `json:"left"`
	Bottom int `json:"bottom"`
	Right  int `json:"right"`
}

type SheetColumnFilter struct {
	Query  string   `json:"query,omitempty"`
	Values []string `json:"values,omitempty"`
}

type SheetSortRule struct {
	Col       int  `json:"col"`
	Ascending bool `json:"ascending"`
}

type SheetFilterConfig struct {
	Enabled   bool                         `json:"enabled,omitempty"`
	HeaderRow int                          `json:"headerRow,omitempty"`
	Rules     map[string]SheetColumnFilter `json:"rules,omitempty"`
	Sort      *SheetSortRule               `json:"sort,omitempty"`
}

type SheetAxis struct {
	ID   int64 `json:"id"`
	Pos  int   `json:"pos"`
	Size int   `json:"size,omitempty"`
}

type SheetCell struct {
	RowID    int64          `json:"rowId"`
	ColumnID int64          `json:"columnId"`
	Raw      string         `json:"raw"`
	Style    SheetCellStyle `json:"style,omitempty"`
	Revision int64          `json:"revision"`
}

type SheetWorksheet struct {
	ID         int64             `json:"id"`
	NodeID     int64             `json:"nodeId"`
	Title      string            `json:"title"`
	Pos        int               `json:"pos"`
	FrozenRows int               `json:"frozenRows"`
	FrozenCols int               `json:"frozenCols"`
	Merges     []SheetMerge      `json:"merges"`
	Filter     SheetFilterConfig `json:"filter"`
	Revision   int64             `json:"revision"`
	Rows       []SheetAxis       `json:"rows"`
	Columns    []SheetAxis       `json:"columns"`
	Cells      []SheetCell       `json:"cells"`
}

type SheetSnapshot struct {
	NodeID           int64            `json:"nodeId"`
	WorkspaceID      int64            `json:"workspaceId"`
	ParentID         *int64           `json:"parentId"`
	Title            string           `json:"title"`
	Role             string           `json:"role"`
	CreatorID        int64            `json:"creatorId"`
	CreatorName      string           `json:"creatorName"`
	DriveRevision    int64            `json:"driveRevision"`
	WorkbookRevision int64            `json:"workbookRevision"`
	Sheets           []SheetWorksheet `json:"sheets"`
	UpdatedAt        time.Time        `json:"updatedAt"`
}

type SheetCellWrite struct {
	RowID            int64           `json:"rowId"`
	ColumnID         int64           `json:"columnId"`
	ExpectedRevision int64           `json:"expectedRevision"`
	Raw              *string         `json:"raw,omitempty"`
	Style            *SheetCellStyle `json:"style,omitempty"`
}

type SheetCellBatch struct {
	MutationID  string           `json:"mutationId"`
	WorksheetID int64            `json:"worksheetId"`
	Cells       []SheetCellWrite `json:"cells"`
}

type SheetCellRevision struct {
	RowID    int64 `json:"rowId"`
	ColumnID int64 `json:"columnId"`
	Revision int64 `json:"revision"`
}

type SheetBatchResult struct {
	MutationID       string              `json:"mutationId"`
	WorksheetID      int64               `json:"worksheetId"`
	WorkbookRevision int64               `json:"workbookRevision"`
	Cells            []SheetCellRevision `json:"cells"`
	Replayed         bool                `json:"replayed"`
}

type WorksheetPatch struct {
	Title            *string            `json:"title,omitempty"`
	Pos              *int               `json:"pos,omitempty"`
	FrozenRows       *int               `json:"frozenRows,omitempty"`
	FrozenCols       *int               `json:"frozenCols,omitempty"`
	Merges           *[]SheetMerge      `json:"merges,omitempty"`
	Filter           *SheetFilterConfig `json:"filter,omitempty"`
	ExpectedRevision *int64             `json:"expectedRevision,omitempty"`
}

type SheetAxisOp struct {
	Op               string `json:"op"`
	Index            int    `json:"index"`
	Count            int    `json:"count,omitempty"`
	Size             int    `json:"size,omitempty"`
	ExpectedRevision *int64 `json:"expectedRevision,omitempty"`
}

type ImportedSheetCell struct {
	Row   int            `json:"row"`
	Col   int            `json:"col"`
	Raw   string         `json:"raw"`
	Style SheetCellStyle `json:"style,omitempty"`
}

type ImportedWorksheet struct {
	Title      string              `json:"title"`
	Rows       int                 `json:"rows"`
	Cols       int                 `json:"cols"`
	FrozenRows int                 `json:"frozenRows,omitempty"`
	FrozenCols int                 `json:"frozenCols,omitempty"`
	Merges     []SheetMerge        `json:"merges,omitempty"`
	Cells      []ImportedSheetCell `json:"cells"`
}

type SheetWorkbookCopy struct {
	SourceID, UserID, WorkspaceID int64
	ParentID                      *int64
	Personal                      *bool
	Title                         string
	Guard                         *RestoreGuard
}

// SheetStore persists standalone multi-worksheet spreadsheets (`kind='sheet'`).
type SheetStore interface {
	GetSheetWorkbook(ctx context.Context, guard RestoreGuard, nodeID int64) (SheetSnapshot, error)
	SheetHead(ctx context.Context, nodeID int64) (int64, error)
	RenameSheetTitle(ctx context.Context, guard RestoreGuard, nodeID int64, title, expectedTitle string, expectedDriveRevision int64) (DriveEntry, error)
	WriteSheetCells(ctx context.Context, guard RestoreGuard, nodeID int64, batch SheetCellBatch) (SheetBatchResult, error)
	CreateWorksheet(ctx context.Context, guard RestoreGuard, nodeID int64, title string) (SheetWorksheet, int64, error)
	UpdateWorksheetMeta(ctx context.Context, guard RestoreGuard, nodeID, worksheetID int64, patch WorksheetPatch) (SheetWorksheet, int64, error)
	DeleteWorksheet(ctx context.Context, guard RestoreGuard, nodeID, worksheetID int64) (int64, error)
	MutateSheetAxis(ctx context.Context, guard RestoreGuard, nodeID, worksheetID int64, op SheetAxisOp) (SheetWorksheet, int64, error)
	ReplaceSheetWorkbook(ctx context.Context, guard RestoreGuard, nodeID, expectedWorkbookRevision int64, mutationID string, sheets []ImportedWorksheet) (SheetSnapshot, error)
	CopySheetWorkbook(ctx context.Context, copy SheetWorkbookCopy) (DocMeta, error)
	SearchSheetContent(ctx context.Context, userID, nodeID int64, foldedNeedle string) (bool, error)
}

func validSheetID(n int64) bool { return n > 0 && n <= sheetMaxRevision }

func validSheetMutationID(s string) bool { return sheetMutationPattern.MatchString(s) }

func cleanWorksheetTitle(raw string) (string, bool) {
	title := strings.TrimSpace(raw)
	if title == "" || !utf8.ValidString(title) {
		return "", false
	}
	if utf8.RuneCountInString(title) > 31 {
		return "", false
	}
	if strings.HasPrefix(title, "'") || strings.HasSuffix(title, "'") || sheetInvalidTitleSet.MatchString(title) {
		return "", false
	}
	for _, r := range title {
		if r < 32 {
			return "", false
		}
	}
	return title, true
}

func validSheetCellText(raw string, formula bool) bool {
	if !utf8.ValidString(raw) || strings.ContainsRune(raw, '\x00') {
		return false
	}
	if formula && strings.HasPrefix(raw, "=") {
		return len(raw) >= 2 && len(raw) <= sheetMaxFormulaBytes
	}
	return len(raw) <= sheetMaxCellBytes
}

func normalizeSheetStyle(style SheetCellStyle) (SheetCellStyle, bool) {
	style.FontFamily = strings.TrimSpace(style.FontFamily)
	if len(style.FontFamily) > 64 || !utf8.ValidString(style.FontFamily) {
		return SheetCellStyle{}, false
	}
	for _, r := range style.FontFamily {
		if r < 32 {
			return SheetCellStyle{}, false
		}
	}
	if style.FontSize != 0 && (style.FontSize < 8 || style.FontSize > 72) {
		return SheetCellStyle{}, false
	}
	if style.Color != "" && !sheetHexColorPattern.MatchString(style.Color) {
		return SheetCellStyle{}, false
	}
	if style.Bg != "" && !sheetHexColorPattern.MatchString(style.Bg) {
		return SheetCellStyle{}, false
	}
	switch style.Align {
	case "", "left", "center", "right":
	default:
		return SheetCellStyle{}, false
	}
	switch style.VAlign {
	case "", "top", "middle", "bottom":
	default:
		return SheetCellStyle{}, false
	}
	switch style.NumFmt {
	case "", "general", "currency", "percent", "decimal2", "decimal1", "integer", "date":
	default:
		return SheetCellStyle{}, false
	}
	if style.Borders != nil {
		b := *style.Borders
		if b.Color != "" && !sheetHexColorPattern.MatchString(b.Color) {
			return SheetCellStyle{}, false
		}
		if !b.Top && !b.Right && !b.Bottom && !b.Left {
			style.Borders = nil
		} else {
			style.Borders = &b
		}
	}
	return style, true
}

func validateAndNormalizeSheetMerges(merges []SheetMerge, rowCount, colCount int) ([]SheetMerge, bool) {
	if len(merges) == 0 {
		return []SheetMerge{}, true
	}
	if len(merges) > 2000 {
		return nil, false
	}
	out := slices.Clone(merges)
	for _, m := range out {
		if m.Top < 0 || m.Left < 0 || m.Bottom >= rowCount || m.Right >= colCount || m.Bottom < m.Top || m.Right < m.Left {
			return nil, false
		}
		if m.Top == m.Bottom && m.Left == m.Right {
			return nil, false
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Top != out[j].Top {
			return out[i].Top < out[j].Top
		}
		if out[i].Left != out[j].Left {
			return out[i].Left < out[j].Left
		}
		if out[i].Bottom != out[j].Bottom {
			return out[i].Bottom < out[j].Bottom
		}
		return out[i].Right < out[j].Right
	})
	for i := 0; i < len(out); i++ {
		a := out[i]
		for j := i + 1; j < len(out); j++ {
			b := out[j]
			if b.Top > a.Bottom {
				break
			}
			if a.Left <= b.Right && b.Left <= a.Right && a.Top <= b.Bottom && b.Top <= a.Bottom {
				return nil, false
			}
		}
	}
	return out, true
}

func validateAndNormalizeSheetFilter(f SheetFilterConfig, rowCount, colCount int) (SheetFilterConfig, bool) {
	if f.HeaderRow < 0 || f.HeaderRow >= rowCount || len(f.Rules) > 100 {
		return SheetFilterConfig{}, false
	}
	if f.Sort != nil {
		if f.Sort.Col < 0 || f.Sort.Col >= colCount {
			return SheetFilterConfig{}, false
		}
		cp := *f.Sort
		f.Sort = &cp
	}
	if len(f.Rules) == 0 {
		f.Rules = nil
		return f, true
	}
	clean := make(map[string]SheetColumnFilter, len(f.Rules))
	for k, rule := range f.Rules {
		if len(k) == 0 || len(k) > 8 || len(rule.Query) > 256 || !utf8.ValidString(rule.Query) || strings.ContainsRune(rule.Query, '\x00') || len(rule.Values) > 500 {
			return SheetFilterConfig{}, false
		}
		for _, c := range k {
			if c < '0' || c > '9' {
				return SheetFilterConfig{}, false
			}
		}
		vals := make([]string, 0, len(rule.Values))
		for _, v := range rule.Values {
			if len(v) > 1024 || !utf8.ValidString(v) || strings.ContainsRune(v, '\x00') {
				return SheetFilterConfig{}, false
			}
			vals = append(vals, v)
		}
		clean[k] = SheetColumnFilter{Query: rule.Query, Values: vals}
	}
	f.Rules = clean
	return f, true
}

func prepareSheetBatch(batch SheetCellBatch) (SheetCellBatch, []byte, error) {
	if !validSheetMutationID(batch.MutationID) || !validSheetID(batch.WorksheetID) || len(batch.Cells) == 0 || len(batch.Cells) > sheetMaxBatchCells {
		return SheetCellBatch{}, nil, ErrConflict
	}
	cells := slices.Clone(batch.Cells)
	sort.Slice(cells, func(i, j int) bool {
		if cells[i].RowID != cells[j].RowID {
			return cells[i].RowID < cells[j].RowID
		}
		return cells[i].ColumnID < cells[j].ColumnID
	})
	totalBytes := 0
	for i := range cells {
		c := &cells[i]
		if !validSheetID(c.RowID) || !validSheetID(c.ColumnID) || c.ExpectedRevision < 0 || c.ExpectedRevision >= sheetMaxRevision {
			return SheetCellBatch{}, nil, ErrConflict
		}
		if c.Raw == nil && c.Style == nil {
			return SheetCellBatch{}, nil, ErrConflict
		}
		if i > 0 && cells[i-1].RowID == c.RowID && cells[i-1].ColumnID == c.ColumnID {
			return SheetCellBatch{}, nil, ErrConflict
		}
		if c.Raw != nil {
			if !validSheetCellText(*c.Raw, true) {
				return SheetCellBatch{}, nil, ErrConflict
			}
			raw := *c.Raw
			c.Raw = &raw
			totalBytes += len(raw)
			if totalBytes > sheetMaxBatchBytes {
				return SheetCellBatch{}, nil, ErrConflict
			}
		}
		if c.Style != nil {
			norm, ok := normalizeSheetStyle(*c.Style)
			if !ok {
				return SheetCellBatch{}, nil, ErrConflict
			}
			c.Style = &norm
		}
	}
	batch.Cells = cells
	payload, err := json.Marshal(struct {
		Version     int              `json:"version"`
		WorksheetID int64            `json:"worksheetId"`
		Cells       []SheetCellWrite `json:"cells"`
	}{1, batch.WorksheetID, batch.Cells})
	if err != nil {
		return SheetCellBatch{}, nil, ErrConflict
	}
	sum := sha256.Sum256(payload)
	return batch, sum[:], nil
}

func adjustSheetMergesInsert(merges []SheetMerge, axis string, index, count int) []SheetMerge {
	out := make([]SheetMerge, 0, len(merges))
	for _, m := range merges {
		if axis == "row" {
			if m.Top >= index {
				m.Top += count
				m.Bottom += count
			} else if m.Bottom >= index {
				m.Bottom += count
			}
		} else {
			if m.Left >= index {
				m.Left += count
				m.Right += count
			} else if m.Right >= index {
				m.Right += count
			}
		}
		out = append(out, m)
	}
	return out
}

func adjustIntervalDelete(start, end, delStart, count int) (int, int, bool) {
	delEnd := delStart + count - 1
	if end < delStart {
		return start, end, true
	}
	if start > delEnd {
		return start - count, end - count, true
	}
	if start >= delStart && end <= delEnd {
		return 0, -1, false
	}
	removed := min(end, delEnd) - max(start, delStart) + 1
	if start >= delStart {
		newStart := delStart
		newEnd := newStart + (end - start + 1 - removed) - 1
		return newStart, newEnd, true
	}
	newEnd := end - removed
	return start, newEnd, true
}

func adjustSheetMergesDelete(merges []SheetMerge, axis string, index, count int) []SheetMerge {
	out := make([]SheetMerge, 0, len(merges))
	for _, m := range merges {
		if axis == "row" {
			nt, nb, keep := adjustIntervalDelete(m.Top, m.Bottom, index, count)
			if !keep {
				continue
			}
			m.Top, m.Bottom = nt, nb
		} else {
			nl, nr, keep := adjustIntervalDelete(m.Left, m.Right, index, count)
			if !keep {
				continue
			}
			m.Left, m.Right = nl, nr
		}
		if m.Top == m.Bottom && m.Left == m.Right {
			continue
		}
		out = append(out, m)
	}
	return out
}

func prepareImportWorksheets(sheets []ImportedWorksheet, mutationID string) ([]ImportedWorksheet, []byte, error) {
	if !validSheetMutationID(mutationID) || len(sheets) == 0 || len(sheets) > sheetMaxWorksheets {
		return nil, nil, ErrConflict
	}
	out := make([]ImportedWorksheet, 0, len(sheets))
	seenTitles := make(map[string]bool, len(sheets))
	totalCells, totalBytes := 0, 0
	for _, rawSheet := range sheets {
		title, ok := cleanWorksheetTitle(rawSheet.Title)
		if !ok {
			return nil, nil, ErrConflict
		}
		folded := strings.ToLower(title)
		if seenTitles[folded] {
			return nil, nil, ErrConflict
		}
		seenTitles[folded] = true
		rows := max(rawSheet.Rows, 1)
		cols := max(rawSheet.Cols, 1)
		if rows > sheetMaxRows || cols > sheetMaxCols {
			return nil, nil, ErrConflict
		}
		if rawSheet.FrozenRows < 0 || rawSheet.FrozenRows > min(sheetMaxFrozenRows, rows-1) || rawSheet.FrozenCols < 0 || rawSheet.FrozenCols > min(sheetMaxFrozenCols, cols-1) {
			return nil, nil, ErrConflict
		}
		seenCells := make(map[[2]int]bool, len(rawSheet.Cells))
		cells := make([]ImportedSheetCell, 0, len(rawSheet.Cells))
		for _, cell := range rawSheet.Cells {
			if cell.Row < 0 || cell.Row >= rows || cell.Col < 0 || cell.Col >= cols {
				return nil, nil, ErrConflict
			}
			key := [2]int{cell.Row, cell.Col}
			if seenCells[key] {
				return nil, nil, ErrConflict
			}
			seenCells[key] = true
			if !validSheetCellText(cell.Raw, true) {
				return nil, nil, ErrConflict
			}
			normStyle, ok := normalizeSheetStyle(cell.Style)
			if !ok {
				return nil, nil, ErrConflict
			}
			totalCells++
			totalBytes += len(cell.Raw)
			if totalCells > sheetMaxImportCells || totalBytes > sheetMaxImportBytes {
				return nil, nil, ErrConflict
			}
			cells = append(cells, ImportedSheetCell{Row: cell.Row, Col: cell.Col, Raw: cell.Raw, Style: normStyle})
		}
		merges, ok := validateAndNormalizeSheetMerges(rawSheet.Merges, rows, cols)
		if !ok {
			return nil, nil, ErrConflict
		}
		out = append(out, ImportedWorksheet{
			Title:      title,
			Rows:       rows,
			Cols:       cols,
			FrozenRows: rawSheet.FrozenRows,
			FrozenCols: rawSheet.FrozenCols,
			Merges:     merges,
			Cells:      cells,
		})
	}
	payload, err := json.Marshal(out)
	if err != nil {
		return nil, nil, ErrConflict
	}
	sum := sha256.Sum256(payload)
	return out, sum[:], nil
}

func cloneSheetStyle(style SheetCellStyle) SheetCellStyle {
	if style.Borders != nil {
		b := *style.Borders
		style.Borders = &b
	}
	return style
}

func cloneSheetFilter(filter SheetFilterConfig) SheetFilterConfig {
	if filter.Sort != nil {
		s := *filter.Sort
		filter.Sort = &s
	}
	if filter.Rules != nil {
		clean := make(map[string]SheetColumnFilter, len(filter.Rules))
		for k, v := range filter.Rules {
			clean[k] = SheetColumnFilter{Query: v.Query, Values: slices.Clone(v.Values)}
		}
		filter.Rules = clean
	}
	return filter
}

func cloneSheetWorksheet(w SheetWorksheet) SheetWorksheet {
	w.Rows = slices.Clone(w.Rows)
	w.Columns = slices.Clone(w.Columns)
	w.Merges = slices.Clone(w.Merges)
	w.Filter = cloneSheetFilter(w.Filter)
	cells := make([]SheetCell, len(w.Cells))
	for i, c := range w.Cells {
		c.Style = cloneSheetStyle(c.Style)
		cells[i] = c
	}
	w.Cells = cells
	return w
}
