package backup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/blob"
)

type sliceRows struct {
	vals []string
	idx  int
}

func (r *sliceRows) Next() bool {
	if r.idx >= len(r.vals) {
		return false
	}
	r.idx++
	return true
}

func (r *sliceRows) Scan(dest ...any) error {
	if len(dest) != 1 {
		return errors.New("expected 1 scan destination")
	}
	p, ok := dest[0].(*string)
	if !ok {
		return errors.New("expected *string scan destination")
	}
	*p = r.vals[r.idx-1]
	return nil
}

func (r *sliceRows) Err() error { return nil }
func (r *sliceRows) Close()     {}

type fakeDB struct {
	tables            map[string][]string // table name -> JSON rows
	denyReplicaRole   bool
	txOpened          int
	txCommitted       int
	txRolledBack      int
	replicaRoleSet    bool
	savepointRolledBk bool
	truncated         []string
	sequencesReset    bool
	restored          map[string][]string
	execLog           []string
}

var (
	selectFromRe = regexp.MustCompile(`FROM "([a-zA-Z0-9_]+)"`)
	insertIntoRe = regexp.MustCompile(`INSERT INTO "([a-zA-Z0-9_]+)"`)
)

func (f *fakeDB) Query(_ context.Context, sql string, _ ...any) (SQLRows, error) {
	if strings.Contains(sql, "information_schema.tables") {
		names := make([]string, 0, len(f.tables))
		for k := range f.tables {
			names = append(names, k)
		}
		sort.Strings(names)
		return &sliceRows{vals: names}, nil
	}
	m := selectFromRe.FindStringSubmatch(sql)
	if len(m) != 2 {
		return nil, errors.New("unexpected query: " + sql)
	}
	rows := append([]string(nil), f.tables[m[1]]...)
	return &sliceRows{vals: rows}, nil
}

func (f *fakeDB) BeginTx(_ context.Context) (SQLTx, error) {
	f.txOpened++
	return &fakeTx{db: f, pending: make(map[string][]string)}, nil
}

type fakeTx struct {
	db      *fakeDB
	pending map[string][]string
	done    bool
}

func (t *fakeTx) Exec(_ context.Context, sql string, args ...any) error {
	t.db.execLog = append(t.db.execLog, sql)
	switch {
	case strings.HasPrefix(sql, "SAVEPOINT "):
		return nil
	case strings.HasPrefix(sql, "RELEASE SAVEPOINT "):
		return nil
	case strings.HasPrefix(sql, "ROLLBACK TO SAVEPOINT "):
		t.db.savepointRolledBk = true
		return nil
	case strings.Contains(sql, "session_replication_role"):
		if t.db.denyReplicaRole {
			return errors.New("permission denied to set parameter session_replication_role")
		}
		t.db.replicaRoleSet = true
		return nil
	case strings.HasPrefix(sql, "TRUNCATE TABLE "):
		t.db.truncated = append(t.db.truncated, sql)
		return nil
	case strings.HasPrefix(sql, "INSERT INTO "):
		m := insertIntoRe.FindStringSubmatch(sql)
		if len(m) != 2 || len(args) != 1 {
			return errors.New("unexpected insert statement: " + sql)
		}
		rowJSON, ok := args[0].(string)
		if !ok {
			return errors.New("expected string json arg")
		}
		t.pending[m[1]] = append(t.pending[m[1]], rowJSON)
		return nil
	case strings.Contains(sql, "setval("):
		t.db.sequencesReset = true
		return nil
	default:
		return errors.New("unexpected SQL in restore tx: " + sql)
	}
}

func (t *fakeTx) Commit(_ context.Context) error {
	if t.done {
		return errors.New("tx already finished")
	}
	t.done = true
	t.db.txCommitted++
	t.db.restored = t.pending
	return nil
}

func (t *fakeTx) Rollback(_ context.Context) error {
	if t.done {
		return nil
	}
	t.done = true
	t.db.txRolledBack++
	return nil
}

