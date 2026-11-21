package pgstore

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/sdk/go/server"
	"github.com/ZSeven-W/jiange/sdk/go/storage"
)

type mockRow struct {
	id        string
	kind      string
	title     string
	version   int64
	data      []byte
	metadata  []byte
	createdAt time.Time
	updatedAt time.Time
}

// mockPG is an in-process PostgreSQL database/sql/driver double that validates
// PostgreSQL SQL syntax ($1..$N placeholders, expected table name) and executes
// real in-memory table storage with atomic CAS semantics and error injection.
type mockPG struct {
	mu           sync.Mutex
	table        string
	tableCreated bool
	indexCreated bool
	rows         map[string]*mockRow
	queries      []string

	onExec  func(query string, args []driver.NamedValue) (driver.Result, error, bool)
	onQuery func(query string, args []driver.NamedValue) (driver.Rows, error, bool)
}

func newMockPG(table string) (*mockPG, *sql.DB) {
	m := &mockPG{
		table: table,
		rows:  make(map[string]*mockRow),
	}
	db := sql.OpenDB(&mockConnector{pg: m})
	return m, db
}

type mockConnector struct {
	pg *mockPG
}

func (c *mockConnector) Connect(context.Context) (driver.Conn, error) {
	return &mockConn{pg: c.pg}, nil
}

func (c *mockConnector) Driver() driver.Driver { return mockDriver{} }

type mockDriver struct{}

func (mockDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("use sql.OpenDB")
}

type mockConn struct {
	pg *mockPG
}

func (c *mockConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("not implemented") }
func (c *mockConn) Close() error                        { return nil }
func (c *mockConn) Begin() (driver.Tx, error)           { return nil, errors.New("not implemented") }

func cloneBytes(b []byte) []byte {
	if b == nil {
		return nil
	}
	cp := make([]byte, len(b))
	copy(cp, b)
	return cp
}

func toBytes(v any) ([]byte, error) {
	if v == nil {
		return nil, nil
	}
	b, ok := v.([]byte)
	if !ok {
		return nil, fmt.Errorf("expected []byte or nil, got %T", v)
	}
	return cloneBytes(b), nil
}

func (c *mockConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if strings.Contains(query, "?") {
		return nil, fmt.Errorf("non-postgres placeholder '?' found in query: %s", query)
	}

	c.pg.mu.Lock()
	defer c.pg.mu.Unlock()
	c.pg.queries = append(c.pg.queries, query)

	if c.pg.onExec != nil {
		if res, err, handled := c.pg.onExec(query, args); handled {
			return res, err
		}
	}

	t := c.pg.table
	switch {
	case strings.HasPrefix(query, "CREATE TABLE IF NOT EXISTS "+t+" ("):
		for _, col := range []string{"id TEXT PRIMARY KEY", "kind TEXT", "title TEXT", "version BIGINT", "data BYTEA", "metadata JSONB", "created_at TIMESTAMPTZ", "updated_at TIMESTAMPTZ"} {
			if !strings.Contains(query, col) {
				return nil, fmt.Errorf("missing expected column definition %q in DDL", col)
			}
		}
		c.pg.tableCreated = true
		return driver.RowsAffected(0), nil

	case query == fmt.Sprintf("CREATE INDEX IF NOT EXISTS idx_%s_kind_id ON %s (kind, id)", t, t):
		if !c.pg.tableCreated {
			return nil, errors.New("table does not exist")
		}
		c.pg.indexCreated = true
		return driver.RowsAffected(0), nil

	case query == fmt.Sprintf("INSERT INTO %s (id, kind, title, version, data, metadata, created_at, updated_at) VALUES ($1, $2, $3, 1, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING", t):
		if len(args) != 7 {
			return nil, fmt.Errorf("insert expects 7 args, got %d", len(args))
		}
		id := args[0].Value.(string)
		if _, exists := c.pg.rows[id]; exists {
			return driver.RowsAffected(0), nil
		}
		data, err := toBytes(args[3].Value)
		if err != nil {
			return nil, err
		}
		metaStr := args[4].Value.(string)
		if !json.Valid([]byte(metaStr)) {
			return nil, fmt.Errorf("invalid jsonb input: %q", metaStr)
		}
		c.pg.rows[id] = &mockRow{
			id:        id,
			kind:      args[1].Value.(string),
			title:     args[2].Value.(string),
			version:   1,
			data:      data,
			metadata:  []byte(metaStr),
			createdAt: args[5].Value.(time.Time),
			updatedAt: args[6].Value.(time.Time),
		}
		return driver.RowsAffected(1), nil

	case query == fmt.Sprintf("DELETE FROM %s WHERE id = $1", t):
		if len(args) != 1 {
			return nil, fmt.Errorf("delete expects 1 arg, got %d", len(args))
		}
		id := args[0].Value.(string)
		if _, exists := c.pg.rows[id]; !exists {
			return driver.RowsAffected(0), nil
		}
		delete(c.pg.rows, id)
		return driver.RowsAffected(1), nil

	default:
		return nil, fmt.Errorf("unexpected exec SQL: %s", query)
	}
}

