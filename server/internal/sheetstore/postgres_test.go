package sheetstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func postgresFixture(t *testing.T) (repositoryFixture, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("sheet_proto_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
		admin.Close()
	})
	if _, err = migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	// Replace the app's production sheet_* tables inside this throwaway test
	// schema with the standalone sheetstore prototype schema.
	if _, err = pool.Exec(ctx, `DROP TABLE IF EXISTS sheet_create_receipts, sheet_write_receipts, sheet_cells, sheet_columns, sheet_rows, sheet_worksheets, sheet_grants, sheet_workbooks CASCADE`); err != nil {
		t.Fatal(err)
	}
	schemaSQL, err := os.ReadFile("schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, string(schemaSQL)); err != nil {
		t.Fatal(err)
	}
	var ownerID, otherID, workspaceID int64
	if err = pool.QueryRow(ctx, `INSERT INTO users(email,name,password_hash) VALUES('sheet-owner@example.test','Owner','hash') RETURNING id`).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `INSERT INTO users(email,name,password_hash) VALUES('sheet-other@example.test','Other','hash') RETURNING id`).Scan(&otherID); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `INSERT INTO workspaces(name,owner_id) VALUES('Workspace',$1) RETURNING id`, ownerID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, workspaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	owner := Guard{UserID: ownerID, SessionHash: []byte("owner")}
	other := Guard{UserID: otherID, SessionHash: []byte("other")}
	if _, err = pool.Exec(ctx, `INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3),($4,$5,$3)`, owner.SessionHash, ownerID, time.Now().Add(time.Hour), other.SessionHash, otherID); err != nil {
		t.Fatal(err)
	}
	return repositoryFixture{repo: &Postgres{Pool: pool}, owner: owner, other: other, workspace: workspaceID,
		grant: func(book, user int64, role string) {
			t.Helper()
			var e error
			if role == "" {
				_, e = pool.Exec(ctx, `DELETE FROM sheet_grants WHERE workbook_id=$1 AND user_id=$2`, book, user)
			} else {
				_, e = pool.Exec(ctx, `INSERT INTO sheet_grants(workbook_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(workbook_id,user_id) DO UPDATE SET role=EXCLUDED.role`, book, user, role)
			}
			if e != nil {
				t.Fatal(e)
			}
		},
		revokeSession: func(g Guard) {
			t.Helper()
			if _, e := pool.Exec(ctx, `DELETE FROM sessions WHERE token_hash=$1`, g.SessionHash); e != nil {
				t.Fatal(e)
			}
		},
	}, pool
}

func TestPostgresRepository(t *testing.T) { f, _ := postgresFixture(t); exerciseRepository(t, f) }
func TestPostgresConcurrentWrites(t *testing.T) {
	f, _ := postgresFixture(t)
	exerciseConcurrentWrites(t, f)
}
func TestPostgresExpiryRollback(t *testing.T) {
	f, _ := postgresFixture(t)
	exerciseExpiryRollback(t, f)
}