func TestBackupRestoreRoundTrip(t *testing.T) {
	ctx := context.Background()

	srcDB := &fakeDB{
		tables: map[string][]string{
			"schema_migrations": {`{"version":1,"name":"0001_init.sql"}`},
			"users": {
				`{"id":1,"email":"alice@example.com","name":"Alice"}`,
				`{"id":2,"email":"bob@example.com","name":"Bob"}`,
			},
			"workspaces": {
				`{"id":10,"name":"Engineering","owner_id":1}`,
			},
			"empty_table": {},
		},
	}

	srcBlobDir, err := blob.NewDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	wantBlobs := map[string][]byte{
		"docs/1/aabbcc.txt":    []byte("hello jiange document attachment"),
		"drive/10/report.bin":  {0x00, 0x01, 0x02, 0xff, 0xfe, 0x42},
		"slides/5/deck-01.png": []byte("fake-png-payload-bytes"),
	}
	for k, body := range wantBlobs {
		if err := srcBlobDir.Put(ctx, k, "application/octet-stream", body); err != nil {
			t.Fatalf("seed blob %s: %v", k, err)
		}
	}
	// Drop a stray in-flight temp file that should be ignored by export.
	if err := os.WriteFile(filepath.Join(srcBlobDir.Root, ".tmp-inflight"), []byte("ignore-me"), 0o600); err != nil {
		t.Fatal(err)
	}

	archivePath := filepath.Join(t.TempDir(), "nested", "jiange-backup.tar.gz")
	exported, err := ExportArchive(ctx, srcDB, NewDirBlobEnumerator(srcBlobDir), archivePath)
	if err != nil {
		t.Fatalf("ExportArchive: %v", err)
	}

	if exported.Version != FormatVersion {
		t.Fatalf("expected version %d, got %d", FormatVersion, exported.Version)
	}
	if exported.CreatedAt.IsZero() {
		t.Fatalf("expected non-zero CreatedAt")
	}
	if exported.BlobCount != len(wantBlobs) {
		t.Fatalf("expected blobCount=%d, got %d", len(wantBlobs), exported.BlobCount)
	}
	if len(exported.Tables) != 3 {
		t.Fatalf("expected 3 exported tables (excluding schema_migrations), got %+v", exported.Tables)
	}
	rowCounts := map[string]int64{}
	for _, tm := range exported.Tables {
		rowCounts[tm.Name] = tm.RowCount
		if tm.Name == "schema_migrations" {
			t.Fatal("schema_migrations must not be exported")
		}
		if exported.SHA256[tm.Entry] == "" || exported.SHA256[tm.Entry] != tm.SHA256 {
			t.Fatalf("missing or mismatched table checksum for %s", tm.Name)
		}
	}
	if rowCounts["users"] != 2 || rowCounts["workspaces"] != 1 || rowCounts["empty_table"] != 0 {
		t.Fatalf("unexpected row counts: %+v", rowCounts)
	}

	// Inspect the archive independently.
	inspected, err := InspectArchive(archivePath)
	if err != nil {
		t.Fatalf("InspectArchive: %v", err)
	}
	if !reflect.DeepEqual(inspected.Tables, exported.Tables) || inspected.BlobCount != exported.BlobCount {
		t.Fatalf("inspected manifest mismatch:\ngot:  %+v\nwant: %+v", inspected, exported)
	}

	// Restore into a fresh DB + fresh blob.Dir.
	dstDB := &fakeDB{}
	dstBlobDir, err := blob.NewDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	restoredManifest, err := RestoreArchive(ctx, dstDB, dstBlobDir, archivePath)
	if err != nil {
		t.Fatalf("RestoreArchive: %v", err)
	}
	if restoredManifest.BlobCount != len(wantBlobs) {
		t.Fatalf("restored manifest blobCount=%d, want %d", restoredManifest.BlobCount, len(wantBlobs))
	}
	if dstDB.txOpened != 1 || dstDB.txCommitted != 1 || dstDB.txRolledBack != 0 {
		t.Fatalf("unexpected tx counts: opened=%d committed=%d rolledBack=%d", dstDB.txOpened, dstDB.txCommitted, dstDB.txRolledBack)
	}
	if !dstDB.replicaRoleSet {
		t.Fatal("expected session_replication_role = 'replica' to be executed")
	}
	if len(dstDB.truncated) != 1 || !strings.Contains(dstDB.truncated[0], `"users"`) || !strings.Contains(dstDB.truncated[0], `"workspaces"`) {
		t.Fatalf("unexpected truncate statements: %+v", dstDB.truncated)
	}
	if !dstDB.sequencesReset {
		t.Fatal("expected sequence reset block to execute")
	}
	if !reflect.DeepEqual(dstDB.restored["users"], srcDB.tables["users"]) {
		t.Fatalf("restored users mismatch:\ngot:  %v\nwant: %v", dstDB.restored["users"], srcDB.tables["users"])
	}
	if !reflect.DeepEqual(dstDB.restored["workspaces"], srcDB.tables["workspaces"]) {
		t.Fatalf("restored workspaces mismatch:\ngot:  %v\nwant: %v", dstDB.restored["workspaces"], srcDB.tables["workspaces"])
	}
	if len(dstDB.restored["empty_table"]) != 0 {
		t.Fatalf("expected 0 rows in empty_table, got %v", dstDB.restored["empty_table"])
	}

	// Verify all blobs restored byte-for-byte.
	for k, want := range wantBlobs {
		rc, err := dstBlobDir.Get(ctx, k)
		if err != nil {
			t.Fatalf("restored blob %s missing: %v", k, err)
		}
		got, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatalf("read restored blob %s: %v", k, err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("restored blob %s content mismatch: got %x want %x", k, got, want)
		}
	}
}

