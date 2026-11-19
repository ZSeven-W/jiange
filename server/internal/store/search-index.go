package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// SearchIndexEntry stores the materialized searchable body text of a node at a
// specific history epoch & sequence (for CRDT docs) or revision/timestamp (for
// base/slides/survey).
type SearchIndexEntry struct {
	NodeID      int64
	SourceEpoch int64
	SourceSeq   int64
	SourceStamp time.Time
	BodyText    string
	IndexedAt   time.Time
}

// SearchIndexStore persists incrementally refreshed full-text search entries.
type SearchIndexStore interface {
	GetSearchIndex(ctx context.Context, nodeID int64) (SearchIndexEntry, error)
	UpsertSearchIndex(ctx context.Context, entry SearchIndexEntry) error
}

func (m *Memory) GetSearchIndex(_ context.Context, nodeID int64) (SearchIndexEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.searchIndex == nil {
		return SearchIndexEntry{}, ErrNotFound
	}
	e, ok := m.searchIndex[nodeID]
	if !ok {
		return SearchIndexEntry{}, ErrNotFound
	}
	return e, nil
}

func (m *Memory) UpsertSearchIndex(_ context.Context, entry SearchIndexEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.searchIndex == nil {
		m.searchIndex = map[int64]SearchIndexEntry{}
	}
	entry.IndexedAt = time.Now()
	m.searchIndex[entry.NodeID] = entry
	return nil
}

func (p *Postgres) GetSearchIndex(ctx context.Context, nodeID int64) (SearchIndexEntry, error) {
	var e SearchIndexEntry
	err := p.Pool.QueryRow(ctx, `
		SELECT node_id, source_epoch, source_seq, source_stamp, body_text, indexed_at
		FROM doc_search_index
		WHERE node_id = $1
	`, nodeID).Scan(&e.NodeID, &e.SourceEpoch, &e.SourceSeq, &e.SourceStamp, &e.BodyText, &e.IndexedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return SearchIndexEntry{}, ErrNotFound
	}
	return e, err
}

func (p *Postgres) UpsertSearchIndex(ctx context.Context, entry SearchIndexEntry) error {
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO doc_search_index (node_id, source_epoch, source_seq, source_stamp, body_text, indexed_at)
		VALUES ($1, $2, $3, $4, $5, now())
		ON CONFLICT (node_id) DO UPDATE SET
			source_epoch = EXCLUDED.source_epoch,
			source_seq = EXCLUDED.source_seq,
			source_stamp = EXCLUDED.source_stamp,
			body_text = EXCLUDED.body_text,
			indexed_at = now()
	`, entry.NodeID, entry.SourceEpoch, entry.SourceSeq, entry.SourceStamp, entry.BodyText)
	return err
}
