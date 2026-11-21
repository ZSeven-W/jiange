package storage

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	// ErrNotFound is returned when a document does not exist in the store.
	ErrNotFound = errors.New("storage: document not found")
	// ErrVersionConflict is returned when optimistic concurrency version check fails.
	ErrVersionConflict = errors.New("storage: version conflict")
	// ErrInvalidID is returned when a document ID is empty or unsafe for storage.
	ErrInvalidID = errors.New("storage: invalid document id")
)

// DocumentRecord represents a versioned Office document stored in a backend.
type DocumentRecord struct {
	ID        string            `json:"id"`
	Kind      string            `json:"kind"`
	Title     string            `json:"title"`
	Version   int64             `json:"version"`
	Data      []byte            `json:"data"`
	Metadata  map[string]string `json:"metadata,omitempty"`
	CreatedAt time.Time         `json:"createdAt"`
	UpdatedAt time.Time         `json:"updatedAt"`
}

// Store defines the persistence contract for Jiange backend integrations.
type Store interface {
	Get(ctx context.Context, id string) (*DocumentRecord, error)
	Put(ctx context.Context, rec *DocumentRecord) error
	Delete(ctx context.Context, id string) error
	List(ctx context.Context, kind string) ([]*DocumentRecord, error)
}

var randRead = rand.Read

// GenerateID generates a random hex identifier with an optional prefix.
func GenerateID(prefix string) string {
	var buf [8]byte
	if _, err := randRead(buf[:]); err != nil {
		return fmt.Sprintf("%s%d", prefix, time.Now().UnixNano())
	}
	return prefix + hex.EncodeToString(buf[:])
}