func TestBackupChecksumTamperDetection(t *testing.T) {
	ctx := context.Background()
	srcDB := &fakeDB{
		tables: map[string][]string{
			"users": {`{"id":1,"email":"alice@example.com","name":"Alice"}`},
		},
	}
	srcBlobDir, err := blob.NewDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := srcBlobDir.Put(ctx, "docs/1/file.txt", "text/plain", []byte("original-content")); err != nil {
		t.Fatal(err)
	}

	origArchive := filepath.Join(t.TempDir(), "orig.tar.gz")
	if _, err := ExportArchive(ctx, srcDB, NewDirBlobEnumerator(srcBlobDir), origArchive); err != nil {
		t.Fatal(err)
	}

	t.Run("tampered_table_row", func(t *testing.T) {
		tampered := rewriteArchive(t, origArchive, func(entries map[string][]byte) {
			entries["tables/users.jsonl"] = []byte(`{"id":1,"email":"evil@example.com","name":"Mallory"}` + "\n")
		})
		if _, err := InspectArchive(tampered); !errors.Is(err, ErrChecksumMismatch) {
			t.Fatalf("expected ErrChecksumMismatch, got %v", err)
		}
		dstDB := &fakeDB{}
		dstBlobs := blob.NewMemory()
		if _, err := RestoreArchive(ctx, dstDB, dstBlobs, tampered); !errors.Is(err, ErrChecksumMismatch) {
			t.Fatalf("expected RestoreArchive ErrChecksumMismatch, got %v", err)
		}
		if dstDB.txOpened != 0 {
			t.Fatalf("restore must abort before opening DB tx on tamper, txOpened=%d", dstDB.txOpened)
		}
		if _, err := dstBlobs.Get(ctx, "docs/1/file.txt"); !errors.Is(err, blob.ErrNotFound) {
			t.Fatalf("restore must abort before writing blobs on tamper, err=%v", err)
		}
	})

	t.Run("tampered_blob_bytes", func(t *testing.T) {
		tampered := rewriteArchive(t, origArchive, func(entries map[string][]byte) {
			entries["blobs/docs/1/file.txt"] = []byte("tampered-content")
		})
		if _, err := InspectArchive(tampered); !errors.Is(err, ErrChecksumMismatch) {
			t.Fatalf("expected ErrChecksumMismatch for tampered blob, got %v", err)
		}
	})

	t.Run("missing_manifest_listed_entry", func(t *testing.T) {
		broken := rewriteArchive(t, origArchive, func(entries map[string][]byte) {
			delete(entries, "blobs/docs/1/file.txt")
		})
		if _, err := InspectArchive(broken); !errors.Is(err, ErrInvalidArchive) {
			t.Fatalf("expected ErrInvalidArchive for missing entry, got %v", err)
		}
	})

	t.Run("unlisted_extra_entry", func(t *testing.T) {
		extra := rewriteArchive(t, origArchive, func(entries map[string][]byte) {
			entries["blobs/docs/1/injected.txt"] = []byte("surprise")
		})
		if _, err := InspectArchive(extra); !errors.Is(err, ErrInvalidArchive) {
			t.Fatalf("expected ErrInvalidArchive for unlisted entry, got %v", err)
		}
	})

	t.Run("path_traversal_entry", func(t *testing.T) {
		evil := filepath.Join(t.TempDir(), "evil.tar.gz")
		writeRawTarGz(t, evil, map[string][]byte{
			"../escape.txt": []byte("nope"),
			"manifest.json": []byte(`{"version":1,"tables":[],"blobCount":0,"sha256":{}}`),
		})
		if _, err := InspectArchive(evil); !errors.Is(err, ErrInvalidArchive) {
			t.Fatalf("expected ErrInvalidArchive for path traversal, got %v", err)
		}
	})
}