func (c *mockConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if strings.Contains(query, "?") {
		return nil, fmt.Errorf("non-postgres placeholder '?' found in query: %s", query)
	}

	c.pg.mu.Lock()
	defer c.pg.mu.Unlock()
	c.pg.queries = append(c.pg.queries, query)

	if c.pg.onQuery != nil {
		if rows, err, handled := c.pg.onQuery(query, args); handled {
			return rows, err
		}
	}

	t := c.pg.table
	recordCols := []string{"id", "kind", "title", "version", "data", "metadata", "created_at", "updated_at"}
	rowToValues := func(r *mockRow) []driver.Value {
		return []driver.Value{
			r.id,
			r.kind,
			r.title,
			r.version,
			cloneBytes(r.data),
			cloneBytes(r.metadata),
			r.createdAt,
			r.updatedAt,
		}
	}

	switch {
	case query == fmt.Sprintf("SELECT id, kind, title, version, data, metadata, created_at, updated_at FROM %s WHERE id = $1", t):
		if len(args) != 1 {
			return nil, fmt.Errorf("get expects 1 arg, got %d", len(args))
		}
		id := args[0].Value.(string)
		r, ok := c.pg.rows[id]
		if !ok {
			return &mockRows{cols: recordCols}, nil
		}
		return &mockRows{cols: recordCols, data: [][]driver.Value{rowToValues(r)}}, nil

	case query == fmt.Sprintf("UPDATE %s SET kind = $1, title = $2, version = version + 1, data = $3, metadata = $4, updated_at = $5 WHERE id = $6 AND version = $7 RETURNING version, created_at", t):
		if len(args) != 7 {
			return nil, fmt.Errorf("update expects 7 args, got %d", len(args))
		}
		id := args[5].Value.(string)
		expectedVer := args[6].Value.(int64)
		r, ok := c.pg.rows[id]
		if !ok || r.version != expectedVer {
			return &mockRows{cols: []string{"version", "created_at"}}, nil
		}
		data, err := toBytes(args[2].Value)
		if err != nil {
			return nil, err
		}
		metaStr := args[3].Value.(string)
		if !json.Valid([]byte(metaStr)) {
			return nil, fmt.Errorf("invalid jsonb input: %q", metaStr)
		}
		r.kind = args[0].Value.(string)
		r.title = args[1].Value.(string)
		r.version++
		r.data = data
		r.metadata = []byte(metaStr)
		r.updatedAt = args[4].Value.(time.Time)
		return &mockRows{
			cols: []string{"version", "created_at"},
			data: [][]driver.Value{{r.version, r.createdAt}},
		}, nil

	case query == fmt.Sprintf("SELECT id, kind, title, version, data, metadata, created_at, updated_at FROM %s ORDER BY id ASC", t):
		if len(args) != 0 {
			return nil, fmt.Errorf("list all expects 0 args, got %d", len(args))
		}
		return c.pg.listRowsLocked("", recordCols, rowToValues), nil

	case query == fmt.Sprintf("SELECT id, kind, title, version, data, metadata, created_at, updated_at FROM %s WHERE kind = $1 ORDER BY id ASC", t):
		if len(args) != 1 {
			return nil, fmt.Errorf("list by kind expects 1 arg, got %d", len(args))
		}
		return c.pg.listRowsLocked(args[0].Value.(string), recordCols, rowToValues), nil

	default:
		return nil, fmt.Errorf("unexpected query SQL: %s", query)
	}
}

