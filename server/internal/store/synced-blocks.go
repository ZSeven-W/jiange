package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// SyncedBlock stores a reusable cross-document synchronized content block.
type SyncedBlock struct {
	ID             string    `json:"id"`
	WorkspaceID    int64     `json:"workspaceId"`
	SourceDocID    int64     `json:"sourceDocId"`
	SourceDocTitle string    `json:"sourceDocTitle,omitempty"`
	Content        string    `json:"content"`
	Revision       int64     `json:"revision"`
	UpdatedBy      *int64    `json:"updatedBy,omitempty"`
	UpdatedByName  string    `json:"updatedByName,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

// SyncedBlockStore persists cross-document synced blocks.
type SyncedBlockStore interface {
	CreateSyncedBlock(ctx context.Context, workspaceID, sourceDocID, userID int64, content string) (SyncedBlock, error)
	GetSyncedBlock(ctx context.Context, id string) (SyncedBlock, error)
	UpdateSyncedBlock(ctx context.Context, id string, userID int64, content string, expectedRevision int64) (SyncedBlock, error)
}

func newSyncedBlockID() string {
	var b [9]byte
	_, _ = rand.Read(b[:])
	return "sb_" + hex.EncodeToString(b[:])
}

func (m *Memory) docTitleLocked(docID int64) string {
	for _, d := range m.d.docs {
		if d.meta.ID == docID {
			return d.meta.Title
		}
	}
	return ""
}

func (m *Memory) CreateSyncedBlock(_ context.Context, workspaceID, sourceDocID, userID int64, content string) (SyncedBlock, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.syncedBlocks == nil {
		m.syncedBlocks = map[string]SyncedBlock{}
	}
	now := time.Now()
	uid := userID
	sb := SyncedBlock{
		ID:             newSyncedBlockID(),
		WorkspaceID:    workspaceID,
		SourceDocID:    sourceDocID,
		SourceDocTitle: m.docTitleLocked(sourceDocID),
		Content:        content,
		Revision:       1,
		UpdatedBy:      &uid,
		UpdatedByName:  m.userNameLocked(userID),
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	m.syncedBlocks[sb.ID] = sb
	return sb, nil
}

func (m *Memory) GetSyncedBlock(_ context.Context, id string) (SyncedBlock, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sb, ok := m.syncedBlocks[id]
	if !ok {
		return SyncedBlock{}, ErrNotFound
	}
	sb.SourceDocTitle = m.docTitleLocked(sb.SourceDocID)
	if sb.UpdatedBy != nil {
		sb.UpdatedByName = m.userNameLocked(*sb.UpdatedBy)
	}
	return sb, nil
}

func (m *Memory) UpdateSyncedBlock(_ context.Context, id string, userID int64, content string, expectedRevision int64) (SyncedBlock, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sb, ok := m.syncedBlocks[id]
	if !ok {
		return SyncedBlock{}, ErrNotFound
	}
	if expectedRevision > 0 && sb.Revision != expectedRevision {
		return SyncedBlock{}, ErrConflict
	}
	uid := userID
	sb.Content = content
	sb.Revision++
	sb.UpdatedBy = &uid
	sb.UpdatedByName = m.userNameLocked(userID)
	sb.SourceDocTitle = m.docTitleLocked(sb.SourceDocID)
	sb.UpdatedAt = time.Now()
	m.syncedBlocks[id] = sb
	return sb, nil
}

const syncedBlockSelectCols = `
	sb.id, sb.workspace_id, sb.source_doc_id, COALESCE(n.title, ''),
	sb.content, sb.revision, sb.updated_by, COALESCE(u.name, ''),
	sb.created_at, sb.updated_at
`

func scanSyncedBlock(row pgx.Row) (SyncedBlock, error) {
	var sb SyncedBlock
	err := row.Scan(
		&sb.ID, &sb.WorkspaceID, &sb.SourceDocID, &sb.SourceDocTitle,
		&sb.Content, &sb.Revision, &sb.UpdatedBy, &sb.UpdatedByName,
		&sb.CreatedAt, &sb.UpdatedAt,
	)
	return sb, err
}

func (p *Postgres) CreateSyncedBlock(ctx context.Context, workspaceID, sourceDocID, userID int64, content string) (SyncedBlock, error) {
	id := newSyncedBlockID()
	row := p.Pool.QueryRow(ctx, `
		WITH ins AS (
			INSERT INTO synced_blocks (id, workspace_id, source_doc_id, content, updated_by)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING *
		)
		SELECT `+syncedBlockSelectCols+`
		FROM ins sb
		LEFT JOIN nodes n ON n.id = sb.source_doc_id
		LEFT JOIN users u ON u.id = sb.updated_by
	`, id, workspaceID, sourceDocID, content, userID)
	return scanSyncedBlock(row)
}

func (p *Postgres) GetSyncedBlock(ctx context.Context, id string) (SyncedBlock, error) {
	row := p.Pool.QueryRow(ctx, `
		SELECT `+syncedBlockSelectCols+`
		FROM synced_blocks sb
		LEFT JOIN nodes n ON n.id = sb.source_doc_id
		LEFT JOIN users u ON u.id = sb.updated_by
		WHERE sb.id = $1
	`, id)
	sb, err := scanSyncedBlock(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return SyncedBlock{}, ErrNotFound
	}
	return sb, err
}

func (p *Postgres) UpdateSyncedBlock(ctx context.Context, id string, userID int64, content string, expectedRevision int64) (SyncedBlock, error) {
	var row pgx.Row
	if expectedRevision > 0 {
		row = p.Pool.QueryRow(ctx, `
			WITH upd AS (
				UPDATE synced_blocks
				SET content = $2, revision = revision + 1, updated_by = $3, updated_at = now()
				WHERE id = $1 AND revision = $4
				RETURNING *
			)
			SELECT `+syncedBlockSelectCols+`
			FROM upd sb
			LEFT JOIN nodes n ON n.id = sb.source_doc_id
			LEFT JOIN users u ON u.id = sb.updated_by
		`, id, content, userID, expectedRevision)
	} else {
		row = p.Pool.QueryRow(ctx, `
			WITH upd AS (
				UPDATE synced_blocks
				SET content = $2, revision = revision + 1, updated_by = $3, updated_at = now()
				WHERE id = $1
				RETURNING *
			)
			SELECT `+syncedBlockSelectCols+`
			FROM upd sb
			LEFT JOIN nodes n ON n.id = sb.source_doc_id
			LEFT JOIN users u ON u.id = sb.updated_by
		`, id, content, userID)
	}
	sb, err := scanSyncedBlock(row)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, gerr := p.GetSyncedBlock(ctx, id); gerr == nil {
			return SyncedBlock{}, ErrConflict
		}
		return SyncedBlock{}, ErrNotFound
	}
	return sb, err
}
