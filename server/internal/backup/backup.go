// Package backup exports and restores portable Jiange backup archives (.tar.gz)
// containing PostgreSQL table dumps (JSONL), attachment blobs, and a
// SHA-256 verified manifest.
package backup

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// FormatVersion is the current backup archive schema version.
const FormatVersion = 1

const (
	manifestEntryName = "manifest.json"
	maxManifestBytes  = 64 << 20 // 64 MiB safety cap for manifest.json
)

var (
	// ErrInvalidArchive indicates a structurally malformed archive.
	ErrInvalidArchive = errors.New("backup: invalid archive")
	// ErrChecksumMismatch indicates an archive entry failed SHA-256 verification.
	ErrChecksumMismatch = errors.New("backup: checksum mismatch")
)

// TableManifest records metadata and integrity hash for one exported table.
type TableManifest struct {
	Name     string `json:"name"`
	RowCount int64  `json:"rowCount"`
	Entry    string `json:"entry"`
	SHA256   string `json:"sha256"`
}

// Manifest is written to manifest.json inside every backup archive.
type Manifest struct {
	Version   int               `json:"version"`
	CreatedAt time.Time         `json:"createdAt"`
	Tables    []TableManifest   `json:"tables"`
	BlobCount int               `json:"blobCount"`
	SHA256    map[string]string `json:"sha256"`
}

// SQLRows iterates over query result rows.
type SQLRows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
	Close()
}

// SQLQuerier executes read-only queries during backup export.
type SQLQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (SQLRows, error)
}