func (m *mockPG) listRowsLocked(kind string, cols []string, convert func(*mockRow) []driver.Value) *mockRows {
	matched := make([]*mockRow, 0, len(m.rows))
	for _, r := range m.rows {
		if kind != "" && r.kind != kind {
			continue
		}
		matched = append(matched, r)
	}
	sort.Slice(matched, func(i, j int) bool { return matched[i].id < matched[j].id })
	out := make([][]driver.Value, 0, len(matched))
	for _, r := range matched {
		out = append(out, convert(r))
	}
	return &mockRows{cols: cols, data: out}
}

type mockRows struct {
	cols     []string
	data     [][]driver.Value
	idx      int
	errAfter int
	nextErr  error
}

func (r *mockRows) Columns() []string { return r.cols }
func (r *mockRows) Close() error      { return nil }
func (r *mockRows) Next(dest []driver.Value) error {
	if r.nextErr != nil && r.idx >= r.errAfter {
		return r.nextErr
	}
	if r.idx >= len(r.data) {
		return io.EOF
	}
	copy(dest, r.data[r.idx])
	r.idx++
	return nil
}

type errRowsAffectedResult struct {
	err error
}

func (r errRowsAffectedResult) LastInsertId() (int64, error) { return 0, r.err }
func (r errRowsAffectedResult) RowsAffected() (int64, error) { return 0, r.err }

func TestNewAndOptions(t *testing.T) {
	if _, err := New(nil); !errors.Is(err, ErrNilDB) {
		t.Fatalf("expected ErrNilDB, got %v", err)
	}

	_, db := newMockPG(DefaultTableName)
	defer db.Close()

	store, err := New(db, nil)
	if err != nil {
		t.Fatalf("New with default options failed: %v", err)
	}
	if store.TableName() != DefaultTableName {
		t.Fatalf("expected default table %q, got %q", DefaultTableName, store.TableName())
	}

	custom, err := New(db, WithTableName("custom_docs_v2"))
	if err != nil {
		t.Fatalf("New with valid custom table failed: %v", err)
	}
	if custom.TableName() != "custom_docs_v2" {
		t.Fatalf("expected custom table name, got %q", custom.TableName())
	}

	badTables := []string{
		"",
		"1starts_with_digit",
		"UpperCase",
		"kebab-case",
		"public.records",
		"records; DROP TABLE users;--",
		"table name",
		`"quoted"`,
	}
	for _, bad := range badTables {
		if _, err := New(db, WithTableName(bad)); !errors.Is(err, ErrInvalidTableName) {
			t.Fatalf("expected ErrInvalidTableName for %q, got %v", bad, err)
		}
	}
}