// ValidateID ensures an ID is non-empty and safe for filesystem and URL paths.
func ValidateID(id string) error {
	if id == "" || id == "." || id == ".." || strings.ContainsAny(id, `/\`) || strings.ContainsRune(id, 0) {
		return ErrInvalidID
	}
	return nil
}

func cloneRecord(rec *DocumentRecord) *DocumentRecord {
	cp := *rec
	if rec.Data != nil {
		cp.Data = append([]byte(nil), rec.Data...)
	}
	if rec.Metadata != nil {
		cp.Metadata = make(map[string]string, len(rec.Metadata))
		for k, v := range rec.Metadata {
			cp.Metadata[k] = v
		}
	}
	return &cp
}

// MemoryStore is a thread-safe in-memory implementation of Store.
type MemoryStore struct {
	mu      sync.RWMutex
	records map[string]*DocumentRecord
	now     func() time.Time
}

// NewMemoryStore creates an initialized MemoryStore.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		records: make(map[string]*DocumentRecord),
		now:     func() time.Time { return time.Now().UTC() },
	}
}

// Get retrieves a document record by ID.
func (m *MemoryStore) Get(_ context.Context, id string) (*DocumentRecord, error) {
	if err := ValidateID(id); err != nil {
		return nil, err
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	rec, ok := m.records[id]
	if !ok {
		return nil, ErrNotFound
	}
	return cloneRecord(rec), nil
}

// Put inserts or updates a document record using optimistic version locking.
func (m *MemoryStore) Put(_ context.Context, rec *DocumentRecord) error {
	if rec == nil {
		return ErrInvalidID
	}
	if err := ValidateID(rec.ID); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	existing, exists := m.records[rec.ID]
	if exists {
		if rec.Version != existing.Version {
			return ErrVersionConflict
		}
		rec.Version = existing.Version + 1
		rec.CreatedAt = existing.CreatedAt
		rec.UpdatedAt = now
	} else {
		if rec.Version != 0 {
			return ErrVersionConflict
		}
		rec.Version = 1
		if rec.CreatedAt.IsZero() {
			rec.CreatedAt = now
		}
		rec.UpdatedAt = now
	}
	m.records[rec.ID] = cloneRecord(rec)
	return nil
}

// Delete removes a document record by ID.
func (m *MemoryStore) Delete(_ context.Context, id string) error {
	if err := ValidateID(id); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.records[id]; !ok {
		return ErrNotFound
	}
	delete(m.records, id)
	return nil
}

// List returns all records matching kind (or all records when kind is empty), sorted by ID.
func (m *MemoryStore) List(_ context.Context, kind string) ([]*DocumentRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*DocumentRecord, 0, len(m.records))
	for _, rec := range m.records {
		if kind != "" && rec.Kind != kind {
			continue
		}
		out = append(out, cloneRecord(rec))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

type tempFile interface {
	io.WriteCloser
	Name() string
}

type fileOps struct {
	createTemp func(dir, pattern string) (tempFile, error)
	rename     func(oldpath, newpath string) error
	remove     func(name string) error
}

func defaultFileOps() fileOps {
	return fileOps{
		createTemp: func(dir, pattern string) (tempFile, error) {
			return os.CreateTemp(dir, pattern)
		},
		rename: os.Rename,
		remove: os.Remove,
	}
}

// FileStore persists DocumentRecords atomically on disk using temp files and rename.
type FileStore struct {
	mu  sync.RWMutex
	dir string
	now func() time.Time
	ops fileOps
}

// NewFileStore initializes a disk-backed FileStore rooted at dir.
func NewFileStore(dir string) (*FileStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &FileStore{
		dir: dir,
		now: func() time.Time { return time.Now().UTC() },
		ops: defaultFileOps(),
	}, nil
}

func (fs *FileStore) pathFor(id string) string {
	return filepath.Join(fs.dir, id+".json")
}

func (fs *FileStore) readRecord(path string) (*DocumentRecord, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	var rec DocumentRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

// Get reads a document record from disk by ID.
func (fs *FileStore) Get(_ context.Context, id string) (*DocumentRecord, error) {
	if err := ValidateID(id); err != nil {
		return nil, err
	}
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	return fs.readRecord(fs.pathFor(id))
}

// Put writes a document record atomically with optimistic version checking.
func (fs *FileStore) Put(_ context.Context, rec *DocumentRecord) error {
	if rec == nil {
		return ErrInvalidID
	}
	if err := ValidateID(rec.ID); err != nil {
		return err
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()

	target := fs.pathFor(rec.ID)
	existing, err := fs.readRecord(target)
	now := fs.now()
	next := cloneRecord(rec)
	if err == nil {
		if rec.Version != existing.Version {
			return ErrVersionConflict
		}
		next.Version = existing.Version + 1
		next.CreatedAt = existing.CreatedAt
		next.UpdatedAt = now
	} else if errors.Is(err, ErrNotFound) {
		if rec.Version != 0 {
			return ErrVersionConflict
		}
		next.Version = 1
		if next.CreatedAt.IsZero() {
			next.CreatedAt = now
		}
		next.UpdatedAt = now
	} else {
		return err
	}

	payload, _ := json.Marshal(next)
	tmp, err := fs.ops.createTemp(fs.dir, ".jiange-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(payload); err != nil {
		_ = tmp.Close()
		_ = fs.ops.remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = fs.ops.remove(tmpName)
		return err
	}
	if err := fs.ops.rename(tmpName, target); err != nil {
		_ = fs.ops.remove(tmpName)
		return err
	}
	rec.Version = next.Version
	rec.CreatedAt = next.CreatedAt
	rec.UpdatedAt = next.UpdatedAt
	return nil
}

// Delete removes a document record file from disk.
func (fs *FileStore) Delete(_ context.Context, id string) error {
	if err := ValidateID(id); err != nil {
		return err
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()
	err := fs.ops.remove(fs.pathFor(id))
	if errors.Is(err, os.ErrNotExist) {
		return ErrNotFound
	}
	return err
}

// List enumerates stored document records filtered by kind, sorted by ID.
func (fs *FileStore) List(_ context.Context, kind string) ([]*DocumentRecord, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	entries, err := os.ReadDir(fs.dir)
	if err != nil {
		return nil, err
	}
	var out []*DocumentRecord
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		rec, err := fs.readRecord(filepath.Join(fs.dir, entry.Name()))
		if err != nil {
			return nil, err
		}
		if kind != "" && rec.Kind != kind {
			continue
		}
		out = append(out, rec)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}
