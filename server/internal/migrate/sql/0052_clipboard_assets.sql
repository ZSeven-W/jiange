-- Idempotent per-user attachment remapping for cross-document block paste.
-- The result and references are committed in the same transaction.
CREATE TABLE clipboard_asset_copies (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_doc_id bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    request_id text NOT NULL CHECK (request_id ~ '^[0-9a-f]{32}$'),
    source_doc_id bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    source_ids bigint[] NOT NULL,
    mapping jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, target_doc_id, request_id)
);
