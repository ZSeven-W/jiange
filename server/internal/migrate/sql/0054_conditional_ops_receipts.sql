-- Receipts distinguish an idempotent retry from unrelated writes at the same head.
CREATE TABLE doc_conditional_ops_receipts (
    doc_id bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id text NOT NULL CHECK (request_id ~ '^[0-9a-f]{32}$'),
    history_epoch bigint NOT NULL CHECK (history_epoch >= 1),
    base_seq bigint NOT NULL CHECK (base_seq >= 0),
    first_seq bigint NOT NULL CHECK (first_seq >= 1),
    op_count integer NOT NULL CHECK (op_count > 0),
    digest bytea NOT NULL CHECK (octet_length(digest) = 32),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (doc_id, user_id, request_id)
);
