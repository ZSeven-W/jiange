package sheetstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Postgres implements the isolated experimental schema. It does not install
// that schema, create cloud-drive nodes, or integrate the host's sharing UI.
type Postgres struct{ Pool *pgxpool.Pool }

func lockSession(ctx context.Context, tx pgx.Tx, g Guard) (time.Time, error) {
	if !validID(g.UserID) || len(g.SessionHash) == 0 {
		return time.Time{}, ErrUnauthenticated
	}
	var user int64
	var expires time.Time
	err := tx.QueryRow(ctx, `SELECT user_id,expires_at FROM sessions WHERE token_hash=$1 FOR SHARE`, g.SessionHash).Scan(&user, &expires)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (user != g.UserID || !g.now().Before(expires)) {
		return time.Time{}, ErrUnauthenticated
	}
	if err != nil {
		return time.Time{}, err
	}
	return expires, nil
}

func checkEnd(ctx context.Context, g Guard, expires time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !g.now().Before(expires) {
		return ErrUnauthenticated
	}
	return nil
}

// lockBook holds session, workbook and explicit grant until transaction end.
// Missing grants are deliberately indistinguishable from missing workbooks.
func lockBook(ctx context.Context, tx pgx.Tx, g Guard, workbookID int64, write bool) (Workbook, time.Time, error) {
	var book Workbook
	expires, err := lockSession(ctx, tx, g)
	if err != nil {
		return book, time.Time{}, err
	}
	if !validID(workbookID) {
		return book, time.Time{}, ErrNotFound
	}
	query := `SELECT id,workspace_id,creator_id,title FROM sheet_workbooks WHERE id=$1 FOR SHARE`
	if write {
		query = `SELECT id,workspace_id,creator_id,title FROM sheet_workbooks WHERE id=$1 FOR UPDATE`
	}
	err = tx.QueryRow(ctx, query, workbookID).Scan(&book.ID, &book.WorkspaceID, &book.CreatorID, &book.Title)
	if errors.Is(err, pgx.ErrNoRows) {
		return Workbook{}, time.Time{}, ErrNotFound
	}
	if err != nil {
		return Workbook{}, time.Time{}, err
	}
	var role string
	err = tx.QueryRow(ctx, `SELECT role FROM sheet_grants WHERE workbook_id=$1 AND user_id=$2 FOR SHARE`, workbookID, g.UserID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return Workbook{}, time.Time{}, ErrNotFound
	}
	if err != nil {
		return Workbook{}, time.Time{}, err
	}
	if role != "view" && role != "edit" && role != "manage" {
		return Workbook{}, time.Time{}, ErrNotFound
	}
	if write && role == "view" {
		return Workbook{}, time.Time{}, ErrForbidden
	}
	return book, expires, nil
}

