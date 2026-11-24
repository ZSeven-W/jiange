package store

import (
	"context"
	"fmt"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
	"weak"

	"golang.org/x/text/cases"
)

// DocEmbedding persists a dense semantic vector for a node along with the
// content hash and model identifier used to generate it.
type DocEmbedding struct {
	DocID       int64     `json:"docId"`
	WorkspaceID int64     `json:"workspaceId"`
	Model       string    `json:"model"`
	ContentHash string    `json:"contentHash"`
	Dimensions  int       `json:"dimensions"`
	Vector      []float32 `json:"vector"`
	Excerpt     string    `json:"excerpt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// EmbeddingStore persists and retrieves semantic document embeddings.
type EmbeddingStore interface {
	GetDocEmbeddings(ctx context.Context, docIDs []int64) (map[int64]DocEmbedding, error)
	UpsertDocEmbedding(ctx context.Context, emb DocEmbedding) error
}

// AttachmentTextEntry stores full text extracted from an uploaded attachment
// (Drive file or document attachment) for search and Workspace AI RAG.
type AttachmentTextEntry struct {
	AttachmentID  int64     `json:"attachmentId"`
	DocID         int64     `json:"docId"`
	WorkspaceID   int64     `json:"workspaceId"`
	Filename      string    `json:"filename"`
	Mime          string    `json:"mime"`
	ExtractedText string    `json:"extractedText"`
	Extractor     string    `json:"extractor"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

// AttachmentTextStore persists and queries extracted attachment full text.
type AttachmentTextStore interface {
	UpsertAttachmentText(ctx context.Context, entry AttachmentTextEntry) error
	ListAttachmentTextsByDocs(ctx context.Context, docIDs []int64) (map[int64][]AttachmentTextEntry, error)
	SearchAttachmentDocIDs(ctx context.Context, docIDs []int64, needle string) (map[int64]bool, error)
}

var (
	_ EmbeddingStore      = (*Memory)(nil)
	_ EmbeddingStore      = (*Postgres)(nil)
	_ AttachmentTextStore = (*Memory)(nil)
	_ AttachmentTextStore = (*Postgres)(nil)
)

type memSearchVectors struct {
	mu          sync.RWMutex
	embeddings  map[int64]DocEmbedding
	attachments map[int64]AttachmentTextEntry
}

var memorySearchVectors sync.Map // map[weak.Pointer[Memory]]*memSearchVectors

func (m *Memory) searchVectors() *memSearchVectors {
	wp := weak.Make(m)
	if existing, ok := memorySearchVectors.Load(wp); ok {
		return existing.(*memSearchVectors)
	}
	created := &memSearchVectors{
		embeddings:  map[int64]DocEmbedding{},
		attachments: map[int64]AttachmentTextEntry{},
	}
	actual, loaded := memorySearchVectors.LoadOrStore(wp, created)
	if !loaded {
		runtime.AddCleanup(m, func(k weak.Pointer[Memory]) {
			memorySearchVectors.Delete(k)
		}, wp)
	}
	return actual.(*memSearchVectors)
}

func sanitizeStoredText(s string) string {
	return strings.ReplaceAll(s, "\x00", "")
}

func normalizeDocEmbedding(emb DocEmbedding) DocEmbedding {
	if strings.TrimSpace(emb.Model) == "" {
		emb.Model = "local-ngram-v1"
	}
	if emb.Vector == nil {
		emb.Vector = []float32{}
	} else {
		emb.Vector = slices.Clone(emb.Vector)
	}
	if emb.Dimensions <= 0 {
		emb.Dimensions = len(emb.Vector)
	}
	emb.Excerpt = sanitizeStoredText(emb.Excerpt)
	return emb
}

// GetDocEmbeddings returns stored embeddings for the requested node IDs.
func (m *Memory) GetDocEmbeddings(ctx context.Context, docIDs []int64) (map[int64]DocEmbedding, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	out := make(map[int64]DocEmbedding, len(docIDs))
	if len(docIDs) == 0 {
		return out, nil
	}
	sv := m.searchVectors()
	sv.mu.RLock()
	defer sv.mu.RUnlock()
	for _, id := range docIDs {
		if emb, ok := sv.embeddings[id]; ok {
			emb.Vector = slices.Clone(emb.Vector)
			out[id] = emb
		}
	}
	return out, nil
}

// UpsertDocEmbedding creates or updates a document's semantic vector.
func (m *Memory) UpsertDocEmbedding(ctx context.Context, emb DocEmbedding) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if emb.DocID <= 0 {
		return fmt.Errorf("%w: invalid doc id", ErrInvalidInput)
	}
	emb = normalizeDocEmbedding(emb)
	emb.UpdatedAt = time.Now()
	sv := m.searchVectors()
	sv.mu.Lock()
	sv.embeddings[emb.DocID] = emb
	sv.mu.Unlock()
	return nil
}

