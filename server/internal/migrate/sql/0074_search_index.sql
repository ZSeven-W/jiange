-- Persistent full-text search index for documents, bases, slides, and surveys.
-- Avoids replaying full CRDT operation logs on repeated queries while tracking
-- exact source_epoch / source_seq / source_stamp so stale entries refresh incrementally.
CREATE TABLE IF NOT EXISTS doc_search_index (
  node_id      BIGINT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  source_epoch BIGINT NOT NULL DEFAULT 0,
  source_seq   BIGINT NOT NULL DEFAULT 0,
  source_stamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  body_text    TEXT NOT NULL DEFAULT '',
  indexed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS doc_search_index_updated_idx
  ON doc_search_index(indexed_at DESC);