func (p *Postgres) CreateWorkbook(ctx context.Context, g Guard, workspaceID int64, title, mutationID string) (result CreateResult, err error) {
	if !validID(workspaceID) || !validTitle(title) || strings.TrimSpace(title) == "" || !validMutation(mutationID) {
		return CreateResult{}, ErrInvalid
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := lockSession(ctx, tx, g)
		if e != nil {
			return e
		}
		var member int64
		e = tx.QueryRow(ctx, `SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, workspaceID, g.UserID).Scan(&member)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if e != nil {
			return e
		}
		// The same mutation must not publish two workbooks when requests race.
		lock := fmt.Sprintf("jiange-sheet-create:%d:%d:%s", workspaceID, g.UserID, mutationID)
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, lock); e != nil {
			return e
		}
		var storedHash []byte
		var storedID int64
		e = tx.QueryRow(ctx, `SELECT digest,workbook_id FROM sheet_create_receipts WHERE workspace_id=$1 AND user_id=$2 AND mutation_id=$3`, workspaceID, g.UserID, mutationID).Scan(&storedHash, &storedID)
		if e == nil {
			if !slices.Equal(storedHash, titleDigest(title)) {
				return ErrConflict
			}
			book, _, e := lockBook(ctx, tx, g, storedID, false)
			if e != nil {
				return e
			}
			result = CreateResult{Workbook: book, Replayed: true}
			return checkEnd(ctx, g, expires)
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		var book Workbook
		e = tx.QueryRow(ctx, `INSERT INTO sheet_workbooks(workspace_id,creator_id,title) VALUES($1,$2,$3) RETURNING id,workspace_id,creator_id,title`, workspaceID, g.UserID, title).Scan(&book.ID, &book.WorkspaceID, &book.CreatorID, &book.Title)
		if e != nil {
			return e
		}
		if !validID(book.ID) {
			return ErrConflict
		}
		if _, e = tx.Exec(ctx, `INSERT INTO sheet_grants(workbook_id,user_id,role) VALUES($1,$2,'manage')`, book.ID, g.UserID); e != nil {
			return e
		}
		var sheetID int64
		if e = tx.QueryRow(ctx, `INSERT INTO sheet_worksheets(workbook_id,title,position) VALUES($1,'工作表1',0) RETURNING id`, book.ID).Scan(&sheetID); e != nil {
			return e
		}
		if !validID(sheetID) {
			return ErrConflict
		}
		if _, e = tx.Exec(ctx, `INSERT INTO sheet_rows(sheet_id,position) SELECT $1,n FROM generate_series(0,$2::int-1) n`, sheetID, initialRows); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO sheet_columns(sheet_id,position) SELECT $1,n FROM generate_series(0,$2::int-1) n`, sheetID, initialColumns); e != nil {
			return e
		}
		var minAxis, maxAxis int64
		if e = tx.QueryRow(ctx, `SELECT LEAST(COALESCE((SELECT min(id) FROM sheet_rows WHERE sheet_id=$1),0),COALESCE((SELECT min(id) FROM sheet_columns WHERE sheet_id=$1),0)),GREATEST(COALESCE((SELECT max(id) FROM sheet_rows WHERE sheet_id=$1),0),COALESCE((SELECT max(id) FROM sheet_columns WHERE sheet_id=$1),0))`, sheetID).Scan(&minAxis, &maxAxis); e != nil {
			return e
		}
		if !validID(minAxis) || !validID(maxAxis) {
			return ErrConflict
		}
		if _, e = tx.Exec(ctx, `INSERT INTO sheet_create_receipts(workspace_id,user_id,mutation_id,digest,workbook_id) VALUES($1,$2,$3,$4,$5)`, workspaceID, g.UserID, mutationID, titleDigest(title), book.ID); e != nil {
			return e
		}
		if e = checkEnd(ctx, g, expires); e != nil {
			return e
		}
		result = CreateResult{Workbook: book}
		return nil
	})
	if err != nil {
		return CreateResult{}, err
	}
	return result, nil
}