// SQLTx executes DDL/DML inside a single restore transaction.
type SQLTx interface {
	Exec(ctx context.Context, sql string, args ...any) error
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

// SQLRestorer opens transactions for restoring database tables.
type SQLRestorer interface {
	BeginTx(ctx context.Context) (SQLTx, error)
}

// BlobEntry describes a single attachment object yielded by a BlobEnumerator.
type BlobEntry struct {
	Key  string
	Size int64
	Open func(ctx context.Context) (io.ReadCloser, error)
}

// BlobEnumerator walks all attachment blobs to include in an export archive.
type BlobEnumerator interface {
	Enumerate(ctx context.Context, fn func(BlobEntry) error) error
}

// NewPGXQuerier wraps a pgxpool.Pool as a SQLQuerier.
func NewPGXQuerier(pool *pgxpool.Pool) SQLQuerier {
	return pgxQuerier{pool: pool}
}

type pgxQuerier struct{ pool *pgxpool.Pool }

func (q pgxQuerier) Query(ctx context.Context, sql string, args ...any) (SQLRows, error) {
	if q.pool == nil {
		return nil, errors.New("backup: nil pgx pool")
	}
	return q.pool.Query(ctx, sql, args...)
}

// NewPGXRestorer wraps a pgxpool.Pool as a SQLRestorer.
func NewPGXRestorer(pool *pgxpool.Pool) SQLRestorer {
	return pgxRestorer{pool: pool}
}

type pgxRestorer struct{ pool *pgxpool.Pool }

func (r pgxRestorer) BeginTx(ctx context.Context) (SQLTx, error) {
	if r.pool == nil {
		return nil, errors.New("backup: nil pgx pool")
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return pgxTx{tx: tx}, nil
}

type pgxTx struct{ tx pgx.Tx }

func (t pgxTx) Exec(ctx context.Context, sql string, args ...any) error {
	_, err := t.tx.Exec(ctx, sql, args...)
	return err
}

func (t pgxTx) Commit(ctx context.Context) error   { return t.tx.Commit(ctx) }
func (t pgxTx) Rollback(ctx context.Context) error { return t.tx.Rollback(ctx) }

// NewDirBlobEnumerator enumerates all attachment files stored in a local blob.Dir.
func NewDirBlobEnumerator(dir *blob.Dir) BlobEnumerator {
	return dirBlobEnumerator{dir: dir}
}

type dirBlobEnumerator struct{ dir *blob.Dir }

func (e dirBlobEnumerator) Enumerate(ctx context.Context, fn func(BlobEntry) error) error {
	if e.dir == nil || e.dir.Root == "" {
		return nil
	}
	root := e.dir.Root
	return filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		name := d.Name()
		// Skip in-flight atomic temp files created by blob.Dir.Put.
		if strings.HasPrefix(name, ".tmp-") {
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(rel)
		if err := validateBlobKey(key); err != nil {
			return fmt.Errorf("backup: blob %q: %w", key, err)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		fullPath := p
		return fn(BlobEntry{
			Key:  key,
			Size: info.Size(),
			Open: func(openCtx context.Context) (io.ReadCloser, error) {
				if err := openCtx.Err(); err != nil {
					return nil, err
				}
				return os.Open(fullPath)
			},
		})
	})
}

const discoverTablesSQL = `SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
  AND table_name <> 'schema_migrations'
ORDER BY table_name`

const resetSequencesSQL = `DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT
      c.table_schema,
      c.table_name,
      c.column_name,
      pg_get_serial_sequence(format('%I.%I', c.table_schema, c.table_name), c.column_name) AS seq_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
  LOOP
    IF rec.seq_name IS NOT NULL THEN
      EXECUTE format(
        'SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM %I.%I), 1), (SELECT COUNT(*) > 0 FROM %I.%I))',
        rec.seq_name, rec.column_name, rec.table_schema, rec.table_name, rec.table_schema, rec.table_name
      );
    END IF;
  END LOOP;
END $$;`

type stagedEntry struct {
	archivePath string
	diskPath    string
	size        int64
	sha256Hex   string
}

// ExportArchive exports all public Postgres tables (excluding schema_migrations)
// and any enumerated attachment blobs into a portable, SHA-256 verified .tar.gz
// archive at outPath.
func ExportArchive(ctx context.Context, db SQLQuerier, blobs BlobEnumerator, outPath string) (*Manifest, error) {
	if db == nil {
		return nil, errors.New("backup: database querier is required")
	}
	if strings.TrimSpace(outPath) == "" {
		return nil, errors.New("backup: output path is required")
	}

	tables, err := discoverTables(ctx, db)
	if err != nil {
		return nil, err
	}

	stageDir, err := os.MkdirTemp("", "jiange-backup-export-*")
	if err != nil {
		return nil, fmt.Errorf("backup: create staging dir: %w", err)
	}
	defer os.RemoveAll(stageDir)

	manifest := &Manifest{
		Version:   FormatVersion,
		CreatedAt: time.Now().UTC(),
		Tables:    make([]TableManifest, 0, len(tables)),
		SHA256:    make(map[string]string),
	}

	var stagedTables []stagedEntry
	for i, tbl := range tables {
		if !isValidSQLIdent(tbl) {
			return nil, fmt.Errorf("backup: unsafe table name %q", tbl)
		}
		stagePath := filepath.Join(stageDir, fmt.Sprintf("table-%04d.jsonl", i))
		rowCount, size, sumHex, err := exportTableJSONL(ctx, db, tbl, stagePath)
		if err != nil {
			return nil, fmt.Errorf("backup: export table %q: %w", tbl, err)
		}
		entryName := "tables/" + tbl + ".jsonl"
		manifest.Tables = append(manifest.Tables, TableManifest{
			Name:     tbl,
			RowCount: rowCount,
			Entry:    entryName,
			SHA256:   sumHex,
		})
		manifest.SHA256[entryName] = sumHex
		stagedTables = append(stagedTables, stagedEntry{
			archivePath: entryName,
			diskPath:    stagePath,
			size:        size,
			sha256Hex:   sumHex,
		})
	}

	var stagedBlobs []stagedEntry
	if blobs != nil {
		seenBlob := make(map[string]struct{})
		blobIdx := 0
		err := blobs.Enumerate(ctx, func(be BlobEntry) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := validateBlobKey(be.Key); err != nil {
				return fmt.Errorf("backup: invalid blob key %q: %w", be.Key, err)
			}
			if _, dup := seenBlob[be.Key]; dup {
				return fmt.Errorf("backup: duplicate blob key %q", be.Key)
			}
			seenBlob[be.Key] = struct{}{}
			if be.Open == nil {
				return fmt.Errorf("backup: blob %q missing Open func", be.Key)
			}
			rc, err := be.Open(ctx)
			if err != nil {
				return fmt.Errorf("backup: open blob %q: %w", be.Key, err)
			}
			stagePath := filepath.Join(stageDir, fmt.Sprintf("blob-%06d.bin", blobIdx))
			blobIdx++
			size, sumHex, copyErr := stageReaderWithHash(rc, stagePath)
			closeErr := rc.Close()
			if copyErr != nil {
				return fmt.Errorf("backup: stage blob %q: %w", be.Key, copyErr)
			}
			if closeErr != nil {
				return fmt.Errorf("backup: close blob %q: %w", be.Key, closeErr)
			}
			entryName := "blobs/" + be.Key
			stagedBlobs = append(stagedBlobs, stagedEntry{
				archivePath: entryName,
				diskPath:    stagePath,
				size:        size,
				sha256Hex:   sumHex,
			})
			return nil
		})
		if err != nil {
			return nil, err
		}
	}

	sort.Slice(stagedBlobs, func(i, j int) bool {
		return stagedBlobs[i].archivePath < stagedBlobs[j].archivePath
	})
	manifest.BlobCount = len(stagedBlobs)
	for _, b := range stagedBlobs {
		manifest.SHA256[b.archivePath] = b.sha256Hex
	}

	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("backup: marshal manifest: %w", err)
	}
	manifestBytes = append(manifestBytes, '\n')

	outDir := filepath.Dir(outPath)
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, fmt.Errorf("backup: mkdir %s: %w", outDir, err)
	}
	tmpOut, err := os.CreateTemp(outDir, ".jiange-backup-*.tmp")
	if err != nil {
		return nil, fmt.Errorf("backup: create temp archive: %w", err)
	}
	tmpPath := tmpOut.Name()
	committed := false
	defer func() {
		if !committed {
			_ = tmpOut.Close()
			_ = os.Remove(tmpPath)
		}
	}()

	gzw := gzip.NewWriter(tmpOut)
	tw := tar.NewWriter(gzw)
	now := manifest.CreatedAt

	if err := writeTarBytes(tw, manifestEntryName, manifestBytes, now); err != nil {
		return nil, err
	}
	for _, te := range stagedTables {
		if err := writeTarFile(tw, te.archivePath, te.diskPath, te.size, now); err != nil {
			return nil, err
		}
	}
	for _, be := range stagedBlobs {
		if err := writeTarFile(tw, be.archivePath, be.diskPath, be.size, now); err != nil {
			return nil, err
		}
	}

	if err := tw.Close(); err != nil {
		return nil, fmt.Errorf("backup: finalize tar: %w", err)
	}
	if err := gzw.Close(); err != nil {
		return nil, fmt.Errorf("backup: finalize gzip: %w", err)
	}
	if err := tmpOut.Sync(); err != nil {
		return nil, fmt.Errorf("backup: sync archive: %w", err)
	}
	if err := tmpOut.Close(); err != nil {
		return nil, fmt.Errorf("backup: close archive: %w", err)
	}
	if err := os.Rename(tmpPath, outPath); err != nil {
		return nil, fmt.Errorf("backup: rename archive to %s: %w", outPath, err)
	}
	committed = true
	return manifest, nil
}

