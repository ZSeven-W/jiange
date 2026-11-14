package sheetstore

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type repositoryFixture struct {
	repo          Repository
	owner, other  Guard
	workspace     int64
	grant         func(book, user int64, role string)
	revokeSession func(Guard)
}

func memoryFixture(t *testing.T) repositoryFixture {
	t.Helper()
	m := newMemory()
	expires := time.Now().Add(time.Hour)
	owner := Guard{UserID: 1, SessionHash: []byte("owner")}
	other := Guard{UserID: 2, SessionHash: []byte("other")}
	m.sessions[string(owner.SessionHash)] = memorySession{user: owner.UserID, expires: expires}
	m.sessions[string(other.SessionHash)] = memorySession{user: other.UserID, expires: expires}
	m.members[1] = map[int64]bool{owner.UserID: true}
	return repositoryFixture{repo: m, owner: owner, other: other, workspace: 1,
		grant: func(book, user int64, role string) {
			m.mu.Lock()
			defer m.mu.Unlock()
			if role == "" {
				delete(m.books[book].grants, user)
			} else {
				m.books[book].grants[user] = role
			}
		},
		revokeSession: func(g Guard) { m.mu.Lock(); defer m.mu.Unlock(); delete(m.sessions, string(g.SessionHash)) },
	}
}

