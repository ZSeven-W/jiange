package store

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sort"
	"sync"
	"time"
	"weak"

	"github.com/jackc/pgx/v5"
)

const (
	defaultReindexAttachmentsLimit = 10000
	storageTopAttachmentsLimit     = 10
)

// StorageKindBreakdown summarizes attachment count and total bytes grouped by parent node kind.
type StorageKindBreakdown struct {
	Kind  string `json:"kind"`
	Count int64  `json:"count"`
	Bytes int64  `json:"bytes"`
}

// StorageTopAttachment describes one of the largest attachments in a workspace.
type StorageTopAttachment struct {
	ID        int64     `json:"id"`
	DocID     int64     `json:"docId"`
	DocTitle  string    `json:"docTitle"`
	DocKind   string    `json:"docKind"`
	Name      string    `json:"name"`
	MIME      string    `json:"mime"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"createdAt"`
}

// WorkspaceStorageUsage reports attachment storage usage, quota, and index coverage for a workspace.
type WorkspaceStorageUsage struct {
	WorkspaceID     int64                  `json:"workspaceId"`
	UsedBytes       int64                  `json:"usedBytes"`
	QuotaBytes      int64                  `json:"quotaBytes"` // 0 = unlimited
	AttachmentCount int64                  `json:"attachmentCount"`
	IndexedCount    int64                  `json:"indexedCount"`
	ByKind          []StorageKindBreakdown `json:"byKind"`
	TopAttachments  []StorageTopAttachment `json:"topAttachments"`
}

// AttachmentBackfillItem holds attachment metadata needed to backfill attachment_text_index.
type AttachmentBackfillItem struct {
	AttachmentID int64
	DocID        int64
	WorkspaceID  int64
	Name         string
	MIME         string
	ObjectKey    string
}

// StorageQuotaStore persists workspace attachment storage quotas, usage analytics,
// and attachment listing for full-text backfill reindexing.
type StorageQuotaStore interface {
	GetWorkspaceStorageUsage(ctx context.Context, wsID int64) (WorkspaceStorageUsage, error)
	GetWorkspaceStorageQuota(ctx context.Context, wsID int64) (usedBytes int64, quotaBytes int64, err error)
	SetWorkspaceStorageQuota(ctx context.Context, wsID int64, quotaBytes int64, updatedBy int64, now time.Time) error
	ListAttachmentsForReindex(ctx context.Context, wsID int64, limit int) ([]AttachmentBackfillItem, error)
}

var (
	_ StorageQuotaStore = (*Memory)(nil)
	_ StorageQuotaStore = (*Postgres)(nil)
)

type memStorageQuotaState struct {
	mu     sync.RWMutex
	quotas map[int64]int64
}

var memoryStorageQuotas sync.Map // map[weak.Pointer[Memory]]*memStorageQuotaState

func (m *Memory) storageQuotaState() *memStorageQuotaState {
	wp := weak.Make(m)
	if existing, ok := memoryStorageQuotas.Load(wp); ok {
		return existing.(*memStorageQuotaState)
	}
	created := &memStorageQuotaState{
		quotas: map[int64]int64{},
	}
	actual, loaded := memoryStorageQuotas.LoadOrStore(wp, created)
	if !loaded {
		runtime.AddCleanup(m, func(k weak.Pointer[Memory]) {
			memoryStorageQuotas.Delete(k)
		}, wp)
	}
	return actual.(*memStorageQuotaState)
}