// InspectArchive validates the .tar.gz archive structure, JSONL row validity,
// and SHA-256 checksum of every member against manifest.json.
func InspectArchive(inPath string) (*Manifest, error) {
	if strings.TrimSpace(inPath) == "" {
		return nil, errors.New("backup: input path is required")
	}
	f, err := os.Open(inPath)
	if err != nil {
		return nil, fmt.Errorf("backup: open archive: %w", err)
	}
	defer f.Close()

	gzr, err := gzip.NewReader(f)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid gzip stream: %v", ErrInvalidArchive, err)
	}
	defer gzr.Close()

	tr := tar.NewReader(gzr)
	var manifest *Manifest
	seen := make(map[string]struct{})
	observedHash := make(map[string]string)
	observedRows := make(map[string]int64)
	observedBlobs := 0

	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("%w: read tar header: %v", ErrInvalidArchive, err)
		}
		if hdr.Typeflag == tar.TypeDir {
			continue
		}
		if hdr.Typeflag != tar.TypeReg {
			return nil, fmt.Errorf("%w: unsupported tar entry type %q for %q", ErrInvalidArchive, hdr.Typeflag, hdr.Name)
		}
		name, err := sanitizeArchivePath(hdr.Name)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidArchive, err)
		}
		if _, dup := seen[name]; dup {
			return nil, fmt.Errorf("%w: duplicate entry %q", ErrInvalidArchive, name)
		}
		seen[name] = struct{}{}

		switch {
		case name == manifestEntryName:
			if hdr.Size > maxManifestBytes {
				return nil, fmt.Errorf("%w: manifest exceeds %d bytes", ErrInvalidArchive, maxManifestBytes)
			}
			raw, err := io.ReadAll(io.LimitReader(tr, maxManifestBytes+1))
			if err != nil {
				return nil, fmt.Errorf("%w: read manifest: %v", ErrInvalidArchive, err)
			}
			if int64(len(raw)) > maxManifestBytes {
				return nil, fmt.Errorf("%w: manifest exceeds %d bytes", ErrInvalidArchive, maxManifestBytes)
			}
			var m Manifest
			if err := json.Unmarshal(raw, &m); err != nil {
				return nil, fmt.Errorf("%w: parse manifest.json: %v", ErrInvalidArchive, err)
			}
			manifest = &m

		case strings.HasPrefix(name, "tables/"):
			tbl, err := parseTableEntryName(name)
			if err != nil {
				return nil, fmt.Errorf("%w: %v", ErrInvalidArchive, err)
			}
			rows, sumHex, err := hashAndValidateJSONL(tr)
			if err != nil {
				return nil, fmt.Errorf("%w: table %q: %v", ErrInvalidArchive, tbl, err)
			}
			observedHash[name] = sumHex
			observedRows[name] = rows

		case strings.HasPrefix(name, "blobs/"):
			key := strings.TrimPrefix(name, "blobs/")
			if err := validateBlobKey(key); err != nil {
				return nil, fmt.Errorf("%w: blob entry %q: %v", ErrInvalidArchive, name, err)
			}
			h := sha256.New()
			if _, err := io.Copy(h, tr); err != nil {
				return nil, fmt.Errorf("%w: read blob %q: %v", ErrInvalidArchive, name, err)
			}
			observedHash[name] = hex.EncodeToString(h.Sum(nil))
			observedBlobs++

		default:
			return nil, fmt.Errorf("%w: unexpected entry %q", ErrInvalidArchive, name)
		}
	}

	if manifest == nil {
		return nil, fmt.Errorf("%w: missing %s", ErrInvalidArchive, manifestEntryName)
	}
	if manifest.Version != FormatVersion {
		return nil, fmt.Errorf("%w: unsupported manifest version %d", ErrInvalidArchive, manifest.Version)
	}
	if manifest.SHA256 == nil {
		return nil, fmt.Errorf("%w: manifest missing sha256 map", ErrInvalidArchive)
	}
	if manifest.BlobCount != observedBlobs {
		return nil, fmt.Errorf("%w: blob count mismatch (manifest=%d, archive=%d)", ErrInvalidArchive, manifest.BlobCount, observedBlobs)
	}

	// Verify every manifest checksum against observed entries.
	for entry, expected := range manifest.SHA256 {
		got, ok := observedHash[entry]
		if !ok {
			return nil, fmt.Errorf("%w: missing archive entry %q listed in manifest", ErrInvalidArchive, entry)
		}
		if !strings.EqualFold(got, expected) {
			return nil, fmt.Errorf("%w: %s (expected %s, got %s)", ErrChecksumMismatch, entry, expected, got)
		}
	}
	// Reject unlisted extra entries in the archive.
	for entry := range observedHash {
		if _, ok := manifest.SHA256[entry]; !ok {
			return nil, fmt.Errorf("%w: archive entry %q missing from manifest sha256 map", ErrInvalidArchive, entry)
		}
	}

	// Verify table manifests match actual files and row counts.
	seenTable := make(map[string]struct{}, len(manifest.Tables))
	for _, tm := range manifest.Tables {
		if !isValidSQLIdent(tm.Name) {
			return nil, fmt.Errorf("%w: invalid table name %q in manifest", ErrInvalidArchive, tm.Name)
		}
		if _, dup := seenTable[tm.Name]; dup {
			return nil, fmt.Errorf("%w: duplicate table %q in manifest", ErrInvalidArchive, tm.Name)
		}
		seenTable[tm.Name] = struct{}{}

		expectedEntry := "tables/" + tm.Name + ".jsonl"
		entry := tm.Entry
		if entry == "" {
			entry = expectedEntry
		}
		if entry != expectedEntry {
			return nil, fmt.Errorf("%w: table %q has mismatched entry %q", ErrInvalidArchive, tm.Name, entry)
		}
		gotRows, ok := observedRows[entry]
		if !ok {
			return nil, fmt.Errorf("%w: missing table archive entry %q", ErrInvalidArchive, entry)
		}
		if gotRows != tm.RowCount {
			return nil, fmt.Errorf("%w: table %q row count mismatch (manifest=%d, archive=%d)", ErrInvalidArchive, tm.Name, tm.RowCount, gotRows)
		}
		if tm.SHA256 != "" && !strings.EqualFold(observedHash[entry], tm.SHA256) {
			return nil, fmt.Errorf("%w: table %q checksum mismatch", ErrChecksumMismatch, tm.Name)
		}
	}
	if len(seenTable) != len(observedRows) {
		return nil, fmt.Errorf("%w: table entry count mismatch (manifest=%d, archive=%d)", ErrInvalidArchive, len(seenTable), len(observedRows))
	}

	return manifest, nil
}