func exerciseRepository(t *testing.T, fixture repositoryFixture) {
	t.Helper()
	ctx := context.Background()
	repo, owner, other, ws := fixture.repo, fixture.owner, fixture.other, fixture.workspace
	const createID = "00000000000000000000000000000001"
	created, err := repo.CreateWorkbook(ctx, owner, ws, "项目表", createID)
	if err != nil || created.Replayed || !validID(created.Workbook.ID) {
		t.Fatalf("create: %+v %v", created, err)
	}
	replayed, err := repo.CreateWorkbook(ctx, owner, ws, "项目表", createID)
	if err != nil || !replayed.Replayed || replayed.Workbook.ID != created.Workbook.ID {
		t.Fatalf("create replay: %+v %v", replayed, err)
	}
	if _, err = repo.CreateWorkbook(ctx, owner, ws, "不同标题", createID); !errors.Is(err, ErrConflict) {
		t.Fatalf("create mismatch: %v", err)
	}
	if _, err = repo.CreateWorkbook(ctx, other, ws, "无权限", "00000000000000000000000000000002"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("workspace access: %v", err)
	}
	if _, err = repo.ReadWorkbook(ctx, other, created.Workbook.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unshared read: %v", err)
	}
	snapshot, err := repo.ReadWorkbook(ctx, owner, created.Workbook.ID)
	if err != nil || len(snapshot.Sheets) != 1 || len(snapshot.Sheets[0].Rows) != initialRows || len(snapshot.Sheets[0].Columns) != initialColumns {
		t.Fatalf("initial: %+v %v", snapshot, err)
	}
	sheet := snapshot.Sheets[0]
	row1, row2, col1, col2 := sheet.Rows[0].ID, sheet.Rows[1].ID, sheet.Columns[0].ID, sheet.Columns[1].ID
	snapshot.Sheets[0].Rows[0].ID = 999999
	again, err := repo.ReadWorkbook(ctx, owner, created.Workbook.ID)
	if err != nil || again.Sheets[0].Rows[0].ID != row1 {
		t.Fatalf("snapshot alias: %+v %v", again, err)
	}
	batch := Batch{MutationID: "00000000000000000000000000000003", WorksheetID: sheet.ID, Cells: []CellWrite{{RowID: row2, ColumnID: col2, Raw: "第二项"}, {RowID: row1, ColumnID: col1, Raw: "第一项"}}}
	result, err := repo.WriteCells(ctx, owner, created.Workbook.ID, batch)
	if err != nil || result.Replayed || len(result.Cells) != 2 || result.Cells[0].RowID != row1 || result.Cells[0].Revision != 1 {
		t.Fatalf("write: %+v %v", result, err)
	}
	if batch.Cells[0].RowID != row2 {
		t.Fatal("validation modified caller batch")
	}
	batch.Cells[0], batch.Cells[1] = batch.Cells[1], batch.Cells[0]
	repeat, err := repo.WriteCells(ctx, owner, created.Workbook.ID, batch)
	if err != nil || !repeat.Replayed || repeat.Cells[0].Revision != 1 {
		t.Fatalf("replay: %+v %v", repeat, err)
	}
	batch.Cells[0].Raw = "不同内容"
	if _, err = repo.WriteCells(ctx, owner, created.Workbook.ID, batch); !errors.Is(err, ErrConflict) {
		t.Fatalf("mutation payload mismatch: %v", err)
	}
	receipt, found, err := repo.LookupWrite(ctx, owner, created.Workbook.ID, batch.MutationID)
	if err != nil || !found || !receipt.Replayed || receipt.Cells[0].Revision != 1 {
		t.Fatalf("receipt: %+v %v %v", receipt, found, err)
	}
	receipt.Cells[0].Revision = 999
	receipt, _, err = repo.LookupWrite(ctx, owner, created.Workbook.ID, batch.MutationID)
	if err != nil || receipt.Cells[0].Revision != 1 {
		t.Fatalf("receipt alias: %+v %v", receipt, err)
	}
	if _, found, err = repo.LookupWrite(ctx, owner, created.Workbook.ID, "00000000000000000000000000000004"); err != nil || found {
		t.Fatalf("unknown receipt: %v %v", found, err)
	}
	bad := Batch{MutationID: "00000000000000000000000000000005", WorksheetID: sheet.ID, Cells: []CellWrite{{RowID: row1, ColumnID: col1, ExpectedRevision: 1, Raw: "应回滚"}, {RowID: row2, ColumnID: col2, ExpectedRevision: 0, Raw: "冲突"}}}
	if _, err = repo.WriteCells(ctx, owner, created.Workbook.ID, bad); !errors.Is(err, ErrConflict) {
		t.Fatalf("atomic conflict: %v", err)
	}
	if _, found, err = repo.LookupWrite(ctx, owner, created.Workbook.ID, bad.MutationID); err != nil || found {
		t.Fatalf("failed write has receipt: %v %v", found, err)
	}
	after, err := repo.ReadWorkbook(ctx, owner, created.Workbook.ID)
	if err != nil || len(after.Sheets[0].Cells) != 2 || after.Sheets[0].Cells[0].Raw != "第一项" {
		t.Fatalf("atomic rollback: %+v %v", after, err)
	}
	clear := Batch{MutationID: "00000000000000000000000000000006", WorksheetID: sheet.ID, Cells: []CellWrite{{RowID: row1, ColumnID: col1, ExpectedRevision: 1, Raw: ""}}}
	if _, err = repo.WriteCells(ctx, owner, created.Workbook.ID, clear); err != nil {
		t.Fatal(err)
	}
	stale := Batch{MutationID: "00000000000000000000000000000007", WorksheetID: sheet.ID, Cells: []CellWrite{{RowID: row1, ColumnID: col1, Raw: "重建"}}}
	if _, err = repo.WriteCells(ctx, owner, created.Workbook.ID, stale); !errors.Is(err, ErrConflict) {
		t.Fatalf("tombstone: %v", err)
	}
	after, err = repo.ReadWorkbook(ctx, owner, created.Workbook.ID)
	if err != nil || after.Sheets[0].Cells[0].Raw != "" || after.Sheets[0].Cells[0].Revision != 2 {
		t.Fatalf("tombstone snapshot: %+v %v", after, err)
	}
	foreign := Batch{MutationID: "00000000000000000000000000000008", WorksheetID: sheet.ID, Cells: []CellWrite{{RowID: row1, ColumnID: maxSafeInteger, Raw: "x"}}}
	if _, err = repo.WriteCells(ctx, owner, created.Workbook.ID, foreign); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign axis: %v", err)
	}
	otherBook, err := repo.CreateWorkbook(ctx, owner, ws, "另一本", "00000000000000000000000000000009")
	if err != nil {
		t.Fatal(err)
	}
	otherSnapshot, err := repo.ReadWorkbook(ctx, owner, otherBook.Workbook.ID)
	if err != nil {
		t.Fatal(err)
	}
	foreign = Batch{MutationID: "0000000000000000000000000000000a", WorksheetID: sheet.ID, Cells: []CellWrite{{RowID: otherSnapshot.Sheets[0].Rows[0].ID, ColumnID: col1, Raw: "cross-workbook"}}}
	if _, err = repo.WriteCells(ctx, owner, created.Workbook.ID, foreign); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign workbook row: %v", err)
	}
	foreign.WorksheetID = otherSnapshot.Sheets[0].ID
	if _, err = repo.WriteCells(ctx, owner, created.Workbook.ID, foreign); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign worksheet: %v", err)
	}
	fixture.grant(created.Workbook.ID, other.UserID, "view")
	if _, err = repo.ReadWorkbook(ctx, other, created.Workbook.ID); err != nil {
		t.Fatalf("shared read: %v", err)
	}
	if _, err = repo.WriteCells(ctx, other, created.Workbook.ID, stale); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer write: %v", err)
	}
	fixture.grant(created.Workbook.ID, other.UserID, "")
	if _, err = repo.ReadWorkbook(ctx, other, created.Workbook.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked grant: %v", err)
	}
	fixture.grant(created.Workbook.ID, owner.UserID, "")
	if _, err = repo.CreateWorkbook(ctx, owner, ws, "项目表", createID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("create receipt after access revoked: %v", err)
	}
	if _, _, err = repo.LookupWrite(ctx, owner, created.Workbook.ID, batch.MutationID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("write receipt after access revoked: %v", err)
	}
	fixture.grant(created.Workbook.ID, owner.UserID, "manage")
	fixture.revokeSession(owner)
	if _, err = repo.ReadWorkbook(ctx, owner, created.Workbook.ID); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("revoked session: %v", err)
	}
	if _, _, err = repo.LookupWrite(ctx, owner, created.Workbook.ID, batch.MutationID); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("receipt after session revoked: %v", err)
	}
}