// GetWorkspaceStorageUsage aggregates attachment usage, breakdown by node kind,
// top largest attachments, full-text index coverage, and configured quota in Memory.
func (m *Memory) GetWorkspaceStorageUsage(ctx context.Context, wsID int64) (WorkspaceStorageUsage, error) {
	if err := ctx.Err(); err != nil {
		return WorkspaceStorageUsage{}, err
	}
	if wsID <= 0 {
		return WorkspaceStorageUsage{}, ErrNotFound
	}

	out := WorkspaceStorageUsage{
		WorkspaceID:    wsID,
		ByKind:         []StorageKindBreakdown{},
		TopAttachments: []StorageTopAttachment{},
	}

	byKind := map[string]*StorageKindBreakdown{}
	attachmentIDs := map[int64]struct{}{}
	var top []StorageTopAttachment

	m.mu.Lock()
	if !m.workspaceExistsLocked(wsID) {
		m.mu.Unlock()
		return WorkspaceStorageUsage{}, ErrNotFound
	}
	for _, f := range m.sh.files {
		if f.ID == 0 {
			continue
		}
		d := m.doc(f.DocID)
		if d == nil || d.purged || d.meta.WorkspaceID != wsID {
			continue
		}
		size := f.Size
		if size < 0 {
			size = 0
		}
		out.UsedBytes += size
		out.AttachmentCount++
		attachmentIDs[f.ID] = struct{}{}

		kind := d.meta.Kind
		if kind == "" {
			kind = "doc"
		}
		bk, ok := byKind[kind]
		if !ok {
			bk = &StorageKindBreakdown{Kind: kind}
			byKind[kind] = bk
		}
		bk.Count++
		bk.Bytes += size

		top = append(top, StorageTopAttachment{
			ID:        f.ID,
			DocID:     f.DocID,
			DocTitle:  d.meta.Title,
			DocKind:   kind,
			Name:      f.Name,
			MIME:      f.Mime,
			Size:      size,
			CreatedAt: f.CreatedAt,
		})
	}
	m.mu.Unlock()

	qs := m.storageQuotaState()
	qs.mu.RLock()
	out.QuotaBytes = qs.quotas[wsID]
	qs.mu.RUnlock()

	if len(attachmentIDs) > 0 {
		sv := m.searchVectors()
		sv.mu.RLock()
		for attID := range attachmentIDs {
			if entry, ok := sv.attachments[attID]; ok && entry.ExtractedText != "" {
				out.IndexedCount++
			}
		}
		sv.mu.RUnlock()
	}

	for _, bk := range byKind {
		out.ByKind = append(out.ByKind, *bk)
	}
	sort.Slice(out.ByKind, func(i, j int) bool {
		if out.ByKind[i].Bytes != out.ByKind[j].Bytes {
			return out.ByKind[i].Bytes > out.ByKind[j].Bytes
		}
		return out.ByKind[i].Kind < out.ByKind[j].Kind
	})

	sort.Slice(top, func(i, j int) bool {
		if top[i].Size != top[j].Size {
			return top[i].Size > top[j].Size
		}
		return top[i].ID > top[j].ID
	})
	if len(top) > storageTopAttachmentsLimit {
		top = top[:storageTopAttachmentsLimit]
	}
	if len(top) > 0 {
		out.TopAttachments = top
	}

	return out, nil
}

// GetWorkspaceStorageQuota returns current total attachment bytes and quota (0 = unlimited) in Memory.
func (m *Memory) GetWorkspaceStorageQuota(ctx context.Context, wsID int64) (int64, int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, 0, err
	}
	if wsID <= 0 {
		return 0, 0, ErrNotFound
	}

	var used int64
	m.mu.Lock()
	if !m.workspaceExistsLocked(wsID) {
		m.mu.Unlock()
		return 0, 0, ErrNotFound
	}
	for _, f := range m.sh.files {
		if f.ID == 0 {
			continue
		}
		d := m.doc(f.DocID)
		if d == nil || d.purged || d.meta.WorkspaceID != wsID {
			continue
		}
		if f.Size > 0 {
			used += f.Size
		}
	}
	m.mu.Unlock()

	qs := m.storageQuotaState()
	qs.mu.RLock()
	quota := qs.quotas[wsID]
	qs.mu.RUnlock()

	return used, quota, nil
}

// SetWorkspaceStorageQuota updates a workspace's attachment storage quota in Memory (0 = unlimited).
func (m *Memory) SetWorkspaceStorageQuota(ctx context.Context, wsID int64, quotaBytes int64, _ int64, _ time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if wsID <= 0 {
		return ErrNotFound
	}
	if quotaBytes < 0 {
		return fmt.Errorf("%w: storage quota must be >= 0", ErrInvalidInput)
	}

	m.mu.Lock()
	exists := m.workspaceExistsLocked(wsID)
	m.mu.Unlock()
	if !exists {
		return ErrNotFound
	}

	qs := m.storageQuotaState()
	qs.mu.Lock()
	qs.quotas[wsID] = quotaBytes
	qs.mu.Unlock()
	return nil
}

