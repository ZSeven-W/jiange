CREATE TABLE IF NOT EXISTS synced_blocks (
  id            TEXT PRIMARY KEY,
  workspace_id  BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_doc_id BIGINT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  content       TEXT NOT NULL DEFAULT '',
  revision      BIGINT NOT NULL DEFAULT 1,
  updated_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS synced_blocks_source_doc_idx
  ON synced_blocks(source_doc_id);