func (p *Postgres) ReadWorkbook(ctx context.Context, g Guard, workbookID int64) (result Snapshot, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		book, expires, e := lockBook(ctx, tx, g, workbookID, false)
		if e != nil {
			return e
		}
		result = Snapshot{Workbook: book, Sheets: []Worksheet{}}
		rows, e := tx.Query(ctx, `SELECT id,workbook_id,title,position FROM sheet_worksheets WHERE workbook_id=$1 ORDER BY position,id LIMIT $2`, workbookID, maxSnapshotSheets+1)
		if e != nil {
			return e
		}
		for rows.Next() {
			var s Worksheet
			if e = rows.Scan(&s.ID, &s.WorkbookID, &s.Title, &s.Position); e != nil {
				rows.Close()
				return e
			}
			if !validID(s.ID) {
				rows.Close()
				return ErrConflict
			}
			result.Sheets = append(result.Sheets, s)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		if len(result.Sheets) > maxSnapshotSheets {
			return ErrTooLarge
		}
		axes, cells, bytes := 0, 0, int64(0)
		for i := range result.Sheets {
			s := &result.Sheets[i]
			for _, item := range []struct {
				query string
				out   *[]Axis
			}{{`SELECT id,position FROM sheet_rows WHERE sheet_id=$1 ORDER BY position,id LIMIT $2`, &s.Rows}, {`SELECT id,position FROM sheet_columns WHERE sheet_id=$1 ORDER BY position,id LIMIT $2`, &s.Columns}} {
				list, e := tx.Query(ctx, item.query, s.ID, maxSnapshotAxes-axes+1)
				if e != nil {
					return e
				}
				*item.out = []Axis{}
				for list.Next() {
					var a Axis
					if e = list.Scan(&a.ID, &a.Position); e != nil {
						list.Close()
						return e
					}
					if !validID(a.ID) {
						list.Close()
						return ErrConflict
					}
					*item.out = append(*item.out, a)
					axes++
				}
				e = list.Err()
				list.Close()
				if e != nil {
					return e
				}
				if axes > maxSnapshotAxes {
					return ErrTooLarge
				}
			}
			var count int
			var size, largest int64
			if e = tx.QueryRow(ctx, `SELECT count(*),COALESCE(sum(octet_length(raw)),0),COALESCE(max(octet_length(raw)),0) FROM sheet_cells WHERE sheet_id=$1`, s.ID).Scan(&count, &size, &largest); e != nil {
				return e
			}
			cells += count
			bytes += size
			if cells > maxSnapshotCells || bytes > maxSnapshotBytes || largest > maxCellBytes {
				return ErrTooLarge
			}
			list, e := tx.Query(ctx, `SELECT row_id,column_id,raw,revision FROM sheet_cells WHERE sheet_id=$1 ORDER BY row_id,column_id`, s.ID)
			if e != nil {
				return e
			}
			s.Cells = []Cell{}
			for list.Next() {
				var cell Cell
				if e = list.Scan(&cell.RowID, &cell.ColumnID, &cell.Raw, &cell.Revision); e != nil {
					list.Close()
					return e
				}
				if !validID(cell.RowID) || !validID(cell.ColumnID) || !validID(cell.Revision) {
					list.Close()
					return ErrConflict
				}
				s.Cells = append(s.Cells, cell)
			}
			e = list.Err()
			list.Close()
			if e != nil {
				return e
			}
		}
		return checkEnd(ctx, g, expires)
	})
	if err != nil {
		return Snapshot{}, err
	}
	return result, nil
}

func receiptValid(result BatchResult, mutationID string) bool {
	if result.MutationID != mutationID || result.Replayed || len(result.Cells) == 0 || len(result.Cells) > maxBatchCells {
		return false
	}
	seen := make(map[cellKey]bool, len(result.Cells))
	var previous cellKey
	for i, c := range result.Cells {
		key := cellKey{c.RowID, c.ColumnID}
		if !validID(c.RowID) || !validID(c.ColumnID) || !validID(c.Revision) || seen[key] || i > 0 && (key.row < previous.row || key.row == previous.row && key.column <= previous.column) {
			return false
		}
		seen[key] = true
		previous = key
	}
	return true
}

