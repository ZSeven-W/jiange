-- Persistent bidirectional reference index for documents, boards, sheets,
-- bases, slides, and surveys.
-- Stores per-source exact version stamps (history_epoch / seq / updated_at)
-- alongside normalized outgoing edges (direct node links, resource embeds, and
-- share-token links) so incoming backlinks and multi-hop graph traversals run
-- via indexed SQL lookups without full-corpus CRDT replays.

CREATE TABLE IF NOT EXISTS doc_reference_index_state (
  source_node_id BIGINT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  source_kind    TEXT NOT NULL DEFAULT 'doc',
  source_epoch   BIGINT NOT NULL DEFAULT 0,
  source_seq     BIGINT NOT NULL DEFAULT 0,
  source_stamp   TIMESTAMPTZ NOT NULL DEFAULT now(),
  indexed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS doc_reference_edges (
  id             BIGSERIAL PRIMARY KEY,
  source_node_id BIGINT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_node_id BIGINT NOT NULL DEFAULT 0,
  target_token   TEXT NOT NULL DEFAULT '',
  target_scheme  TEXT NOT NULL DEFAULT '',
  source_block   TEXT NOT NULL DEFAULT '',
  excerpt        TEXT NOT NULL DEFAULT '',
  relation_kind  TEXT NOT NULL DEFAULT 'link',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS doc_reference_edges_source_idx
  ON doc_reference_edges(source_node_id);

CREATE INDEX IF NOT EXISTS doc_reference_edges_target_idx
  ON doc_reference_edges(target_node_id) WHERE target_node_id > 0;

CREATE INDEX IF NOT EXISTS doc_reference_edges_token_idx
  ON doc_reference_edges(target_token) WHERE target_token <> '';