func TestPostgresReceiptFailuresRollback(t *testing.T) {
	f, pool := postgresFixture(t)
	ctx := context.Background()
	const createID = "40000000000000000000000000000000"
	if _, err := pool.Exec(ctx, `CREATE FUNCTION reject_sheet_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$; CREATE TRIGGER reject_create_receipt BEFORE INSERT ON sheet_create_receipts FOR EACH ROW EXECUTE FUNCTION reject_sheet_receipt()`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.repo.CreateWorkbook(ctx, f.owner, f.workspace, "回滚", createID); err == nil {
		t.Fatal("expected injected create failure")
	}
	var books, sheets int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM sheet_workbooks),(SELECT count(*) FROM sheet_worksheets)`).Scan(&books, &sheets); err != nil || books != 0 || sheets != 0 {
		t.Fatalf("partial workbook: %d %d %v", books, sheets, err)
	}
	if _, err := pool.Exec(ctx, `DROP TRIGGER reject_create_receipt ON sheet_create_receipts`); err != nil {
		t.Fatal(err)
	}
	created, err := f.repo.CreateWorkbook(ctx, f.owner, f.workspace, "回滚", createID)
	if err != nil || created.Replayed {
		t.Fatalf("retry after rollback: %+v %v", created, err)
	}
	snapshot, err := f.repo.ReadWorkbook(ctx, f.owner, created.Workbook.ID)
	if err != nil {
		t.Fatal(err)
	}
	sheet := snapshot.Sheets[0]
	batch := Batch{MutationID: "40000000000000000000000000000001", WorksheetID: sheet.ID, Cells: []CellWrite{{RowID: sheet.Rows[0].ID, ColumnID: sheet.Columns[0].ID, Raw: "x"}, {RowID: sheet.Rows[1].ID, ColumnID: sheet.Columns[1].ID, Raw: "y"}}}
	if _, err = pool.Exec(ctx, `CREATE TRIGGER reject_write_receipt BEFORE INSERT ON sheet_write_receipts FOR EACH ROW EXECUTE FUNCTION reject_sheet_receipt()`); err != nil {
		t.Fatal(err)
	}
	if _, err = f.repo.WriteCells(ctx, f.owner, created.Workbook.ID, batch); err == nil {
		t.Fatal("expected injected write failure")
	}
	if _, err = pool.Exec(ctx, `DROP TRIGGER reject_write_receipt ON sheet_write_receipts; DROP FUNCTION reject_sheet_receipt()`); err != nil {
		t.Fatal(err)
	}
	after, err := f.repo.ReadWorkbook(ctx, f.owner, created.Workbook.ID)
	if err != nil || len(after.Sheets[0].Cells) != 0 {
		t.Fatalf("partial cells: %+v %v", after, err)
	}
	if _, found, err := f.repo.LookupWrite(ctx, f.owner, created.Workbook.ID, batch.MutationID); err != nil || found {
		t.Fatalf("partial receipt: %v %v", found, err)
	}
	if result, err := f.repo.WriteCells(ctx, f.owner, created.Workbook.ID, batch); err != nil || result.Replayed || len(result.Cells) != 2 {
		t.Fatalf("retry: %+v %v", result, err)
	}
}

func TestPostgresAuthorizationRevocationBeforeWrite(t *testing.T) {
	for _, mode := range []string{"grant", "session"} {
		t.Run(mode, func(t *testing.T) {
			f, pool := postgresFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			created, err := f.repo.CreateWorkbook(ctx, f.owner, f.workspace, "授权", "60000000000000000000000000000000")
			if err != nil {
				t.Fatal(err)
			}
			f.grant(created.Workbook.ID, f.other.UserID, "edit")
			snapshot, err := f.repo.ReadWorkbook(ctx, f.owner, created.Workbook.ID)
			if err != nil {
				t.Fatal(err)
			}
			sheet := snapshot.Sheets[0]
			batch := Batch{MutationID: "60000000000000000000000000000001", WorksheetID: sheet.ID, Cells: []CellWrite{{RowID: sheet.Rows[0].ID, ColumnID: sheet.Columns[0].ID, Raw: "不应写入"}}}
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if mode == "grant" {
				_, err = tx.Exec(ctx, `UPDATE sheet_grants SET role='view' WHERE workbook_id=$1 AND user_id=$2`, created.Workbook.ID, f.other.UserID)
			} else {
				_, err = tx.Exec(ctx, `DELETE FROM sessions WHERE token_hash=$1`, f.other.SessionHash)
			}
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { _, e := f.repo.WriteCells(ctx, f.other, created.Workbook.ID, batch); done <- e }()
			select {
			case e := <-done:
				t.Fatalf("write passed a pending revocation: %v", e)
			case <-time.After(100 * time.Millisecond):
			}
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			result := <-done
			if mode == "grant" && !errors.Is(result, ErrForbidden) || mode == "session" && !errors.Is(result, ErrUnauthenticated) {
				t.Fatalf("revoked write: %v", result)
			}
			after, err := f.repo.ReadWorkbook(ctx, f.owner, created.Workbook.ID)
			if err != nil || len(after.Sheets[0].Cells) != 0 {
				t.Fatalf("revoked write changed cells: %+v %v", after, err)
			}
		})
	}
}

func TestPostgresSnapshotWaitsForCompleteWrite(t *testing.T) {
	f, pool := postgresFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	created, err := f.repo.CreateWorkbook(ctx, f.owner, f.workspace, "一致快照", "70000000000000000000000000000000")
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := f.repo.ReadWorkbook(ctx, f.owner, created.Workbook.ID)
	if err != nil {
		t.Fatal(err)
	}
	sheet := snapshot.Sheets[0]
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	var locked int64
	if err = tx.QueryRow(ctx, `SELECT id FROM sheet_workbooks WHERE id=$1 FOR UPDATE`, created.Workbook.ID).Scan(&locked); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO sheet_cells(sheet_id,row_id,column_id,raw,revision) VALUES($1,$2,$3,'first',1)`, sheet.ID, sheet.Rows[0].ID, sheet.Columns[0].ID); err != nil {
		t.Fatal(err)
	}
	type readResult struct {
		value Snapshot
		err   error
	}
	done := make(chan readResult, 1)
	go func() {
		value, e := f.repo.ReadWorkbook(ctx, f.owner, created.Workbook.ID)
		done <- readResult{value, e}
	}()
	select {
	case result := <-done:
		t.Fatalf("read observed in-flight write: %+v %v", result.value, result.err)
	case <-time.After(100 * time.Millisecond):
	}
	if _, err = tx.Exec(ctx, `INSERT INTO sheet_cells(sheet_id,row_id,column_id,raw,revision) VALUES($1,$2,$3,'second',1)`, sheet.ID, sheet.Rows[1].ID, sheet.Columns[1].ID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	result := <-done
	if result.err != nil || len(result.value.Sheets) != 1 || len(result.value.Sheets[0].Cells) != 2 {
		t.Fatalf("incomplete snapshot: %+v %v", result.value, result.err)
	}
}