func TestEnsureSchemaAndCRUD(t *testing.T) {
	ctx := context.Background()
	pg, db := newMockPG("custom_records")
	defer db.Close()

	store, err := New(db, WithTableName("custom_records"))
	if err != nil {
		t.Fatalf("New failed: %v", err)
	}
	if err := store.EnsureSchema(ctx); err != nil {
		t.Fatalf("EnsureSchema failed: %v", err)
	}
	if !pg.tableCreated || !pg.indexCreated {
		t.Fatalf("expected table and index created: table=%v index=%v", pg.tableCreated, pg.indexCreated)
	}
	// Idempotent second call.
	if err := store.EnsureSchema(ctx); err != nil {
		t.Fatalf("second EnsureSchema failed: %v", err)
	}

	// Empty List returns non-nil empty slice.
	empty, err := store.List(ctx, "")
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("expected empty non-nil slice, got %#v err=%v", empty, err)
	}

	// Validation & not-found errors match storage.MemoryStore / FileStore.
	if _, err := store.Get(ctx, ""); !errors.Is(err, storage.ErrInvalidID) {
		t.Fatalf("expected ErrInvalidID on Get, got %v", err)
	}
	if _, err := store.Get(ctx, "missing"); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("expected ErrNotFound on Get, got %v", err)
	}
	if err := store.Put(ctx, nil); !errors.Is(err, storage.ErrInvalidID) {
		t.Fatalf("expected ErrInvalidID on nil Put, got %v", err)
	}
	if err := store.Put(ctx, &storage.DocumentRecord{ID: "../escape"}); !errors.Is(err, storage.ErrInvalidID) {
		t.Fatalf("expected ErrInvalidID on unsafe ID, got %v", err)
	}
	if err := store.Put(ctx, &storage.DocumentRecord{ID: "neg", Version: -1}); !errors.Is(err, storage.ErrVersionConflict) {
		t.Fatalf("expected ErrVersionConflict on negative version, got %v", err)
	}
	if err := store.Put(ctx, &storage.DocumentRecord{ID: "missing", Version: 2}); !errors.Is(err, storage.ErrVersionConflict) {
		t.Fatalf("expected ErrVersionConflict for missing doc with version>0, got %v", err)
	}

	// Create record with data & metadata; verify caller mutation isolation.
	rec := &storage.DocumentRecord{
		ID:       "doc-b",
		Kind:     "sheet",
		Title:    "Budget",
		Data:     []byte("v1"),
		Metadata: map[string]string{"owner": "alice"},
	}
	if err := store.Put(ctx, rec); err != nil {
		t.Fatalf("Put create failed: %v", err)
	}
	if rec.Version != 1 || rec.CreatedAt.IsZero() || rec.UpdatedAt.IsZero() {
		t.Fatalf("unexpected record timestamps/version after create: %+v", rec)
	}
	if rec.CreatedAt.Location() != time.UTC || rec.UpdatedAt.Location() != time.UTC {
		t.Fatalf("expected UTC timestamps, got %v %v", rec.CreatedAt.Location(), rec.UpdatedAt.Location())
	}

	rec.Data[0] = 'X'
	rec.Metadata["owner"] = "mallory"

	got, err := store.Get(ctx, "doc-b")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if string(got.Data) != "v1" || got.Metadata["owner"] != "alice" || got.Version != 1 || got.Title != "Budget" {
		t.Fatalf("unexpected loaded record: %+v", got)
	}
	// Mutating returned Data must not affect stored row.
	got.Data[0] = 'Y'
	gotAgain, err := store.Get(ctx, "doc-b")
	if err != nil || string(gotAgain.Data) != "v1" {
		t.Fatalf("byte copy isolation failed: %+v err=%v", gotAgain, err)
	}

	// Duplicate insert with Version == 0 returns ErrVersionConflict without mutating caller record.
	dup := &storage.DocumentRecord{ID: "doc-b", Kind: "sheet", Version: 0, Data: []byte("dup")}
	if err := store.Put(ctx, dup); !errors.Is(err, storage.ErrVersionConflict) {
		t.Fatalf("expected ErrVersionConflict on duplicate insert, got %v", err)
	}
	if dup.Version != 0 {
		t.Fatalf("expected failed Put not to mutate Version, got %d", dup.Version)
	}

	// Valid CAS update increments version and preserves CreatedAt.
	origCreated := gotAgain.CreatedAt
	gotAgain.Title = "Budget Q2"
	gotAgain.Data = []byte("v2")
	gotAgain.Metadata = map[string]string{"owner": "alice", "stage": "final"}
	if err := store.Put(ctx, gotAgain); err != nil {
		t.Fatalf("CAS update failed: %v", err)
	}
	if gotAgain.Version != 2 || !gotAgain.CreatedAt.Equal(origCreated) {
		t.Fatalf("unexpected version/createdAt after update: ver=%d created=%v orig=%v", gotAgain.Version, gotAgain.CreatedAt, origCreated)
	}

	// Stale version update returns ErrVersionConflict.
	stale := &storage.DocumentRecord{ID: "doc-b", Kind: "sheet", Version: 1, Data: []byte("stale")}
	if err := store.Put(ctx, stale); !errors.Is(err, storage.ErrVersionConflict) {
		t.Fatalf("expected ErrVersionConflict on stale version, got %v", err)
	}

	// Create second record with preset non-UTC CreatedAt, nil Data, and nil Metadata.
	tzPlus8 := time.FixedZone("UTC+8", 8*3600)
	presetCreated := time.Date(2026, 5, 1, 12, 0, 0, 0, tzPlus8)
	recA := &storage.DocumentRecord{
		ID:        "doc-a",
		Kind:      "doc",
		Title:     "Spec",
		CreatedAt: presetCreated,
	}
	if err := store.Put(ctx, recA); err != nil {
		t.Fatalf("Put doc-a failed: %v", err)
	}
	if !recA.CreatedAt.Equal(presetCreated) || recA.CreatedAt.Location() != time.UTC {
		t.Fatalf("expected preset CreatedAt normalized to UTC, got %v", recA.CreatedAt)
	}
	loadedA, err := store.Get(ctx, "doc-a")
	if err != nil {
		t.Fatalf("Get doc-a failed: %v", err)
	}
	if loadedA.Data != nil || loadedA.Metadata != nil {
		t.Fatalf("expected nil Data and nil Metadata, got data=%v meta=%v", loadedA.Data, loadedA.Metadata)
	}

	// Non-nil empty Data slice round-trips as non-nil empty slice (distinct from SQL NULL).
	recEmpty := &storage.DocumentRecord{
		ID:    "doc-c",
		Kind:  "doc",
		Title: "Empty Payload",
		Data:  []byte{},
	}
	if err := store.Put(ctx, recEmpty); err != nil {
		t.Fatalf("Put doc-c failed: %v", err)
	}
	loadedEmpty, err := store.Get(ctx, "doc-c")
	if err != nil || loadedEmpty.Data == nil || len(loadedEmpty.Data) != 0 {
		t.Fatalf("expected non-nil empty Data, got %#v err=%v", loadedEmpty, err)
	}
	if err := store.Delete(ctx, "doc-c"); err != nil {
		t.Fatalf("Delete doc-c failed: %v", err)
	}

	// List all and List filtered by kind, ordered by id ASC.
	all, err := store.List(ctx, "")
	if err != nil || len(all) != 2 || all[0].ID != "doc-a" || all[1].ID != "doc-b" {
		t.Fatalf("unexpected List all: %+v err=%v", all, err)
	}
	sheets, err := store.List(ctx, "sheet")
	if err != nil || len(sheets) != 1 || sheets[0].ID != "doc-b" || sheets[0].Title != "Budget Q2" {
		t.Fatalf("unexpected List sheet: %+v err=%v", sheets, err)
	}

	// Delete error & success paths.
	if err := store.Delete(ctx, ""); !errors.Is(err, storage.ErrInvalidID) {
		t.Fatalf("expected ErrInvalidID on Delete, got %v", err)
	}
	if err := store.Delete(ctx, "missing"); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("expected ErrNotFound on Delete, got %v", err)
	}
	if err := store.Delete(ctx, "doc-a"); err != nil {
		t.Fatalf("Delete doc-a failed: %v", err)
	}
	if _, err := store.Get(ctx, "doc-a"); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("expected ErrNotFound after Delete, got %v", err)
	}
}

