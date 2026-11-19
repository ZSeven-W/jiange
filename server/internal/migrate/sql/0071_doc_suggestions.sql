CREATE TABLE IF NOT EXISTS doc_suggestions (
  id            BIGSERIAL PRIMARY KEY,
  doc_id        BIGINT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  block_id      TEXT NOT NULL,
  author_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'replace',
  original_text TEXT NOT NULL DEFAULT '',
  proposed_text TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open',
  resolved_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT doc_suggestions_kind_check CHECK (kind IN ('replace', 'insert', 'delete')),
  CONSTRAINT doc_suggestions_status_check CHECK (status IN ('open', 'accepted', 'rejected', 'withdrawn'))
);

CREATE INDEX IF NOT EXISTS doc_suggestions_doc_status_idx
  ON doc_suggestions(doc_id, status, created_at DESC);