func (p *Postgres) WriteCells(ctx context.Context, g Guard, workbookID int64, batch Batch) (result BatchResult, err error) {
	batch, digest, err := validateBatch(batch)
	if err != nil {
		return BatchResult{}, err
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := lockBook(ctx, tx, g, workbookID, true)
		if e != nil {
			return e
		}
		var hash, raw []byte
		e = tx.QueryRow(ctx, `SELECT digest,CASE WHEN octet_length(result::text)<=131072 THEN result ELSE NULL END FROM sheet_write_receipts WHERE workbook_id=$1 AND user_id=$2 AND mutation_id=$3`, workbookID, g.UserID, batch.MutationID).Scan(&hash, &raw)
		if e == nil {
			if !slices.Equal(hash, digest) {
				return ErrConflict
			}
			if json.Unmarshal(raw, &result) != nil || !receiptValid(result, batch.MutationID) || len(result.Cells) != len(batch.Cells) {
				return ErrConflict
			}
			for i, cell := range result.Cells {
				if cell.RowID != batch.Cells[i].RowID || cell.ColumnID != batch.Cells[i].ColumnID || cell.Revision != batch.Cells[i].ExpectedRevision+1 {
					return ErrConflict
				}
			}
			result.Replayed = true
			return checkEnd(ctx, g, expires)
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		var exists bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM sheet_worksheets WHERE id=$1 AND workbook_id=$2)`, batch.WorksheetID, workbookID).Scan(&exists); e != nil {
			return e
		}
		if !exists {
			return ErrNotFound
		}
		rowIDs, columnIDs := make([]int64, 0, len(batch.Cells)), make([]int64, 0, len(batch.Cells))
		rowSet, columnSet := map[int64]bool{}, map[int64]bool{}
		for _, cell := range batch.Cells {
			if !rowSet[cell.RowID] {
				rowSet[cell.RowID] = true
				rowIDs = append(rowIDs, cell.RowID)
			}
			if !columnSet[cell.ColumnID] {
				columnSet[cell.ColumnID] = true
				columnIDs = append(columnIDs, cell.ColumnID)
			}
		}
		var count int
		if e = tx.QueryRow(ctx, `SELECT count(*) FROM sheet_rows WHERE sheet_id=$1 AND id=ANY($2)`, batch.WorksheetID, rowIDs).Scan(&count); e != nil {
			return e
		}
		if count != len(rowIDs) {
			return ErrNotFound
		}
		if e = tx.QueryRow(ctx, `SELECT count(*) FROM sheet_columns WHERE sheet_id=$1 AND id=ANY($2)`, batch.WorksheetID, columnIDs).Scan(&count); e != nil {
			return e
		}
		if count != len(columnIDs) {
			return ErrNotFound
		}
		result = BatchResult{MutationID: batch.MutationID, Cells: make([]CellRevision, 0, len(batch.Cells))}
		for _, cell := range batch.Cells {
			var revision int64
			if cell.ExpectedRevision == 0 {
				e = tx.QueryRow(ctx, `INSERT INTO sheet_cells(sheet_id,row_id,column_id,raw,revision) VALUES($1,$2,$3,$4,1) ON CONFLICT(sheet_id,row_id,column_id) DO NOTHING RETURNING revision`, batch.WorksheetID, cell.RowID, cell.ColumnID, cell.Raw).Scan(&revision)
			} else {
				e = tx.QueryRow(ctx, `UPDATE sheet_cells SET raw=$4,revision=revision+1 WHERE sheet_id=$1 AND row_id=$2 AND column_id=$3 AND revision=$5 RETURNING revision`, batch.WorksheetID, cell.RowID, cell.ColumnID, cell.Raw, cell.ExpectedRevision).Scan(&revision)
			}
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrConflict
			}
			if e != nil {
				return e
			}
			if revision != cell.ExpectedRevision+1 {
				return ErrConflict
			}
			result.Cells = append(result.Cells, CellRevision{RowID: cell.RowID, ColumnID: cell.ColumnID, Revision: revision})
		}
		encoded, e := json.Marshal(result)
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO sheet_write_receipts(workbook_id,user_id,mutation_id,digest,result) VALUES($1,$2,$3,$4,$5::jsonb)`, workbookID, g.UserID, batch.MutationID, digest, encoded); e != nil {
			return e
		}
		return checkEnd(ctx, g, expires)
	})
	if err != nil {
		return BatchResult{}, err
	}
	return cloneResult(result, result.Replayed), nil
}

func (p *Postgres) LookupWrite(ctx context.Context, g Guard, workbookID int64, mutationID string) (result BatchResult, found bool, err error) {
	if !validMutation(mutationID) {
		return BatchResult{}, false, ErrInvalid
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := lockBook(ctx, tx, g, workbookID, false)
		if e != nil {
			return e
		}
		var hash, raw []byte
		e = tx.QueryRow(ctx, `SELECT digest,CASE WHEN octet_length(result::text)<=131072 THEN result ELSE NULL END FROM sheet_write_receipts WHERE workbook_id=$1 AND user_id=$2 AND mutation_id=$3`, workbookID, g.UserID, mutationID).Scan(&hash, &raw)
		if errors.Is(e, pgx.ErrNoRows) {
			return checkEnd(ctx, g, expires)
		}
		if e != nil {
			return e
		}
		if len(hash) != 32 || json.Unmarshal(raw, &result) != nil || !receiptValid(result, mutationID) {
			return ErrConflict
		}
		found = true
		result.Replayed = true
		return checkEnd(ctx, g, expires)
	})
	if err != nil {
		return BatchResult{}, false, err
	}
	return cloneResult(result, found), found, nil
}

var _ Repository = (*Postgres)(nil)