func exerciseConcurrentWrites(t *testing.T, fixture repositoryFixture) {
	t.Helper()
	ctx, repo, owner := context.Background(), fixture.repo, fixture.owner
	const createID = "10000000000000000000000000000000"
	const workers = 12
	type created struct {
		result CreateResult
		err    error
	}
	createdResults := make(chan created, workers)
	var start sync.WaitGroup
	start.Add(1)
	for range workers {
		go func() {
			start.Wait()
			result, err := repo.CreateWorkbook(ctx, owner, fixture.workspace, "并发", createID)
			createdResults <- created{result, err}
		}()
	}
	start.Done()
	var id int64
	fresh := 0
	for range workers {
		r := <-createdResults
		if r.err != nil {
			t.Fatal(r.err)
		}
		if id == 0 {
			id = r.result.Workbook.ID
		}
		if id != r.result.Workbook.ID {
			t.Fatal("duplicate workbook created")
		}
		if !r.result.Replayed {
			fresh++
		}
	}
	if fresh != 1 {
		t.Fatalf("create fresh count: %d", fresh)
	}
	snap, err := repo.ReadWorkbook(ctx, owner, id)
	if err != nil {
		t.Fatal(err)
	}
	s := snap.Sheets[0]
	batch := Batch{MutationID: "10000000000000000000000000000001", WorksheetID: s.ID, Cells: []CellWrite{{RowID: s.Rows[0].ID, ColumnID: s.Columns[0].ID, Raw: "x"}}}
	type wrote struct {
		result BatchResult
		err    error
	}
	writes := make(chan wrote, workers)
	start.Add(1)
	for range workers {
		go func() { start.Wait(); result, e := repo.WriteCells(ctx, owner, id, batch); writes <- wrote{result, e} }()
	}
	start.Done()
	fresh = 0
	for range workers {
		r := <-writes
		if r.err != nil {
			t.Fatal(r.err)
		}
		if !r.result.Replayed {
			fresh++
		}
		if r.result.Cells[0].Revision != 1 {
			t.Fatalf("revision: %+v", r.result)
		}
	}
	if fresh != 1 {
		t.Fatalf("write fresh count: %d", fresh)
	}
	start.Add(1)
	for i := range workers {
		go func(i int) {
			start.Wait()
			candidate := batch
			candidate.MutationID = fmt.Sprintf("%032x", 100+i)
			candidate.Cells = []CellWrite{{RowID: s.Rows[1].ID, ColumnID: s.Columns[1].ID, Raw: fmt.Sprint(i)}}
			result, e := repo.WriteCells(ctx, owner, id, candidate)
			writes <- wrote{result, e}
		}(i)
	}
	start.Done()
	fresh, conflicts := 0, 0
	for range workers {
		r := <-writes
		if r.err == nil {
			fresh++
		} else if errors.Is(r.err, ErrConflict) {
			conflicts++
		} else {
			t.Fatal(r.err)
		}
	}
	if fresh != 1 || conflicts != workers-1 {
		t.Fatalf("compare-and-set: %d %d", fresh, conflicts)
	}
}

