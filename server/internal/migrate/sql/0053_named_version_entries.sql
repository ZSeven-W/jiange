-- A document may have several named versions of the same immutable snapshot.
-- The snapshot remains the unit used by legacy preview/restore endpoints.
CREATE TABLE doc_version_entries (
    id bigserial PRIMARY KEY,
    doc_id bigint NOT NULL,
    seq bigint NOT NULL,
    history_epoch bigint,
    label text NOT NULL,
    created_by bigint REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    request_id text CHECK (request_id IS NULL OR request_id ~ '^[0-9a-f]{32}$'),
    FOREIGN KEY (doc_id, seq) REFERENCES doc_snapshots(doc_id, seq) ON DELETE CASCADE,
    UNIQUE (doc_id, created_by, request_id)
);
CREATE INDEX doc_version_entries_order ON doc_version_entries (doc_id, created_at DESC, id DESC);

-- Preserve all versions already visible through the legacy snapshot list.
INSERT INTO doc_version_entries (doc_id,seq,label,created_by,created_at)
SELECT doc_id,seq,label,created_by,created_at FROM doc_snapshots WHERE is_version;