func TestErrorPaths(t *testing.T) {
	ctx := context.Background()
	boom := errors.New("boom")

	// 1. EnsureSchema fails on CREATE TABLE and on CREATE INDEX.
	pg, db := newMockPG(DefaultTableName)
	defer db.Close()
	store, err := New(db)
	if err != nil {
		t.Fatal(err)
	}

	pg.onExec = func(query string, _ []driver.NamedValue) (driver.Result, error, bool) {
		if strings.HasPrefix(query, "CREATE TABLE") {
			return nil, boom, true
		}
		return nil, nil, false
	}
	if err := store.EnsureSchema(ctx); !errors.Is(err, boom) {
		t.Fatalf("expected CREATE TABLE error, got %v", err)
	}

	pg.onExec = func(query string, _ []driver.NamedValue) (driver.Result, error, bool) {
		if strings.HasPrefix(query, "CREATE INDEX") {
			return nil, boom, true
		}
		return nil, nil, false
	}
	if err := store.EnsureSchema(ctx); !errors.Is(err, boom) {
		t.Fatalf("expected CREATE INDEX error, got %v", err)
	}
	pg.onExec = nil
	if err := store.EnsureSchema(ctx); err != nil {
		t.Fatalf("EnsureSchema recovery failed: %v", err)
	}

	// 2. Put insert ExecContext error and RowsAffected error.
	pg.onExec = func(query string, _ []driver.NamedValue) (driver.Result, error, bool) {
		if strings.HasPrefix(query, "INSERT INTO") {
			return nil, boom, true
		}
		return nil, nil, false
	}
	if err := store.Put(ctx, &storage.DocumentRecord{ID: "d1"}); !errors.Is(err, boom) {
		t.Fatalf("expected insert exec error, got %v", err)
	}

	pg.onExec = func(query string, _ []driver.NamedValue) (driver.Result, error, bool) {
		if strings.HasPrefix(query, "INSERT INTO") {
			return errRowsAffectedResult{err: boom}, nil, true
		}
		return nil, nil, false
	}
	if err := store.Put(ctx, &storage.DocumentRecord{ID: "d1"}); !errors.Is(err, boom) {
		t.Fatalf("expected insert RowsAffected error, got %v", err)
	}
	pg.onExec = nil

	// Seed a real row for update/get/list/delete error injection.
	if err := store.Put(ctx, &storage.DocumentRecord{ID: "d1", Kind: "doc", Title: "T", Data: []byte("ok")}); err != nil {
		t.Fatal(err)
	}

	// 3. Put update non-ErrNoRows query error.
	pg.onQuery = func(query string, _ []driver.NamedValue) (driver.Rows, error, bool) {
		if strings.HasPrefix(query, "UPDATE ") {
			return nil, boom, true
		}
		return nil, nil, false
	}
	if err := store.Put(ctx, &storage.DocumentRecord{ID: "d1", Version: 1}); !errors.Is(err, boom) {
		t.Fatalf("expected update query error, got %v", err)
	}

	// 4. Get non-ErrNoRows query error.
	pg.onQuery = func(query string, _ []driver.NamedValue) (driver.Rows, error, bool) {
		if strings.Contains(query, "WHERE id = $1") {
			return nil, boom, true
		}
		return nil, nil, false
	}
	if _, err := store.Get(ctx, "d1"); !errors.Is(err, boom) {
		t.Fatalf("expected Get query error, got %v", err)
	}

	// 5. Get scan error (corrupt column type) & corrupt JSON metadata error.
	pg.onQuery = func(query string, _ []driver.NamedValue) (driver.Rows, error, bool) {
		if strings.Contains(query, "WHERE id = $1") {
			return &mockRows{
				cols: []string{"id", "kind", "title", "version", "data", "metadata", "created_at", "updated_at"},
				data: [][]driver.Value{{"d1", "doc", "T", "not-an-int64", nil, []byte("{}"), time.Now(), time.Now()}},
			}, nil, true
		}
		return nil, nil, false
	}
	if _, err := store.Get(ctx, "d1"); err == nil {
		t.Fatal("expected Get scan type error")
	}

	pg.onQuery = func(query string, _ []driver.NamedValue) (driver.Rows, error, bool) {
		if strings.Contains(query, "WHERE id = $1") {
			return &mockRows{
				cols: []string{"id", "kind", "title", "version", "data", "metadata", "created_at", "updated_at"},
				data: [][]driver.Value{{"d1", "doc", "T", int64(1), nil, []byte("{corrupt-json"), time.Now(), time.Now()}},
			}, nil, true
		}
		return nil, nil, false
	}
	if _, err := store.Get(ctx, "d1"); err == nil || !strings.Contains(err.Error(), "decode metadata") {
		t.Fatalf("expected metadata decode error, got %v", err)
	}

	// 6. List query error (all & kind), scan error inside rows loop, and rows.Err() iteration error.
	pg.onQuery = func(string, []driver.NamedValue) (driver.Rows, error, bool) {
		return nil, boom, true
	}
	if _, err := store.List(ctx, ""); !errors.Is(err, boom) {
		t.Fatalf("expected List all query error, got %v", err)
	}
	if _, err := store.List(ctx, "doc"); !errors.Is(err, boom) {
		t.Fatalf("expected List kind query error, got %v", err)
	}

	pg.onQuery = func(string, []driver.NamedValue) (driver.Rows, error, bool) {
		return &mockRows{
			cols: []string{"id", "kind", "title", "version", "data", "metadata", "created_at", "updated_at"},
			data: [][]driver.Value{{"d1", "doc", "T", int64(1), nil, []byte("{bad"), time.Now(), time.Now()}},
		}, nil, true
	}
	if _, err := store.List(ctx, ""); err == nil || !strings.Contains(err.Error(), "decode metadata") {
		t.Fatalf("expected List scan/decode error, got %v", err)
	}

	pg.onQuery = func(string, []driver.NamedValue) (driver.Rows, error, bool) {
		return &mockRows{
			cols:     []string{"id", "kind", "title", "version", "data", "metadata", "created_at", "updated_at"},
			data:     [][]driver.Value{{"d1", "doc", "T", int64(1), nil, []byte("{}"), time.Now(), time.Now()}},
			errAfter: 1,
			nextErr:  boom,
		}, nil, true
	}
	if _, err := store.List(ctx, ""); !errors.Is(err, boom) {
		t.Fatalf("expected List rows.Err() error, got %v", err)
	}
	pg.onQuery = nil

	// 7. Delete ExecContext error and RowsAffected error.
	pg.onExec = func(query string, _ []driver.NamedValue) (driver.Result, error, bool) {
		if strings.HasPrefix(query, "DELETE FROM") {
			return nil, boom, true
		}
		return nil, nil, false
	}
	if err := store.Delete(ctx, "d1"); !errors.Is(err, boom) {
		t.Fatalf("expected Delete exec error, got %v", err)
	}

	pg.onExec = func(query string, _ []driver.NamedValue) (driver.Result, error, bool) {
		if strings.HasPrefix(query, "DELETE FROM") {
			return errRowsAffectedResult{err: boom}, nil, true
		}
		return nil, nil, false
	}
	if err := store.Delete(ctx, "d1"); !errors.Is(err, boom) {
		t.Fatalf("expected Delete RowsAffected error, got %v", err)
	}
	pg.onExec = nil

	// 8. Context cancellation propagates across operations.
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := store.Get(canceled, "d1"); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled on Get, got %v", err)
	}
	if err := store.Put(canceled, &storage.DocumentRecord{ID: "d2"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled on Put, got %v", err)
	}
	if _, err := store.List(canceled, ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled on List, got %v", err)
	}
	if err := store.Delete(canceled, "d1"); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled on Delete, got %v", err)
	}
}