func TestMemoryRepository(t *testing.T)       { exerciseRepository(t, memoryFixture(t)) }
func TestMemoryConcurrentWrites(t *testing.T) { exerciseConcurrentWrites(t, memoryFixture(t)) }

func exerciseExpiryRollback(t *testing.T, fixture repositoryFixture) {
	t.Helper()
	ctx, repo, owner := context.Background(), fixture.repo, fixture.owner
	const createID = "30000000000000000000000000000000"
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := repo.CreateWorkbook(cancelled, owner, fixture.workspace, "取消", "30000000000000000000000000000002"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled create: %v", err)
	}
	var calls atomic.Int32
	unstable := owner
	unstable.Now = func() time.Time {
		if calls.Add(1) == 1 {
			return time.Now()
		}
		return time.Now().Add(2 * time.Hour)
	}
	if _, err := repo.CreateWorkbook(ctx, unstable, fixture.workspace, "到期", createID); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expired create: %v", err)
	}
	created, err := repo.CreateWorkbook(ctx, owner, fixture.workspace, "到期", createID)
	if err != nil || created.Replayed {
		t.Fatalf("create rolled back: %+v %v", created, err)
	}
	snapshot, err := repo.ReadWorkbook(ctx, owner, created.Workbook.ID)
	if err != nil {
		t.Fatal(err)
	}
	sheet := snapshot.Sheets[0]
	batch := Batch{MutationID: "30000000000000000000000000000001", WorksheetID: sheet.ID, Cells: []CellWrite{{RowID: sheet.Rows[0].ID, ColumnID: sheet.Columns[0].ID, Raw: "到期写入"}}}
	calls.Store(0)
	if _, err = repo.WriteCells(ctx, unstable, created.Workbook.ID, batch); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expired write: %v", err)
	}
	if _, found, err := repo.LookupWrite(ctx, owner, created.Workbook.ID, batch.MutationID); err != nil || found {
		t.Fatalf("expired write receipt: %v %v", found, err)
	}
	after, err := repo.ReadWorkbook(ctx, owner, created.Workbook.ID)
	if err != nil || len(after.Sheets[0].Cells) != 0 {
		t.Fatalf("expired write persisted: %+v %v", after, err)
	}
}

func TestMemoryExpiryRollback(t *testing.T) { exerciseExpiryRollback(t, memoryFixture(t)) }

func TestMemorySnapshotSheetLimit(t *testing.T) {
	f := memoryFixture(t)
	ctx := context.Background()
	created, err := f.repo.CreateWorkbook(ctx, f.owner, f.workspace, "上限", "71000000000000000000000000000000")
	if err != nil {
		t.Fatal(err)
	}
	m := f.repo.(*memory)
	m.mu.Lock()
	for i := 0; i < maxSnapshotSheets; i++ {
		id := int64(10000 + i)
		m.books[created.Workbook.ID].sheets[id] = &memoryWorksheet{sheet: Worksheet{ID: id, WorkbookID: created.Workbook.ID, Position: i + 1}, rows: map[int64]bool{}, columns: map[int64]bool{}, cells: map[cellKey]Cell{}}
	}
	m.mu.Unlock()
	if _, err = f.repo.ReadWorkbook(ctx, f.owner, created.Workbook.ID); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize snapshot: %v", err)
	}
}

