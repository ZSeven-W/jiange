// Package pgstore provides a zero-dependency PostgreSQL implementation of
// github.com/ZSeven-W/jiange/sdk/go/storage.Store built on Go's standard
// database/sql package with PostgreSQL ($1..$N) parameter placeholders.
//
// Callers supply their own *sql.DB opened with any PostgreSQL database/sql
// driver (such as github.com/jackc/pgx/v5/stdlib or github.com/lib/pq) and
// retain ownership of the connection pool lifecycle.
package pgstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/ZSeven-W/jiange/sdk/go/storage"
)

// DefaultTableName is the PostgreSQL table name used when WithTableName is not specified.
const DefaultTableName = "jiange_sdk_records"

var (
	// ErrNilDB is returned by New when a nil *sql.DB is supplied.
	ErrNilDB = errors.New("pgstore: nil database handle")
	// ErrInvalidTableName is returned by New when a table name fails validation.
	ErrInvalidTableName = errors.New("pgstore: invalid table name")
)

var validTableName = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)

var _ storage.Store = (*Store)(nil)

// Option configures a PostgreSQL Store.
type Option func(*config)

type config struct {
	table string
}

// WithTableName configures the PostgreSQL table name used to persist document records.
// The name must match ^[a-z_][a-z0-9_]*$ to guarantee safe SQL identifier interpolation.
func WithTableName(name string) Option {
	return func(c *config) {
		c.table = name
	}
}

// Store is a concurrency-safe PostgreSQL implementation of storage.Store.
// The caller retains ownership of the underlying *sql.DB connection pool and
// is responsible for closing it when the application shuts down.
type Store struct {
	db    *sql.DB
	table string
	now   func() time.Time

	qCreateTable string
	qCreateIndex string
	qGet         string
	qInsert      string
	qUpdate      string
	qDelete      string
	qListAll     string
	qListKind    string
}

// New constructs a Store backed by db. The caller remains responsible for
// configuring and closing db.
func New(db *sql.DB, opts ...Option) (*Store, error) {
	if db == nil {
		return nil, ErrNilDB
	}
	cfg := config{table: DefaultTableName}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	if !validTableName.MatchString(cfg.table) {
		return nil, fmt.Errorf("%w: %q", ErrInvalidTableName, cfg.table)
	}

	t := cfg.table
	return &Store{
		db:    db,
		table: t,
		now:   func() time.Time { return time.Now().UTC() },
		qCreateTable: fmt.Sprintf(`CREATE TABLE IF NOT EXISTS %s (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL DEFAULT '',
	title TEXT NOT NULL DEFAULT '',
	version BIGINT NOT NULL,
	data BYTEA,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL
)`, t),
		qCreateIndex: fmt.Sprintf(`CREATE INDEX IF NOT EXISTS idx_%s_kind_id ON %s (kind, id)`, t, t),
		qGet:         fmt.Sprintf(`SELECT id, kind, title, version, data, metadata, created_at, updated_at FROM %s WHERE id = $1`, t),
		qInsert:      fmt.Sprintf(`INSERT INTO %s (id, kind, title, version, data, metadata, created_at, updated_at) VALUES ($1, $2, $3, 1, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`, t),
		qUpdate:      fmt.Sprintf(`UPDATE %s SET kind = $1, title = $2, version = version + 1, data = $3, metadata = $4, updated_at = $5 WHERE id = $6 AND version = $7 RETURNING version, created_at`, t),
		qDelete:      fmt.Sprintf(`DELETE FROM %s WHERE id = $1`, t),
		qListAll:     fmt.Sprintf(`SELECT id, kind, title, version, data, metadata, created_at, updated_at FROM %s ORDER BY id ASC`, t),
		qListKind:    fmt.Sprintf(`SELECT id, kind, title, version, data, metadata, created_at, updated_at FROM %s WHERE kind = $1 ORDER BY id ASC`, t),
	}, nil
}

// TableName returns the validated PostgreSQL table name used by this Store.
func (s *Store) TableName() string {
	return s.table
}

// EnsureSchema creates the document storage table and its (kind, id) index if they do not exist.
func (s *Store) EnsureSchema(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, s.qCreateTable); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, s.qCreateIndex); err != nil {
		return err
	}
	return nil
}