// RestoreArchive validates the archive's SHA-256 checksums first, restores all
// attachment blobs into blobs, and then atomically truncates and reloads all
// tables and sequences inside a database transaction.
func RestoreArchive(ctx context.Context, db SQLRestorer, blobs blob.Store, inPath string) (*Manifest, error) {
	if db == nil {
		return nil, errors.New("backup: database restorer is required")
	}
	manifest, err := InspectArchive(inPath)
	if err != nil {
		return nil, err
	}
	if manifest.BlobCount > 0 && blobs == nil {
		return nil, fmt.Errorf("backup: archive contains %d blobs but no blob store is configured", manifest.BlobCount)
	}

	stageDir, err := os.MkdirTemp("", "jiange-backup-restore-*")
	if err != nil {
		return nil, fmt.Errorf("backup: create restore staging dir: %w", err)
	}
	defer os.RemoveAll(stageDir)

	tableFiles := make(map[string]string, len(manifest.Tables))

	f, err := os.Open(inPath)
	if err != nil {
		return nil, fmt.Errorf("backup: reopen archive: %w", err)
	}
	defer f.Close()

	gzr, err := gzip.NewReader(f)
	if err != nil {
		return nil, fmt.Errorf("backup: reopen gzip: %w", err)
	}
	defer gzr.Close()

	tr := tar.NewReader(gzr)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("backup: read archive during restore: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		name, err := sanitizeArchivePath(hdr.Name)
		if err != nil {
			return nil, err
		}
		switch {
		case strings.HasPrefix(name, "blobs/"):
			key := strings.TrimPrefix(name, "blobs/")
			body, err := io.ReadAll(tr)
			if err != nil {
				return nil, fmt.Errorf("backup: read blob %q: %w", key, err)
			}
			if err := blobs.Put(ctx, key, "application/octet-stream", body); err != nil {
				return nil, fmt.Errorf("backup: restore blob %q: %w", key, err)
			}

		case strings.HasPrefix(name, "tables/"):
			tbl, err := parseTableEntryName(name)
			if err != nil {
				return nil, err
			}
			dstPath := filepath.Join(stageDir, tbl+".jsonl")
			if err := copyToFile(tr, dstPath); err != nil {
				return nil, fmt.Errorf("backup: stage table %q: %w", tbl, err)
			}
			tableFiles[tbl] = dstPath
		}
	}

	tx, err := db.BeginTx(ctx)
	if err != nil {
		return nil, fmt.Errorf("backup: begin restore transaction: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	if len(manifest.Tables) > 0 {
		// Disable triggers and FK checks when permitted (superuser/rds_superuser).
		// Wrap in a savepoint so unprivileged DB roles fall back cleanly without
		// aborting the surrounding transaction.
		_ = tx.Exec(ctx, `SAVEPOINT jiange_backup_replica_role`)
		if err := tx.Exec(ctx, `SET LOCAL session_replication_role = 'replica'`); err != nil {
			_ = tx.Exec(ctx, `ROLLBACK TO SAVEPOINT jiange_backup_replica_role`)
		} else {
			_ = tx.Exec(ctx, `RELEASE SAVEPOINT jiange_backup_replica_role`)
		}

		quoted := make([]string, 0, len(manifest.Tables))
		for _, tm := range manifest.Tables {
			quoted = append(quoted, quoteIdent(tm.Name))
		}
		truncateSQL := "TRUNCATE TABLE " + strings.Join(quoted, ", ") + " RESTART IDENTITY CASCADE"
		if err := tx.Exec(ctx, truncateSQL); err != nil {
			return nil, fmt.Errorf("backup: truncate tables: %w", err)
		}

		for _, tm := range manifest.Tables {
			p, ok := tableFiles[tm.Name]
			if !ok {
				return nil, fmt.Errorf("backup: missing staged file for table %q", tm.Name)
			}
			if err := restoreTableFromJSONL(ctx, tx, tm.Name, p); err != nil {
				return nil, fmt.Errorf("backup: restore table %q: %w", tm.Name, err)
			}
		}

		if err := tx.Exec(ctx, resetSequencesSQL); err != nil {
			return nil, fmt.Errorf("backup: reset sequences: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("backup: commit restore transaction: %w", err)
	}
	committed = true
	return manifest, nil
}

// ExportPostgresDir is a convenience helper for CLI commands (e.g. `jiange backup`)
// that exports a Postgres database and optional local blob directory to outPath.
func ExportPostgresDir(ctx context.Context, pg *store.Postgres, blobDir string, outPath string) (*Manifest, error) {
	if pg == nil || pg.Pool == nil {
		return nil, errors.New("backup: postgres store is not initialized")
	}
	var enumerator BlobEnumerator
	if strings.TrimSpace(blobDir) != "" {
		st, err := os.Stat(blobDir)
		switch {
		case errors.Is(err, os.ErrNotExist):
			// No blobs stored yet; export DB cleanly with blobCount=0.
		case err != nil:
			return nil, fmt.Errorf("backup: stat blob dir %q: %w", blobDir, err)
		case !st.IsDir():
			return nil, fmt.Errorf("backup: blob dir %q is not a directory", blobDir)
		default:
			abs, err := filepath.Abs(blobDir)
			if err != nil {
				return nil, fmt.Errorf("backup: resolve blob dir %q: %w", blobDir, err)
			}
			enumerator = NewDirBlobEnumerator(&blob.Dir{Root: abs})
		}
	}
	return ExportArchive(ctx, NewPGXQuerier(pg.Pool), enumerator, outPath)
}

// RestorePostgresDir is a convenience helper for CLI commands (e.g. `jiange restore`)
// that validates and restores an archive into a Postgres database and blob store.
func RestorePostgresDir(ctx context.Context, pg *store.Postgres, blobs blob.Store, inPath string) (*Manifest, error) {
	if pg == nil || pg.Pool == nil {
		return nil, errors.New("backup: postgres store is not initialized")
	}
	return RestoreArchive(ctx, NewPGXRestorer(pg.Pool), blobs, inPath)
}

func discoverTables(ctx context.Context, db SQLQuerier) ([]string, error) {
	rows, err := db.Query(ctx, discoverTablesSQL)
	if err != nil {
		return nil, fmt.Errorf("backup: list tables: %w", err)
	}
	defer rows.Close()

	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("backup: scan table name: %w", err)
		}
		if name == "schema_migrations" {
			continue
		}
		tables = append(tables, name)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("backup: iterate tables: %w", err)
	}
	sort.Strings(tables)
	return tables, nil
}

func exportTableJSONL(ctx context.Context, db SQLQuerier, table, dstPath string) (rowCount int64, size int64, sha256Hex string, err error) {
	q := fmt.Sprintf("SELECT row_to_json(t)::text FROM %s AS t", quoteIdent(table))
	rows, err := db.Query(ctx, q)
	if err != nil {
		return 0, 0, "", err
	}
	defer rows.Close()

	f, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, 0, "", err
	}
	defer f.Close()

	h := sha256.New()
	bw := bufio.NewWriter(io.MultiWriter(f, h))
	var compactBuf bytes.Buffer

	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return 0, 0, "", err
		}
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return 0, 0, "", err
		}
		line := bytes.TrimSpace([]byte(raw))
		if len(line) == 0 {
			continue
		}
		if !json.Valid(line) {
			return 0, 0, "", fmt.Errorf("invalid JSON row from table %q", table)
		}
		if bytes.ContainsAny(line, "\r\n") {
			compactBuf.Reset()
			if err := json.Compact(&compactBuf, line); err != nil {
				return 0, 0, "", err
			}
			line = compactBuf.Bytes()
		}
		n, err := bw.Write(line)
		if err != nil {
			return 0, 0, "", err
		}
		if err := bw.WriteByte('\n'); err != nil {
			return 0, 0, "", err
		}
		size += int64(n) + 1
		rowCount++
	}
	if err := rows.Err(); err != nil {
		return 0, 0, "", err
	}
	if err := bw.Flush(); err != nil {
		return 0, 0, "", err
	}
	if err := f.Close(); err != nil {
		return 0, 0, "", err
	}
	return rowCount, size, hex.EncodeToString(h.Sum(nil)), nil
}

