package sheetstore

import (
	"context"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

// memory is an isolated test implementation. Its identity state is not the
// application's Memory store and therefore must not be exposed via an API.
type memory struct {
	mu                            sync.Mutex
	sessions                      map[string]memorySession
	members                       map[int64]map[int64]bool
	books                         map[int64]*memoryWorkbook
	creates                       map[createKey]createReceipt
	writes                        map[writeKey]writeReceipt
	nextBook, nextSheet, nextAxis int64
}
type memorySession struct {
	user    int64
	expires time.Time
}
type createKey struct {
	workspace, user int64
	mutation        string
}
type createReceipt struct {
	digest   string
	workbook int64
}
type writeKey struct {
	workbook, user int64
	mutation       string
}
type writeReceipt struct {
	digest string
	result BatchResult
}
type cellKey struct{ row, column int64 }
type memoryWorkbook struct {
	workbook Workbook
	grants   map[int64]string
	sheets   map[int64]*memoryWorksheet
}
type memoryWorksheet struct {
	sheet         Worksheet
	rows, columns map[int64]bool
	cells         map[cellKey]Cell
}

func newMemory() *memory {
	return &memory{sessions: map[string]memorySession{}, members: map[int64]map[int64]bool{}, books: map[int64]*memoryWorkbook{}, creates: map[createKey]createReceipt{}, writes: map[writeKey]writeReceipt{}}
}

func (m *memory) session(ctx context.Context, guard Guard) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !validID(guard.UserID) || len(guard.SessionHash) == 0 {
		return ErrUnauthenticated
	}
	session, ok := m.sessions[string(guard.SessionHash)]
	if !ok || session.user != guard.UserID || !guard.now().Before(session.expires) {
		return ErrUnauthenticated
	}
	return nil
}

func (m *memory) access(ctx context.Context, guard Guard, id int64, write bool) (*memoryWorkbook, error) {
	if err := m.session(ctx, guard); err != nil {
		return nil, err
	}
	if !validID(id) {
		return nil, ErrNotFound
	}
	book := m.books[id]
	if book == nil || book.grants[guard.UserID] == "" {
		return nil, ErrNotFound
	}
	role := book.grants[guard.UserID]
	if role != "view" && role != "edit" && role != "manage" {
		return nil, ErrNotFound
	}
	if write && role == "view" {
		return nil, ErrForbidden
	}
	return book, nil
}