// ListAttachmentsForReindex returns attachments in wsID (or all workspaces when wsID == 0).
func (m *Memory) ListAttachmentsForReindex(ctx context.Context, wsID int64, limit int) ([]AttachmentBackfillItem, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if wsID < 0 {
		return nil, fmt.Errorf("%w: invalid workspace id", ErrInvalidInput)
	}
	if limit <= 0 {
		limit = defaultReindexAttachmentsLimit
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if wsID > 0 && !m.workspaceExistsLocked(wsID) {
		return nil, ErrNotFound
	}

	out := []AttachmentBackfillItem{}
	for _, f := range m.sh.files {
		if f.ID == 0 {
			continue
		}
		d := m.doc(f.DocID)
		if d == nil || d.purged {
			continue
		}
		if wsID > 0 && d.meta.WorkspaceID != wsID {
			continue
		}
		out = append(out, AttachmentBackfillItem{
			AttachmentID: f.ID,
			DocID:        f.DocID,
			WorkspaceID:  d.meta.WorkspaceID,
			Name:         f.Name,
			MIME:         f.Mime,
			ObjectKey:    f.ObjectKey,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].AttachmentID < out[j].AttachmentID
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// GetWorkspaceStorageUsage aggregates attachment usage, kind breakdown, top files,
// index coverage, and configured quota in PostgreSQL.
func (p *Postgres) GetWorkspaceStorageUsage(ctx context.Context, wsID int64) (WorkspaceStorageUsage, error) {
	if err := ctx.Err(); err != nil {
		return WorkspaceStorageUsage{}, err
	}
	if wsID <= 0 {
		return WorkspaceStorageUsage{}, ErrNotFound
	}

	out := WorkspaceStorageUsage{
		WorkspaceID:    wsID,
		ByKind:         []StorageKindBreakdown{},
		TopAttachments: []StorageTopAttachment{},
	}

	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(p.storage_quota_bytes, 0)
			FROM workspaces w
			LEFT JOIN workspace_security_policies p ON p.workspace_id = w.id
			WHERE w.id = $1
		`, wsID).Scan(&out.QuotaBytes); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}

		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(SUM(GREATEST(a.size, 0)), 0), COUNT(*)
			FROM attachments a
			JOIN nodes n ON n.id = a.doc_id
			WHERE n.workspace_id = $1
		`, wsID).Scan(&out.UsedBytes, &out.AttachmentCount); err != nil {
			return err
		}

		if err := tx.QueryRow(ctx, `
			SELECT COUNT(*)
			FROM attachment_text_index ati
			JOIN attachments a ON a.id = ati.attachment_id
			JOIN nodes n ON n.id = a.doc_id
			WHERE n.workspace_id = $1 AND ati.extracted_text <> ''
		`, wsID).Scan(&out.IndexedCount); err != nil {
			return err
		}

		kindRows, err := tx.Query(ctx, `
			SELECT COALESCE(NULLIF(n.kind, ''), 'doc') AS kind,
			       COUNT(*) AS cnt,
			       COALESCE(SUM(GREATEST(a.size, 0)), 0) AS total_bytes
			FROM attachments a
			JOIN nodes n ON n.id = a.doc_id
			WHERE n.workspace_id = $1
			GROUP BY COALESCE(NULLIF(n.kind, ''), 'doc')
			ORDER BY total_bytes DESC, kind ASC
		`, wsID)
		if err != nil {
			return err
		}
		defer kindRows.Close()
		for kindRows.Next() {
			var bk StorageKindBreakdown
			if err := kindRows.Scan(&bk.Kind, &bk.Count, &bk.Bytes); err != nil {
				return err
			}
			out.ByKind = append(out.ByKind, bk)
		}
		if err := kindRows.Err(); err != nil {
			return err
		}

		topRows, err := tx.Query(ctx, `
			SELECT a.id, a.doc_id, n.title, COALESCE(NULLIF(n.kind, ''), 'doc'), a.name, a.mime, GREATEST(a.size, 0), a.created_at
			FROM attachments a
			JOIN nodes n ON n.id = a.doc_id
			WHERE n.workspace_id = $1
			ORDER BY a.size DESC, a.id DESC
			LIMIT $2
		`, wsID, storageTopAttachmentsLimit)
		if err != nil {
			return err
		}
		defer topRows.Close()
		for topRows.Next() {
			var item StorageTopAttachment
			if err := topRows.Scan(&item.ID, &item.DocID, &item.DocTitle, &item.DocKind, &item.Name, &item.MIME, &item.Size, &item.CreatedAt); err != nil {
				return err
			}
			out.TopAttachments = append(out.TopAttachments, item)
		}
		return topRows.Err()
	})
	if err != nil {
		return WorkspaceStorageUsage{}, err
	}
	return out, nil
}

// GetWorkspaceStorageQuota returns current attachment bytes and quota (0 = unlimited) in PostgreSQL.
func (p *Postgres) GetWorkspaceStorageQuota(ctx context.Context, wsID int64) (int64, int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, 0, err
	}
	if wsID <= 0 {
		return 0, 0, ErrNotFound
	}
	var usedBytes, quotaBytes int64
	err := p.Pool.QueryRow(ctx, `
		SELECT
			COALESCE((SELECT SUM(GREATEST(a.size, 0)) FROM attachments a JOIN nodes n ON n.id = a.doc_id WHERE n.workspace_id = w.id), 0),
			COALESCE(p.storage_quota_bytes, 0)
		FROM workspaces w
		LEFT JOIN workspace_security_policies p ON p.workspace_id = w.id
		WHERE w.id = $1
	`, wsID).Scan(&usedBytes, &quotaBytes)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, ErrNotFound
	}
	if err != nil {
		return 0, 0, err
	}
	return usedBytes, quotaBytes, nil
}