func restoreTableFromJSONL(ctx context.Context, tx SQLTx, table, srcPath string) error {
	f, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer f.Close()

	qIdent := quoteIdent(table)
	insertSQL := fmt.Sprintf(
		"INSERT INTO %s OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_record(NULL::%s, $1::json)",
		qIdent, qIdent,
	)

	br := bufio.NewReaderSize(f, 64*1024)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		line, readErr := br.ReadBytes('\n')
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) > 0 {
			if !json.Valid(trimmed) {
				return fmt.Errorf("invalid JSON row in %s", table)
			}
			if err := tx.Exec(ctx, insertSQL, string(trimmed)); err != nil {
				return err
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	return nil
}

func hashAndValidateJSONL(r io.Reader) (rowCount int64, sha256Hex string, err error) {
	h := sha256.New()
	tr := io.TeeReader(r, h)
	br := bufio.NewReaderSize(tr, 64*1024)
	for {
		line, readErr := br.ReadBytes('\n')
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) > 0 {
			if !json.Valid(trimmed) {
				return 0, "", fmt.Errorf("malformed JSON at line %d", rowCount+1)
			}
			rowCount++
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return 0, "", readErr
		}
	}
	return rowCount, hex.EncodeToString(h.Sum(nil)), nil
}

func stageReaderWithHash(r io.Reader, dstPath string) (size int64, sha256Hex string, err error) {
	f, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, "", err
	}
	defer f.Close()

	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), r)
	if err != nil {
		return 0, "", err
	}
	if err := f.Close(); err != nil {
		return 0, "", err
	}
	return n, hex.EncodeToString(h.Sum(nil)), nil
}