// UpsertAttachmentText stores or updates extracted full text for an attachment.
func (m *Memory) UpsertAttachmentText(ctx context.Context, entry AttachmentTextEntry) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if entry.AttachmentID <= 0 || entry.DocID <= 0 {
		return fmt.Errorf("%w: invalid attachment or doc id", ErrInvalidInput)
	}
	entry.Filename = sanitizeStoredText(entry.Filename)
	entry.Mime = sanitizeStoredText(entry.Mime)
	entry.ExtractedText = sanitizeStoredText(entry.ExtractedText)
	entry.Extractor = sanitizeStoredText(entry.Extractor)
	entry.UpdatedAt = time.Now()
	sv := m.searchVectors()
	sv.mu.Lock()
	sv.attachments[entry.AttachmentID] = entry
	sv.mu.Unlock()
	return nil
}

// DeleteAttachmentText removes an attachment's indexed text entry.
func (m *Memory) DeleteAttachmentText(ctx context.Context, attachmentID int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	sv := m.searchVectors()
	sv.mu.Lock()
	delete(sv.attachments, attachmentID)
	sv.mu.Unlock()
	return nil
}

// ListAttachmentTextsByDocs returns indexed attachment texts grouped by doc ID.
func (m *Memory) ListAttachmentTextsByDocs(ctx context.Context, docIDs []int64) (map[int64][]AttachmentTextEntry, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	out := map[int64][]AttachmentTextEntry{}
	if len(docIDs) == 0 {
		return out, nil
	}
	wanted := make(map[int64]bool, len(docIDs))
	for _, id := range docIDs {
		wanted[id] = true
	}
	sv := m.searchVectors()
	sv.mu.RLock()
	for _, entry := range sv.attachments {
		if wanted[entry.DocID] {
			out[entry.DocID] = append(out[entry.DocID], entry)
		}
	}
	sv.mu.RUnlock()
	for docID := range out {
		sort.Slice(out[docID], func(i, j int) bool {
			return out[docID][i].AttachmentID < out[docID][j].AttachmentID
		})
	}
	return out, nil
}

// SearchAttachmentDocIDs returns the subset of docIDs that have an indexed
// attachment whose extracted text or filename contains needle (case-folded).
func (m *Memory) SearchAttachmentDocIDs(ctx context.Context, docIDs []int64, needle string) (map[int64]bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	matched := map[int64]bool{}
	foldedNeedle := cases.Fold().String(strings.TrimSpace(needle))
	if len(docIDs) == 0 || foldedNeedle == "" {
		return matched, nil
	}
	wanted := make(map[int64]bool, len(docIDs))
	for _, id := range docIDs {
		wanted[id] = true
	}
	fold := cases.Fold()
	sv := m.searchVectors()
	sv.mu.RLock()
	defer sv.mu.RUnlock()
	for _, entry := range sv.attachments {
		if !wanted[entry.DocID] || matched[entry.DocID] {
			continue
		}
		if strings.Contains(fold.String(entry.ExtractedText), foldedNeedle) ||
			strings.Contains(fold.String(entry.Filename), foldedNeedle) {
			matched[entry.DocID] = true
		}
	}
	return matched, nil
}