func (m *memory) CreateWorkbook(ctx context.Context, guard Guard, workspaceID int64, title, mutationID string) (CreateResult, error) {
	if !validID(workspaceID) || !validTitle(title) || strings.TrimSpace(title) == "" || !validMutation(mutationID) {
		return CreateResult{}, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.session(ctx, guard); err != nil {
		return CreateResult{}, err
	}
	if !m.members[workspaceID][guard.UserID] {
		return CreateResult{}, ErrForbidden
	}
	key := createKey{workspace: workspaceID, user: guard.UserID, mutation: mutationID}
	digest := DigestHex(titleDigest(title))
	if receipt, ok := m.creates[key]; ok {
		if receipt.digest != digest {
			return CreateResult{}, ErrConflict
		}
		book, err := m.access(ctx, guard, receipt.workbook, false)
		if err != nil {
			return CreateResult{}, err
		}
		return CreateResult{Workbook: book.workbook, Replayed: true}, nil
	}
	if m.nextBook >= maxSafeInteger || m.nextSheet >= maxSafeInteger || m.nextAxis > maxSafeInteger-initialRows-initialColumns {
		return CreateResult{}, ErrConflict
	}
	bookID, sheetID, axis := m.nextBook+1, m.nextSheet+1, m.nextAxis
	book := &memoryWorkbook{workbook: Workbook{ID: bookID, WorkspaceID: workspaceID, CreatorID: guard.UserID, Title: title}, grants: map[int64]string{guard.UserID: "manage"}, sheets: map[int64]*memoryWorksheet{}}
	sheet := &memoryWorksheet{sheet: Worksheet{ID: sheetID, WorkbookID: bookID, Title: "工作表1", Position: 0}, rows: map[int64]bool{}, columns: map[int64]bool{}, cells: map[cellKey]Cell{}}
	for i := 0; i < initialRows; i++ {
		axis++
		sheet.rows[axis] = true
		sheet.sheet.Rows = append(sheet.sheet.Rows, Axis{ID: axis, Position: i})
	}
	for i := 0; i < initialColumns; i++ {
		axis++
		sheet.columns[axis] = true
		sheet.sheet.Columns = append(sheet.sheet.Columns, Axis{ID: axis, Position: i})
	}
	book.sheets[sheetID] = sheet
	if err := m.session(ctx, guard); err != nil {
		return CreateResult{}, err
	}
	m.nextBook, m.nextSheet, m.nextAxis = bookID, sheetID, axis
	m.books[bookID] = book
	m.creates[key] = createReceipt{digest: digest, workbook: bookID}
	return CreateResult{Workbook: book.workbook}, nil
}

func (m *memory) ReadWorkbook(ctx context.Context, guard Guard, id int64) (Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	book, err := m.access(ctx, guard, id, false)
	if err != nil {
		return Snapshot{}, err
	}
	if len(book.sheets) > maxSnapshotSheets {
		return Snapshot{}, ErrTooLarge
	}
	axisCount, cellCount, bytes := 0, 0, 0
	for _, entry := range book.sheets {
		axisCount += len(entry.sheet.Rows) + len(entry.sheet.Columns)
		cellCount += len(entry.cells)
		if axisCount > maxSnapshotAxes || cellCount > maxSnapshotCells {
			return Snapshot{}, ErrTooLarge
		}
		for _, cell := range entry.cells {
			if len(cell.Raw) > maxCellBytes {
				return Snapshot{}, ErrTooLarge
			}
			bytes += len(cell.Raw)
			if bytes > maxSnapshotBytes {
				return Snapshot{}, ErrTooLarge
			}
		}
	}
	result := Snapshot{Workbook: book.workbook, Sheets: make([]Worksheet, 0, len(book.sheets))}
	for _, entry := range book.sheets {
		sheet := entry.sheet
		sheet.Rows = slices.Clone(sheet.Rows)
		sheet.Columns = slices.Clone(sheet.Columns)
		sheet.Cells = make([]Cell, 0, len(entry.cells))
		for _, cell := range entry.cells {
			sheet.Cells = append(sheet.Cells, cell)
		}
		sort.Slice(sheet.Cells, func(i, j int) bool {
			if sheet.Cells[i].RowID != sheet.Cells[j].RowID {
				return sheet.Cells[i].RowID < sheet.Cells[j].RowID
			}
			return sheet.Cells[i].ColumnID < sheet.Cells[j].ColumnID
		})
		result.Sheets = append(result.Sheets, sheet)
	}
	sort.Slice(result.Sheets, func(i, j int) bool { return result.Sheets[i].Position < result.Sheets[j].Position })
	if err := m.session(ctx, guard); err != nil {
		return Snapshot{}, err
	}
	return result, nil
}

func cloneResult(result BatchResult, replay bool) BatchResult {
	result.Cells = slices.Clone(result.Cells)
	result.Replayed = replay
	return result
}

func (m *memory) WriteCells(ctx context.Context, guard Guard, workbookID int64, batch Batch) (BatchResult, error) {
	batch, hash, err := validateBatch(batch)
	if err != nil {
		return BatchResult{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	book, err := m.access(ctx, guard, workbookID, true)
	if err != nil {
		return BatchResult{}, err
	}
	key := writeKey{workbook: workbookID, user: guard.UserID, mutation: batch.MutationID}
	digest := DigestHex(hash)
	if receipt, ok := m.writes[key]; ok {
		if receipt.digest != digest {
			return BatchResult{}, ErrConflict
		}
		return cloneResult(receipt.result, true), nil
	}
	sheet := book.sheets[batch.WorksheetID]
	if sheet == nil {
		return BatchResult{}, ErrNotFound
	}
	result := BatchResult{MutationID: batch.MutationID, Cells: make([]CellRevision, 0, len(batch.Cells))}
	for _, write := range batch.Cells {
		if !sheet.rows[write.RowID] || !sheet.columns[write.ColumnID] {
			return BatchResult{}, ErrNotFound
		}
		current := sheet.cells[cellKey{write.RowID, write.ColumnID}]
		if current.Revision != write.ExpectedRevision || current.Revision >= maxSafeInteger {
			return BatchResult{}, ErrConflict
		}
		result.Cells = append(result.Cells, CellRevision{RowID: write.RowID, ColumnID: write.ColumnID, Revision: current.Revision + 1})
	}
	if err := m.session(ctx, guard); err != nil {
		return BatchResult{}, err
	}
	for i, write := range batch.Cells {
		sheet.cells[cellKey{write.RowID, write.ColumnID}] = Cell{RowID: write.RowID, ColumnID: write.ColumnID, Raw: write.Raw, Revision: result.Cells[i].Revision}
	}
	m.writes[key] = writeReceipt{digest: digest, result: cloneResult(result, false)}
	return cloneResult(result, false), nil
}

func (m *memory) LookupWrite(ctx context.Context, guard Guard, workbookID int64, mutationID string) (BatchResult, bool, error) {
	if !validMutation(mutationID) {
		return BatchResult{}, false, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.access(ctx, guard, workbookID, false); err != nil {
		return BatchResult{}, false, err
	}
	receipt, ok := m.writes[writeKey{workbook: workbookID, user: guard.UserID, mutation: mutationID}]
	if !ok {
		return BatchResult{}, false, nil
	}
	return cloneResult(receipt.result, true), true, nil
}

var _ Repository = (*memory)(nil)