func copyToFile(r io.Reader, dstPath string) error {
	f, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

func writeTarBytes(tw *tar.Writer, name string, data []byte, modTime time.Time) error {
	hdr := &tar.Header{
		Name:     name,
		Mode:     0o644,
		Size:     int64(len(data)),
		ModTime:  modTime,
		Typeflag: tar.TypeReg,
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return fmt.Errorf("backup: write tar header %q: %w", name, err)
	}
	if _, err := tw.Write(data); err != nil {
		return fmt.Errorf("backup: write tar body %q: %w", name, err)
	}
	return nil
}

func writeTarFile(tw *tar.Writer, archiveName, diskPath string, size int64, modTime time.Time) error {
	f, err := os.Open(diskPath)
	if err != nil {
		return fmt.Errorf("backup: open staged %q: %w", archiveName, err)
	}
	defer f.Close()

	hdr := &tar.Header{
		Name:     archiveName,
		Mode:     0o644,
		Size:     size,
		ModTime:  modTime,
		Typeflag: tar.TypeReg,
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return fmt.Errorf("backup: write tar header %q: %w", archiveName, err)
	}
	if _, err := io.Copy(tw, f); err != nil {
		return fmt.Errorf("backup: write tar body %q: %w", archiveName, err)
	}
	return nil
}

func sanitizeArchivePath(raw string) (string, error) {
	if raw == "" || !utf8.ValidString(raw) || strings.Contains(raw, `\`) || strings.HasPrefix(raw, "/") {
		return "", fmt.Errorf("unsafe archive path %q", raw)
	}
	cleaned := path.Clean(raw)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") || strings.HasPrefix(cleaned, "/") {
		return "", fmt.Errorf("unsafe archive path %q", raw)
	}
	for _, seg := range strings.Split(cleaned, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return "", fmt.Errorf("unsafe archive path %q", raw)
		}
	}
	return cleaned, nil
}

func parseTableEntryName(entry string) (string, error) {
	if !strings.HasPrefix(entry, "tables/") || !strings.HasSuffix(entry, ".jsonl") {
		return "", fmt.Errorf("invalid table entry %q", entry)
	}
	name := strings.TrimSuffix(strings.TrimPrefix(entry, "tables/"), ".jsonl")
	if strings.Contains(name, "/") || !isValidSQLIdent(name) {
		return "", fmt.Errorf("invalid table name %q", name)
	}
	return name, nil
}

func validateBlobKey(key string) error {
	if key == "" || !utf8.ValidString(key) || strings.Contains(key, `\`) || strings.HasPrefix(key, "/") {
		return errors.New("invalid blob key")
	}
	for _, p := range strings.Split(key, "/") {
		if p == "" || p == "." || p == ".." {
			return errors.New("invalid blob key segment")
		}
		for _, r := range p {
			ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.'
			if !ok {
				return errors.New("invalid character in blob key")
			}
		}
	}
	return nil
}

func isValidSQLIdent(name string) bool {
	if name == "" || len(name) > 128 {
		return false
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		isLetter := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'
		isDigit := c >= '0' && c <= '9'
		if i == 0 && !isLetter {
			return false
		}
		if !isLetter && !isDigit {
			return false
		}
	}
	return true
}

func quoteIdent(ident string) string {
	return `"` + strings.ReplaceAll(ident, `"`, `""`) + `"`
}
