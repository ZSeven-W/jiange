// Package sheetstore is an isolated, not-yet-routed spreadsheet storage
// foundation. It is not the application's Base or document table model.
package sheetstore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ErrUnauthenticated = errors.New("sheet: session expired")
	ErrForbidden       = errors.New("sheet: access denied")
	ErrNotFound        = errors.New("sheet: workbook not found")
	ErrConflict        = errors.New("sheet: revision or mutation conflict")
	ErrInvalid         = errors.New("sheet: invalid input")
	ErrFormula         = errors.New("sheet: formulas are not yet supported")
)

const (
	maxSafeInteger = int64(1<<53 - 1)
	maxCellBytes   = 32 * 1024
	maxBatchCells  = 500
)

var mutationPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

// Guard is created by the authenticated API layer, never from request JSON.
// SessionHash is the stored hash, not the raw cookie.
type Guard struct {
	UserID      int64
	SessionHash []byte
	Now         func() time.Time
}

func (g Guard) now() time.Time {
	if g.Now != nil { return g.Now() }
	return time.Now()
}

type Workbook struct {
	ID, WorkspaceID, CreatorID int64
	Title string
}
type Axis struct { ID int64; Position int }
type Cell struct { RowID, ColumnID int64; Raw string; Revision int64 }
type Worksheet struct {
	ID, WorkbookID int64
	Title string
	Position int
	Rows, Columns []Axis
	Cells []Cell
}
type CellWrite struct {
	RowID int64 `json:"rowId"`
	ColumnID int64 `json:"columnId"`
	ExpectedRevision int64 `json:"expectedRevision"`
	Raw string `json:"raw"`
}
type Batch struct {
	MutationID string `json:"mutationId"`
	WorksheetID int64 `json:"worksheetId"`
	Cells []CellWrite `json:"cells"`
}
type CellRevision struct {
	RowID int64 `json:"rowId"`
	ColumnID int64 `json:"columnId"`
	Revision int64 `json:"revision"`
}
type BatchResult struct {
	MutationID string `json:"mutationId"`
	Cells []CellRevision `json:"cells"`
	// A replay returns the original commit receipt. The caller must refresh to
	// observe edits made after that commit.
	Replayed bool `json:"replayed"`
}

func validID(n int64) bool { return n > 0 && n <= maxSafeInteger }
func validTitle(s string) bool {
	return utf8.ValidString(s) && len(s) > 0 && len(s) <= 256 && !strings.ContainsRune(s, '\x00')
}
func validateBatch(b Batch) (Batch, []byte, error) {
	if !mutationPattern.MatchString(b.MutationID) || !validID(b.WorksheetID) || len(b.Cells) == 0 || len(b.Cells) > maxBatchCells { return Batch{}, nil, ErrInvalid }
	b.Cells = slices.Clone(b.Cells)
	slices.SortFunc(b.Cells, func(a, c CellWrite) int {
		if a.RowID < c.RowID { return -1 }; if a.RowID > c.RowID { return 1 }
		if a.ColumnID < c.ColumnID { return -1 }; if a.ColumnID > c.ColumnID { return 1 }; return 0
	})
	for i, c := range b.Cells {
		if !validID(c.RowID) || !validID(c.ColumnID) || c.ExpectedRevision < 0 || c.ExpectedRevision >= maxSafeInteger || len(c.Raw) > maxCellBytes || !utf8.ValidString(c.Raw) || strings.ContainsRune(c.Raw, '\x00') { return Batch{}, nil, ErrInvalid }
		if strings.HasPrefix(c.Raw, "=") { return Batch{}, nil, ErrFormula }
		if i > 0 && b.Cells[i-1].RowID == c.RowID && b.Cells[i-1].ColumnID == c.ColumnID { return Batch{}, nil, ErrInvalid }
	}
	// The mutation identifier is the key, not part of the payload identity.
	payload, err := json.Marshal(struct { Version int `json:"version"`; WorksheetID int64 `json:"worksheetId"`; Cells []CellWrite `json:"cells"` }{1,b.WorksheetID,b.Cells})
	if err != nil { return Batch{}, nil, ErrInvalid }
	h := sha256.Sum256(payload)
	return b, h[:], nil
}

func validMutation(s string) bool { return mutationPattern.MatchString(s) }
func titleDigest(s string) []byte { h := sha256.Sum256([]byte("sheet-create-v1\x00" + s)); return h[:] }
func DigestHex(b []byte) string { return hex.EncodeToString(b) }