// Get retrieves a document record by ID, returning storage.ErrNotFound if no row exists.
func (s *Store) Get(ctx context.Context, id string) (*storage.DocumentRecord, error) {
	if err := storage.ValidateID(id); err != nil {
		return nil, err
	}
	row := s.db.QueryRowContext(ctx, s.qGet, id)
	rec, err := scanRecord(row.Scan)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, storage.ErrNotFound
		}
		return nil, err
	}
	return rec, nil
}

// Put inserts or updates a document record using atomic optimistic concurrency control
// matching storage.MemoryStore and storage.FileStore semantics.
//
// When rec.Version == 0, Put performs an atomic insert and returns storage.ErrVersionConflict
// if a record with the same ID already exists. When rec.Version > 0, Put performs an atomic
// compare-and-swap update and returns storage.ErrVersionConflict if the record does not exist
// or its stored version differs. On success, rec.Version, rec.CreatedAt, and rec.UpdatedAt
// are updated in place.
func (s *Store) Put(ctx context.Context, rec *storage.DocumentRecord) error {
	if rec == nil {
		return storage.ErrInvalidID
	}
	if err := storage.ValidateID(rec.ID); err != nil {
		return err
	}
	if rec.Version < 0 {
		return storage.ErrVersionConflict
	}

	now := s.now().UTC()
	metaJSON := marshalMetadata(rec.Metadata)

	if rec.Version == 0 {
		createdAt := rec.CreatedAt.UTC()
		if rec.CreatedAt.IsZero() {
			createdAt = now
		}
		res, err := s.db.ExecContext(
			ctx,
			s.qInsert,
			rec.ID,
			rec.Kind,
			rec.Title,
			rec.Data,
			metaJSON,
			createdAt,
			now,
		)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n == 0 {
			return storage.ErrVersionConflict
		}
		rec.Version = 1
		rec.CreatedAt = createdAt
		rec.UpdatedAt = now
		return nil
	}

	var (
		newVersion int64
		createdAt  time.Time
	)
	err := s.db.QueryRowContext(
		ctx,
		s.qUpdate,
		rec.Kind,
		rec.Title,
		rec.Data,
		metaJSON,
		now,
		rec.ID,
		rec.Version,
	).Scan(&newVersion, &createdAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return storage.ErrVersionConflict
		}
		return err
	}
	rec.Version = newVersion
	rec.CreatedAt = createdAt.UTC()
	rec.UpdatedAt = now
	return nil
}

// Delete removes a document record by ID, returning storage.ErrNotFound if no row was deleted.
func (s *Store) Delete(ctx context.Context, id string) error {
	if err := storage.ValidateID(id); err != nil {
		return err
	}
	res, err := s.db.ExecContext(ctx, s.qDelete, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return storage.ErrNotFound
	}
	return nil
}

// List returns all records matching kind (or all records when kind is empty), ordered by id ASC.
func (s *Store) List(ctx context.Context, kind string) ([]*storage.DocumentRecord, error) {
	var (
		rows *sql.Rows
		err  error
	)
	if kind == "" {
		rows, err = s.db.QueryContext(ctx, s.qListAll)
	} else {
		rows, err = s.db.QueryContext(ctx, s.qListKind, kind)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]*storage.DocumentRecord, 0)
	for rows.Next() {
		rec, err := scanRecord(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func marshalMetadata(meta map[string]string) string {
	if len(meta) == 0 {
		return "{}"
	}
	raw, _ := json.Marshal(meta)
	return string(raw)
}

func scanRecord(scan func(dest ...any) error) (*storage.DocumentRecord, error) {
	var (
		rec       storage.DocumentRecord
		data      []byte
		metaRaw   []byte
		createdAt time.Time
		updatedAt time.Time
	)
	if err := scan(
		&rec.ID,
		&rec.Kind,
		&rec.Title,
		&rec.Version,
		&data,
		&metaRaw,
		&createdAt,
		&updatedAt,
	); err != nil {
		return nil, err
	}
	if data != nil {
		rec.Data = make([]byte, len(data))
		copy(rec.Data, data)
	}
	if len(metaRaw) > 0 {
		var meta map[string]string
		if err := json.Unmarshal(metaRaw, &meta); err != nil {
			return nil, fmt.Errorf("pgstore: decode metadata: %w", err)
		}
		if len(meta) > 0 {
			rec.Metadata = meta
		}
	}
	rec.CreatedAt = createdAt.UTC()
	rec.UpdatedAt = updatedAt.UTC()
	return &rec, nil
}