// GetDocEmbeddings loads stored vectors for docIDs from PostgreSQL.
func (p *Postgres) GetDocEmbeddings(ctx context.Context, docIDs []int64) (map[int64]DocEmbedding, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	out := make(map[int64]DocEmbedding, len(docIDs))
	if len(docIDs) == 0 {
		return out, nil
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT doc_id, workspace_id, model, content_hash, dimensions, vector, excerpt, updated_at
		FROM doc_embeddings
		WHERE doc_id = ANY($1)
	`, docIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var e DocEmbedding
		if err := rows.Scan(&e.DocID, &e.WorkspaceID, &e.Model, &e.ContentHash, &e.Dimensions, &e.Vector, &e.Excerpt, &e.UpdatedAt); err != nil {
			return nil, err
		}
		out[e.DocID] = e
	}
	return out, rows.Err()
}

// UpsertDocEmbedding inserts or updates a document embedding in PostgreSQL.
func (p *Postgres) UpsertDocEmbedding(ctx context.Context, emb DocEmbedding) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if emb.DocID <= 0 {
		return fmt.Errorf("%w: invalid doc id", ErrInvalidInput)
	}
	emb = normalizeDocEmbedding(emb)
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO doc_embeddings (doc_id, workspace_id, model, content_hash, dimensions, vector, excerpt, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, now())
		ON CONFLICT (doc_id) DO UPDATE SET
			workspace_id = EXCLUDED.workspace_id,
			model        = EXCLUDED.model,
			content_hash = EXCLUDED.content_hash,
			dimensions   = EXCLUDED.dimensions,
			vector       = EXCLUDED.vector,
			excerpt      = EXCLUDED.excerpt,
			updated_at   = now()
	`, emb.DocID, emb.WorkspaceID, emb.Model, emb.ContentHash, emb.Dimensions, emb.Vector, emb.Excerpt)
	return err
}

// UpsertAttachmentText inserts or updates extracted attachment full text in PostgreSQL.
func (p *Postgres) UpsertAttachmentText(ctx context.Context, entry AttachmentTextEntry) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if entry.AttachmentID <= 0 || entry.DocID <= 0 {
		return fmt.Errorf("%w: invalid attachment or doc id", ErrInvalidInput)
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO attachment_text_index (attachment_id, doc_id, workspace_id, filename, mime, extracted_text, extractor, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, now())
		ON CONFLICT (attachment_id) DO UPDATE SET
			doc_id         = EXCLUDED.doc_id,
			workspace_id   = EXCLUDED.workspace_id,
			filename       = EXCLUDED.filename,
			mime           = EXCLUDED.mime,
			extracted_text = EXCLUDED.extracted_text,
			extractor      = EXCLUDED.extractor,
			updated_at     = now()
	`, entry.AttachmentID, entry.DocID, entry.WorkspaceID,
		sanitizeStoredText(entry.Filename),
		sanitizeStoredText(entry.Mime),
		sanitizeStoredText(entry.ExtractedText),
		sanitizeStoredText(entry.Extractor))
	return err
}

// DeleteAttachmentText removes an attachment's extracted text row from PostgreSQL.
func (p *Postgres) DeleteAttachmentText(ctx context.Context, attachmentID int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	_, err := p.Pool.Exec(ctx, `DELETE FROM attachment_text_index WHERE attachment_id = $1`, attachmentID)
	return err
}

// ListAttachmentTextsByDocs loads extracted attachment text rows grouped by doc ID.
func (p *Postgres) ListAttachmentTextsByDocs(ctx context.Context, docIDs []int64) (map[int64][]AttachmentTextEntry, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	out := map[int64][]AttachmentTextEntry{}
	if len(docIDs) == 0 {
		return out, nil
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT attachment_id, doc_id, workspace_id, filename, mime, extracted_text, extractor, updated_at
		FROM attachment_text_index
		WHERE doc_id = ANY($1)
		ORDER BY doc_id, attachment_id
	`, docIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var e AttachmentTextEntry
		if err := rows.Scan(&e.AttachmentID, &e.DocID, &e.WorkspaceID, &e.Filename, &e.Mime, &e.ExtractedText, &e.Extractor, &e.UpdatedAt); err != nil {
			return nil, err
		}
		out[e.DocID] = append(out[e.DocID], e)
	}
	return out, rows.Err()
}

// SearchAttachmentDocIDs finds candidate doc IDs whose attachment text or filename matches needle.
func (p *Postgres) SearchAttachmentDocIDs(ctx context.Context, docIDs []int64, needle string) (map[int64]bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	matched := map[int64]bool{}
	needle = strings.TrimSpace(needle)
	if len(docIDs) == 0 || needle == "" {
		return matched, nil
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT DISTINCT doc_id
		FROM attachment_text_index
		WHERE doc_id = ANY($1)
		  AND (strpos(lower(extracted_text), lower($2)) > 0 OR strpos(lower(filename), lower($2)) > 0)
	`, docIDs, needle)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var docID int64
		if err := rows.Scan(&docID); err != nil {
			return nil, err
		}
		matched[docID] = true
	}
	return matched, rows.Err()
}