func TestRestoreNonSuperuserFallback(t *testing.T) {
	ctx := context.Background()
	srcDB := &fakeDB{
		tables: map[string][]string{
			"users": {`{"id":1,"email":"a@b.co","name":"A"}`},
		},
	}
	archivePath := filepath.Join(t.TempDir(), "backup.tar.gz")
	if _, err := ExportArchive(ctx, srcDB, nil, archivePath); err != nil {
		t.Fatal(err)
	}

	dstDB := &fakeDB{denyReplicaRole: true}
	if _, err := RestoreArchive(ctx, dstDB, nil, archivePath); err != nil {
		t.Fatalf("RestoreArchive should succeed when session_replication_role is denied: %v", err)
	}
	if dstDB.replicaRoleSet {
		t.Fatal("replica role should not have succeeded")
	}
	if !dstDB.savepointRolledBk {
		t.Fatal("expected ROLLBACK TO SAVEPOINT when session_replication_role fails")
	}
	if dstDB.txCommitted != 1 || len(dstDB.restored["users"]) != 1 {
		t.Fatalf("expected commit and restored row, got committed=%d restored=%+v", dstDB.txCommitted, dstDB.restored)
	}
}

func TestBackupEdgeCases(t *testing.T) {
	ctx := context.Background()

	// Archive containing blobs fails safely when target blob.Store is nil.
	srcDB := &fakeDB{tables: map[string][]string{"users": {}}}
	srcBlobs, err := blob.NewDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := srcBlobs.Put(ctx, "docs/1/f.bin", "application/octet-stream", []byte("x")); err != nil {
		t.Fatal(err)
	}
	archivePath := filepath.Join(t.TempDir(), "with-blob.tar.gz")
	if _, err := ExportArchive(ctx, srcDB, NewDirBlobEnumerator(srcBlobs), archivePath); err != nil {
		t.Fatal(err)
	}
	if _, err := RestoreArchive(ctx, &fakeDB{}, nil, archivePath); err == nil {
		t.Fatal("expected error restoring archive with blobs when blob store is nil")
	}

	// Nil postgres guards on convenience wrappers.
	if _, err := ExportPostgresDir(ctx, nil, "", archivePath); err == nil {
		t.Fatal("expected error for nil Postgres on ExportPostgresDir")
	}
	if _, err := RestorePostgresDir(ctx, nil, nil, archivePath); err == nil {
		t.Fatal("expected error for nil Postgres on RestorePostgresDir")
	}

	// Verify Manifest JSON field names explicitly match contract.
	m, err := InspectArchive(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	var generic map[string]any
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"version", "createdAt", "tables", "blobCount", "sha256"} {
		if _, ok := generic[field]; !ok {
			t.Fatalf("manifest JSON missing required field %q: %s", field, string(raw))
		}
	}
}

func rewriteArchive(t *testing.T, inPath string, mutate func(entries map[string][]byte)) string {
	t.Helper()
	f, err := os.Open(inPath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gzr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	defer gzr.Close()
	tr := tar.NewReader(gzr)
	entries := map[string][]byte{}
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		entries[hdr.Name] = b
	}
	mutate(entries)
	outPath := filepath.Join(t.TempDir(), "mutated.tar.gz")
	writeRawTarGz(t, outPath, entries)
	return outPath
}

func writeRawTarGz(t *testing.T, outPath string, entries map[string][]byte) {
	t.Helper()
	f, err := os.Create(outPath)
	if err != nil {
		t.Fatal(err)
	}
	gzw := gzip.NewWriter(f)
	tw := tar.NewWriter(gzw)
	names := make([]string, 0, len(entries))
	for k := range entries {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		data := entries[k]
		if err := tw.WriteHeader(&tar.Header{
			Name:     k,
			Mode:     0o644,
			Size:     int64(len(data)),
			Typeflag: tar.TypeReg,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}