func TestConcurrencyAndCASContention(t *testing.T) {
	ctx := context.Background()
	_, db := newMockPG(DefaultTableName)
	defer db.Close()

	store, err := New(db)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}

	const workers = 16

	// 1. Race to create the same document ID: exactly 1 succeeds, rest get ErrVersionConflict.
	var createdCount, conflictCount atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start
			err := store.Put(ctx, &storage.DocumentRecord{
				ID:    "shared-doc",
				Kind:  "sheet",
				Title: fmt.Sprintf("w-%d", idx),
				Data:  []byte{byte(idx)},
			})
			switch {
			case err == nil:
				createdCount.Add(1)
			case errors.Is(err, storage.ErrVersionConflict):
				conflictCount.Add(1)
			default:
				t.Errorf("unexpected create error: %v", err)
			}
		}(i)
	}
	close(start)
	wg.Wait()
	if createdCount.Load() != 1 || conflictCount.Load() != workers-1 {
		t.Fatalf("expected 1 create & %d conflicts, got creates=%d conflicts=%d", workers-1, createdCount.Load(), conflictCount.Load())
	}

	// 2. Race to update from version 1 -> version 2: exactly 1 wins.
	var updateWins, updateConflicts atomic.Int32
	start2 := make(chan struct{})
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start2
			err := store.Put(ctx, &storage.DocumentRecord{
				ID:      "shared-doc",
				Kind:    "sheet",
				Title:   fmt.Sprintf("u-%d", idx),
				Version: 1,
				Data:    []byte{byte(idx)},
			})
			switch {
			case err == nil:
				updateWins.Add(1)
			case errors.Is(err, storage.ErrVersionConflict):
				updateConflicts.Add(1)
			default:
				t.Errorf("unexpected update error: %v", err)
			}
		}(i)
	}
	close(start2)
	wg.Wait()
	if updateWins.Load() != 1 || updateConflicts.Load() != workers-1 {
		t.Fatalf("expected 1 update win & %d conflicts, got wins=%d conflicts=%d", workers-1, updateWins.Load(), updateConflicts.Load())
	}

	// 3. Parallel mixed Put/Get/List/Delete across distinct documents under -race.
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			id := fmt.Sprintf("parallel-%02d", idx)
			if err := store.Put(ctx, &storage.DocumentRecord{ID: id, Kind: "doc", Data: []byte("payload")}); err != nil {
				t.Errorf("parallel put %s failed: %v", id, err)
				return
			}
			if _, err := store.Get(ctx, id); err != nil {
				t.Errorf("parallel get %s failed: %v", id, err)
			}
			if _, err := store.List(ctx, "doc"); err != nil {
				t.Errorf("parallel list failed: %v", err)
			}
			if err := store.Delete(ctx, id); err != nil {
				t.Errorf("parallel delete %s failed: %v", id, err)
			}
		}(i)
	}
	wg.Wait()
}