func TestPostgresSnapshotSheetLimit(t *testing.T) {
	f, pool := postgresFixture(t)
	ctx := context.Background()
	created, err := f.repo.CreateWorkbook(ctx, f.owner, f.workspace, "上限", "71000000000000000000000000000000")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO sheet_worksheets(workbook_id,title,position) SELECT $1,'extra',n FROM generate_series(1,$2::int) n`, created.Workbook.ID, maxSnapshotSheets); err != nil {
		t.Fatal(err)
	}
	if _, err = f.repo.ReadWorkbook(ctx, f.owner, created.Workbook.ID); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize snapshot: %v", err)
	}
}

func TestPostgresCorruptReceiptFailsClosed(t *testing.T) {
	f, pool := postgresFixture(t)
	ctx := context.Background()
	created, err := f.repo.CreateWorkbook(ctx, f.owner, f.workspace, "回执", "72000000000000000000000000000000")
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := f.repo.ReadWorkbook(ctx, f.owner, created.Workbook.ID)
	if err != nil {
		t.Fatal(err)
	}
	sheet := snapshot.Sheets[0]
	batch := Batch{MutationID: "72000000000000000000000000000001", WorksheetID: sheet.ID, Cells: []CellWrite{{RowID: sheet.Rows[0].ID, ColumnID: sheet.Columns[0].ID, Raw: "x"}}}
	result, err := f.repo.WriteCells(ctx, f.owner, created.Workbook.ID, batch)
	if err != nil {
		t.Fatal(err)
	}
	result.Replayed = true
	corrupt, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE sheet_write_receipts SET result=$3::jsonb WHERE workbook_id=$1 AND mutation_id=$2`, created.Workbook.ID, batch.MutationID, corrupt); err != nil {
		t.Fatal(err)
	}
	if _, _, err = f.repo.LookupWrite(ctx, f.owner, created.Workbook.ID, batch.MutationID); !errors.Is(err, ErrConflict) {
		t.Fatalf("corrupt lookup: %v", err)
	}
	if _, err = f.repo.WriteCells(ctx, f.owner, created.Workbook.ID, batch); !errors.Is(err, ErrConflict) {
		t.Fatalf("corrupt retry: %v", err)
	}
	if _, err = pool.Exec(ctx, `UPDATE sheet_write_receipts SET result=jsonb_build_object('padding',repeat('x',131073)) WHERE workbook_id=$1 AND mutation_id=$2`, created.Workbook.ID, batch.MutationID); err != nil {
		t.Fatal(err)
	}
	if _, _, err = f.repo.LookupWrite(ctx, f.owner, created.Workbook.ID, batch.MutationID); !errors.Is(err, ErrConflict) {
		t.Fatalf("oversize receipt: %v", err)
	}
	after, err := f.repo.ReadWorkbook(ctx, f.owner, created.Workbook.ID)
	if err != nil || len(after.Sheets[0].Cells) != 1 || after.Sheets[0].Cells[0].Revision != 1 {
		t.Fatalf("corrupt retry changed data: %+v %v", after, err)
	}
}