func TestBatchValidationBoundaries(t *testing.T) {
	base := Batch{MutationID: "20000000000000000000000000000000", WorksheetID: 1, Cells: []CellWrite{{RowID: 1, ColumnID: 1, Raw: "ok"}}}
	invalid := []Batch{
		{MutationID: "invalid", WorksheetID: 1, Cells: base.Cells},
		{MutationID: base.MutationID, WorksheetID: 0, Cells: base.Cells},
		{MutationID: base.MutationID, WorksheetID: 1, Cells: nil},
		{MutationID: base.MutationID, WorksheetID: 1, Cells: []CellWrite{{RowID: 1, ColumnID: 1, Raw: "a"}, {RowID: 1, ColumnID: 1, Raw: "b"}}},
		{MutationID: base.MutationID, WorksheetID: 1, Cells: []CellWrite{{RowID: 1, ColumnID: 1, ExpectedRevision: maxSafeInteger, Raw: "x"}}},
		{MutationID: base.MutationID, WorksheetID: 1, Cells: []CellWrite{{RowID: 1, ColumnID: 1, Raw: strings.Repeat("x", maxCellBytes+1)}}},
		{MutationID: base.MutationID, WorksheetID: 1, Cells: []CellWrite{{RowID: 1, ColumnID: 1, Raw: "bad\x00value"}}},
		{MutationID: base.MutationID, WorksheetID: 1, Cells: []CellWrite{{RowID: 1, ColumnID: 1, Raw: string([]byte{0xff})}}},
	}
	for _, b := range invalid {
		if _, _, err := validateBatch(b); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid batch accepted: %+v %v", b, err)
		}
	}
	large := base
	large.Cells = nil
	for i := 1; i <= 65; i++ {
		large.Cells = append(large.Cells, CellWrite{RowID: int64(i), ColumnID: 1, Raw: strings.Repeat("x", maxCellBytes)})
	}
	if _, _, err := validateBatch(large); !errors.Is(err, ErrInvalid) {
		t.Fatalf("oversized batch: %v", err)
	}
	formula := base
	formula.Cells = []CellWrite{{RowID: 1, ColumnID: 1, Raw: "=SUM(A1:A2)"}}
	if _, _, err := validateBatch(formula); !errors.Is(err, ErrFormula) {
		t.Fatalf("formula should not be silently treated as text: %v", err)
	}
}

func TestReceiptValidationRejectsCorruption(t *testing.T) {
	id := "50000000000000000000000000000000"
	valid := BatchResult{MutationID: id, Cells: []CellRevision{{RowID: 1, ColumnID: 1, Revision: 1}, {RowID: 2, ColumnID: 1, Revision: 2}}}
	if !receiptValid(valid, id) {
		t.Fatal("valid receipt rejected")
	}
	bad := []BatchResult{
		{MutationID: id, Replayed: true, Cells: valid.Cells},
		{MutationID: "wrong", Cells: valid.Cells},
		{MutationID: id, Cells: []CellRevision{{RowID: 1, ColumnID: 1, Revision: 0}}},
		{MutationID: id, Cells: []CellRevision{{RowID: 1, ColumnID: 1, Revision: 1}, {RowID: 1, ColumnID: 1, Revision: 1}}},
		{MutationID: id, Cells: []CellRevision{{RowID: 2, ColumnID: 1, Revision: 1}, {RowID: 1, ColumnID: 1, Revision: 1}}},
	}
	for _, item := range bad {
		if receiptValid(item, id) {
			t.Fatalf("accepted corrupt receipt: %+v", item)
		}
	}
}