func TestEndToEndServerMount(t *testing.T) {
	ctx := context.Background()
	_, db := newMockPG(DefaultTableName)
	defer db.Close()

	pgStore, err := New(db)
	if err != nil {
		t.Fatalf("New failed: %v", err)
	}
	if err := pgStore.EnsureSchema(ctx); err != nil {
		t.Fatalf("EnsureSchema failed: %v", err)
	}

	srv := server.New(server.Config{Store: pgStore})

	do := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, r)
		return rec
	}

	// Create documents across all five Jiange domains backed by pgStore.
	if rec := do(http.MethodPost, "/sheets", `{"id":"pg-s1","title":"Q1 Budget"}`); rec.Code != http.StatusCreated {
		t.Fatalf("POST /sheets failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(http.MethodPost, "/docs", `{"id":"pg-d1","title":"Design Spec"}`); rec.Code != http.StatusCreated {
		t.Fatalf("POST /docs failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(http.MethodPost, "/slides", `{"id":"pg-p1","title":"Pitch Deck"}`); rec.Code != http.StatusCreated {
		t.Fatalf("POST /slides failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(http.MethodPost, "/boards", `{"id":"pg-b1","title":"Architecture"}`); rec.Code != http.StatusCreated {
		t.Fatalf("POST /boards failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(http.MethodPost, "/bases", `{"id":"pg-bs1","title":"CRM"}`); rec.Code != http.StatusCreated {
		t.Fatalf("POST /bases failed: %d %s", rec.Code, rec.Body.String())
	}

	// Apply a sheet mutation -> triggers CAS UPDATE version 1 -> 2 in PostgreSQL.
	if rec := do(http.MethodPost, "/sheets/pg-s1/apply", `{"ops":[{"op":"setCell","sheet":"Sheet1","a1":"A1","raw":"100"},{"op":"setCell","sheet":"Sheet1","a1":"A2","raw":"=A1*2"}]}`); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"version":2`) {
		t.Fatalf("POST /sheets/pg-s1/apply failed: %d %s", rec.Code, rec.Body.String())
	}

	// Inspect through GET /sheets/{id} and via AI/MCP tool endpoint.
	if rec := do(http.MethodGet, "/sheets/pg-s1", ""); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"version":2`) {
		t.Fatalf("GET /sheets/pg-s1 failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(http.MethodPost, "/ai/tools/sheet_inspect", `{"id":"pg-s1"}`); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("POST /ai/tools/sheet_inspect failed: %d %s", rec.Code, rec.Body.String())
	}

	// Verify records directly via pgStore.List.
	all, err := pgStore.List(ctx, "")
	if err != nil || len(all) != 5 {
		t.Fatalf("expected 5 records persisted in pgStore, got %d err=%v", len(all), err)
	}
	sheets, err := pgStore.List(ctx, "sheet")
	if err != nil || len(sheets) != 1 || sheets[0].ID != "pg-s1" || sheets[0].Version != 2 {
		t.Fatalf("unexpected sheet record in pgStore: %+v err=%v", sheets, err)
	}

	// Delete through REST API and confirm 404 afterward.
	if rec := do(http.MethodDelete, "/sheets/pg-s1", ""); rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE /sheets/pg-s1 failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(http.MethodGet, "/sheets/pg-s1", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 after delete, got %d", rec.Code)
	}
}