// SetWorkspaceStorageQuota upserts workspace_security_policies.storage_quota_bytes without
// clobbering any other security policy columns.
func (p *Postgres) SetWorkspaceStorageQuota(ctx context.Context, wsID int64, quotaBytes int64, updatedBy int64, now time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if wsID <= 0 {
		return ErrNotFound
	}
	if quotaBytes < 0 {
		return fmt.Errorf("%w: storage quota must be >= 0", ErrInvalidInput)
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}

	return pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var exists int
		if err := tx.QueryRow(ctx, `SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE`, wsID).Scan(&exists); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO workspace_security_policies (workspace_id, storage_quota_bytes, updated_by, updated_at)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (workspace_id) DO UPDATE SET
				storage_quota_bytes = EXCLUDED.storage_quota_bytes,
				updated_by          = EXCLUDED.updated_by,
				updated_at          = EXCLUDED.updated_at
		`, wsID, quotaBytes, nullablePositiveID(updatedBy), now)
		return err
	})
}

// ListAttachmentsForReindex lists attachments in wsID (or across all workspaces when wsID == 0).
func (p *Postgres) ListAttachmentsForReindex(ctx context.Context, wsID int64, limit int) ([]AttachmentBackfillItem, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if wsID < 0 {
		return nil, fmt.Errorf("%w: invalid workspace id", ErrInvalidInput)
	}
	if limit <= 0 {
		limit = defaultReindexAttachmentsLimit
	}

	if wsID > 0 {
		var exists int
		if err := p.Pool.QueryRow(ctx, `SELECT 1 FROM workspaces WHERE id = $1`, wsID).Scan(&exists); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrNotFound
			}
			return nil, err
		}
	}

	rows, err := p.Pool.Query(ctx, `
		SELECT a.id, a.doc_id, n.workspace_id, a.name, a.mime, a.object_key
		FROM attachments a
		JOIN nodes n ON n.id = a.doc_id
		WHERE ($1::bigint = 0 OR n.workspace_id = $1)
		ORDER BY a.id ASC
		LIMIT $2
	`, wsID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []AttachmentBackfillItem{}
	for rows.Next() {
		var item AttachmentBackfillItem
		if err := rows.Scan(&item.AttachmentID, &item.DocID, &item.WorkspaceID, &item.Name, &item.MIME, &item.ObjectKey); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
